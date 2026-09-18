import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { DshAdapter } from '../../packages/adapters/dsh/src/dsh-adapter.ts';
import { DshHandshakeCoordinator } from '../../packages/adapters/dsh/src/handshake.ts';
import { WorkspaceLeaseManager } from '../../packages/controller/src/handoff/lease.ts';
import { HandoffStateMachine } from '../../packages/controller/src/handoff/state-machine.ts';
import type { HandoffPackManifest, HandoffAckPacket } from '../../packages/protocol/src/types.ts';

const MOCK_SERVER_PATH = fileURLToPath(new URL('../fixtures/mock-dsh-sdk-server.mjs', import.meta.url));

test('dsh-handshake: prepares read-only prompt, verifies 3D hashes, and increments CAS lease epoch', async () => {
  const adapter = new DshAdapter({
    runnerOptions: {
      binPath: process.execPath,
      extraArgsPrefix: [MOCK_SERVER_PATH],
      startupGracePeriodMs: 50
    }
  });

  try {
    const leaseManager = new WorkspaceLeaseManager();
    const workspaceKey = 'ws-dsh-test-1';
    leaseManager.acquireInitialLease(workspaceKey, 'source-dsh-session', 1);

    const sm = new HandoffStateMachine('run-dsh-1', 'source-dsh-session', 1);
    sm.requestHandoff('unit_completed');
    sm.checkpointCompleted('ckpt-dsh-1');

    const coordinator = new DshHandshakeCoordinator({
      adapter,
      leaseManager,
      stateMachine: sm,
      workspaceKey
    });

    const manifest: HandoffPackManifest = {
      handoffId: 'h-dsh-1',
      runId: 'run-dsh-1',
      epoch: 1,
      sourceSessionId: 'source-dsh-session',
      targetModel: { provider: 'deepseek-official', model: 'deepseek-chat', effort: 'high' },
      inputLedgerHeadHash: 'hash-input-999',
      requirementVersion: 1,
      taskSnapshotHash: 'hash-task-888',
      workspaceFingerprint: {
        commitHash: 'commit-dsh-1',
        dirtyFiles: [],
        untrackedFiles: [],
        treeHash: 'hash-tree-777'
      },
      timestamp: Date.now()
    };

    const prepPrompt = coordinator.buildPreparationPrompt(manifest);
    assert.ok(prepPrompt.includes('PREPARATION_MODE: READ_ONLY'));
    assert.ok(prepPrompt.includes('HANDOFF_ID: h-dsh-1'));
    assert.ok(prepPrompt.includes('INPUT_HEAD_HASH: hash-input-999'));
    assert.ok(prepPrompt.includes('TASK_SNAPSHOT_HASH: hash-task-888'));
    assert.ok(prepPrompt.includes('WORKSPACE_TREE_HASH: hash-tree-777'));

    coordinator.startNewSession('target-dsh-session');
    assert.strictEqual(sm.getState(), 'PREPARING');

    await adapter.createFresh({
      sessionId: 'target-dsh-session',
      runId: 'run-dsh-1',
      readOnly: true,
      model: manifest.targetModel,
      initialPrompt: prepPrompt
    });

    const quiescence = await adapter.awaitQuiescence('target-dsh-session', 3000);
    assert.strictEqual(quiescence, 'quiescent');

    const output = adapter.getSessionOutput('target-dsh-session');
    assert.ok(output.includes('HANDOFF_ACK_START'));

    const ack = coordinator.parseAckFromOutput(output);
    assert.ok(ack);
    assert.strictEqual(ack?.handoffId, 'h-dsh-1');
    assert.strictEqual(ack?.verifiedInputHeadHash, 'hash-input-999');
    assert.strictEqual(ack?.verifiedTaskSnapshotHash, 'hash-task-888');
    assert.strictEqual(ack?.verifiedWorkspaceHash, 'hash-tree-777');
    assert.strictEqual(ack?.effectiveModel?.provider, 'deepseek-official');
    assert.strictEqual(ack?.effectiveModel?.model, 'deepseek-chat');

    const authResult = coordinator.verifyAckAndAuthorize(manifest, ack!);
    assert.strictEqual(authResult.success, true);
    assert.strictEqual(authResult.epoch, 2);
    assert.ok(authResult.executionToken?.startsWith('EXEC_TOKEN_'));

    const updatedLease = leaseManager.getLease(workspaceKey);
    assert.strictEqual(updatedLease?.currentOwner, 'target-dsh-session');
    assert.strictEqual(updatedLease?.epoch, 2);
    assert.strictEqual(sm.getState(), 'RUNNING');
  } finally {
    await adapter.shutdown();
  }
});

test('dsh-handshake: rejects ACK on hash mismatch or model mismatch without mutating lease', () => {
  const adapter = new DshAdapter();
  const leaseManager = new WorkspaceLeaseManager();
  const workspaceKey = 'ws-dsh-test-2';
  leaseManager.acquireInitialLease(workspaceKey, 'source-dsh-session', 1);

  const sm = new HandoffStateMachine('run-dsh-1', 'source-dsh-session', 1);
  sm.requestHandoff('unit_completed');
  sm.checkpointCompleted();

  const coordinator = new DshHandshakeCoordinator({
    adapter,
    leaseManager,
    stateMachine: sm,
    workspaceKey
  });
  coordinator.startNewSession('target-dsh-session');

  const manifest: HandoffPackManifest = {
    handoffId: 'h-dsh-1',
    runId: 'run-dsh-1',
    epoch: 1,
    sourceSessionId: 'source-dsh-session',
    targetModel: { provider: 'deepseek-official', model: 'deepseek-chat' },
    inputLedgerHeadHash: 'hash-input-correct',
    requirementVersion: 1,
    taskSnapshotHash: 'hash-task-correct',
    workspaceFingerprint: { commitHash: 'c1', dirtyFiles: [], untrackedFiles: [], treeHash: 'hash-ws-correct' },
    timestamp: Date.now()
  };

  // Bad input hash
  const badInputAck: HandoffAckPacket = {
    handoffId: 'h-dsh-1',
    runId: 'run-dsh-1',
    newSessionId: 'target-dsh-session',
    effectiveModel: { provider: 'deepseek-official', model: 'deepseek-chat' },
    verifiedInputHeadHash: 'TAMPERED_INPUT_HASH',
    verifiedTaskSnapshotHash: 'hash-task-correct',
    verifiedWorkspaceHash: 'hash-ws-correct',
    ackTimestamp: Date.now()
  };
  const res1 = coordinator.verifyAckAndAuthorize(manifest, badInputAck);
  assert.strictEqual(res1.success, false);
  assert.match(res1.error || '', /Input ledger head hash mismatch/);
  assert.strictEqual(sm.getState(), 'PREPARING');
  assert.strictEqual(leaseManager.getLease(workspaceKey)?.currentOwner, 'source-dsh-session');
  assert.strictEqual(leaseManager.getLease(workspaceKey)?.epoch, 1);

  // Bad task snapshot hash
  const badTaskAck: HandoffAckPacket = {
    handoffId: 'h-dsh-1',
    runId: 'run-dsh-1',
    newSessionId: 'target-dsh-session',
    effectiveModel: { provider: 'deepseek-official', model: 'deepseek-chat' },
    verifiedInputHeadHash: 'hash-input-correct',
    verifiedTaskSnapshotHash: 'TAMPERED_TASK_HASH',
    verifiedWorkspaceHash: 'hash-ws-correct',
    ackTimestamp: Date.now()
  };
  const res2 = coordinator.verifyAckAndAuthorize(manifest, badTaskAck);
  assert.strictEqual(res2.success, false);
  assert.match(res2.error || '', /Task snapshot hash mismatch/);

  // Bad workspace tree hash
  const badWsAck: HandoffAckPacket = {
    handoffId: 'h-dsh-1',
    runId: 'run-dsh-1',
    newSessionId: 'target-dsh-session',
    effectiveModel: { provider: 'deepseek-official', model: 'deepseek-chat' },
    verifiedInputHeadHash: 'hash-input-correct',
    verifiedTaskSnapshotHash: 'hash-task-correct',
    verifiedWorkspaceHash: 'TAMPERED_WS_HASH',
    ackTimestamp: Date.now()
  };
  const res3 = coordinator.verifyAckAndAuthorize(manifest, badWsAck);
  assert.strictEqual(res3.success, false);
  assert.match(res3.error || '', /Workspace hash mismatch/);

  // Bad model
  const badModelAck: HandoffAckPacket = {
    handoffId: 'h-dsh-1',
    runId: 'run-dsh-1',
    newSessionId: 'target-dsh-session',
    effectiveModel: { provider: 'deepseek-official', model: 'deepseek-reasoner' },
    verifiedInputHeadHash: 'hash-input-correct',
    verifiedTaskSnapshotHash: 'hash-task-correct',
    verifiedWorkspaceHash: 'hash-ws-correct',
    ackTimestamp: Date.now()
  };
  const res4 = coordinator.verifyAckAndAuthorize(manifest, badModelAck);
  assert.strictEqual(res4.success, false);
  assert.match(res4.error || '', /Model mismatch/);

  // Bad handoff ID
  const badHandoffIdAck: HandoffAckPacket = {
    handoffId: 'WRONG_HANDOFF_ID',
    runId: 'run-dsh-1',
    newSessionId: 'target-dsh-session',
    effectiveModel: { provider: 'deepseek-official', model: 'deepseek-chat' },
    verifiedInputHeadHash: 'hash-input-correct',
    verifiedTaskSnapshotHash: 'hash-task-correct',
    verifiedWorkspaceHash: 'hash-ws-correct',
    ackTimestamp: Date.now()
  };
  const res5 = coordinator.verifyAckAndAuthorize(manifest, badHandoffIdAck);
  assert.strictEqual(res5.success, false);
  assert.match(res5.error || '', /Handoff ID mismatch/);

  // Lease remains completely unmodified through all rejections
  const lease = leaseManager.getLease(workspaceKey);
  assert.strictEqual(lease?.currentOwner, 'source-dsh-session');
  assert.strictEqual(lease?.epoch, 1);
});

test('dsh-handshake: rejects when lease is missing, owner mismatch, or state machine not in PREPARING (lease untouched)', () => {
  const adapter = new DshAdapter();
  const leaseManager = new WorkspaceLeaseManager();
  const workspaceKey = 'ws-dsh-test-3';
  leaseManager.acquireInitialLease(workspaceKey, 'source-dsh-session', 1);

  // State machine in RUNNING (not PREPARING)
  const sm = new HandoffStateMachine('run-dsh-1', 'source-dsh-session', 1);

  const coordinator = new DshHandshakeCoordinator({
    adapter,
    leaseManager,
    stateMachine: sm,
    workspaceKey
  });

  const manifest: HandoffPackManifest = {
    handoffId: 'h-dsh-1',
    runId: 'run-dsh-1',
    epoch: 1,
    sourceSessionId: 'source-dsh-session',
    targetModel: { provider: 'deepseek-official', model: 'deepseek-chat' },
    inputLedgerHeadHash: 'hash-input-correct',
    requirementVersion: 1,
    taskSnapshotHash: 'hash-task-correct',
    workspaceFingerprint: { commitHash: 'c1', dirtyFiles: [], untrackedFiles: [], treeHash: 'hash-ws-correct' },
    timestamp: Date.now()
  };

  const ack: HandoffAckPacket = {
    handoffId: 'h-dsh-1',
    runId: 'run-dsh-1',
    newSessionId: 'target-dsh-session',
    effectiveModel: { provider: 'deepseek-official', model: 'deepseek-chat' },
    verifiedInputHeadHash: 'hash-input-correct',
    verifiedTaskSnapshotHash: 'hash-task-correct',
    verifiedWorkspaceHash: 'hash-ws-correct',
    ackTimestamp: Date.now()
  };

  // State machine in RUNNING
  const res = coordinator.verifyAckAndAuthorize(manifest, ack);
  assert.strictEqual(res.success, false);
  assert.match(res.error || '', /Cannot receive ACK in state RUNNING/);
  assert.strictEqual(leaseManager.getLease(workspaceKey)?.currentOwner, 'source-dsh-session');
  assert.strictEqual(leaseManager.getLease(workspaceKey)?.epoch, 1);
});

test('dsh-handshake: state machine error during receiveAck triggers monotonic CAS lease rollback (newEpoch + 1)', () => {
  const adapter = new DshAdapter();
  const leaseManager = new WorkspaceLeaseManager();
  const workspaceKey = 'ws-dsh-test-4';
  leaseManager.acquireInitialLease(workspaceKey, 'source-dsh-session', 1);

  const sm = new HandoffStateMachine('run-dsh-1', 'source-dsh-session', 1);
  sm.requestHandoff('unit_completed');
  sm.checkpointCompleted();

  const coordinator = new DshHandshakeCoordinator({
    adapter,
    leaseManager,
    stateMachine: sm,
    workspaceKey
  });
  coordinator.startNewSession('target-dsh-session');
  assert.strictEqual(sm.getState(), 'PREPARING');

  const manifest: HandoffPackManifest = {
    handoffId: 'h-dsh-1',
    runId: 'run-dsh-1',
    epoch: 1,
    sourceSessionId: 'source-dsh-session',
    targetModel: { provider: 'deepseek-official', model: 'deepseek-chat' },
    inputLedgerHeadHash: 'hash-input-correct',
    requirementVersion: 1,
    taskSnapshotHash: 'hash-task-correct',
    workspaceFingerprint: { commitHash: 'c1', dirtyFiles: [], untrackedFiles: [], treeHash: 'hash-ws-correct' },
    timestamp: Date.now()
  };

  // ACK with mismatched runId causes sm.receiveAck() to throw after CAS lease acquisition
  const badRunAck: HandoffAckPacket = {
    handoffId: 'h-dsh-1',
    runId: 'run-MISMATCHED',
    newSessionId: 'target-dsh-session',
    effectiveModel: { provider: 'deepseek-official', model: 'deepseek-chat' },
    verifiedInputHeadHash: 'hash-input-correct',
    verifiedTaskSnapshotHash: 'hash-task-correct',
    verifiedWorkspaceHash: 'hash-ws-correct',
    ackTimestamp: Date.now()
  };

  const res = coordinator.verifyAckAndAuthorize(manifest, badRunAck);
  assert.strictEqual(res.success, false);
  assert.match(res.error || '', /Run ID mismatch/);

  // Verify monotonic rollback: owner reverts to sourceSessionId, epoch becomes newEpoch + 1 = 3
  const lease = leaseManager.getLease(workspaceKey);
  assert.strictEqual(lease?.currentOwner, 'source-dsh-session');
  assert.strictEqual(lease?.epoch, 3);
});

test('dsh-handshake: parseAckFromOutput parses HANDOFF_ACK markers and markdown code blocks', () => {
  const adapter = new DshAdapter();
  const leaseManager = new WorkspaceLeaseManager();
  const sm = new HandoffStateMachine('run-dsh-1', 'source-dsh', 1);
  const coordinator = new DshHandshakeCoordinator({
    adapter,
    leaseManager,
    stateMachine: sm,
    workspaceKey: 'ws-test'
  });

  const sampleAck: HandoffAckPacket = {
    handoffId: 'h-dsh-extract',
    runId: 'run-dsh-1',
    newSessionId: 'target-dsh-session',
    effectiveModel: { provider: 'deepseek-official', model: 'deepseek-chat' },
    verifiedInputHeadHash: 'hash-in',
    verifiedTaskSnapshotHash: 'hash-task',
    verifiedWorkspaceHash: 'hash-ws',
    ackTimestamp: 1700000000000
  };

  // Case 1: Markers with newline
  const markerOutput = `Some text\nHANDOFF_ACK_START\n${JSON.stringify(sampleAck, null, 2)}\nHANDOFF_ACK_END\nMore text`;
  assert.deepStrictEqual(coordinator.parseAckFromOutput(markerOutput), sampleAck);

  // Case 2: Markdown code block
  const mdOutput = `Checking workspace...\n\`\`\`json\n${JSON.stringify(sampleAck, null, 2)}\n\`\`\``;
  assert.deepStrictEqual(coordinator.parseAckFromOutput(mdOutput), sampleAck);

  // Case 3: Prompt echo containing instructions followed by real ACK
  const echoAndAck = `
INSTRUCTION: reply strictly with HANDOFF_ACK_START and HANDOFF_ACK_END block.
HANDOFF_ACK_START
${JSON.stringify(sampleAck)}
HANDOFF_ACK_END
`;
  assert.deepStrictEqual(coordinator.parseAckFromOutput(echoAndAck), sampleAck);

  // Case 4: No ACK
  assert.strictEqual(coordinator.parseAckFromOutput('Nothing here'), null);

  // Case 5: Malformed JSON between markers
  assert.strictEqual(coordinator.parseAckFromOutput('HANDOFF_ACK_START\n{ bad json }\nHANDOFF_ACK_END'), null);
});
