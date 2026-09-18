// tests/run/status.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RelayDatabase } from '../../packages/controller/src/run/db.ts';
import { RunStore } from '../../packages/controller/src/run/store.ts';
import { SessionChainLedger } from '../../packages/controller/src/run/chain.ts';
import {
  buildRunStatus,
  renderStatusCard,
  renderStatusJson,
  writeStateProjection
} from '../../packages/controller/src/run/status.ts';
import type { TaskItem } from '../../packages/protocol/src/types.ts';

function seedRun() {
  const db = new RelayDatabase({ dbPath: ':memory:' });
  const store = new RunStore(db);
  const runId = 'run-status-1';
  store.insertRun({
    runId,
    workspaceKey: 'ws-status',
    workspacePath: 'C:/tmp/ws-status',
    goal: '完成深度学习流水线三单元实现',
    state: 'RUNNING',
    unitCount: 4
  });

  const tasks: TaskItem[] = [
    {
      taskId: 'u1',
      requirementId: 'req-root',
      title: 'Data Ingestion',
      description: '',
      dependencies: [],
      status: 'completed',
      allowedPaths: [],
      expectedArtifacts: [],
      testEvidenceHash: 'evidence-u1',
      completedAt: 1_760_000_000_000
    },
    {
      taskId: 'u2',
      requirementId: 'req-root',
      title: 'Transformer Encoder',
      description: '',
      dependencies: ['u1'],
      status: 'in_progress',
      allowedPaths: [],
      expectedArtifacts: []
    },
    {
      taskId: 'u3',
      requirementId: 'req-root',
      title: 'Autoregressive Decoder',
      description: '',
      dependencies: ['u2'],
      status: 'pending',
      allowedPaths: [],
      expectedArtifacts: []
    },
    {
      taskId: 'u4',
      requirementId: 'req-root',
      title: 'Loss and Optimizer',
      description: '',
      dependencies: ['u3'],
      status: 'pending',
      allowedPaths: [],
      expectedArtifacts: []
    }
  ];
  store.appendTaskSnapshot(runId, 1, JSON.stringify(tasks), 'snapshot-hash-1');

  store.updateRunState(runId, 'RUNNING', {
    currentSessionId: 'worker-C',
    currentEpoch: 3,
    handoffCount: 2,
    currentSessionUnitCount: 1
  });

  const chain = new SessionChainLedger(store);
  chain.append({
    runId,
    nextSessionId: 'worker-A',
    adapter: 'dsh',
    provider: 'deepseek-official',
    model: 'deepseek-chat',
    effort: 'high',
    epoch: 1,
    reason: 'run_started'
  });
  chain.append({
    runId,
    prevSessionId: 'worker-A',
    nextSessionId: 'worker-B',
    adapter: 'dsh',
    provider: 'deepseek-official',
    model: 'deepseek-chat',
    effort: 'high',
    epoch: 2,
    handoffId: 'h-1',
    reason: 'unit_completed'
  });
  chain.append({
    runId,
    prevSessionId: 'worker-B',
    nextSessionId: 'worker-C',
    adapter: 'dsh',
    provider: 'deepseek-official',
    model: 'deepseek-reasoner',
    effort: 'high',
    epoch: 3,
    handoffId: 'h-2',
    reason: 'unit_completed'
  });

  return { db, store, runId };
}

test('status: view reports goal, progress, verification, handoff, model and control state', () => {
  const { db, store, runId } = seedRun();
  const view = buildRunStatus(store, runId);

  assert.strictEqual(view.runId, runId);
  assert.strictEqual(view.goal, '完成深度学习流水线三单元实现');
  assert.strictEqual(view.state, 'RUNNING');
  assert.strictEqual(view.progress.completed, 1);
  assert.strictEqual(view.progress.total, 4);
  assert.strictEqual(view.progress.currentTaskId, 'u2');
  assert.strictEqual(view.progress.currentTaskTitle, 'Transformer Encoder');
  assert.strictEqual(view.verification.verified, true);
  assert.strictEqual(view.verification.evidenceHash, 'evidence-u1');
  assert.strictEqual(view.handoff?.handoffId, 'h-2');
  assert.strictEqual(view.handoff?.fromSessionId, 'worker-B');
  assert.strictEqual(view.handoff?.toSessionId, 'worker-C');
  assert.strictEqual(view.handoff?.epoch, 3);
  assert.strictEqual(view.model?.model, 'deepseek-reasoner');
  // 当前单元（u2，in_progress）就是正在执行的单元，因此下一动作是继续执行它——
  // 与设计文档 §8.1 的示例一致（当前 Unit 3 对应下一动作 执行 Unit 3）。
  // 只有当运行停在单元之间时，当前单元才是第一个 pending 单元。
  assert.strictEqual(view.control.nextAction, 'Execute Unit 2: Transformer Encoder');
  assert.strictEqual(view.control.paused, false);
  db.close();
});

test('status: unmeasured metrics are reported as unknown, never as zero (V09)', () => {
  const { db, store, runId } = seedRun();
  const view = buildRunStatus(store, runId);
  assert.strictEqual(view.context.compaction, 'unknown');
  assert.strictEqual(view.usage, 'unknown');

  const card = renderStatusCard(view);
  assert.match(card, /压缩: 未知/);
  assert.match(card, /用量: 未知/);
  assert.doesNotMatch(card, /压缩: 0/);
  assert.doesNotMatch(card, /%/);
  db.close();
});

test('status: card renders the Chinese status card shape from 03-技术设计.md §12', () => {
  const { db, store, runId } = seedRun();
  const card = renderStatusCard(buildRunStatus(store, runId));

  assert.match(card, /^目标: 完成深度学习流水线三单元实现/m);
  assert.match(card, /^进度: 1\/4 单元完成（当前: Unit 2 — Transformer Encoder）/m);
  assert.match(card, /^验证: Unit 1 已通过 · 证据 evidence-u1/m);
  assert.match(card, /^交接: h-2 · worker-B → worker-C · epoch 3/m);
  assert.match(card, /^模型: deepseek-official \/ deepseek-reasoner \(effort: high\)/m);
  assert.match(card, /^控制: 无暂停 · 下一动作: Execute Unit 2/m);
  db.close();
});

test('status: the current unit index comes from array position, not from the task id', () => {
  const db = new RelayDatabase({ dbPath: ':memory:' });
  const store = new RunStore(db);
  store.insertRun({
    runId: 'run-position',
    workspaceKey: 'ws-position',
    workspacePath: 'C:/tmp/ws-position',
    goal: 'Positional index',
    state: 'RUNNING',
    unitCount: 3
  });
  const tasks: TaskItem[] = [
    { taskId: 'design-the-schema', requirementId: 'req-root', title: 'Design the schema', description: '',
      dependencies: [], status: 'completed', allowedPaths: [], expectedArtifacts: [],
      testEvidenceHash: 'ev-schema', completedAt: 1 },
    { taskId: 'write-migration', requirementId: 'req-root', title: 'Write the migration', description: '',
      dependencies: ['design-the-schema'], status: 'in_progress', allowedPaths: [], expectedArtifacts: [] },
    { taskId: 'add-index', requirementId: 'req-root', title: 'Add the index', description: '',
      dependencies: ['write-migration'], status: 'pending', allowedPaths: [], expectedArtifacts: [] }
  ];
  store.appendTaskSnapshot('run-position', 1, JSON.stringify(tasks), 'hash-position');

  const view = buildRunStatus(store, 'run-position');
  assert.strictEqual(view.progress.currentTaskId, 'write-migration');
  assert.strictEqual(view.progress.currentTaskIndex, 2);
  assert.match(renderStatusCard(view), /当前: Unit 2 — Write the migration/);

  db.close();
});

test('status: verification reports the most recently completed unit', () => {
  const db = new RelayDatabase({ dbPath: ':memory:' });
  const store = new RunStore(db);
  store.insertRun({
    runId: 'run-verify',
    workspaceKey: 'ws-verify',
    workspacePath: 'C:/tmp/ws-verify',
    goal: 'Latest evidence',
    state: 'RUNNING',
    unitCount: 3
  });
  const tasks: TaskItem[] = [
    { taskId: 'v1', requirementId: 'req-root', title: 'First', description: '', dependencies: [],
      status: 'completed', allowedPaths: [], expectedArtifacts: [], testEvidenceHash: 'ev-first', completedAt: 1 },
    { taskId: 'v2', requirementId: 'req-root', title: 'Second', description: '', dependencies: ['v1'],
      status: 'completed', allowedPaths: [], expectedArtifacts: [], testEvidenceHash: 'ev-second', completedAt: 2 },
    { taskId: 'v3', requirementId: 'req-root', title: 'Third', description: '', dependencies: ['v2'],
      status: 'in_progress', allowedPaths: [], expectedArtifacts: [] }
  ];
  store.appendTaskSnapshot('run-verify', 1, JSON.stringify(tasks), 'hash-verify');

  const view = buildRunStatus(store, 'run-verify');
  assert.strictEqual(view.progress.completed, 2);
  assert.strictEqual(view.verification.taskId, 'v2');
  assert.strictEqual(view.verification.taskIndex, 2);
  assert.strictEqual(view.verification.evidenceHash, 'ev-second');
  assert.match(renderStatusCard(view), /^验证: Unit 2 已通过 · 证据 ev-second/m);

  db.close();
});

test('status: paused and blocked reasons are surfaced', () => {
  const { db, store, runId } = seedRun();
  store.updateRunState(runId, 'PAUSED', { pauseReason: 'user_pause_next_node' });
  const paused = buildRunStatus(store, runId);
  assert.strictEqual(paused.control.paused, true);
  assert.strictEqual(paused.control.pauseReason, 'user_pause_next_node');
  assert.match(renderStatusCard(paused), /^控制: 已暂停 · 原因: user_pause_next_node/m);

  store.updateRunState(runId, 'BLOCKED', { blockedReason: 'loop_detected_u2' });
  const blocked = buildRunStatus(store, runId);
  assert.strictEqual(blocked.control.blockedReason, 'loop_detected_u2');
  assert.match(renderStatusCard(blocked), /loop_detected_u2/);
  db.close();
});

test('status: run without any snapshot or chain still renders a valid card', () => {
  const db = new RelayDatabase({ dbPath: ':memory:' });
  const store = new RunStore(db);
  store.insertRun({
    runId: 'run-empty',
    workspaceKey: 'ws-empty',
    workspacePath: 'C:/tmp/ws-empty',
    goal: 'fresh run',
    state: 'INITIALIZING',
    unitCount: 3
  });

  const view = buildRunStatus(store, 'run-empty');
  assert.strictEqual(view.progress.total, 3);
  assert.strictEqual(view.progress.completed, 0);
  assert.strictEqual(view.progress.currentTaskId, undefined);
  assert.strictEqual(view.handoff, null);
  assert.strictEqual(view.model, null);
  assert.strictEqual(view.verification.verified, false);
  assert.match(renderStatusCard(view), /^进度: 0\/3 单元完成/m);
  db.close();
});

test('status: total falls back to the run unit count when no snapshot exists yet', () => {
  const db = new RelayDatabase({ dbPath: ':memory:' });
  const store = new RunStore(db);
  store.insertRun({
    runId: 'run-nosnapshot',
    workspaceKey: 'ws-nosnapshot',
    workspacePath: 'C:/tmp/ws-nosnapshot',
    goal: 'Fallback denominator',
    state: 'RUNNING',
    unitCount: 4
  });

  const view = buildRunStatus(store, 'run-nosnapshot');
  assert.strictEqual(view.progress.total, 4, 'total must come from the run row before any snapshot is written');
  assert.strictEqual(view.progress.completed, 0);
  assert.match(renderStatusCard(view), /^进度: 0\/4 单元完成/m);

  db.close();
});

test('status: buildRunStatus throws for an unknown run and json output is parseable', () => {
  const { db, store, runId } = seedRun();
  assert.throws(() => buildRunStatus(store, 'nope'), /unknown run/i);

  const json = JSON.parse(renderStatusJson(buildRunStatus(store, runId))) as Record<string, unknown>;
  assert.strictEqual(json.runId, runId);
  assert.strictEqual((json.progress as Record<string, unknown>).completed, 1);
  db.close();
});

test('status: writeStateProjection writes a rebuildable state.md and is idempotent', () => {
  const { db, store, runId } = seedRun();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-relay-status-'));

  const view = buildRunStatus(store, runId);
  const firstPath = writeStateProjection(dataDir, view);

  assert.strictEqual(firstPath, path.join(dataDir, runId, 'state.md'));
  const content = fs.readFileSync(firstPath, 'utf8');
  assert.strictEqual(content, renderStatusCard(view), 'state.md is a projection of the authoritative view');

  // 引擎每个 tick 都会重写投影；必须是真的覆盖，而不是「已存在就跳过」，
  // 否则用户看到的 state.md 会停在第一次写入的旧内容上。
  store.updateRunState(runId, 'PAUSED', { pauseReason: 'user_pause_next_node' });
  const pausedView = buildRunStatus(store, runId);
  const changedPath = writeStateProjection(dataDir, pausedView);
  assert.strictEqual(changedPath, firstPath);
  const changed = fs.readFileSync(changedPath, 'utf8');
  assert.notStrictEqual(changed, content, 'a changed view must replace state.md, not be skipped');
  assert.strictEqual(changed, renderStatusCard(pausedView));
  assert.match(changed, /已暂停/);

  // 投影可从权威库完整重建（写入前先清空，证明它不是第二份真相）
  fs.rmSync(path.join(dataDir, runId), { recursive: true, force: true });
  const rebuiltPath = writeStateProjection(dataDir, buildRunStatus(store, runId));
  assert.strictEqual(fs.readFileSync(rebuiltPath, 'utf8'), changed);

  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
