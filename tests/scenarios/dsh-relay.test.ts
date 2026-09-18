// tests/scenarios/dsh-relay.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { DshAdapter } from '../../packages/adapters/dsh/src/dsh-adapter.ts';
import { DshHandshakeCoordinator } from '../../packages/adapters/dsh/src/handshake.ts';
import { WorkspaceLeaseManager } from '../../packages/controller/src/handoff/lease.ts';
import { HandoffStateMachine } from '../../packages/controller/src/handoff/state-machine.ts';
import { InputLedger } from '../../packages/controller/src/inputs/ledger.ts';
import { TaskGraph } from '../../packages/controller/src/tasks/graph.ts';
import { WorkspaceSentinel } from '../../packages/controller/src/workspace/sentinel.ts';
import { HandoffPackager } from '../../packages/controller/src/workspace/checkpoint.ts';
import type { HandoffPackManifest, HandoffAckPacket } from '../../packages/protocol/src/types.ts';

const MOCK_SERVER_PATH = fileURLToPath(new URL('../fixtures/mock-dsh-sdk-server.mjs', import.meta.url));

test('scenarios: S01~S03 - 3-round automated DSH relay with model preservation and CAS lease', async () => {
  const adapter = new DshAdapter({
    runnerOptions: {
      binPath: process.execPath,
      extraArgsPrefix: [MOCK_SERVER_PATH],
      startupGracePeriodMs: 50
    }
  });

  try {
    const lease = new WorkspaceLeaseManager();
    const sentinel = new WorkspaceSentinel(process.cwd());
    const packager = new HandoffPackager();
    const ledger = new InputLedger();
    ledger.appendUserMessage('Build high-performance deep learning pipeline with DSH runtime');

    const graph = new TaskGraph();
    graph.addTask({ taskId: 'dsh-t1', requirementId: 'req-dsh-1', title: 'Unit 1: Data Ingestion & Tokenizer' });
    graph.addTask({ taskId: 'dsh-t2', requirementId: 'req-dsh-1', title: 'Unit 2: Transformer Encoder Layer' });
  graph.addTask({ taskId: 'dsh-t3', requirementId: 'req-dsh-1', title: 'Unit 3: Autoregressive Decoder & Loss' });

  const runId = 'dsh-relay-run-001';
  const workspaceKey = 'ws-dsh-repo';
  const targetModelA = { provider: 'deepseek-official', model: 'deepseek-chat', effort: 'high' };
  const targetModelC = { provider: 'deepseek-official', model: 'deepseek-reasoner', effort: 'high' };

  // ==========================================
  // ROUND 1: Worker A (Initial session)
  // ==========================================
  const workerA_Id = 'worker-dsh-A';
  const workerA_Secret = 'worker-A-scratchpad-secret-9812';
  lease.acquireInitialLease(workspaceKey, workerA_Id, 1);
  const sm = new HandoffStateMachine(runId, workerA_Id, 1);

  const workerA_Inspect = await adapter.createFresh({
    sessionId: workerA_Id,
    runId,
    model: targetModelA,
    initialPrompt: `echo: Worker A starting unit 1 with scratchpad ${workerA_Secret}`
  });

  // Verify S02: DeepSeek model and provider initialized properly
  assert.strictEqual(workerA_Inspect.effectiveModel?.provider, 'deepseek-official');
  assert.strictEqual(workerA_Inspect.effectiveModel?.model, 'deepseek-chat');
  assert.strictEqual(workerA_Inspect.effectiveModel?.effort, 'high');

  await adapter.awaitQuiescence(workerA_Id, 2000);
  const workerA_Output = adapter.getSessionOutput(workerA_Id);
  assert.ok(workerA_Output.includes('Worker A starting unit 1'));
  assert.ok(workerA_Output.includes(workerA_Secret));

  // Worker A finishes Unit 1 and provides evidence
  graph.completeTaskWithEvidence('dsh-t1', 'hash-evidence-dsh-1');
  sm.requestHandoff('unit_completed');
  const fp1 = await sentinel.captureFingerprint();
  const manifest1 = packager.createManifest({
    handoffId: 'h-dsh-1',
    runId,
    epoch: 1,
    sourceSessionId: workerA_Id,
    targetModel: targetModelA,
    inputLedgerHeadHash: ledger.getHeadHash(),
    requirementVersion: 1,
    taskSnapshotHash: graph.computeSnapshotHash(),
    workspaceFingerprint: fp1
  });
  sm.checkpointCompleted(manifest1.handoffId);

  // ==========================================
  // ROUND 2: Worker B (Worker A -> Worker B)
  // ==========================================
  const workerB_Id = 'worker-dsh-B';
  const workerB_Secret = 'worker-B-scratchpad-secret-5541';
  const coord1 = new DshHandshakeCoordinator({
    adapter,
    leaseManager: lease,
    stateMachine: sm,
    workspaceKey
  });
  coord1.startNewSession(workerB_Id);
  assert.strictEqual(sm.getState(), 'PREPARING');

  const prepPrompt1 = coord1.buildPreparationPrompt(manifest1);
  const workerB_Inspect = await adapter.createFresh({
    sessionId: workerB_Id,
    runId,
    model: targetModelA,
    readOnly: true,
    initialPrompt: prepPrompt1
  });

  // Verify S02: DeepSeek model and provider preserved in Round 2
  assert.strictEqual(workerB_Inspect.effectiveModel?.provider, 'deepseek-official');
  assert.strictEqual(workerB_Inspect.effectiveModel?.model, 'deepseek-chat');
  assert.strictEqual(workerB_Inspect.effectiveModel?.effort, 'high');

  // Verify S01: Worker B is distinct from Worker A with zero history leakage
  assert.notStrictEqual(workerA_Id, workerB_Id);
  const workerB_InitialOutput = adapter.getSessionOutput(workerB_Id);
  assert.strictEqual(
    workerB_InitialOutput.includes(workerA_Secret),
    false,
    'Worker B output must not leak Worker A private scratchpad secret'
  );
  assert.strictEqual(
    workerB_InitialOutput.includes('Worker A starting unit 1'),
    false,
    'Worker B output must not leak Worker A conversation messages'
  );

  await adapter.awaitQuiescence(workerB_Id, 2000);
  const workerB_AckOutput = adapter.getSessionOutput(workerB_Id);
  assert.ok(workerB_AckOutput.includes('HANDOFF_ACK_START'));

  const ack1 = coord1.parseAckFromOutput(workerB_AckOutput);
  assert.ok(ack1, 'Worker B must reply with valid HandoffAckPacket');
  assert.strictEqual(ack1?.handoffId, 'h-dsh-1');
  assert.strictEqual(ack1?.verifiedInputHeadHash, ledger.getHeadHash());
  assert.strictEqual(ack1?.verifiedTaskSnapshotHash, graph.computeSnapshotHash());
  assert.strictEqual(ack1?.verifiedWorkspaceHash, fp1.treeHash);
  assert.strictEqual(ack1?.effectiveModel?.provider, 'deepseek-official');
  assert.strictEqual(ack1?.effectiveModel?.model, 'deepseek-chat');

  // Authorize execution and verify CAS lease transfer
  const auth1 = coord1.verifyAckAndAuthorize(manifest1, ack1!);
  assert.strictEqual(auth1.success, true);
  assert.strictEqual(auth1.epoch, 2);
  assert.strictEqual(lease.getLease(workspaceKey)?.currentOwner, workerB_Id);
  assert.strictEqual(lease.getLease(workspaceKey)?.epoch, 2);
  assert.strictEqual(sm.getState(), 'RUNNING');

  // Verify S03: Stale Worker A write attempts are rejected by CAS
  assert.strictEqual(
    lease.compareAndSetOwner(workspaceKey, workerA_Id, 'worker-dsh-rogue', 1, 3),
    false,
    'Stale Worker A attempt with old epoch 1 must be rejected by CAS'
  );
  assert.strictEqual(
    lease.compareAndSetOwner(workspaceKey, workerA_Id, 'worker-dsh-rogue', 2, 3),
    false,
    'Stale Worker A attempt with wrong owner must be rejected by CAS'
  );

  // Authorize execution in adapter
  await adapter.authorizeExecution(workerB_Id, auth1.epoch!, auth1.executionToken!);
  await adapter.awaitQuiescence(workerB_Id, 2000);
  assert.ok(adapter.getSessionOutput(workerB_Id).includes('EXECUTION_AUTHORIZED'));

  // Worker B completes Unit 2
  await adapter.submit(workerB_Id, 'msg-b1', `echo: Worker B completed unit 2 with scratchpad ${workerB_Secret}`);
  await adapter.awaitQuiescence(workerB_Id, 2000);
  assert.ok(adapter.getSessionOutput(workerB_Id).includes(workerB_Secret));

  graph.completeTaskWithEvidence('dsh-t2', 'hash-evidence-dsh-2');
  sm.requestHandoff('unit_completed');
  const fp2 = await sentinel.captureFingerprint();
  const manifest2 = packager.createManifest({
    handoffId: 'h-dsh-2',
    runId,
    epoch: 2,
    sourceSessionId: workerB_Id,
    targetModel: targetModelC,
    inputLedgerHeadHash: ledger.getHeadHash(),
    requirementVersion: 1,
    taskSnapshotHash: graph.computeSnapshotHash(),
    workspaceFingerprint: fp2
  });
  sm.checkpointCompleted(manifest2.handoffId);

  // ==========================================
  // ROUND 3: Worker C (Worker B -> Worker C)
  // ==========================================
  const workerC_Id = 'worker-dsh-C';
  const workerC_Secret = 'worker-C-scratchpad-secret-1209';
  const coord2 = new DshHandshakeCoordinator({
    adapter,
    leaseManager: lease,
    stateMachine: sm,
    workspaceKey
  });
  coord2.startNewSession(workerC_Id);
  assert.strictEqual(sm.getState(), 'PREPARING');

  const prepPrompt2 = coord2.buildPreparationPrompt(manifest2);
  const workerC_Inspect = await adapter.createFresh({
    sessionId: workerC_Id,
    runId,
    model: targetModelC,
    readOnly: true,
    initialPrompt: prepPrompt2
  });

  // Verify S02: DeepSeek model and provider preserved for deepseek-reasoner in Round 3
  assert.strictEqual(workerC_Inspect.effectiveModel?.provider, 'deepseek-official');
  assert.strictEqual(workerC_Inspect.effectiveModel?.model, 'deepseek-reasoner');
  assert.strictEqual(workerC_Inspect.effectiveModel?.effort, 'high');

  // Verify S01: Worker C is distinct with zero history leakage from Worker A or Worker B
  assert.notStrictEqual(workerB_Id, workerC_Id);
  assert.notStrictEqual(workerA_Id, workerC_Id);
  const workerC_InitialOutput = adapter.getSessionOutput(workerC_Id);
  assert.strictEqual(
    workerC_InitialOutput.includes(workerA_Secret),
    false,
    'Worker C output must not leak Worker A private scratchpad secret'
  );
  assert.strictEqual(
    workerC_InitialOutput.includes(workerB_Secret),
    false,
    'Worker C output must not leak Worker B private scratchpad secret'
  );
  assert.strictEqual(
    workerC_InitialOutput.includes('Worker A starting unit 1'),
    false,
    'Worker C output must not leak Worker A messages'
  );
  assert.strictEqual(
    workerC_InitialOutput.includes('Worker B completed unit 2'),
    false,
    'Worker C output must not leak Worker B messages'
  );

  await adapter.awaitQuiescence(workerC_Id, 2000);
  const workerC_AckOutput = adapter.getSessionOutput(workerC_Id);
  assert.ok(workerC_AckOutput.includes('HANDOFF_ACK_START'));

  const ack2 = coord2.parseAckFromOutput(workerC_AckOutput);
  assert.ok(ack2, 'Worker C must reply with valid HandoffAckPacket');
  assert.strictEqual(ack2?.handoffId, 'h-dsh-2');
  assert.strictEqual(ack2?.verifiedInputHeadHash, ledger.getHeadHash());
  assert.strictEqual(ack2?.verifiedTaskSnapshotHash, graph.computeSnapshotHash());
  assert.strictEqual(ack2?.verifiedWorkspaceHash, fp2.treeHash);
  assert.strictEqual(ack2?.effectiveModel?.provider, 'deepseek-official');
  assert.strictEqual(ack2?.effectiveModel?.model, 'deepseek-reasoner');

  // Authorize execution and verify CAS lease transfer to Worker C
  const auth2 = coord2.verifyAckAndAuthorize(manifest2, ack2!);
  assert.strictEqual(auth2.success, true);
  assert.strictEqual(auth2.epoch, 3);
  assert.strictEqual(lease.getLease(workspaceKey)?.currentOwner, workerC_Id);
  assert.strictEqual(lease.getLease(workspaceKey)?.epoch, 3);
  assert.strictEqual(sm.getState(), 'RUNNING');

  // Verify S03: Stale Worker B and Worker A write attempts are rejected by CAS
  assert.strictEqual(
    lease.compareAndSetOwner(workspaceKey, workerB_Id, 'worker-dsh-rogue', 2, 4),
    false,
    'Stale Worker B attempt with old epoch 2 must be rejected by CAS'
  );
  assert.strictEqual(
    lease.compareAndSetOwner(workspaceKey, workerA_Id, 'worker-dsh-rogue', 1, 4),
    false,
    'Stale Worker A attempt with old epoch 1 must be rejected by CAS'
  );
  assert.strictEqual(
    lease.compareAndSetOwner(workspaceKey, 'worker-dsh-imposter', 'worker-dsh-rogue', 3, 4),
    false,
    'Imposter attempt with incorrect current owner must be rejected by CAS'
  );

  // Authorize execution in adapter
  await adapter.authorizeExecution(workerC_Id, auth2.epoch!, auth2.executionToken!);
  await adapter.awaitQuiescence(workerC_Id, 2000);
  assert.ok(adapter.getSessionOutput(workerC_Id).includes('EXECUTION_AUTHORIZED'));

  // Worker C completes Unit 3
  await adapter.submit(workerC_Id, 'msg-c1', `echo: Worker C completed unit 3 with scratchpad ${workerC_Secret}`);
  await adapter.awaitQuiescence(workerC_Id, 2000);
  assert.ok(adapter.getSessionOutput(workerC_Id).includes(workerC_Secret));
  graph.completeTaskWithEvidence('dsh-t3', 'hash-evidence-dsh-3');

  // Verify all 3 tasks completed cleanly across 3 distinct worker sessions
  assert.strictEqual(graph.getTask('dsh-t1')?.status, 'completed');
  assert.strictEqual(graph.getTask('dsh-t2')?.status, 'completed');
  assert.strictEqual(graph.getTask('dsh-t3')?.status, 'completed');

  // Verify final lease is owned by Worker C at epoch 3
  const finalLease = lease.getLease(workspaceKey);
    assert.strictEqual(finalLease?.currentOwner, workerC_Id);
    assert.strictEqual(finalLease?.epoch, 3);
  } finally {
    await adapter.shutdown();
  }
});

test('scenarios: S04 - Quiescence detection and dedicated worker shutdown / interruptOwned cancellation handling', async () => {
  const adapter = new DshAdapter({
    runnerOptions: {
      binPath: process.execPath,
      extraArgsPrefix: [MOCK_SERVER_PATH],
      startupGracePeriodMs: 50
    }
  });

  try {
    const worker1_Id = 'worker-dsh-s04-w1';
    const worker2_Id = 'worker-dsh-s04-w2';

    // 1. Create two separate sessions (dedicated workers)
    const w1_Inspect = await adapter.createFresh({
      sessionId: worker1_Id,
      runId: 'run-s04',
      model: { provider: 'deepseek-official', model: 'deepseek-chat' },
      initialPrompt: 'echo: Worker 1 online'
    });
    const w2_Inspect = await adapter.createFresh({
      sessionId: worker2_Id,
      runId: 'run-s04',
      model: { provider: 'deepseek-official', model: 'deepseek-reasoner' },
      initialPrompt: 'echo: Worker 2 online'
    });

    assert.strictEqual(w1_Inspect.active, true);
    assert.strictEqual(w2_Inspect.active, true);

    // 2. Quiescence detection
    const q1 = await adapter.awaitQuiescence(worker1_Id, 2000);
    const q2 = await adapter.awaitQuiescence(worker2_Id, 2000);
    assert.strictEqual(q1, 'quiescent');
    assert.strictEqual(q2, 'quiescent');
    assert.ok(adapter.getSessionOutput(worker1_Id).includes('Worker 1 online'));
    assert.ok(adapter.getSessionOutput(worker2_Id).includes('Worker 2 online'));

    // 3. Interrupt Worker 1 only
    const interrupted1 = await adapter.interruptOwned(worker1_Id);
    assert.strictEqual(interrupted1, true);

    const w1_After = adapter.inspectSession(worker1_Id);
    assert.strictEqual(w1_After?.active, false);
    assert.strictEqual(typeof w1_After?.exitCode, 'number');

    // 4. Dedicated worker isolation: Worker 2 remains active, unaffected by Worker 1 termination
    const w2_After = adapter.inspectSession(worker2_Id);
    assert.strictEqual(w2_After?.active, true);

    await adapter.submit(worker2_Id, 'msg-w2-cont', 'echo: Worker 2 still operational');
    const q2_cont = await adapter.awaitQuiescence(worker2_Id, 2000);
    assert.strictEqual(q2_cont, 'quiescent');
    assert.ok(adapter.getSessionOutput(worker2_Id).includes('Worker 2 still operational'));

    // 5. Submitting to interrupted Worker 1 fails immediately
    await assert.rejects(
      async () => {
        await adapter.submit(worker1_Id, 'msg-fail', 'Should be rejected');
      },
      {
        message: /Cannot submit to inactive session worker-dsh-s04-w1/
      }
    );

    // 6. Calling interrupt on nonexistent session returns false
    const interruptedNonexistent = await adapter.interruptOwned('nonexistent-worker');
    assert.strictEqual(interruptedNonexistent, false);

    // 7. Awaiting quiescence on inactive session returns quiescent immediately
    const qInactive = await adapter.awaitQuiescence(worker1_Id, 500);
    assert.strictEqual(qInactive, 'quiescent');

    // 8. Interrupt Worker 2
    const interrupted2 = await adapter.interruptOwned(worker2_Id);
    assert.strictEqual(interrupted2, true);
    assert.strictEqual(adapter.inspectSession(worker2_Id)?.active, false);
  } finally {
    // 9. Clean adapter shutdown
    await adapter.shutdown();
  }
});

test('scenarios: S05 - User pause/cancellation priority stopping handoff sequence immediately', () => {
  const leaseManager = new WorkspaceLeaseManager();
  const workspaceKey = 'ws-dsh-pause-cancel';
  const worker1_Id = 'worker-dsh-ctl-1';
  const worker2_Id = 'worker-dsh-ctl-2';

  leaseManager.acquireInitialLease(workspaceKey, worker1_Id, 1);
  const sm = new HandoffStateMachine('run-ctl-001', worker1_Id, 1);

  // -------------------------------------------------------------
  // Part A: User Pause Priority
  // -------------------------------------------------------------
  // User pauses mid-execution
  sm.pause();
  assert.strictEqual(sm.getState(), 'PAUSED');

  // Attempting to request handoff while PAUSED is blocked
  assert.throws(
    () => sm.requestHandoff('unit_completed'),
    /Cannot request handoff in state PAUSED/
  );

  // Attempting to start a new session while PAUSED is blocked
  assert.throws(
    () => sm.startNewSession(worker2_Id),
    /Cannot start new session in state PAUSED/
  );

  // -------------------------------------------------------------
  // Part B: User Cancellation Priority during handoff sequence
  // -------------------------------------------------------------
  const cancelWorkspaceKey = 'ws-dsh-cancel-test';
  const cancelWorkerA = 'worker-cancel-A';
  const cancelWorkerB = 'worker-cancel-B';
  leaseManager.acquireInitialLease(cancelWorkspaceKey, cancelWorkerA, 1);

  const smCancel = new HandoffStateMachine('run-cancel-002', cancelWorkerA, 1);
  smCancel.requestHandoff('unit_completed');
  smCancel.checkpointCompleted('h-cancel-ckpt-1');
  smCancel.startNewSession(cancelWorkerB);
  assert.strictEqual(smCancel.getState(), 'PREPARING');

  const coordinator = new DshHandshakeCoordinator({
    leaseManager,
    stateMachine: smCancel,
    workspaceKey: cancelWorkspaceKey
  });

  const manifest: HandoffPackManifest = {
    handoffId: 'h-cancel-1',
    runId: 'run-cancel-002',
    epoch: 1,
    sourceSessionId: cancelWorkerA,
    targetModel: { provider: 'deepseek-official', model: 'deepseek-chat' },
    inputLedgerHeadHash: 'hash-input-valid',
    requirementVersion: 1,
    taskSnapshotHash: 'hash-task-valid',
    workspaceFingerprint: { commitHash: 'c1', dirtyFiles: [], untrackedFiles: [], treeHash: 'hash-tree-valid' },
    timestamp: Date.now()
  };

  const validAck: HandoffAckPacket = {
    handoffId: 'h-cancel-1',
    runId: 'run-cancel-002',
    newSessionId: cancelWorkerB,
    effectiveModel: { provider: 'deepseek-official', model: 'deepseek-chat' },
    verifiedInputHeadHash: 'hash-input-valid',
    verifiedTaskSnapshotHash: 'hash-task-valid',
    verifiedWorkspaceHash: 'hash-tree-valid',
    ackTimestamp: Date.now()
  };

  // User hits cancel mid-preparation
  smCancel.cancel();
  assert.strictEqual(smCancel.getState(), 'CANCELLED');

  // State machine directly rejects receiveAck and issueExecutionToken
  assert.throws(
    () => smCancel.receiveAck(validAck),
    /Cannot receive ACK in state CANCELLED/
  );
  assert.throws(
    () => smCancel.issueExecutionToken(),
    /Cannot issue execution token in state CANCELLED/
  );

  // Handshake coordinator verifyAckAndAuthorize must fail immediately
  const authResult = coordinator.verifyAckAndAuthorize(manifest, validAck);
  assert.strictEqual(authResult.success, false);
  assert.match(authResult.error || '', /Cannot receive ACK in state CANCELLED/);

  // Verify single-writer lease remains untouched at original owner and epoch 1
  const preservedLease = leaseManager.getLease(cancelWorkspaceKey);
  assert.strictEqual(preservedLease?.currentOwner, cancelWorkerA);
  assert.strictEqual(preservedLease?.epoch, 1);
});
