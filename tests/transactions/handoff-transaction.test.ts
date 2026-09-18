import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkspaceLeaseManager } from '../../packages/controller/src/handoff/lease.ts';
import { OutboxQueue } from '../../packages/controller/src/handoff/outbox.ts';
import { HandoffStateMachine } from '../../packages/controller/src/handoff/state-machine.ts';
import { MockAdapter } from '../../packages/adapters/mock/src/mock-adapter.ts';

// ─── WorkspaceLeaseManager ───

test('lease: enforces single-writer owner and rejects stale epoch CAS (R10, V34)', () => {
  const lease = new WorkspaceLeaseManager();
  const acquired = lease.acquireInitialLease('ws-1', 'session-A', 1);
  assert.strictEqual(acquired, true);

  // Split-brain attempt: Session C tries to overwrite with old epoch
  const badCas = lease.compareAndSetOwner('ws-1', 'session-A', 'session-C', 1, 1);
  assert.strictEqual(badCas, false);

  // Legitimate handoff: Session A to Session B with incremented epoch
  const goodCas = lease.compareAndSetOwner('ws-1', 'session-A', 'session-B', 1, 2);
  assert.strictEqual(goodCas, true);
  assert.strictEqual(lease.getLease('ws-1')?.currentOwner, 'session-B');
  assert.strictEqual(lease.getLease('ws-1')?.epoch, 2);
});

test('lease: acquireInitialLease returns false when already held', () => {
  const lease = new WorkspaceLeaseManager();
  assert.strictEqual(lease.acquireInitialLease('ws-1', 'owner-1'), true);
  assert.strictEqual(lease.acquireInitialLease('ws-1', 'owner-2'), false);
});

test('lease: compareAndSetOwner returns false for unknown workspace', () => {
  const lease = new WorkspaceLeaseManager();
  assert.strictEqual(lease.compareAndSetOwner('non-existent', 'owner-1', 'owner-2', 1, 2), false);
});

test('lease: releaseLease clears lease for correct owner and rejects wrong owner', () => {
  const lease = new WorkspaceLeaseManager();
  lease.acquireInitialLease('ws-1', 'owner-1', 1);
  assert.strictEqual(lease.releaseLease('ws-1', 'wrong-owner'), false);
  assert.ok(lease.getLease('ws-1') !== undefined);

  assert.strictEqual(lease.releaseLease('ws-1', 'owner-1'), true);
  assert.strictEqual(lease.getLease('ws-1'), undefined);
});

test('lease: getLease returns defensive copy', () => {
  const lease = new WorkspaceLeaseManager();
  lease.acquireInitialLease('ws-1', 'owner-1', 1);
  const copy = lease.getLease('ws-1')!;
  copy.currentOwner = 'hacked';
  assert.strictEqual(lease.getLease('ws-1')?.currentOwner, 'owner-1');
});

test('lease: independent workspaces operate in isolation (V31, V34)', () => {
  const lease = new WorkspaceLeaseManager();
  assert.strictEqual(lease.acquireInitialLease('ws-repo-A', 'session-A', 1), true);
  assert.strictEqual(lease.acquireInitialLease('ws-repo-B', 'session-B', 1), true);

  assert.strictEqual(lease.getLease('ws-repo-A')?.currentOwner, 'session-A');
  assert.strictEqual(lease.getLease('ws-repo-B')?.currentOwner, 'session-B');

  // Releasing ws-repo-A does not touch ws-repo-B
  assert.strictEqual(lease.releaseLease('ws-repo-A', 'session-A'), true);
  assert.strictEqual(lease.getLease('ws-repo-A'), undefined);
  assert.strictEqual(lease.getLease('ws-repo-B')?.currentOwner, 'session-B');
});

// ─── OutboxQueue ───

test('outbox: enqueue, getPending, and markDelivered preserve FIFO and defensive copies (V06, V07, V27, V34)', () => {
  const outbox = new OutboxQueue();
  const msg1 = outbox.enqueue('handoff', { step: 1 });
  const msg2 = outbox.enqueue('handoff', { step: 2 });

  const pending = outbox.getPending();
  assert.strictEqual(pending.length, 2);
  assert.strictEqual(pending[0].payload.step, 1);
  assert.strictEqual(pending[1].payload.step, 2);

  // Defensive copy
  pending[0].payload.step = 999;
  assert.strictEqual(outbox.getPending()[0].payload.step, 1);

  // Mark delivered
  outbox.markDelivered(msg1.id);
  const afterDelivered = outbox.getPending();
  assert.strictEqual(afterDelivered.length, 1);
  assert.strictEqual(afterDelivered[0].id, msg2.id);
});

// ─── HandoffStateMachine ───

test('state-machine: RUNNING -> DRAINING -> CHECKPOINTED -> PREPARING -> READY -> RUNNING (R2, R4, R10)', () => {
  const sm = new HandoffStateMachine('run-1', 'session-A', 1);
  assert.strictEqual(sm.getState(), 'RUNNING');

  sm.requestHandoff('unit_completed');
  assert.strictEqual(sm.getState(), 'DRAINING');

  sm.checkpointCompleted('checkpoint-hash-1');
  assert.strictEqual(sm.getState(), 'CHECKPOINTED');

  sm.startNewSession('session-B');
  assert.strictEqual(sm.getState(), 'PREPARING');

  // Session B submits read-only ACK
  sm.receiveAck({
    handoffId: 'h-1',
    runId: 'run-1',
    newSessionId: 'session-B',
    effectiveModel: { provider: 'openai', model: 'gpt-5.6-luna' },
    verifiedInputHeadHash: 'hash-input',
    verifiedTaskSnapshotHash: 'hash-task',
    verifiedWorkspaceHash: 'hash-ws',
    ackTimestamp: Date.now()
  });
  assert.strictEqual(sm.getState(), 'READY');

  // Controller issues execution token
  const token = sm.issueExecutionToken();
  assert.ok(token.token.startsWith('EXEC_TOKEN_'));
  assert.strictEqual(sm.getState(), 'RUNNING');
  assert.strictEqual(sm.getCurrentOwner(), 'session-B');
  assert.strictEqual(sm.getEpoch(), 2);
});

test('state-machine: rejects invalid transitions and runId mismatch', () => {
  const sm = new HandoffStateMachine('run-guard', 'session-1', 1);

  // Cannot start session while running
  assert.throws(() => sm.startNewSession('session-2'), /Cannot start new session in state RUNNING/);

  // Cannot issue token while running
  assert.throws(() => sm.issueExecutionToken(), /Cannot issue execution token in state RUNNING/);

  sm.requestHandoff('unit_completed');
  assert.throws(() => sm.requestHandoff('unit_completed'), /Cannot request handoff in state DRAINING/);

  sm.checkpointCompleted();
  sm.startNewSession('session-2');

  // Mismatched runId on ACK
  assert.throws(
    () =>
      sm.receiveAck({
        handoffId: 'h-test',
        runId: 'wrong-run-id',
        newSessionId: 'session-2',
        effectiveModel: { provider: 'p', model: 'm' },
        verifiedInputHeadHash: 'h1',
        verifiedTaskSnapshotHash: 'h2',
        verifiedWorkspaceHash: 'h3',
        ackTimestamp: Date.now()
      }),
    /Run ID mismatch/
  );

  // Mismatched session ID on ACK
  assert.throws(
    () =>
      sm.receiveAck({
        handoffId: 'h-test',
        runId: 'run-guard',
        newSessionId: 'wrong-session-id',
        effectiveModel: { provider: 'p', model: 'm' },
        verifiedInputHeadHash: 'h1',
        verifiedTaskSnapshotHash: 'h2',
        verifiedWorkspaceHash: 'h3',
        ackTimestamp: Date.now()
      }),
    /Session ID mismatch/
  );
});

test('state-machine: pause and cancel transitions', () => {
  const sm1 = new HandoffStateMachine('run-p', 'session-1', 1);
  sm1.pause();
  assert.strictEqual(sm1.getState(), 'PAUSED');

  const sm2 = new HandoffStateMachine('run-c', 'session-1', 1);
  sm2.cancel();
  assert.strictEqual(sm2.getState(), 'CANCELLED');
});

// ─── MockAdapter ───

test('mock-adapter: session spawn, ack generation, and termination', () => {
  const adapter = new MockAdapter();
  const session = adapter.spawnSession('sess-100', { provider: 'anthropic', model: 'claude-3-7-sonnet' });
  assert.strictEqual(session.active, true);
  assert.strictEqual(session.model.model, 'claude-3-7-sonnet');

  const ack = adapter.createAck('sess-100', 'h-99', 'run-99');
  assert.strictEqual(ack.handoffId, 'h-99');
  assert.strictEqual(ack.newSessionId, 'sess-100');
  assert.strictEqual(ack.effectiveModel.model, 'claude-3-7-sonnet');

  adapter.terminateSession('sess-100');
  assert.strictEqual(adapter.sessions.get('sess-100')?.active, false);
});

test('state-machine: supports the STARTING leg and recovery transitions required by the engine (V14, V20)', () => {
  const sm = new HandoffStateMachine('run-sm-2', 'session-a', 1);
  assert.strictEqual(sm.getState(), 'RUNNING');

  sm.requestHandoff('unit_completed');
  sm.checkpointCompleted('h-ckpt');
  assert.strictEqual(sm.getState(), 'CHECKPOINTED');

  // STARTING models the window where the create intent is durable but the
  // create result may still be unknown (V14).
  sm.beginStarting();
  assert.strictEqual(sm.getState(), 'STARTING');

  // startNewSession must accept STARTING as well as CHECKPOINTED
  sm.startNewSession('session-b');
  assert.strictEqual(sm.getState(), 'PREPARING');
  assert.strictEqual(sm.getCurrentOwner(), 'session-b');

  // PREPARING -> RECOVERY_REQUIRED when the ACK cannot be reconciled
  sm.markRecoveryRequired();
  assert.strictEqual(sm.getState(), 'RECOVERY_REQUIRED');

  // RECOVERY_REQUIRED -> CHECKPOINTED once the state is re-established
  sm.resolveRecovery();
  assert.strictEqual(sm.getState(), 'CHECKPOINTED');

  // PAUSED -> CHECKPOINTED on user resume (03-技术设计.md §7)
  const sm2 = new HandoffStateMachine('run-sm-3', 'session-x', 1);
  sm2.pause();
  assert.strictEqual(sm2.getState(), 'PAUSED');
  sm2.resume();
  assert.strictEqual(sm2.getState(), 'CHECKPOINTED');
});

test('state-machine: new transitions reject invalid source states', () => {
  const sm = new HandoffStateMachine('run-sm-4', 'session-a', 1);

  assert.throws(() => sm.beginStarting(), /Cannot begin starting session in state RUNNING/);
  assert.throws(() => sm.resolveRecovery(), /Cannot resolve recovery in state RUNNING/);
  assert.throws(() => sm.resume(), /Cannot resume in state RUNNING/);

  sm.requestHandoff('unit_completed');
  assert.throws(() => sm.beginStarting(), /Cannot begin starting session in state DRAINING/);
  // 无法确认旧写入静止时 DRAINING 必须能进入恢复态（03-技术设计.md §7、§6.3 第 2 步；Task 8 交接第 2 步依赖它）
  sm.markRecoveryRequired();
  assert.strictEqual(sm.getState(), 'RECOVERY_REQUIRED');
});
