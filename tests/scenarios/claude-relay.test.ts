// tests/scenarios/claude-relay.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { ClaudeAdapter } from '../../packages/adapters/claude/src/claude-adapter.ts';
import { ClaudeProcessRunner } from '../../packages/adapters/claude/src/runner.ts';
import { TwoPhaseHandshakeCoordinator } from '../../packages/adapters/claude/src/handshake.ts';
import { WorkspaceLeaseManager } from '../../packages/controller/src/handoff/lease.ts';
import { HandoffStateMachine } from '../../packages/controller/src/handoff/state-machine.ts';
import { InputLedger } from '../../packages/controller/src/inputs/ledger.ts';
import { TaskGraph } from '../../packages/controller/src/tasks/graph.ts';
import { WorkspaceSentinel } from '../../packages/controller/src/workspace/sentinel.ts';
import { HandoffPackager } from '../../packages/controller/src/workspace/checkpoint.ts';
import { TriggerPolicy } from '../../packages/controller/src/policy/trigger.ts';
import { GlobalBudget } from '../../packages/controller/src/policy/budget.ts';
import type { HandoffAckPacket } from '../../packages/protocol/src/types.ts';

const MOCK_CLI_PATH = fileURLToPath(new URL('../fixtures/mock-claude-cli.mjs', import.meta.url));

test('scenarios: S01~S03 - 3-round automated Claude relay with model preservation and CAS lease', async () => {
  const runner = new ClaudeProcessRunner({
    binPath: process.execPath,
    extraArgsPrefix: [MOCK_CLI_PATH]
  });
  const adapter = new ClaudeAdapter({ runner });
  const lease = new WorkspaceLeaseManager();
  const sentinel = new WorkspaceSentinel(process.cwd());
  const packager = new HandoffPackager();
  const ledger = new InputLedger();
  ledger.appendUserMessage('Build reliable 3-stage calculator');

  const graph = new TaskGraph();
  graph.addTask({ taskId: 't1', requirementId: 'r1', title: 'Unit 1: Add' });
  graph.addTask({ taskId: 't2', requirementId: 'r1', title: 'Unit 2: Subtract' });
  graph.addTask({ taskId: 't3', requirementId: 'r1', title: 'Unit 3: Multiply' });

  const runId = 'relay-run-001';
  const workspaceKey = 'ws-test-repo';
  const targetModel = { provider: 'anthropic', model: 'claude-3-7-sonnet', effort: 'high' };

  // ─── ROUND 1: Session A ───
  const sessionA_Id = 'session-claude-A';
  lease.acquireInitialLease(workspaceKey, sessionA_Id, 1);
  const sm = new HandoffStateMachine(runId, sessionA_Id, 1);

  await adapter.createFresh({
    sessionId: sessionA_Id,
    runId,
    model: targetModel,
    initialPrompt: 'Execute Unit 1'
  });

  // Complete Unit 1
  graph.completeTaskWithEvidence('t1', 'hash-ev-1');
  sm.requestHandoff('unit_completed');
  const fp1 = await sentinel.captureFingerprint();
  const manifest1 = packager.createManifest({
    handoffId: 'h-1',
    runId,
    epoch: 1,
    sourceSessionId: sessionA_Id,
    targetModel,
    inputLedgerHeadHash: ledger.getHeadHash(),
    requirementVersion: 1,
    taskSnapshotHash: graph.computeSnapshotHash(),
    workspaceFingerprint: fp1
  });
  sm.checkpointCompleted(manifest1.handoffId);

  // ─── ROUND 2: Session B (L3 fresh spawn) ───
  const sessionB_Id = 'session-claude-B';
  const coord1 = new TwoPhaseHandshakeCoordinator(sm, lease, workspaceKey);
  coord1.startNewSession(sessionB_Id);

  const sessionB_Inspect = await adapter.createFresh({
    sessionId: sessionB_Id,
    runId,
    model: targetModel,
    readOnly: true,
    initialPrompt: coord1.generatePreparationPrompt(manifest1)
  });

  // Verify R5: Model and effort are strictly preserved
  assert.strictEqual(sessionB_Inspect.effectiveModel?.model, 'claude-3-7-sonnet');
  assert.strictEqual(sessionB_Inspect.effectiveModel?.effort, 'high');

  // Verify Session A and B have distinct IDs
  assert.notStrictEqual(sessionA_Id, sessionB_Id);

  // Submit ACK from Session B
  const ack1: HandoffAckPacket = {
    handoffId: 'h-1',
    runId,
    newSessionId: sessionB_Id,
    effectiveModel: targetModel,
    verifiedInputHeadHash: ledger.getHeadHash(),
    verifiedTaskSnapshotHash: graph.computeSnapshotHash(),
    verifiedWorkspaceHash: fp1.treeHash,
    ackTimestamp: Date.now()
  };

  const auth1 = coord1.verifyAckAndAuthorize(manifest1, ack1);
  assert.strictEqual(auth1.success, true);
  assert.strictEqual(lease.getLease(workspaceKey)?.currentOwner, sessionB_Id);
  assert.strictEqual(lease.getLease(workspaceKey)?.epoch, 2);

  // Old session A tries to write with old epoch -> REJECTED by CAS (R10)
  assert.strictEqual(lease.compareAndSetOwner(workspaceKey, sessionA_Id, 'session-C', 1, 3), false);

  // Complete Unit 2
  graph.completeTaskWithEvidence('t2', 'hash-ev-2');
  sm.requestHandoff('unit_completed');
  const fp2 = await sentinel.captureFingerprint();
  const manifest2 = packager.createManifest({
    handoffId: 'h-2',
    runId,
    epoch: 2,
    sourceSessionId: sessionB_Id,
    targetModel,
    inputLedgerHeadHash: ledger.getHeadHash(),
    requirementVersion: 1,
    taskSnapshotHash: graph.computeSnapshotHash(),
    workspaceFingerprint: fp2
  });
  sm.checkpointCompleted(manifest2.handoffId);

  // ─── ROUND 3: Session C (L3 fresh spawn) ───
  const sessionC_Id = 'session-claude-C';
  const coord2 = new TwoPhaseHandshakeCoordinator(sm, lease, workspaceKey);
  coord2.startNewSession(sessionC_Id);

  const sessionC_Inspect = await adapter.createFresh({
    sessionId: sessionC_Id,
    runId,
    model: targetModel,
    readOnly: true,
    initialPrompt: coord2.generatePreparationPrompt(manifest2)
  });

  assert.strictEqual(sessionC_Inspect.effectiveModel?.model, 'claude-3-7-sonnet');
  assert.strictEqual(sessionC_Inspect.effectiveModel?.effort, 'high');
  assert.notStrictEqual(sessionB_Id, sessionC_Id);

  // Verify policy & budget tracking across handoffs
  const policy = new TriggerPolicy();
  assert.strictEqual(policy.evaluate({ unitCompleted: true, hasMoreUnits: false }).shouldHandoff, false);
  const budget = new GlobalBudget({ maxDurationMs: 3600000 });
  budget.recordTurn(100, 50);
  assert.strictEqual(budget.isExceeded(), false);

  const ack2: HandoffAckPacket = {
    handoffId: 'h-2',
    runId,
    newSessionId: sessionC_Id,
    effectiveModel: targetModel,
    verifiedInputHeadHash: ledger.getHeadHash(),
    verifiedTaskSnapshotHash: graph.computeSnapshotHash(),
    verifiedWorkspaceHash: fp2.treeHash,
    ackTimestamp: Date.now()
  };

  const auth2 = coord2.verifyAckAndAuthorize(manifest2, ack2);
  assert.strictEqual(auth2.success, true);
  assert.strictEqual(lease.getLease(workspaceKey)?.currentOwner, sessionC_Id);
  assert.strictEqual(lease.getLease(workspaceKey)?.epoch, 3);

  // Complete Unit 3
  graph.completeTaskWithEvidence('t3', 'hash-ev-3');
  assert.strictEqual(graph.getTask('t1')?.status, 'completed');
  assert.strictEqual(graph.getTask('t2')?.status, 'completed');
  assert.strictEqual(graph.getTask('t3')?.status, 'completed');
});

test('scenarios: S04 - Stop hook deduplication prevents infinite continue loop (R6)', () => {
  const adapter = new ClaudeAdapter();
  const hookHandler = adapter.getHookHandler();

  let handoffTriggerCount = 0;
  hookHandler.onHandoffTrigger(() => {
    handoffTriggerCount++;
  });

  // Emulate repeated Stop hook events
  for (let i = 0; i < 5; i++) {
    hookHandler.processEvent({
      type: 'system',
      subtype: 'hook_response',
      session_id: 'session-loop-1',
      hook_id: 'stop-fixed-id',
      hook_name: 'Stop',
      hook_event: 'Stop'
    });
  }

  // Deduplicated to exactly 1 trigger
  assert.strictEqual(handoffTriggerCount, 1);
});

test('scenarios: S05 - User pause priority stops relay sequence immediately (R7)', () => {
  const lease = new WorkspaceLeaseManager();
  lease.acquireInitialLease('ws-p', 'session-1', 1);
  const sm = new HandoffStateMachine('run-p', 'session-1', 1);

  // User pauses mid-execution
  sm.pause();
  assert.strictEqual(sm.getState(), 'PAUSED');

  // Any attempt to request handoff or start new session must be blocked
  assert.throws(() => sm.requestHandoff('unit_completed'), /Cannot request handoff in state PAUSED/);
  assert.throws(() => sm.startNewSession('session-2'), /Cannot start new session in state PAUSED/);

  // User cancels mid-execution (cancellation priority)
  const smCancel = new HandoffStateMachine('run-cancel', 'session-1', 1);
  smCancel.cancel();
  assert.strictEqual(smCancel.getState(), 'CANCELLED');
  assert.throws(() => smCancel.requestHandoff('unit_completed'), /Cannot request handoff in state CANCELLED/);
  assert.throws(() => smCancel.startNewSession('session-2'), /Cannot start new session in state CANCELLED/);
});
