// tests/run/reconciler-phase1-phase2.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { RelayDatabase } from '../../packages/controller/src/run/db.ts';
import { RunStore } from '../../packages/controller/src/run/store.ts';
import { RunController } from '../../packages/controller/src/run/engine.ts';
import { ControlIntentLog } from '../../packages/controller/src/run/intent.ts';
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

test('reconciler: Phase 1 removes orphaned corrupted snapshot files and preserves valid state (V16)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-p1-'));
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
      runId: 'run-rec-1',
      workspacePath: tmpDir,
      goal: 'Snapshot clean test',
      model: { provider: 'test', model: 'test-m' },
      tasks: [{ taskId: 'u1', requirementId: 'req-1', title: 'T1' }],
      initialUserMessage: 'init'
    });

    // 构造孤立/损坏的快照文件（既测试 relay-data/<runId>/handoffs 也测试 <runId>/handoffs）
    const orphanDir1 = path.join(tmpDir, 'relay-data', 'run-rec-1', 'handoffs', 'h-orphan');
    fs.mkdirSync(orphanDir1, { recursive: true });
    fs.writeFileSync(path.join(orphanDir1, 'manifest.json'), 'corrupted json {', 'utf8');

    const orphanDir2 = path.join(tmpDir, 'run-rec-1', 'handoffs', 'h-orphan-direct');
    fs.mkdirSync(orphanDir2, { recursive: true });
    fs.writeFileSync(path.join(orphanDir2, 'manifest.json'), 'corrupted json 2 {', 'utf8');

    // 运行 reconcile
    const result = await controller.reconcile();
    assert.strictEqual(result.requiresManualIntervention, false);
    assert.strictEqual(fs.existsSync(path.join(orphanDir1, 'manifest.json')), false, 'corrupted manifest 1 must be purged');
    assert.strictEqual(fs.existsSync(path.join(orphanDir2, 'manifest.json')), false, 'corrupted manifest 2 must be purged');
    assert.ok(result.healedActions.includes('purged_corrupted_snapshot:h-orphan'));
    assert.ok(result.healedActions.includes('purged_corrupted_snapshot:h-orphan-direct'));
  } finally {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('reconciler: Phase 2 detects workspace commit or dirty mismatch and halts safely without git reset (V25)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-p2-git-'));
  execSync('git init -b main', { cwd: tmpDir, stdio: 'ignore' });
  execSync('git config user.name "Test"', { cwd: tmpDir, stdio: 'ignore' });
  execSync('git config user.email "test@example.com"', { cwd: tmpDir, stdio: 'ignore' });
  fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'baseline');
  execSync('git add file.txt && git commit -m "init"', { cwd: tmpDir, stdio: 'ignore' });

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
      runId: 'run-rec-git',
      workspacePath: tmpDir,
      goal: 'Workspace mismatch defense',
      model: { provider: 'test', model: 'test-m' },
      tasks: [{ taskId: 'u1', requirementId: 'req-1', title: 'T1' }],
      initialUserMessage: 'init'
    });

    // 模拟用户在外部修改文件并切换到新分支
    fs.writeFileSync(path.join(tmpDir, 'user-edit.txt'), 'do not touch me');
    execSync('git checkout -b user-branch', { cwd: tmpDir, stdio: 'ignore' });

    const result = await controller.reconcile();
    assert.strictEqual(result.requiresManualIntervention, true);
    assert.strictEqual(result.recoveredState, 'RECOVERY_REQUIRED');
    assert.strictEqual(result.reason, 'workspace_fingerprint_mismatch');

    // 绝对不自动 reset / stash，用户文件必须完好存在！
    assert.strictEqual(fs.existsSync(path.join(tmpDir, 'user-edit.txt')), true);
    assert.strictEqual(fs.readFileSync(path.join(tmpDir, 'user-edit.txt'), 'utf8'), 'do not touch me');
  } finally {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('reconciler: Phase 1 honours unconsumed stop_now intent and transitions to CANCELLED (V21)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-p1-stop-'));
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
      runId: 'run-rec-stop',
      workspacePath: tmpDir,
      goal: 'Stop intent test',
      model: { provider: 'test', model: 'test-m' },
      tasks: [{ taskId: 'u1', requirementId: 'req-1', title: 'T1' }],
      initialUserMessage: 'init'
    });

    // 模拟追加未消费的 stop_now 意图
    const intents = new ControlIntentLog(store);
    intents.append('run-rec-stop', 'stop_now');

    const result = await controller.reconcile();
    assert.strictEqual(result.recoveredState, 'CANCELLED');
    assert.strictEqual(result.requiresManualIntervention, false);
    assert.ok(result.healedActions.includes('honoured_stop_intent'));
    assert.strictEqual(store.getRun('run-rec-stop')?.state, 'CANCELLED');
  } finally {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('reconciler: Phase 1 preserves PAUSED state when no resume intent exists', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-p1-pause-'));
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
      runId: 'run-rec-pause',
      workspacePath: tmpDir,
      goal: 'Pause state test',
      model: { provider: 'test', model: 'test-m' },
      tasks: [{ taskId: 'u1', requirementId: 'req-1', title: 'T1' }],
      initialUserMessage: 'init'
    });

    store.updateRunState('run-rec-pause', 'PAUSED', { pauseReason: 'user_paused' });

    const result = await controller.reconcile();
    assert.strictEqual(result.recoveredState, 'PAUSED');
    assert.strictEqual(result.requiresManualIntervention, false);
    assert.strictEqual(store.getRun('run-rec-pause')?.state, 'PAUSED');
  } finally {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('reconciler: Phase 1 cleans corrupted handoff with mismatched hash and marks ABANDONED', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-p1-corrupt-'));
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
      runId: 'run-rec-corrupt',
      workspacePath: tmpDir,
      goal: 'Corrupt handoff test',
      model: { provider: 'test', model: 'test-m' },
      tasks: [{ taskId: 'u1', requirementId: 'req-1', title: 'T1' }],
      initialUserMessage: 'init'
    });

    const handoffDir = path.join(tmpDir, 'run-rec-corrupt', 'handoffs', 'h-1');
    fs.mkdirSync(handoffDir, { recursive: true });
    const manifestPath = path.join(handoffDir, 'manifest.json');
    fs.writeFileSync(manifestPath, '{"version": 1}', 'utf8');

    // 在 store 中记录一个不同的期望哈希
    store.insertHandoff({
      handoffId: 'h-1',
      runId: 'run-rec-corrupt',
      epoch: 1,
      sourceSessionId: 'sess-old',
      state: 'SNAPSHOTTED',
      manifestPath,
      manifestHash: 'expected-different-hash-12345678'
    });

    const result = await controller.reconcile();
    assert.strictEqual(fs.existsSync(manifestPath), false, 'corrupted manifest file must be removed');
    assert.strictEqual(store.getHandoff('h-1')?.state, 'ABANDONED', 'corrupted handoff record must be marked ABANDONED');
    assert.ok(result.healedActions.includes('purged_corrupted_snapshot:h-1'));
  } finally {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('reconciler: Phase 2 detects dirty modification on same branch without reset', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-p2-dirty-'));
  execSync('git init -b main', { cwd: tmpDir, stdio: 'ignore' });
  execSync('git config user.name "Test"', { cwd: tmpDir, stdio: 'ignore' });
  execSync('git config user.email "test@example.com"', { cwd: tmpDir, stdio: 'ignore' });
  fs.writeFileSync(path.join(tmpDir, 'tracked.txt'), 'version 1');
  execSync('git add tracked.txt && git commit -m "init"', { cwd: tmpDir, stdio: 'ignore' });

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
      runId: 'run-rec-dirty',
      workspacePath: tmpDir,
      goal: 'Dirty mismatch test',
      model: { provider: 'test', model: 'test-m' },
      tasks: [{ taskId: 'u1', requirementId: 'req-1', title: 'T1' }],
      initialUserMessage: 'init'
    });

    // 修改已跟踪文件（形成 dirty 文件，但处于同一分支和同一 commit）
    fs.writeFileSync(path.join(tmpDir, 'tracked.txt'), 'modified by external user');

    const result = await controller.reconcile();
    assert.strictEqual(result.requiresManualIntervention, true);
    assert.strictEqual(result.recoveredState, 'RECOVERY_REQUIRED');
    assert.strictEqual(result.reason, 'workspace_fingerprint_mismatch');
    assert.strictEqual(fs.readFileSync(path.join(tmpDir, 'tracked.txt'), 'utf8'), 'modified by external user');
  } finally {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

