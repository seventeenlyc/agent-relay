import test from 'node:test';
import assert from 'node:assert/strict';
import { ControlIntentLog } from '../../packages/controller/src/run/intent.ts';
import { DurableLeaseManager } from '../../packages/controller/src/handoff/durable-lease.ts';
import { ScriptedAdapter } from '../helpers/scripted-adapter.ts';
import { recoveryHarness } from '../helpers/recovery-harness.ts';

test('V18: a surviving unresponsive worker keeps its lease across controller restart', async t => {
  class HungWorker extends ScriptedAdapter {
    hung = false;
    override interruptOwned(id: string) { return this.hung ? false : super.interruptOwned(id); }
    override awaitQuiescence(id: string) {
      return this.hung ? Promise.resolve('timeout' as const) : super.awaitQuiescence(id);
    }
  }
  const adapter = new HungWorker();
  const h = recoveryHarness(t, adapter);
  await h.controller.tick();
  const run = h.store.getRun('recovery')!;
  const lease = new DurableLeaseManager(h.store).getLease(run.workspaceKey)!;
  // An old timestamp is not proof that the physical worker stopped.
  h.db.prepare('UPDATE lease_state SET acquired_at = 0 WHERE workspace_key = ?').run(run.workspaceKey);
  h.store.updateRunState('recovery', 'DRAINING');
  adapter.hung = true;
  h.reboot();
  const result = await h.controller.reconcile();
  assert.equal(result.recoveredState, 'RECOVERY_REQUIRED');
  assert.equal(result.reason, 'old_session_quiescence_unconfirmed');
  assert.equal((await h.controller.tick()).kind, 'recovery_required');
  assert.equal(adapter.sessions.get(run.currentSessionId!)!.active, true);
  const remaining = new DurableLeaseManager(h.store).getLease(run.workspaceKey)!;
  assert.equal(remaining.currentOwner, lease.currentOwner);
  assert.equal(remaining.epoch, lease.epoch);
  assert.equal(adapter.created.length, 1);
  h.assertInvariants('RECOVERY_REQUIRED');
});

for (const consumed of [false, true]) {
  test(`V21: ${consumed ? 'consumed' : 'pending'} stop survives a closed database and cannot restart execution`, async t => {
    const h = recoveryHarness(t);
    await h.controller.tick();
    new ControlIntentLog(h.store).append('recovery', 'stop_now');
    if (consumed) assert.equal((await h.controller.tick()).kind, 'stopped');
    const submissions = h.adapter.submitted.length;
    h.reboot();
    assert.equal((await h.controller.reconcile()).recoveredState, 'CANCELLED');
    assert.equal([...h.adapter.sessions.values()].filter(s => s.active).length, 0, 'stop must stop the surviving worker before releasing its lease');
    h.reboot();
    assert.equal((await h.controller.reconcile()).recoveredState, 'CANCELLED');
    assert.equal((await h.controller.tick()).kind, 'stopped');
    assert.equal(h.adapter.submitted.length, submissions);
    assert.equal(h.adapter.created.length, 1);
    h.assertInvariants('CANCELLED');
  });
}

test('V18/V21: failed stop keeps the pending intent and writer lease until quiescence is confirmed', async t => {
  class StubbornWorker extends ScriptedAdapter {
    refusesStop = false;
    override interruptOwned(id: string) { return this.refusesStop ? false : super.interruptOwned(id); }
    override awaitQuiescence(id: string) {
      return this.refusesStop ? Promise.resolve('timeout' as const) : super.awaitQuiescence(id);
    }
  }
  const adapter = new StubbornWorker();
  const h = recoveryHarness(t, adapter);
  await h.controller.tick();
  const workspaceKey = h.store.getRun('recovery')!.workspaceKey;
  const lease = h.store.getLeaseRow(workspaceKey);
  new ControlIntentLog(h.store).append('recovery', 'stop_now');
  adapter.refusesStop = true;
  h.reboot();
  assert.equal((await h.controller.reconcile()).reason, 'stop_quiescence_unconfirmed');
  assert.equal(new ControlIntentLog(h.store).pendingCount('recovery'), 1);
  assert.deepEqual(h.store.getLeaseRow(workspaceKey), lease);
  assert.equal(adapter.sessions.get('recovery-s1')!.active, true);
  h.assertInvariants('RECOVERY_REQUIRED');
  adapter.refusesStop = false;
  h.reboot();
  assert.equal((await h.controller.reconcile()).recoveredState, 'CANCELLED');
  assert.equal(new ControlIntentLog(h.store).pendingCount('recovery'), 0);
  assert.equal(h.store.getLeaseRow(workspaceKey), undefined);
  h.assertInvariants('CANCELLED');
});

test('V21: a paused run remains paused through reconciliation and database restart', async t => {
  const h = recoveryHarness(t);
  await h.controller.tick();
  new ControlIntentLog(h.store).append('recovery', 'pause_next_node');
  assert.equal((await h.controller.tick()).kind, 'paused');
  const submissions = h.adapter.submitted.length;
  h.reboot();
  assert.equal((await h.controller.reconcile()).recoveredState, 'PAUSED');
  assert.equal((await h.controller.tick()).kind, 'paused');
  assert.equal(h.adapter.submitted.length, submissions);
  assert.equal(h.adapter.created.length, 1);
  h.assertInvariants('PAUSED');
});

test('V33: post-CAS stop invalidates the unconsumed epoch and survives restart', async t => {
  let grantedEpoch = 0;
  const h = recoveryHarness(t, new ScriptedAdapter(), (point, ctx) => {
    if (point === 'after_owner_cas') {
      grantedEpoch = ctx.epoch!;
      new ControlIntentLog(h.store).append('recovery', 'stop_now');
    }
  });
  await h.controller.tick();
  assert.equal((await h.controller.tick()).kind, 'stopped');
  assert.equal(grantedEpoch, 2);
  const run = h.store.getRun('recovery')!;
  const leases = new DurableLeaseManager(h.store);
  assert.equal(leases.getLease(run.workspaceKey)!.epoch, grantedEpoch + 1);
  assert.equal(leases.compareAndSetOwner(run.workspaceKey, 'recovery-s2', 'rogue', grantedEpoch, grantedEpoch + 1), false);
  assert.equal(h.adapter.wasAuthorized('recovery-s2'), false);
  assert.equal(h.adapter.sessions.get('recovery-s2')!.readOnly, true);
  assert.equal(h.adapter.sessions.get('recovery-s2')!.active, false);
  const submissions = h.adapter.submitted.length;
  h.reboot();
  assert.equal((await h.controller.reconcile()).recoveredState, 'CANCELLED');
  assert.equal((await h.controller.tick()).kind, 'stopped');
  assert.equal(h.adapter.submitted.length, submissions);
  h.assertInvariants('CANCELLED');
});

test('V21/V33: stop persisted at a crashed CAS boundary cannot replay authorization after another restart', async t => {
  const h = recoveryHarness(t, new ScriptedAdapter(), point => {
    if (point === 'after_owner_cas') {
      new ControlIntentLog(h.store).append('recovery', 'stop_now');
      throw new Error('power loss after CAS');
    }
  });
  await h.controller.tick();
  await assert.rejects(h.controller.tick(), /power loss after CAS/);
  for (let attempt = 0; attempt < 2; attempt++) {
    h.reboot();
    assert.equal((await h.controller.reconcile()).recoveredState, 'CANCELLED');
    assert.equal((await h.controller.tick()).kind, 'stopped');
    assert.equal(h.adapter.wasAuthorized('recovery-s2'), false);
    assert.ok([...h.adapter.sessions.values()].every(s => !s.active));
    h.assertInvariants('CANCELLED');
  }
});
