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
    unitCount: 0
  });

  const view = buildRunStatus(store, 'run-empty');
  assert.strictEqual(view.progress.total, 0);
  assert.strictEqual(view.progress.completed, 0);
  assert.strictEqual(view.progress.currentTaskId, undefined);
  assert.strictEqual(view.handoff, null);
  assert.strictEqual(view.model, null);
  assert.strictEqual(view.verification.verified, false);
  assert.match(renderStatusCard(view), /^进度: 0\/0 单元完成/m);
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
  const secondPath = writeStateProjection(dataDir, buildRunStatus(store, runId));

  assert.strictEqual(firstPath, secondPath);
  assert.strictEqual(firstPath, path.join(dataDir, runId, 'state.md'));
  const content = fs.readFileSync(firstPath, 'utf8');
  assert.strictEqual(content, renderStatusCard(view), 'state.md is a projection of the authoritative view');

  // 投影可从权威库完整重建（写入前先清空，证明它不是第二份真相）
  fs.rmSync(path.join(dataDir, runId), { recursive: true, force: true });
  const rebuiltPath = writeStateProjection(dataDir, buildRunStatus(store, runId));
  assert.strictEqual(fs.readFileSync(rebuiltPath, 'utf8'), content);

  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
