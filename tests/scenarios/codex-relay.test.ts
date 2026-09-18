// tests/scenarios/codex-relay.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { CodexAdapter } from '../../packages/adapters/codex/src/codex-adapter.ts';
import { CodexProcessRunner } from '../../packages/adapters/codex/src/runner.ts';
import { CodexHandshakeCoordinator } from '../../packages/adapters/codex/src/handshake.ts';
import { WorkspaceLeaseManager } from '../../packages/controller/src/handoff/lease.ts';
import { HandoffStateMachine } from '../../packages/controller/src/handoff/state-machine.ts';
import { InputLedger } from '../../packages/controller/src/inputs/ledger.ts';
import { TaskGraph } from '../../packages/controller/src/tasks/graph.ts';
import { WorkspaceSentinel } from '../../packages/controller/src/workspace/sentinel.ts';
import { HandoffPackager } from '../../packages/controller/src/workspace/checkpoint.ts';

const MOCK_SERVER_PATH = fileURLToPath(new URL('../fixtures/mock-codex-app-server.mjs', import.meta.url));

test('scenarios: S01~S03 - 3-round automated Codex relay with model preservation and CAS lease', async () => {
  const runner = new CodexProcessRunner({
    binPath: process.execPath,
    extraArgsPrefix: [MOCK_SERVER_PATH]
  });
  const adapter = new CodexAdapter({ runner });
  const lease = new WorkspaceLeaseManager();
  const sentinel = new WorkspaceSentinel(process.cwd());
  const packager = new HandoffPackager();
  const ledger = new InputLedger();
  ledger.appendUserMessage('Build high-throughput Codex pipeline');

  const graph = new TaskGraph();
  graph.addTask({ taskId: 'c-t1', requirementId: 'req-1', title: 'Unit 1: Ingest' });
  graph.addTask({ taskId: 'c-t2', requirementId: 'req-1', title: 'Unit 2: Process' });
  graph.addTask({ taskId: 'c-t3', requirementId: 'req-1', title: 'Unit 3: Emit' });

  const runId = 'codex-relay-run-001';
  const workspaceKey = 'ws-codex-repo';
  const targetModel = { provider: 'openai', model: 'gpt-5.6-luna', effort: 'xhigh' };

  // ─── ROUND 1: Thread A ───
  const threadA_Id = 'thread-codex-A';
  lease.acquireInitialLease(workspaceKey, threadA_Id, 1);
  const sm = new HandoffStateMachine(runId, threadA_Id, 1);

  await adapter.createFresh({
    sessionId: threadA_Id,
    runId,
    model: targetModel,
    initialPrompt: 'Execute Unit 1: Ingest'
  });

  await adapter.awaitQuiescence(threadA_Id, 1000);
  graph.completeTaskWithEvidence('c-t1', 'hash-evidence-c1');
  sm.requestHandoff('unit_completed');
  const fp1 = await sentinel.captureFingerprint();
  const manifest1 = packager.createManifest({
    handoffId: 'h-codex-1',
    runId,
    epoch: 1,
    sourceSessionId: threadA_Id,
    targetModel,
    inputLedgerHeadHash: ledger.getHeadHash(),
    requirementVersion: 1,
    taskSnapshotHash: graph.computeSnapshotHash(),
    workspaceFingerprint: fp1
  });
  sm.checkpointCompleted(manifest1.handoffId);

  // ─── ROUND 2: Thread B (Fresh spawn) ───
  const threadB_Id = 'thread-codex-B';
  const coord1 = new CodexHandshakeCoordinator(sm, lease, workspaceKey);
  coord1.startNewSession(threadB_Id);

  const threadB_Inspect = await adapter.createFresh({
    sessionId: threadB_Id,
    runId,
    model: targetModel,
    readOnly: true,
    initialPrompt: coord1.generatePreparationPrompt(manifest1)
  });

  // Verify R5: Model and reasoning effort are strictly preserved
  assert.strictEqual(threadB_Inspect.effectiveModel?.model, 'gpt-5.6-luna');
  assert.strictEqual(threadB_Inspect.effectiveModel?.provider, 'openai');
  assert.strictEqual(threadB_Inspect.effectiveModel?.effort, 'xhigh');

  // Verify distinct session IDs
  assert.notStrictEqual(threadA_Id, threadB_Id);

  await adapter.awaitQuiescence(threadB_Id, 1000);
  const threadB_Output = adapter.getSessionOutput(threadB_Id);
  const extractedAck1 = coord1.extractAckFromText(threadB_Output);
  assert.ok(extractedAck1);

  // Authorize execution
  const auth1 = coord1.verifyAckAndAuthorize(manifest1, extractedAck1);
  assert.strictEqual(auth1.success, true);
  assert.strictEqual(lease.getLease(workspaceKey)?.currentOwner, threadB_Id);
  assert.strictEqual(lease.getLease(workspaceKey)?.epoch, 2);

  // Stale Thread A tries to write with old epoch -> REJECTED by CAS (R10)
  assert.strictEqual(lease.compareAndSetOwner(workspaceKey, threadA_Id, 'thread-C', 1, 3), false);

  await adapter.authorizeExecution(threadB_Id, auth1.epoch!, auth1.executionToken!);
  await adapter.awaitQuiescence(threadB_Id, 1000);

  graph.completeTaskWithEvidence('c-t2', 'hash-evidence-c2');
  sm.requestHandoff('unit_completed');
  const fp2 = await sentinel.captureFingerprint();
  const manifest2 = packager.createManifest({
    handoffId: 'h-codex-2',
    runId,
    epoch: 2,
    sourceSessionId: threadB_Id,
    targetModel,
    inputLedgerHeadHash: ledger.getHeadHash(),
    requirementVersion: 1,
    taskSnapshotHash: graph.computeSnapshotHash(),
    workspaceFingerprint: fp2
  });
  sm.checkpointCompleted(manifest2.handoffId);

  // ─── ROUND 3: Thread C (Fresh spawn) ───
  const threadC_Id = 'thread-codex-C';
  const coord2 = new CodexHandshakeCoordinator(sm, lease, workspaceKey);
  coord2.startNewSession(threadC_Id);

  const threadC_Inspect = await adapter.createFresh({
    sessionId: threadC_Id,
    runId,
    model: targetModel,
    readOnly: true,
    initialPrompt: coord2.generatePreparationPrompt(manifest2)
  });

  assert.strictEqual(threadC_Inspect.effectiveModel?.model, 'gpt-5.6-luna');
  assert.notStrictEqual(threadB_Id, threadC_Id);

  await adapter.awaitQuiescence(threadC_Id, 1000);
  const threadC_Output = adapter.getSessionOutput(threadC_Id);
  const extractedAck2 = coord2.extractAckFromText(threadC_Output);
  assert.ok(extractedAck2);

  const auth2 = coord2.verifyAckAndAuthorize(manifest2, extractedAck2);
  assert.strictEqual(auth2.success, true);
  assert.strictEqual(lease.getLease(workspaceKey)?.currentOwner, threadC_Id);
  assert.strictEqual(lease.getLease(workspaceKey)?.epoch, 3);

  await adapter.authorizeExecution(threadC_Id, auth2.epoch!, auth2.executionToken!);
  await adapter.awaitQuiescence(threadC_Id, 1000);

  graph.completeTaskWithEvidence('c-t3', 'hash-evidence-c3');
  assert.strictEqual(graph.getTask('c-t1')?.status, 'completed');
  assert.strictEqual(graph.getTask('c-t2')?.status, 'completed');
  assert.strictEqual(graph.getTask('c-t3')?.status, 'completed');

  await adapter.shutdown();
});

test('scenarios: S04 - Quiescence detection and turn/interrupt cancellation handling (R6, R7)', async () => {
  const runner = new CodexProcessRunner({
    binPath: process.execPath,
    extraArgsPrefix: [MOCK_SERVER_PATH]
  });
  const adapter = new CodexAdapter({ runner });

  await adapter.createFresh({
    sessionId: 'thread-interrupt-test',
    runId: 'run-interrupt',
    model: { provider: 'openai', model: 'gpt-5.6-luna' }
  });

  // Start turn then immediately interrupt
  await adapter.submit('thread-interrupt-test', 'msg-int-1', 'long essay');
  const interrupted = await adapter.interruptOwned('thread-interrupt-test');
  assert.strictEqual(interrupted, true);

  const quiescence = await adapter.awaitQuiescence('thread-interrupt-test', 500);
  assert.strictEqual(quiescence, 'quiescent');

  const inspected = await adapter.inspectSession('thread-interrupt-test');
  assert.strictEqual(inspected?.active, false);

  await adapter.shutdown();
});

test('scenarios: S05 - User pause priority stops relay sequence immediately (R7)', () => {
  const lease = new WorkspaceLeaseManager();
  lease.acquireInitialLease('ws-pause-codex', 'thread-1', 1);
  const sm = new HandoffStateMachine('run-p-codex', 'thread-1', 1);

  // User pauses mid-execution
  sm.pause();
  assert.strictEqual(sm.getState(), 'PAUSED');

  // Any attempt to request handoff or start new session must be blocked
  assert.throws(() => sm.requestHandoff('unit_completed'), /Cannot request handoff in state PAUSED/);
  assert.throws(() => sm.startNewSession('thread-2'), /Cannot start new session in state PAUSED/);
});
