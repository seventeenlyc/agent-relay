// tests/adapters/codex-handshake.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexHandshakeCoordinator } from '../../packages/adapters/codex/src/handshake.ts';
import { HandoffStateMachine } from '../../packages/controller/src/handoff/state-machine.ts';
import { WorkspaceLeaseManager } from '../../packages/controller/src/handoff/lease.ts';
import type { HandoffPackManifest, HandoffAckPacket } from '../../packages/protocol/src/types.ts';

test('codex-handshake: prepares read-only prompt and completes two-phase ACK with CAS lease', () => {
  const lease = new WorkspaceLeaseManager();
  lease.acquireInitialLease('ws-codex-1', 'codex-session-A', 1);

  const sm = new HandoffStateMachine('run-codex-1', 'codex-session-A', 1);
  sm.requestHandoff('unit_completed');
  sm.checkpointCompleted('ckpt-codex-1');

  const coordinator = new CodexHandshakeCoordinator(sm, lease, 'ws-codex-1');

  const manifest: HandoffPackManifest = {
    handoffId: 'h-codex-1',
    runId: 'run-codex-1',
    epoch: 1,
    sourceSessionId: 'codex-session-A',
    targetModel: { provider: 'openai', model: 'gpt-5.6-luna' },
    inputLedgerHeadHash: 'input-hash-codex-1',
    requirementVersion: 1,
    taskSnapshotHash: 'task-hash-codex-1',
    workspaceFingerprint: {
      commitHash: 'commit-codex-1',
      dirtyFiles: [],
      untrackedFiles: [],
      treeHash: 'ws-tree-hash-codex-1'
    },
    timestamp: Date.now()
  };

  // 1. Generate preparation prompt
  const prepPrompt = coordinator.generatePreparationPrompt(manifest);
  assert.ok(prepPrompt.includes('READ-ONLY PREPARATION MODE'));
  assert.ok(prepPrompt.includes('"handoffId": "h-codex-1"'));

  // 2. Start new session in state machine
  coordinator.startNewSession('codex-session-B');
  assert.strictEqual(sm.getState(), 'PREPARING');

  // 3. Formulate and verify ACK packet
  const ack: HandoffAckPacket = {
    handoffId: 'h-codex-1',
    runId: 'run-codex-1',
    newSessionId: 'codex-session-B',
    effectiveModel: { provider: 'openai', model: 'gpt-5.6-luna' },
    verifiedInputHeadHash: 'input-hash-codex-1',
    verifiedTaskSnapshotHash: 'task-hash-codex-1',
    verifiedWorkspaceHash: 'ws-tree-hash-codex-1',
    ackTimestamp: Date.now()
  };

  const authorized = coordinator.verifyAckAndAuthorize(manifest, ack);
  assert.strictEqual(authorized.success, true);
  assert.ok(authorized.executionToken?.startsWith('EXEC_TOKEN_'));
  assert.strictEqual(authorized.epoch, 2);

  // Verify lease transferred atomically to codex-session-B with epoch 2
  assert.strictEqual(lease.getLease('ws-codex-1')?.currentOwner, 'codex-session-B');
  assert.strictEqual(lease.getLease('ws-codex-1')?.epoch, 2);
  assert.strictEqual(sm.getState(), 'RUNNING');
});

test('codex-handshake: rejects ACK on tampered input ledger hash, task snapshot hash, workspace tree hash, handoffId, or target model mismatch', () => {
  const lease = new WorkspaceLeaseManager();
  lease.acquireInitialLease('ws-codex-1', 'codex-session-A', 1);

  const sm = new HandoffStateMachine('run-codex-1', 'codex-session-A', 1);
  sm.requestHandoff('unit_completed');
  sm.checkpointCompleted();

  const coordinator = new CodexHandshakeCoordinator(sm, lease, 'ws-codex-1');
  coordinator.startNewSession('codex-session-B');

  const manifest: HandoffPackManifest = {
    handoffId: 'h-codex-1',
    runId: 'run-codex-1',
    epoch: 1,
    sourceSessionId: 'codex-session-A',
    targetModel: { provider: 'openai', model: 'gpt-5.6-luna' },
    inputLedgerHeadHash: 'input-hash-codex-1',
    requirementVersion: 1,
    taskSnapshotHash: 'task-hash-codex-1',
    workspaceFingerprint: { commitHash: 'c1', dirtyFiles: [], untrackedFiles: [], treeHash: 'valid-ws-hash' },
    timestamp: Date.now()
  };

  // Mismatched input ledger head hash
  const badInputAck: HandoffAckPacket = {
    handoffId: 'h-codex-1',
    runId: 'run-codex-1',
    newSessionId: 'codex-session-B',
    effectiveModel: { provider: 'openai', model: 'gpt-5.6-luna' },
    verifiedInputHeadHash: 'TAMPERED_INPUT_HASH',
    verifiedTaskSnapshotHash: 'task-hash-codex-1',
    verifiedWorkspaceHash: 'valid-ws-hash',
    ackTimestamp: Date.now()
  };

  const res1 = coordinator.verifyAckAndAuthorize(manifest, badInputAck);
  assert.strictEqual(res1.success, false);
  assert.match(res1.error || '', /Input ledger head hash mismatch/);
  assert.strictEqual(sm.getState(), 'PREPARING');

  // Mismatched task snapshot hash
  const badTaskAck: HandoffAckPacket = {
    handoffId: 'h-codex-1',
    runId: 'run-codex-1',
    newSessionId: 'codex-session-B',
    effectiveModel: { provider: 'openai', model: 'gpt-5.6-luna' },
    verifiedInputHeadHash: 'input-hash-codex-1',
    verifiedTaskSnapshotHash: 'TAMPERED_TASK_HASH',
    verifiedWorkspaceHash: 'valid-ws-hash',
    ackTimestamp: Date.now()
  };

  const res2 = coordinator.verifyAckAndAuthorize(manifest, badTaskAck);
  assert.strictEqual(res2.success, false);
  assert.match(res2.error || '', /Task snapshot hash mismatch/);
  assert.strictEqual(sm.getState(), 'PREPARING');

  // Mismatched workspace tree hash
  const badWsAck: HandoffAckPacket = {
    handoffId: 'h-codex-1',
    runId: 'run-codex-1',
    newSessionId: 'codex-session-B',
    effectiveModel: { provider: 'openai', model: 'gpt-5.6-luna' },
    verifiedInputHeadHash: 'input-hash-codex-1',
    verifiedTaskSnapshotHash: 'task-hash-codex-1',
    verifiedWorkspaceHash: 'TAMPERED_WS_HASH',
    ackTimestamp: Date.now()
  };

  const res3 = coordinator.verifyAckAndAuthorize(manifest, badWsAck);
  assert.strictEqual(res3.success, false);
  assert.match(res3.error || '', /Workspace hash mismatch/);
  assert.strictEqual(sm.getState(), 'PREPARING');

  // Mismatched handoffId
  const badHandoffIdAck: HandoffAckPacket = {
    handoffId: 'WRONG_HANDOFF_ID',
    runId: 'run-codex-1',
    newSessionId: 'codex-session-B',
    effectiveModel: { provider: 'openai', model: 'gpt-5.6-luna' },
    verifiedInputHeadHash: 'input-hash-codex-1',
    verifiedTaskSnapshotHash: 'task-hash-codex-1',
    verifiedWorkspaceHash: 'valid-ws-hash',
    ackTimestamp: Date.now()
  };

  const res4 = coordinator.verifyAckAndAuthorize(manifest, badHandoffIdAck);
  assert.strictEqual(res4.success, false);
  assert.match(res4.error || '', /Handoff ID mismatch/);
  assert.strictEqual(sm.getState(), 'PREPARING');

  // Mismatched model
  const badModelAck: HandoffAckPacket = {
    handoffId: 'h-codex-1',
    runId: 'run-codex-1',
    newSessionId: 'codex-session-B',
    effectiveModel: { provider: 'openai', model: 'gpt-4o' },
    verifiedInputHeadHash: 'input-hash-codex-1',
    verifiedTaskSnapshotHash: 'task-hash-codex-1',
    verifiedWorkspaceHash: 'valid-ws-hash',
    ackTimestamp: Date.now()
  };

  const res5 = coordinator.verifyAckAndAuthorize(manifest, badModelAck);
  assert.strictEqual(res5.success, false);
  assert.match(res5.error || '', /Model mismatch: expected gpt-5.6-luna, got gpt-4o/);
  assert.strictEqual(sm.getState(), 'PREPARING');
});

test('codex-handshake: rejects when lease is missing, owner mismatch, or epoch mismatch, with lease left unmodified', () => {
  const manifest: HandoffPackManifest = {
    handoffId: 'h-codex-1',
    runId: 'run-codex-1',
    epoch: 1,
    sourceSessionId: 'codex-session-A',
    targetModel: { provider: 'openai', model: 'gpt-5.6-luna' },
    inputLedgerHeadHash: 'input-hash-codex-1',
    requirementVersion: 1,
    taskSnapshotHash: 'task-hash-codex-1',
    workspaceFingerprint: { commitHash: 'c1', dirtyFiles: [], untrackedFiles: [], treeHash: 'ws-hash-1' },
    timestamp: Date.now()
  };

  const ack: HandoffAckPacket = {
    handoffId: 'h-codex-1',
    runId: 'run-codex-1',
    newSessionId: 'codex-session-B',
    effectiveModel: { provider: 'openai', model: 'gpt-5.6-luna' },
    verifiedInputHeadHash: 'input-hash-codex-1',
    verifiedTaskSnapshotHash: 'task-hash-codex-1',
    verifiedWorkspaceHash: 'ws-hash-1',
    ackTimestamp: Date.now()
  };

  // Case 1: Missing lease
  const lease1 = new WorkspaceLeaseManager();
  const sm1 = new HandoffStateMachine('run-codex-1', 'codex-session-A', 1);
  sm1.requestHandoff('unit_completed');
  sm1.checkpointCompleted();

  const coordinator1 = new CodexHandshakeCoordinator(sm1, lease1, 'ws-missing');
  coordinator1.startNewSession('codex-session-B');

  const res1 = coordinator1.verifyAckAndAuthorize(manifest, ack);
  assert.strictEqual(res1.success, false);
  assert.match(res1.error || '', /No active lease for workspace ws-missing/);
  assert.strictEqual(lease1.getLease('ws-missing'), undefined);

  // Case 2: Lease owner mismatch
  const lease2 = new WorkspaceLeaseManager();
  lease2.acquireInitialLease('ws-owner-mismatch', 'codex-session-OTHER', 1);
  const sm2 = new HandoffStateMachine('run-codex-1', 'codex-session-A', 1);
  sm2.requestHandoff('unit_completed');
  sm2.checkpointCompleted();

  const coordinator2 = new CodexHandshakeCoordinator(sm2, lease2, 'ws-owner-mismatch');
  coordinator2.startNewSession('codex-session-B');

  const res2 = coordinator2.verifyAckAndAuthorize(manifest, ack);
  assert.strictEqual(res2.success, false);
  assert.match(res2.error || '', /Lease owner mismatch: expected codex-session-A, got codex-session-OTHER/);
  assert.strictEqual(lease2.getLease('ws-owner-mismatch')?.currentOwner, 'codex-session-OTHER');
  assert.strictEqual(lease2.getLease('ws-owner-mismatch')?.epoch, 1);

  // Case 3: Lease epoch mismatch
  const lease3 = new WorkspaceLeaseManager();
  lease3.acquireInitialLease('ws-epoch-mismatch', 'codex-session-A', 42);
  const sm3 = new HandoffStateMachine('run-codex-1', 'codex-session-A', 1);
  sm3.requestHandoff('unit_completed');
  sm3.checkpointCompleted();

  const coordinator3 = new CodexHandshakeCoordinator(sm3, lease3, 'ws-epoch-mismatch');
  coordinator3.startNewSession('codex-session-B');

  const res3 = coordinator3.verifyAckAndAuthorize(manifest, ack);
  assert.strictEqual(res3.success, false);
  assert.match(res3.error || '', /Lease epoch mismatch: expected 1, got 42/);
  assert.strictEqual(lease3.getLease('ws-epoch-mismatch')?.currentOwner, 'codex-session-A');
  assert.strictEqual(lease3.getLease('ws-epoch-mismatch')?.epoch, 42);

  // Case 4: CAS acquisition failure
  const lease4 = new WorkspaceLeaseManager();
  lease4.acquireInitialLease('ws-cas-fail', 'codex-session-A', 1);
  const sm4 = new HandoffStateMachine('run-codex-1', 'codex-session-A', 1);
  sm4.requestHandoff('unit_completed');
  sm4.checkpointCompleted();

  const coordinator4 = new CodexHandshakeCoordinator(sm4, lease4, 'ws-cas-fail');
  coordinator4.startNewSession('codex-session-B');

  lease4.compareAndSetOwner = () => false;

  const res4 = coordinator4.verifyAckAndAuthorize(manifest, ack);
  assert.strictEqual(res4.success, false);
  assert.match(res4.error || '', /CAS lease acquisition failed/);
});

test('codex-handshake: catches state machine error when state is not PREPARING (lease untouched)', () => {
  const lease = new WorkspaceLeaseManager();
  lease.acquireInitialLease('ws-codex-1', 'codex-session-A', 1);

  // State machine in RUNNING state (not PREPARING)
  const sm = new HandoffStateMachine('run-codex-1', 'codex-session-A', 1);
  const coordinator = new CodexHandshakeCoordinator(sm, lease, 'ws-codex-1');

  const manifest: HandoffPackManifest = {
    handoffId: 'h-codex-1',
    runId: 'run-codex-1',
    epoch: 1,
    sourceSessionId: 'codex-session-A',
    targetModel: { provider: 'openai', model: 'gpt-5.6-luna' },
    inputLedgerHeadHash: 'input-hash-codex-1',
    requirementVersion: 1,
    taskSnapshotHash: 'task-hash-codex-1',
    workspaceFingerprint: { commitHash: 'c1', dirtyFiles: [], untrackedFiles: [], treeHash: 'ws-hash-1' },
    timestamp: Date.now()
  };

  const ack: HandoffAckPacket = {
    handoffId: 'h-codex-1',
    runId: 'run-codex-1',
    newSessionId: 'codex-session-B',
    effectiveModel: { provider: 'openai', model: 'gpt-5.6-luna' },
    verifiedInputHeadHash: 'input-hash-codex-1',
    verifiedTaskSnapshotHash: 'task-hash-codex-1',
    verifiedWorkspaceHash: 'ws-hash-1',
    ackTimestamp: Date.now()
  };

  const res = coordinator.verifyAckAndAuthorize(manifest, ack);
  assert.strictEqual(res.success, false);
  assert.match(res.error || '', /Cannot receive ACK in state RUNNING/);
  // Lease remained untouched because state check preceded lease check / CAS
  assert.strictEqual(lease.getLease('ws-codex-1')?.currentOwner, 'codex-session-A');
  assert.strictEqual(lease.getLease('ws-codex-1')?.epoch, 1);
});

test('codex-handshake: monotonic lease rollback when state machine throws during receiveAck (owner reverted to sourceSessionId with newEpoch + 1)', () => {
  const lease = new WorkspaceLeaseManager();
  lease.acquireInitialLease('ws-codex-1', 'codex-session-A', 1);

  const sm = new HandoffStateMachine('run-codex-1', 'codex-session-A', 1);
  sm.requestHandoff('unit_completed');
  sm.checkpointCompleted();

  const coordinator = new CodexHandshakeCoordinator(sm, lease, 'ws-codex-1');
  coordinator.startNewSession('codex-session-B');
  assert.strictEqual(sm.getState(), 'PREPARING');

  const manifest: HandoffPackManifest = {
    handoffId: 'h-codex-1',
    runId: 'run-codex-1',
    epoch: 1,
    sourceSessionId: 'codex-session-A',
    targetModel: { provider: 'openai', model: 'gpt-5.6-luna' },
    inputLedgerHeadHash: 'input-hash-codex-1',
    requirementVersion: 1,
    taskSnapshotHash: 'task-hash-codex-1',
    workspaceFingerprint: { commitHash: 'c1', dirtyFiles: [], untrackedFiles: [], treeHash: 'ws-hash-1' },
    timestamp: Date.now()
  };

  // ACK with mismatched runId will cause sm.receiveAck() to throw AFTER CAS transfer succeeds
  const badRunAck: HandoffAckPacket = {
    handoffId: 'h-codex-1',
    runId: 'run-MISMATCHED',
    newSessionId: 'codex-session-B',
    effectiveModel: { provider: 'openai', model: 'gpt-5.6-luna' },
    verifiedInputHeadHash: 'input-hash-codex-1',
    verifiedTaskSnapshotHash: 'task-hash-codex-1',
    verifiedWorkspaceHash: 'ws-hash-1',
    ackTimestamp: Date.now()
  };

  const res = coordinator.verifyAckAndAuthorize(manifest, badRunAck);
  assert.strictEqual(res.success, false);
  assert.match(res.error || '', /Run ID mismatch/);

  // Lease reverted to sourceSessionId with monotonic epoch (newEpoch + 1 = 3)
  assert.strictEqual(lease.getLease('ws-codex-1')?.currentOwner, 'codex-session-A');
  assert.strictEqual(lease.getLease('ws-codex-1')?.epoch, 3);
});

test('codex-handshake: extracts HandoffAckPacket from markdown code blocks and raw JSON text', () => {
  const lease = new WorkspaceLeaseManager();
  const sm = new HandoffStateMachine('run-codex-1', 'codex-session-A', 1);
  const coordinator = new CodexHandshakeCoordinator(sm, lease, 'ws-codex-1');

  const expectedAck: HandoffAckPacket = {
    handoffId: 'h-extract-codex-1',
    runId: 'run-codex-1',
    newSessionId: 'codex-session-B',
    effectiveModel: { provider: 'openai', model: 'gpt-5.6-luna' },
    verifiedInputHeadHash: 'input-hash-xyz',
    verifiedTaskSnapshotHash: 'task-hash-xyz',
    verifiedWorkspaceHash: 'ws-hash-xyz',
    ackTimestamp: 1700000000000
  };

  // 1. Markdown code block
  const outputWithJson = `
I have completed verification of the manifest. All hashes verified.
Here is my ACK:
\`\`\`json
${JSON.stringify(expectedAck, null, 2)}
\`\`\`
Standing by for execution token.
`;
  const extracted = coordinator.extractAckFromText(outputWithJson);
  assert.deepStrictEqual(extracted, expectedAck);

  // 2. Discrete balanced JSON object in plain text
  const discreteText = `Verification complete. ACK: ${JSON.stringify(expectedAck)} Ready for authorization.`;
  const extractedDiscrete = coordinator.extractAckFromText(discreteText);
  assert.deepStrictEqual(extractedDiscrete, expectedAck);

  // 3. Preceding prompt echo containing manifest JSON block followed by ACK code block
  const promptEchoWithAck = `
Inspect manifest:
\`\`\`json
{
  "handoffId": "h-extract-codex-1",
  "runId": "run-codex-1",
  "epoch": 1,
  "sourceSessionId": "codex-session-A",
  "targetModel": { "provider": "openai", "model": "gpt-5.6-luna" },
  "inputLedgerHeadHash": "input-hash-xyz"
}
\`\`\`
Here is the ACK response:
\`\`\`json
${JSON.stringify(expectedAck, null, 2)}
\`\`\`
`;
  const extractedEcho = coordinator.extractAckFromText(promptEchoWithAck);
  assert.deepStrictEqual(extractedEcho, expectedAck);

  // 4. Preceding discrete JSON object without markdown followed by discrete ACK object
  const multipleDiscrete = `
{"status": "ok", "handoffId": "h-extract-codex-1"}
Some intervening notes.
${JSON.stringify(expectedAck)}
`;
  const extractedMultiDiscrete = coordinator.extractAckFromText(multipleDiscrete);
  assert.deepStrictEqual(extractedMultiDiscrete, expectedAck);

  // 5. Non-matching text
  assert.strictEqual(coordinator.extractAckFromText('No JSON here'), undefined);

  // 6. Invalid JSON text
  const malformed = '{ "handoffId": "h-1", "verifiedInputHeadHash": bad_json }';
  assert.strictEqual(coordinator.extractAckFromText(malformed), undefined);
});
