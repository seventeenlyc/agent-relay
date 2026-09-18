// tests/run/reconciler-phase3.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RelayDatabase } from '../../packages/controller/src/run/db.ts';
import { RunStore } from '../../packages/controller/src/run/store.ts';
import { RunController } from '../../packages/controller/src/run/engine.ts';
import { TwoPhaseHandshakeCoordinator } from '../../packages/adapters/claude/src/handshake.ts';
import { HandoffStateMachine } from '../../packages/controller/src/handoff/state-machine.ts';
import { WorkspaceLeaseManager } from '../../packages/controller/src/handoff/lease.ts';
import { ScriptedAdapter } from '../helpers/scripted-adapter.ts';

function createCoordinator(deps: any) {
  return new TwoPhaseHandshakeCoordinator(
    deps.stateMachine as HandoffStateMachine,
    deps.leaseManager as unknown as WorkspaceLeaseManager,
    deps.workspaceKey
  );
}

test('reconciler Phase 3 (V14): rebinds externally existing session from outbox without duplicate spawn', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-p3-v14-'));
  const dbPath = path.join(tmpDir, 'relay.db');
  const db = new RelayDatabase({ dbPath });
  const store = new RunStore(db);
  const adapter = new ScriptedAdapter();

  try {
    const controller = new RunController({
      store,
      dataDir: tmpDir,
      adapter,
      adapterName: 'claude',
      createCoordinator
    });

    controller.startRun({
      runId: 'run-v14-1',
      workspacePath: tmpDir,
      goal: 'V14 Outbox Rebind Test',
      model: { provider: 'test', model: 'test-m' },
      tasks: [{ taskId: 'u1', requirementId: 'req-1', title: 'T1' }],
      initialUserMessage: 'init'
    });

    const targetSessionId = 'run-v14-1-s2';
    // 模拟服务端/适配器已经创建了该会话
    adapter.createFresh({
      sessionId: targetSessionId,
      runId: 'run-v14-1',
      cwd: tmpDir,
      model: { provider: 'test', model: 'test-m' },
      readOnly: true
    });
    const createdCountBefore = adapter.created.length;

    // 构造处于 CREATING 态的 handoff 与 PENDING 态的 create_session outbox 记录
    const handoffId = 'h-v14-test';
    store.insertHandoff({
      handoffId,
      runId: 'run-v14-1',
      epoch: 2,
      sourceSessionId: 'run-v14-1-s1',
      targetSessionId,
      state: 'CREATING'
    });
    store.updateRunState('run-v14-1', 'STARTING');

    const outboxRow = store.enqueueOutbox({
      runId: 'run-v14-1',
      handoffId,
      topic: 'create_session',
      targetSessionId,
      payload: { readOnly: true }
    });

    // 触发对账
    const result = await controller.reconcile();

    assert.strictEqual(result.requiresManualIntervention, false);
    assert.ok(result.healedActions.includes(`rebound_session:${targetSessionId}`));

    // 验证 outbox 状态更新为 DISPATCHED
    const updatedOutbox = store.getOutbox(outboxRow.msgId);
    assert.strictEqual(updatedOutbox?.state, 'DISPATCHED');

    // 验证 handoff 推进至 PREPARING
    const updatedHandoff = store.getHandoff(handoffId);
    assert.strictEqual(updatedHandoff?.state, 'PREPARING');

    // 验证未重复创建会话
    assert.strictEqual(adapter.created.length, createdCountBefore, 'Must not spawn duplicate session');
  } finally {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('reconciler Phase 3 (V14): halts at RECOVERY_REQUIRED if outbox session creation is ambiguous', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-p3-v14-ambiguous-'));
  const dbPath = path.join(tmpDir, 'relay.db');
  const db = new RelayDatabase({ dbPath });
  const store = new RunStore(db);
  const adapter = new ScriptedAdapter();

  try {
    const controller = new RunController({
      store,
      dataDir: tmpDir,
      adapter,
      adapterName: 'claude',
      createCoordinator
    });

    controller.startRun({
      runId: 'run-v14-amb',
      workspacePath: tmpDir,
      goal: 'V14 Ambiguous Test',
      model: { provider: 'test', model: 'test-m' },
      tasks: [{ taskId: 'u1', requirementId: 'req-1', title: 'T1' }],
      initialUserMessage: 'init'
    });

    const targetSessionId = 'run-v14-nonexistent-s2';
    // 适配器中不存在该会话
    const handoffId = 'h-v14-amb';
    store.insertHandoff({
      handoffId,
      runId: 'run-v14-amb',
      epoch: 2,
      sourceSessionId: 'run-v14-amb-s1',
      targetSessionId,
      state: 'CREATING'
    });
    store.updateRunState('run-v14-amb', 'STARTING');

    store.enqueueOutbox({
      runId: 'run-v14-amb',
      handoffId,
      topic: 'create_session',
      targetSessionId,
      payload: { readOnly: true }
    });

    const result = await controller.reconcile();

    assert.strictEqual(result.requiresManualIntervention, true);
    assert.strictEqual(result.recoveredState, 'RECOVERY_REQUIRED');
    assert.strictEqual(result.reason, 'session_creation_ambiguous');
    assert.strictEqual(store.getRun('run-v14-amb')?.state, 'RECOVERY_REQUIRED');
    assert.strictEqual(store.getRun('run-v14-amb')?.blockedReason, 'session_creation_ambiguous');
  } finally {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('reconciler Phase 3 (V17): replays idempotent execution token for AUTHORIZED handoff and restores RUNNING', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-p3-v17-'));
  const dbPath = path.join(tmpDir, 'relay.db');
  const db = new RelayDatabase({ dbPath });
  const store = new RunStore(db);
  const adapter = new ScriptedAdapter();

  try {
    const controller = new RunController({
      store,
      dataDir: tmpDir,
      adapter,
      adapterName: 'claude',
      createCoordinator
    });

    controller.startRun({
      runId: 'run-v17-1',
      workspacePath: tmpDir,
      goal: 'V17 Token Replay Test',
      model: { provider: 'test', model: 'test-m' },
      tasks: [{ taskId: 'u1', requirementId: 'req-1', title: 'T1' }],
      initialUserMessage: 'init'
    });

    const sourceSessionId = 'run-v17-1-s1';
    const targetSessionId = 'run-v17-1-s2';

    // 模拟旧会话已存在
    adapter.createFresh({
      sessionId: sourceSessionId,
      runId: 'run-v17-1',
      cwd: tmpDir,
      model: { provider: 'test', model: 'test-m' }
    });

    // 模拟目标会话已就绪并等待令牌
    adapter.createFresh({
      sessionId: targetSessionId,
      runId: 'run-v17-1',
      cwd: tmpDir,
      model: { provider: 'test', model: 'test-m' },
      readOnly: true
    });

    const handoffId = 'h-v17-test';
    store.insertHandoff({
      handoffId,
      runId: 'run-v17-1',
      epoch: 2,
      sourceSessionId,
      targetSessionId,
      state: 'AUTHORIZED'
    });

    const outbox = store.enqueueOutbox({
      runId: 'run-v17-1',
      handoffId,
      topic: 'create_session',
      targetSessionId,
      payload: { readOnly: true }
    });

    const result = await controller.reconcile();

    assert.strictEqual(result.requiresManualIntervention, false);
    assert.strictEqual(result.recoveredState, 'RUNNING');
    assert.ok(result.healedActions.includes(`replayed_execution_token:${targetSessionId}`));

    // 验证适配器收到了 authorizeExecution 调用
    assert.strictEqual(adapter.wasAuthorized(targetSessionId), true);
    // 验证旧会话被 interruptOwned
    assert.ok(adapter.interrupted.includes(sourceSessionId));

    // 验证 handoff 变为 COMPLETED
    assert.strictEqual(store.getHandoff(handoffId)?.state, 'COMPLETED');
    // 验证 outbox 记录变为 ACKED
    assert.strictEqual(store.getOutbox(outbox.msgId)?.state, 'ACKED');

    // 验证 session_chain 存在目标会话
    const chain = store.listChain('run-v17-1');
    const targetLink = chain.find((c) => c.nextSessionId === targetSessionId);
    assert.ok(targetLink, 'Target session must be in session chain');
    assert.strictEqual(targetLink.prevSessionId, sourceSessionId);

    // 验证 run 状态恢复为 RUNNING
    const run = store.getRun('run-v17-1');
    assert.strictEqual(run?.state, 'RUNNING');
    assert.strictEqual(run?.currentSessionId, targetSessionId);
  } finally {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('reconciler Phase 3 (V18): halts at RECOVERY_REQUIRED if old session cannot be confirmed quiescent', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-p3-v18-unconfirmed-'));
  const dbPath = path.join(tmpDir, 'relay.db');
  const db = new RelayDatabase({ dbPath });
  const store = new RunStore(db);

  // 模拟旧会话等待静止超时
  const adapter = new ScriptedAdapter({
    quiescenceOverrides: { 'run-v18-1-s1': 'timeout' }
  });

  try {
    const controller = new RunController({
      store,
      dataDir: tmpDir,
      adapter,
      adapterName: 'claude',
      createCoordinator
    });

    controller.startRun({
      runId: 'run-v18-1',
      workspacePath: tmpDir,
      goal: 'V18 Quiescence Guard Test',
      model: { provider: 'test', model: 'test-m' },
      tasks: [{ taskId: 'u1', requirementId: 'req-1', title: 'T1' }],
      initialUserMessage: 'init'
    });

    adapter.createFresh({
      sessionId: 'run-v18-1-s1',
      runId: 'run-v18-1',
      cwd: tmpDir,
      model: { provider: 'test', model: 'test-m' }
    });

    // 模拟处于 DRAINING 状态
    store.updateRunState('run-v18-1', 'DRAINING', {
      currentSessionId: 'run-v18-1-s1'
    });

    const result = await controller.reconcile();

    assert.strictEqual(result.requiresManualIntervention, true);
    assert.strictEqual(result.recoveredState, 'RECOVERY_REQUIRED');
    assert.strictEqual(result.reason, 'old_session_quiescence_unconfirmed');
    assert.strictEqual(store.getRun('run-v18-1')?.state, 'RECOVERY_REQUIRED');
    assert.strictEqual(store.getRun('run-v18-1')?.blockedReason, 'old_session_quiescence_unconfirmed');
  } finally {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('reconciler Phase 3 (V18): transitions DRAINING to CHECKPOINTED when old session confirms quiescent', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-p3-v18-quiescent-'));
  const dbPath = path.join(tmpDir, 'relay.db');
  const db = new RelayDatabase({ dbPath });
  const store = new RunStore(db);
  const adapter = new ScriptedAdapter();

  try {
    const controller = new RunController({
      store,
      dataDir: tmpDir,
      adapter,
      adapterName: 'claude',
      createCoordinator
    });

    controller.startRun({
      runId: 'run-v18-2',
      workspacePath: tmpDir,
      goal: 'V18 Quiescent Checkpoint Test',
      model: { provider: 'test', model: 'test-m' },
      tasks: [{ taskId: 'u1', requirementId: 'req-1', title: 'T1' }],
      initialUserMessage: 'init'
    });

    adapter.createFresh({
      sessionId: 'run-v18-2-s1',
      runId: 'run-v18-2',
      cwd: tmpDir,
      model: { provider: 'test', model: 'test-m' }
    });

    store.updateRunState('run-v18-2', 'DRAINING', {
      currentSessionId: 'run-v18-2-s1'
    });

    const result = await controller.reconcile();

    assert.strictEqual(result.requiresManualIntervention, false);
    assert.strictEqual(result.recoveredState, 'CHECKPOINTED');
    assert.ok(result.healedActions.includes('quiesced_draining_session:run-v18-2-s1'));
    assert.strictEqual(store.getRun('run-v18-2')?.state, 'CHECKPOINTED');
  } finally {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
