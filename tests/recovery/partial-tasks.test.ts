import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ScriptedAdapter } from '../helpers/scripted-adapter.ts';
import { recoveryHarness } from '../helpers/recovery-harness.ts';

test('V07: failed verification and diagnostics reach the successor after database restart', async t => {
  const diagnostic = 'verification failed: expected 42, actual 41; inspect src/counter.ts:17';
  const h = recoveryHarness(t, new ScriptedAdapter({ unitReplies: {
    u1: { status: 'failed', summary: diagnostic, evidenceHash: 'failed-output-sha256' }
  }}));
  assert.deepEqual(await h.controller.tick(), { kind: 'unit_executed', taskId: 'u1', status: 'failed' });
  assert.equal(h.tasks()[0].status, 'in_progress');
  assert.equal(h.tasks()[1].status, 'pending');
  const hashes = h.controller.getInvariantHashes();
  h.reboot();
  assert.deepEqual(h.controller.getInvariantHashes(), hashes);
  assert.equal((await h.controller.reconcile()).recoveredState, 'RUNNING');
  assert.equal((await h.controller.tick()).kind, 'handoff_performed');
  const handoff = h.store.getHandoff('h-recovery-1')!;
  const manifest = JSON.parse(fs.readFileSync(handoff.manifestPath!, 'utf8'));
  assert.ok(JSON.stringify(manifest).includes(diagnostic), 'published handoff retains failed verification diagnostics');
  assert.ok(JSON.stringify(manifest).includes('failed-output-sha256'), 'failure evidence is distinct from completion evidence');
  await h.controller.tick();
  const retry = h.adapter.submitted.find(s => s.sessionId === 'recovery-s2' && s.content.includes('TASK_ID: u1'));
  assert.ok(retry?.content.includes(diagnostic), 'successor must diagnose the prior failure, not restart without context');
  assert.equal(h.tasks()[0].status, 'in_progress');
  assert.equal(h.store.listEvents('recovery').filter(e => e.type === 'unit_completed').length, 0);
  h.assertInvariants('RUNNING');
});

test('V26: unknown external outcome is never replayed by repeated reconciliation and restart', async t => {
  const h = recoveryHarness(t, new ScriptedAdapter({ unitReplies: {
    u1: { status: 'unknown_outcome', summary: 'deploy job-123 timed out; query remote status before any retry' }
  }}));
  assert.equal((await h.controller.tick()).kind, 'recovery_required');
  const submissions = h.adapter.submitted.length;
  for (let attempt = 0; attempt < 2; attempt++) {
    h.reboot();
    assert.equal((await h.controller.reconcile()).recoveredState, 'RECOVERY_REQUIRED');
    assert.equal((await h.controller.tick()).kind, 'recovery_required');
    assert.equal(h.adapter.submitted.length, submissions, 'external action must not be resubmitted');
    assert.equal(h.adapter.created.length, 1);
    assert.equal(h.tasks()[0].status, 'in_progress');
    assert.ok(h.store.listEvents('recovery').some(e => e.payload?.summary?.includes('job-123')));
    h.assertInvariants('RECOVERY_REQUIRED');
  }
});

test('V26: a long-running unit with unconfirmed completion requires recovery and is never resubmitted', async t => {
  const h = recoveryHarness(t, new ScriptedAdapter({ quiescenceOverrides: { 'recovery-s1': 'timeout' } }));
  assert.equal((await h.controller.tick()).kind, 'recovery_required');
  const submissions = h.adapter.submitted.length;
  h.reboot();
  assert.equal((await h.controller.reconcile()).recoveredState, 'RECOVERY_REQUIRED');
  assert.equal((await h.controller.tick()).kind, 'recovery_required');
  assert.equal(h.adapter.submitted.length, submissions);
  assert.equal(h.adapter.created.length, 1);
  assert.equal(h.tasks()[0].status, 'in_progress');
  h.assertInvariants('RECOVERY_REQUIRED');
});
