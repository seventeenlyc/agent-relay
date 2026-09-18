// tests/contracts/handshake-coordinator.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import type { HandshakeCoordinator } from '../../packages/protocol/src/coordinator.ts';
import type { HandoffPackManifest, HandoffAckPacket } from '../../packages/protocol/src/types.ts';
import { HandoffStateMachine } from '../../packages/controller/src/handoff/state-machine.ts';
import { WorkspaceLeaseManager } from '../../packages/controller/src/handoff/lease.ts';
import { TwoPhaseHandshakeCoordinator } from '../../packages/adapters/claude/src/handshake.ts';
import { CodexHandshakeCoordinator } from '../../packages/adapters/codex/src/handshake.ts';
import { DshHandshakeCoordinator } from '../../packages/adapters/dsh/src/handshake.ts';

const WORKSPACE_KEY = 'ws-coordinator-contract';

function makeManifest(): HandoffPackManifest {
  return {
    handoffId: 'h-contract-1',
    runId: 'run-contract-1',
    epoch: 1,
    sourceSessionId: 'source-session',
    targetModel: { provider: 'deepseek-official', model: 'deepseek-chat', effort: 'high' },
    inputLedgerHeadHash: 'hash-input-contract',
    requirementVersion: 1,
    taskSnapshotHash: 'hash-task-contract',
    workspaceFingerprint: {
      commitHash: 'c0ffee',
      untrackedFiles: [],
      dirtyFiles: [],
      treeHash: 'hash-tree-contract'
    },
    timestamp: 1_760_000_000_000
  };
}

type CoordinatorBuilder = (
  stateMachine: HandoffStateMachine,
  leaseManager: WorkspaceLeaseManager,
  workspaceKey: string
) => HandshakeCoordinator;

/**
 * 用规范的只读准备提示词 + 标记块 ACK 驱动一次完整握手。
 * coordinator 必须由调用方用**同一组** stateMachine / leaseManager 构造，
 * 否则 CAS 断言会落空。
 */
function driveCanonicalHandshake(build: CoordinatorBuilder) {
  const manifest = makeManifest();
  const stateMachine = new HandoffStateMachine(manifest.runId, manifest.sourceSessionId, 1);
  const leaseManager = new WorkspaceLeaseManager();
  leaseManager.acquireInitialLease(WORKSPACE_KEY, manifest.sourceSessionId, 1);

  // 先构造被测 coordinator，再由它启动新会话：startNewSession 是契约成员，必须被契约测试真正调用。
  const coordinator = build(stateMachine, leaseManager, WORKSPACE_KEY);

  stateMachine.requestHandoff('unit_completed');
  stateMachine.checkpointCompleted(manifest.handoffId);
  coordinator.startNewSession('target-session');
  assert.strictEqual(stateMachine.getState(), 'PREPARING');

  const prompt = coordinator.buildPreparationPrompt(manifest);
  assert.ok(prompt.length > 0, 'buildPreparationPrompt must return a non-empty prompt');
  assert.match(prompt, /READ[-_]?ONLY/i, 'the preparation prompt must declare read-only mode');
  assert.ok(prompt.includes(manifest.handoffId), 'the preparation prompt must carry the handoff id');

  const ack: HandoffAckPacket = {
    handoffId: manifest.handoffId,
    runId: manifest.runId,
    newSessionId: 'target-session',
    effectiveModel: { provider: 'deepseek-official', model: 'deepseek-chat', effort: 'high' },
    verifiedInputHeadHash: manifest.inputLedgerHeadHash,
    verifiedTaskSnapshotHash: manifest.taskSnapshotHash,
    verifiedWorkspaceHash: manifest.workspaceFingerprint.treeHash,
    ackTimestamp: 1_760_000_000_100
  };

  // 标记块方言：claude/codex 的平衡 JSON 扫描与 dsh 的标记解析都能识别
  const output = `Reading preparation material...\nHANDOFF_ACK_START\n${JSON.stringify(ack)}\nHANDOFF_ACK_END\n`;
  const parsed = coordinator.parseAckFromOutput(output);
  assert.ok(parsed, 'parseAckFromOutput must extract a marked ACK block');
  assert.strictEqual(parsed?.handoffId, manifest.handoffId);

  // 无关文本必须返回 null 而不是抛错
  assert.strictEqual(coordinator.parseAckFromOutput('no ack here at all'), null);
  assert.strictEqual(coordinator.parseAckFromOutput(''), null);

  const result = coordinator.verifyAckAndAuthorize(manifest, ack);
  assert.strictEqual(result.success, true, `handshake must succeed, got: ${result.error}`);
  assert.strictEqual(result.epoch, 2);
  assert.ok(result.executionToken);
  assert.strictEqual(leaseManager.getLease(WORKSPACE_KEY)?.currentOwner, 'target-session');
  assert.strictEqual(leaseManager.getLease(WORKSPACE_KEY)?.epoch, 2);
  assert.strictEqual(stateMachine.getState(), 'RUNNING');
}

test('handshake-coordinator: Claude TwoPhaseHandshakeCoordinator satisfies the unified contract', () => {
  driveCanonicalHandshake((sm, lm, key) => new TwoPhaseHandshakeCoordinator(sm, lm, key));
});

test('handshake-coordinator: Codex coordinator satisfies the unified contract', () => {
  driveCanonicalHandshake((sm, lm, key) => new CodexHandshakeCoordinator(sm, lm, key));
});

test('handshake-coordinator: DSH coordinator satisfies the unified contract', () => {
  driveCanonicalHandshake(
    (sm, lm, key) => new DshHandshakeCoordinator({ leaseManager: lm, stateMachine: sm, workspaceKey: key })
  );
});

test('handshake-coordinator: canonical and legacy method names agree on every adapter', () => {
  const manifest = makeManifest();
  const build = (): [HandoffStateMachine, WorkspaceLeaseManager] => [
    new HandoffStateMachine('run-contract-1', 'source-session', 1),
    new WorkspaceLeaseManager()
  ];

  const [claudeSm, claudeLm] = build();
  const claude = new TwoPhaseHandshakeCoordinator(claudeSm, claudeLm, WORKSPACE_KEY);
  assert.strictEqual(claude.buildPreparationPrompt(manifest), claude.generatePreparationPrompt(manifest));
  assert.strictEqual(claude.parseAckFromOutput('nothing'), claude.extractAckFromText('nothing') ?? null);

  const [codexSm, codexLm] = build();
  const codex = new CodexHandshakeCoordinator(codexSm, codexLm, WORKSPACE_KEY);
  assert.strictEqual(codex.buildPreparationPrompt(manifest), codex.generatePreparationPrompt(manifest));
  assert.strictEqual(codex.parseAckFromOutput('nothing'), codex.extractAckFromText('nothing') ?? null);

  const [dshSm, dshLm] = build();
  const dsh = new DshHandshakeCoordinator({
    leaseManager: dshLm,
    stateMachine: dshSm,
    workspaceKey: WORKSPACE_KEY
  });
  assert.strictEqual(dsh.buildPreparationPrompt(manifest), dsh.generatePreparationPrompt(manifest));
  assert.strictEqual(dsh.parseAckFromOutput('nothing'), dsh.extractAckFromText('nothing') ?? null);
});
