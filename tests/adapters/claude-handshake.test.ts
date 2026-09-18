// tests/adapters/claude-handshake.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { TwoPhaseHandshakeCoordinator } from '../../packages/adapters/claude/src/handshake.ts';
import { HandoffStateMachine } from '../../packages/controller/src/handoff/state-machine.ts';
import { WorkspaceLeaseManager } from '../../packages/controller/src/handoff/lease.ts';
import type { HandoffPackManifest, HandoffAckPacket } from '../../packages/protocol/src/types.ts';

test('handshake: prepares read-only prompt and completes two-phase ACK with CAS lease', () => {
  const lease = new WorkspaceLeaseManager();
  lease.acquireInitialLease('ws-1', 'session-A', 1);

  const sm = new HandoffStateMachine('run-1', 'session-A', 1);
  sm.requestHandoff('unit_completed');
  sm.checkpointCompleted('ckpt-hash-1');

  const coordinator = new TwoPhaseHandshakeCoordinator(sm, lease, 'ws-1');

  const manifest: HandoffPackManifest = {
    handoffId: 'h-1',
    runId: 'run-1',
    epoch: 1,
    sourceSessionId: 'session-A',
    targetModel: { provider: 'anthropic', model: 'claude-3-7-sonnet' },
    inputLedgerHeadHash: 'input-hash-1',
    requirementVersion: 1,
    taskSnapshotHash: 'task-hash-1',
    workspaceFingerprint: {
      commitHash: 'commit-1',
      dirtyFiles: [],
      untrackedFiles: [],
      treeHash: 'ws-tree-hash-1'
    },
    timestamp: Date.now()
  };

  // 1. Generate preparation prompt
  const prepPrompt = coordinator.generatePreparationPrompt(manifest);
  assert.ok(prepPrompt.includes('READ-ONLY PREPARATION MODE'));
  assert.ok(prepPrompt.includes('"handoffId": "h-1"'));

  // 2. Start new session in state machine
  coordinator.startNewSession('session-B');
  assert.strictEqual(sm.getState(), 'PREPARING');

  // 3. Formulate and verify ACK packet
  const ack: HandoffAckPacket = {
    handoffId: 'h-1',
    runId: 'run-1',
    newSessionId: 'session-B',
    effectiveModel: { provider: 'anthropic', model: 'claude-3-7-sonnet' },
    verifiedInputHeadHash: 'input-hash-1',
    verifiedTaskSnapshotHash: 'task-hash-1',
    verifiedWorkspaceHash: 'ws-tree-hash-1',
    ackTimestamp: Date.now()
  };

  const authorized = coordinator.verifyAckAndAuthorize(manifest, ack);
  assert.strictEqual(authorized.success, true);
  assert.ok(authorized.executionToken?.startsWith('EXEC_TOKEN_'));
  assert.strictEqual(authorized.epoch, 2);

  // Verify lease transferred atomically to session-B with epoch 2
  assert.strictEqual(lease.getLease('ws-1')?.currentOwner, 'session-B');
  assert.strictEqual(lease.getLease('ws-1')?.epoch, 2);
  assert.strictEqual(sm.getState(), 'RUNNING');
});

test('handshake: rejects ACK with mismatched manifest hashes', () => {
  const lease = new WorkspaceLeaseManager();
  lease.acquireInitialLease('ws-1', 'session-A', 1);

  const sm = new HandoffStateMachine('run-1', 'session-A', 1);
  sm.requestHandoff('unit_completed');
  sm.checkpointCompleted();

  const coordinator = new TwoPhaseHandshakeCoordinator(sm, lease, 'ws-1');
  coordinator.startNewSession('session-B');

  const manifest: HandoffPackManifest = {
    handoffId: 'h-1',
    runId: 'run-1',
    epoch: 1,
    sourceSessionId: 'session-A',
    targetModel: { provider: 'anthropic', model: 'claude-3-7-sonnet' },
    inputLedgerHeadHash: 'input-hash-1',
    requirementVersion: 1,
    taskSnapshotHash: 'task-hash-1',
    workspaceFingerprint: { commitHash: 'c1', dirtyFiles: [], untrackedFiles: [], treeHash: 'valid-ws-hash' },
    timestamp: Date.now()
  };

  // Mismatched input ledger head hash
  const badInputAck: HandoffAckPacket = {
    handoffId: 'h-1',
    runId: 'run-1',
    newSessionId: 'session-B',
    effectiveModel: { provider: 'anthropic', model: 'claude-3-7-sonnet' },
    verifiedInputHeadHash: 'TAMPERED_HASH',
    verifiedTaskSnapshotHash: 'task-hash-1',
    verifiedWorkspaceHash: 'valid-ws-hash',
    ackTimestamp: Date.now()
  };

  const res1 = coordinator.verifyAckAndAuthorize(manifest, badInputAck);
  assert.strictEqual(res1.success, false);
  assert.match(res1.error || '', /Input ledger head hash mismatch/);
  assert.strictEqual(sm.getState(), 'PREPARING'); // Did not advance

  // Mismatched task snapshot hash
  const badTaskAck: HandoffAckPacket = {
    handoffId: 'h-1',
    runId: 'run-1',
    newSessionId: 'session-B',
    effectiveModel: { provider: 'anthropic', model: 'claude-3-7-sonnet' },
    verifiedInputHeadHash: 'input-hash-1',
    verifiedTaskSnapshotHash: 'TAMPERED_TASK',
    verifiedWorkspaceHash: 'valid-ws-hash',
    ackTimestamp: Date.now()
  };

  const res2 = coordinator.verifyAckAndAuthorize(manifest, badTaskAck);
  assert.strictEqual(res2.success, false);
  assert.match(res2.error || '', /Task snapshot hash mismatch/);
  assert.strictEqual(sm.getState(), 'PREPARING');

  // Mismatched workspace hash
  const badWsAck: HandoffAckPacket = {
    handoffId: 'h-1',
    runId: 'run-1',
    newSessionId: 'session-B',
    effectiveModel: { provider: 'anthropic', model: 'claude-3-7-sonnet' },
    verifiedInputHeadHash: 'input-hash-1',
    verifiedTaskSnapshotHash: 'task-hash-1',
    verifiedWorkspaceHash: 'TAMPERED_WS',
    ackTimestamp: Date.now()
  };

  const res3 = coordinator.verifyAckAndAuthorize(manifest, badWsAck);
  assert.strictEqual(res3.success, false);
  assert.match(res3.error || '', /Workspace hash mismatch/);
  assert.strictEqual(sm.getState(), 'PREPARING');
});

test('handshake: rejects authorization if lease is missing or CAS fails', () => {
  const manifest: HandoffPackManifest = {
    handoffId: 'h-1',
    runId: 'run-1',
    epoch: 1,
    sourceSessionId: 'session-A',
    targetModel: { provider: 'anthropic', model: 'claude-3-7-sonnet' },
    inputLedgerHeadHash: 'input-hash-1',
    requirementVersion: 1,
    taskSnapshotHash: 'task-hash-1',
    workspaceFingerprint: { commitHash: 'c1', dirtyFiles: [], untrackedFiles: [], treeHash: 'ws-hash-1' },
    timestamp: Date.now()
  };

  const ack: HandoffAckPacket = {
    handoffId: 'h-1',
    runId: 'run-1',
    newSessionId: 'session-B',
    effectiveModel: { provider: 'anthropic', model: 'claude-3-7-sonnet' },
    verifiedInputHeadHash: 'input-hash-1',
    verifiedTaskSnapshotHash: 'task-hash-1',
    verifiedWorkspaceHash: 'ws-hash-1',
    ackTimestamp: Date.now()
  };

  // Case 1: Missing lease
  const lease1 = new WorkspaceLeaseManager(); // No lease acquired
  const sm1 = new HandoffStateMachine('run-1', 'session-A', 1);
  sm1.requestHandoff('unit_completed');
  sm1.checkpointCompleted();

  const coordinator1 = new TwoPhaseHandshakeCoordinator(sm1, lease1, 'ws-missing');
  coordinator1.startNewSession('session-B');

  const res1 = coordinator1.verifyAckAndAuthorize(manifest, ack);
  assert.strictEqual(res1.success, false);
  assert.match(res1.error || '', /No active lease for workspace ws-missing/);

  // Case 2: CAS failure (e.g. lease owner changed concurrently)
  const lease2 = new WorkspaceLeaseManager();
  lease2.acquireInitialLease('ws-cas', 'session-A', 1);
  const sm2 = new HandoffStateMachine('run-1', 'session-A', 1);
  sm2.requestHandoff('unit_completed');
  sm2.checkpointCompleted();

  const coordinator2 = new TwoPhaseHandshakeCoordinator(sm2, lease2, 'ws-cas');
  coordinator2.startNewSession('session-B');

  // Interfere with lease so compareAndSetOwner will fail (e.g., owner altered)
  // Mock compareAndSetOwner returning false
  lease2.compareAndSetOwner = () => false;

  const res2 = coordinator2.verifyAckAndAuthorize(manifest, ack);
  assert.strictEqual(res2.success, false);
  assert.match(res2.error || '', /CAS lease acquisition failed/);
});

test('handshake: catches state machine error during verifyAckAndAuthorize', () => {
  const lease = new WorkspaceLeaseManager();
  lease.acquireInitialLease('ws-1', 'session-A', 1);

  // State machine NOT in PREPARING state (it is RUNNING)
  const sm = new HandoffStateMachine('run-1', 'session-A', 1);
  const coordinator = new TwoPhaseHandshakeCoordinator(sm, lease, 'ws-1');

  const manifest: HandoffPackManifest = {
    handoffId: 'h-1',
    runId: 'run-1',
    epoch: 1,
    sourceSessionId: 'session-A',
    targetModel: { provider: 'anthropic', model: 'claude-3-7-sonnet' },
    inputLedgerHeadHash: 'input-hash-1',
    requirementVersion: 1,
    taskSnapshotHash: 'task-hash-1',
    workspaceFingerprint: { commitHash: 'c1', dirtyFiles: [], untrackedFiles: [], treeHash: 'ws-hash-1' },
    timestamp: Date.now()
  };

  const ack: HandoffAckPacket = {
    handoffId: 'h-1',
    runId: 'run-1',
    newSessionId: 'session-B',
    effectiveModel: { provider: 'anthropic', model: 'claude-3-7-sonnet' },
    verifiedInputHeadHash: 'input-hash-1',
    verifiedTaskSnapshotHash: 'task-hash-1',
    verifiedWorkspaceHash: 'ws-hash-1',
    ackTimestamp: Date.now()
  };

  const res = coordinator.verifyAckAndAuthorize(manifest, ack);
  assert.strictEqual(res.success, false);
  assert.match(res.error || '', /Cannot receive ACK in state RUNNING/);
});

test('handshake: extracts HandoffAckPacket from stream or stdout text', () => {
  const lease = new WorkspaceLeaseManager();
  const sm = new HandoffStateMachine('run-1', 'session-A', 1);
  const coordinator = new TwoPhaseHandshakeCoordinator(sm, lease, 'ws-1');

  const expectedAck: HandoffAckPacket = {
    handoffId: 'h-extract-1',
    runId: 'run-1',
    newSessionId: 'session-B',
    effectiveModel: { provider: 'anthropic', model: 'claude-3-7-sonnet' },
    verifiedInputHeadHash: 'input-hash-xyz',
    verifiedTaskSnapshotHash: 'task-hash-xyz',
    verifiedWorkspaceHash: 'ws-hash-xyz',
    ackTimestamp: 1700000000000
  };

  const outputWithJson = `
I have completed verification of the manifest. Everything matches.
Here is my ACK:
\`\`\`json
${JSON.stringify(expectedAck, null, 2)}
\`\`\`
Standing by for execution authorization.
`;

  const extracted = coordinator.extractAckFromText(outputWithJson);
  assert.deepStrictEqual(extracted, expectedAck);

  // Non-matching text
  assert.strictEqual(coordinator.extractAckFromText('No JSON here'), undefined);

  // Invalid JSON text
  const malformed = '{ "handoffId": "h-1", "verifiedInputHeadHash": bad_json }';
  assert.strictEqual(coordinator.extractAckFromText(malformed), undefined);
});
