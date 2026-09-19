# P3-01 崩溃、掉线与部分任务恢复实现计划 (Crash, Offline & Partial Recovery)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建完备的崩溃故障恢复机制与两阶段对账器（Two-Phase Reconciler），实现持久化发信箱（`run_outbox`）、工作区指纹严格防御、非终态故障自愈与 10 个状态机边界的故障注入测试套件，彻底满足 V07, V14, V16, V17, V18, V25, V26, V33 验收要求。

**Architecture:** 
1. 持久化层扩展：在 SQLite WAL 库中引入 `run_outbox` 表，记录外部 RPC（会话创建、令牌发放）状态与重试信息。
2. 运行编排层：`RunController` 增加无侵入 `faultHook`，并在启动/重启边界执行 `reconcile()`（Phase 1 静态快照清理、Phase 2 工作区指纹严格审计、Phase 3 外部会话与发信箱自愈）。
3. 异常边界：单元失败保持 `in_progress` 并固化诊断现场；长作业与未知外部操作清晰停在 `RECOVERY_REQUIRED`；CAS 转让后并发取消递增 epoch 废弃令牌。
4. 恢复测试套件：`tests/recovery/` 下 5 个端到端回归测试，自动化验证 5 项机械恢复不变量。

**Tech Stack:** Node.js 24 原生 `node:sqlite`, `node:test`, `node:assert/strict`, Git CLI, TypeScript (ESM, `--experimental-strip-types`)。

**Spec:** `docs/superpowers/specs/2026-09-19-agent-relay-p3-01-crash-recovery-design.md`

## Global Constraints

- **不可破坏用户代码**：工作区指纹一旦失配，转入 `RECOVERY_REQUIRED` 并暴露差异，严禁自动 `git reset --hard` 或 `git stash`。
- **不可伪报完成**：单元执行失败时任务保持 `in_progress` 并记录错误诊断；未知结果时严禁标记完成。
- **单写入者 CAS 租约**：任何时刻物理工作区仅允许唯一的有效 Owner 写入，其 epoch 严格单调递增。
- **不可变哈希稳定**：崩溃恢复后，`inputLedgerHeadHash` 与 `taskSnapshotHash` 与崩溃前记录的哈希完全一致。
- **零额外运行时依赖**：完全基于 Node.js 24 原生内置能力（`node:sqlite`、`node:crypto`、`node:fs`、`node:child_process`），零引入三方 npm 模块。

---

### Task 1: 持久化发信箱表 (`run_outbox`) 与 Store 访问接口

**Files:**
- Modify: `packages/controller/src/run/db.ts:60-150`
- Modify: `packages/controller/src/run/store.ts:1-200`
- Test: `tests/run/outbox-store.test.ts`

**Interfaces:**
- Consumes: `RelayDatabase` 连接与保存点事务
- Produces: 
  - `OutboxRow`: `{ msgId: string; runId: string; handoffId: string | null; topic: string; targetSessionId: string | null; payload: string; state: 'PENDING' | 'DISPATCHED' | 'ACKED' | 'FAILED'; attempts: number; lastError: string | null; createdAt: number; updatedAt: number }`
  - `RunStore.enqueueOutbox(input)`
  - `RunStore.updateOutboxState(msgId, state, options)`
  - `RunStore.getOutbox(msgId)`
  - `RunStore.findOutboxByHandoff(handoffId, topic)`
  - `RunStore.listPendingOutbox(runId)`

- [ ] **Step 1: 编写测试用例 `tests/run/outbox-store.test.ts`**

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RelayDatabase } from '../../packages/controller/src/run/db.ts';
import { RunStore } from '../../packages/controller/src/run/store.ts';

test('outbox-store: enqueue, retrieve, update, and query pending outbox messages', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'outbox-test-'));
  const dbPath = path.join(tmpDir, 'relay.db');
  const db = new RelayDatabase({ dbPath });
  const store = new RunStore(db);

  try {
    store.insertRun({
      runId: 'run-outbox-1',
      workspaceKey: 'ws-key',
      workspacePath: 'C:/ws',
      goal: 'Test outbox',
      model: { provider: 'test', model: 'test-m' },
      state: 'RUNNING',
      unitCount: 1
    });

    const enqueued = store.enqueueOutbox({
      runId: 'run-outbox-1',
      handoffId: 'h-1',
      topic: 'create_session',
      targetSessionId: 'sess-target-1',
      payload: { readOnly: true }
    });

    assert.ok(enqueued.msgId);
    assert.strictEqual(enqueued.runId, 'run-outbox-1');
    assert.strictEqual(enqueued.handoffId, 'h-1');
    assert.strictEqual(enqueued.topic, 'create_session');
    assert.strictEqual(enqueued.targetSessionId, 'sess-target-1');
    assert.strictEqual(enqueued.state, 'PENDING');
    assert.strictEqual(enqueued.attempts, 0);

    const retrieved = store.getOutbox(enqueued.msgId);
    assert.ok(retrieved);
    assert.strictEqual(retrieved.msgId, enqueued.msgId);
    assert.deepStrictEqual(JSON.parse(retrieved.payload), { readOnly: true });

    const byHandoff = store.findOutboxByHandoff('h-1', 'create_session');
    assert.ok(byHandoff);
    assert.strictEqual(byHandoff.msgId, enqueued.msgId);

    const pendingList = store.listPendingOutbox('run-outbox-1');
    assert.strictEqual(pendingList.length, 1);

    store.updateOutboxState(enqueued.msgId, 'DISPATCHED', { incrementAttempts: true });
    const updated = store.getOutbox(enqueued.msgId);
    assert.strictEqual(updated?.state, 'DISPATCHED');
    assert.strictEqual(updated?.attempts, 1);

    store.updateOutboxState(enqueued.msgId, 'ACKED');
    const acked = store.getOutbox(enqueued.msgId);
    assert.strictEqual(acked?.state, 'ACKED');

    const pendingAfterAck = store.listPendingOutbox('run-outbox-1');
    assert.strictEqual(pendingAfterAck.length, 0);
  } finally {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 运行测试验证失败**

运行：`node --experimental-strip-types tests/run/outbox-store.test.ts`
预期：FAIL，`enqueueOutbox is not a function`

- [ ] **Step 3: 修改 `db.ts` 与 `store.ts` 实现发信箱存储**

在 `RelayDatabase.MIGRATIONS` 追加创建 `run_outbox` 表及其索引：
```typescript
  `CREATE TABLE IF NOT EXISTS run_outbox (
    msg_id            TEXT PRIMARY KEY,
    run_id            TEXT NOT NULL,
    handoff_id        TEXT,
    topic             TEXT NOT NULL,
    target_session_id TEXT,
    payload           TEXT NOT NULL DEFAULT '{}',
    state             TEXT NOT NULL,
    attempts          INTEGER NOT NULL DEFAULT 0,
    last_error        TEXT,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_outbox_run ON run_outbox(run_id, state)`,
  `CREATE INDEX IF NOT EXISTS idx_outbox_handoff ON run_outbox(handoff_id)`
```

在 `RunStore` 中实现类型定义与增删改查：
- `enqueueOutbox(input)`: 默认 `randomUUID()`, `state: 'PENDING'`, 序列化 payload，落库并返回 `OutboxRow`。
- `updateOutboxState(msgId, state, options)`: 事务内更新状态、重试次数、最后错误及 `updated_at`。
- `getOutbox(msgId)`: 按主键查询。
- `findOutboxByHandoff(handoffId, topic)`: 按交接 ID 与主题查重。
- `listPendingOutbox(runId)`: 筛选 `state IN ('PENDING', 'DISPATCHED')`。

- [ ] **Step 4: 运行测试验证通过**

运行：`node --experimental-strip-types tests/run/outbox-store.test.ts`
预期：PASS

- [ ] **Step 5: 提交代码**

```bash
git add packages/controller/src/run/db.ts packages/controller/src/run/store.ts tests/run/outbox-store.test.ts
git commit -m "feat(store): add durable outbox table and accessors for crash recovery"
```

---

### Task 2: 故障注入挂钩架构与 Outbox 融入交接八步

**Files:**
- Modify: `packages/controller/src/run/engine.ts:50-130, 680-860`
- Test: `tests/run/fault-hook.test.ts`

**Interfaces:**
- Consumes: `RunStore`, `RelayDatabase`, `AgentRelayAdapter`
- Produces: 
  - `FaultInjectionPoint`, `FaultContext`, `FaultHook` 类型定义在 `engine.ts` 中导出。
  - `RunControllerOptions.faultHook` 挂钩支持。
  - 交接步骤 4 前置在同一个原子事务中写入 `run_outbox`（`topic: 'create_session'`），创建完成后置为 `DISPATCHED`，ACK 成功后置为 `ACKED`。
  - 步骤 8 令牌投递前写入 `run_outbox`（`topic: 'authorize_execution'`），投递成功后置为 `ACKED`。

- [ ] **Step 1: 编写测试用例 `tests/run/fault-hook.test.ts`**

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RelayDatabase } from '../../packages/controller/src/run/db.ts';
import { RunStore } from '../../packages/controller/src/run/store.ts';
import { RunController, type FaultInjectionPoint } from '../../packages/controller/src/run/engine.ts';
import { MockAdapter } from '../fixtures/mock-adapter.ts';

test('fault-hook: triggers hook at key boundaries and records outbox records', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fault-test-'));
  const dbPath = path.join(tmpDir, 'relay.db');
  const db = new RelayDatabase({ dbPath });
  const store = new RunStore(db);
  const adapter = new MockAdapter();

  const firedPoints: FaultInjectionPoint[] = [];

  const controller = new RunController({
    store,
    dataDir: tmpDir,
    adapter,
    adapterName: 'claude',
    createCoordinator: (deps) => adapter.createCoordinator(deps),
    settleTimeoutMs: 50,
    quiescenceTimeoutMs: 50,
    faultHook: (point) => {
      firedPoints.push(point);
    }
  });

  try {
    controller.startRun({
      runId: 'run-fault-1',
      workspacePath: tmpDir,
      goal: 'Test fault injection',
      model: { provider: 'anthropic', model: 'claude-3-7-sonnet' },
      tasks: [
        { taskId: 'u1', requirementId: 'req-1', title: 'Task 1' },
        { taskId: 'u2', requirementId: 'req-1', title: 'Task 2' }
      ],
      initialUserMessage: 'Do it'
    });

    // 触发第一个 tick 执行 u1
    const outcome1 = await controller.tick();
    assert.strictEqual(outcome1.kind, 'unit_executed');

    // 触发第二个 tick 执行交接并观察故障挂钩触发
    const outcome2 = await controller.tick();
    assert.strictEqual(outcome2.kind, 'handoff_performed');

    assert.ok(firedPoints.includes('during_snapshot_write'));
    assert.ok(firedPoints.includes('after_snapshot_file_written'));
    assert.ok(firedPoints.includes('before_session_create_call'));
    assert.ok(firedPoints.includes('after_ack_received'));
    assert.ok(firedPoints.includes('after_owner_cas'));

    // 校验 outbox 记录
    const outboxMessages = store.listPendingOutbox('run-fault-1');
    assert.strictEqual(outboxMessages.length, 0); // 正常完成后所有消息均已 ACKED
  } finally {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 运行测试验证失败**

运行：`node --experimental-strip-types tests/run/fault-hook.test.ts`
预期：FAIL，`FaultInjectionPoint` 未定义或 `faultHook` 未被触发。

- [ ] **Step 3: 修改 `engine.ts` 实现故障挂钩与发信箱事务融合**

1. 导出 `FaultInjectionPoint`, `FaultContext`, `FaultHook`。
2. 在 `RunControllerOptions` 中增加 `faultHook?: FaultHook`。
3. 私有辅助函数 `private async triggerFaultHook(point: FaultInjectionPoint, ctx: FaultContext = {})`。
4. 在 `performHandoff` 中：
   - 快照生成前触发 `during_snapshot_write`；快照写入后落库前触发 `after_snapshot_file_written`；事务提交后触发 `after_db_publish`。
   - 步骤 4 创建会话前在同一个事务内执行 `store.enqueueOutbox({ runId, handoffId, topic: 'create_session', targetSessionId: toSessionId })`，并触发 `before_session_create_call`。
   - 调用 `createFresh` 之后更新发信箱为 `DISPATCHED`，并触发 `session_create_response_lost`（供模拟丢回包）。
   - ACK 核验完成后触发 `after_ack_received`。
   - CAS 事务提交完成后触发 `after_owner_cas`。
   - 步骤 8 令牌发送成功后，将 `create_session` 与令牌投递发信箱标记为 `ACKED`。

- [ ] **Step 4: 运行测试验证通过**

运行：`node --experimental-strip-types tests/run/fault-hook.test.ts`
预期：PASS

- [ ] **Step 5: 提交代码**

```bash
git add packages/controller/src/run/engine.ts tests/run/fault-hook.test.ts
git commit -m "feat(engine): add fault injection hooks and wire durable outbox in handoff flow"
```

---

### Task 3: 两阶段对账器 Phase 1 & Phase 2：快照自愈 (V16)、意图守卫 (V21) 与工作区防御 (V25)

**Files:**
- Create: `packages/controller/src/run/reconciler.ts`
- Modify: `packages/controller/src/run/engine.ts:80-250`
- Test: `tests/run/reconciler-phase1-phase2.test.ts`

**Interfaces:**
- Consumes: `RunStore`, `WorkspaceSentinel`, `ControlIntentLog`, `RelayDatabase`
- Produces: 
  - `RunReconciler.reconcile(runId: string)`:
    - Phase 1: 扫描孤立/损坏快照文件并清理；如果存在未消费 `stop_now`，安全保持 `CANCELLED`。
    - Phase 2: 调用 `WorkspaceSentinel.captureFingerprint()` 与快照记录比对；若存在 Commit 变更或外部未记录文件修改，转入 `RECOVERY_REQUIRED`（`blockedReason: 'workspace_fingerprint_mismatch'`），保留现场。

- [ ] **Step 1: 编写测试用例 `tests/run/reconciler-phase1-phase2.test.ts`**

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { RelayDatabase } from '../../packages/controller/src/run/db.ts';
import { RunStore } from '../../packages/controller/src/run/store.ts';
import { RunController } from '../../packages/controller/src/run/engine.ts';
import { MockAdapter } from '../fixtures/mock-adapter.ts';

test('reconciler: Phase 1 removes orphaned corrupted snapshot files and preserves valid state (V16)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-p1-'));
  const dbPath = path.join(tmpDir, 'relay.db');
  const db = new RelayDatabase({ dbPath });
  const store = new RunStore(db);
  const adapter = new MockAdapter();

  try {
    const controller = new RunController({
      store,
      dataDir: tmpDir,
      adapter,
      adapterName: 'claude',
      createCoordinator: (deps) => adapter.createCoordinator(deps)
    });

    controller.startRun({
      runId: 'run-rec-1',
      workspacePath: tmpDir,
      goal: 'Snapshot clean test',
      model: { provider: 'test', model: 'test-m' },
      tasks: [{ taskId: 'u1', requirementId: 'req-1', title: 'T1' }],
      initialUserMessage: 'init'
    });

    // 构造孤立/损坏的快照文件
    const orphanDir = path.join(tmpDir, 'relay-data', 'run-rec-1', 'handoffs', 'h-orphan');
    fs.mkdirSync(orphanDir, { recursive: true });
    fs.writeFileSync(path.join(orphanDir, 'manifest.json'), 'corrupted json {', 'utf8');

    // 运行 reconcile
    const result = await controller.reconcile();
    assert.strictEqual(result.requiresManualIntervention, false);
    assert.strictEqual(fs.existsSync(path.join(orphanDir, 'manifest.json')), false, 'corrupted manifest must be purged');
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
  const adapter = new MockAdapter();

  try {
    const controller = new RunController({
      store,
      dataDir: tmpDir,
      adapter,
      adapterName: 'claude',
      createCoordinator: (deps) => adapter.createCoordinator(deps)
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
```

- [ ] **Step 2: 运行测试验证失败**

运行：`node --experimental-strip-types tests/run/reconciler-phase1-phase2.test.ts`
预期：FAIL，`controller.reconcile is not a function`

- [ ] **Step 3: 创建 `reconciler.ts` 并集成进 `engine.ts`**

1. 创建 `packages/controller/src/run/reconciler.ts`，导出 `RunReconciler` 与 `ReconcileResult`。
2. 实现 Phase 1：
   - 扫描 `handoffs` 目录，验证每个 `manifest.json` 与数据库中的 `manifest_hash` 对齐，若表无对应记录或文件内容哈希失配，执行删除并记录 `healedActions.push('purged_corrupted_snapshot:' + handoffId)`。
   - 读取 `intents.resolve(runId)`，若包含未消费的 `stop_now`，直接更新为 `CANCELLED`。
3. 实现 Phase 2：
   - 调用 `WorkspaceSentinel.captureFingerprint()` 比对最近一次快照中的基线指纹。
   - 若 commitHash 不一致或出现外部未预期改动，更新 `run.state = 'RECOVERY_REQUIRED'`, `blockedReason = 'workspace_fingerprint_mismatch'`，并在事件日志中落盘 `workspace_mismatch_detected`。
4. 在 `RunController` 增加 `public async reconcile(): Promise<ReconcileResult>` 并委托给 `RunReconciler`。在 `rehydrate` 与 `tick()` 发现中间态时自动调用。

- [ ] **Step 4: 运行测试验证通过**

运行：`node --experimental-strip-types tests/run/reconciler-phase1-phase2.test.ts`
预期：PASS

- [ ] **Step 5: 提交代码**

```bash
git add packages/controller/src/run/reconciler.ts packages/controller/src/run/engine.ts tests/run/reconciler-phase1-phase2.test.ts
git commit -m "feat(reconciler): add Phase 1 snapshot self-healing and Phase 2 workspace mismatch defense"
```

---

### Task 4: 两阶段对账器 Phase 3：Outbox 会话对账 (V14)、幂等令牌重投 (V17) 与旧静止防护 (V18)

**Files:**
- Modify: `packages/controller/src/run/reconciler.ts`
- Modify: `packages/controller/src/run/engine.ts`
- Test: `tests/run/reconciler-phase3.test.ts`

**Interfaces:**
- Consumes: `RunStore`, `AgentRelayAdapter`, `HandshakeCoordinator`
- Produces: 
  - Phase 3 会话对账：
    - `run_outbox` 中挂起的 `create_session`：查询适配器会话列表；若会话已存在，重绑并推进至 ACK 阶段（V14）；若无法确认，停在 `RECOVERY_REQUIRED`。
    - `handoffs.state === 'AUTHORIZED'` 且令牌未送达：重新投递带相同 epoch 的执行令牌，补齐会话链（V17）。
    - 处于 `DRAINING` 态且旧会话未静止：尝试再次中断；若无法确认静止，停在 `RECOVERY_REQUIRED`（V18）。

- [ ] **Step 1: 编写测试用例 `tests/run/reconciler-phase3.test.ts`**

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RelayDatabase } from '../../packages/controller/src/run/db.ts';
import { RunStore } from '../../packages/controller/src/run/store.ts';
import { RunController } from '../../packages/controller/src/run/engine.ts';
import { MockAdapter } from '../fixtures/mock-adapter.ts';

test('reconciler: Phase 3 rebinds existing session when create response was lost (V14)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-p3-v14-'));
  const dbPath = path.join(tmpDir, 'relay.db');
  const db = new RelayDatabase({ dbPath });
  const store = new RunStore(db);
  const adapter = new MockAdapter();

  try {
    store.insertRun({
      runId: 'run-v14',
      workspaceKey: 'ws-k',
      workspacePath: tmpDir,
      goal: 'V14 test',
      model: { provider: 'test', model: 'test-m' },
      state: 'STARTING',
      unitCount: 2
    });

    store.insertHandoff({
      handoffId: 'h-v14-1',
      runId: 'run-v14',
      epoch: 1,
      sourceSessionId: 'sess-old',
      targetSessionId: 'sess-new-created',
      state: 'CREATING'
    });

    store.enqueueOutbox({
      runId: 'run-v14',
      handoffId: 'h-v14-1',
      topic: 'create_session',
      targetSessionId: 'sess-new-created'
    });

    // 适配器模拟服务端已创建该 session
    adapter.injectExistingSession('sess-new-created', tmpDir);

    const controller = new RunController({
      store,
      dataDir: tmpDir,
      adapter,
      adapterName: 'claude',
      createCoordinator: (deps) => adapter.createCoordinator(deps)
    });
    controller.rehydrate('run-v14');

    const result = await controller.reconcile();
    assert.strictEqual(result.requiresManualIntervention, false);
    assert.ok(result.healedActions.some((a) => a.includes('rebound_session:sess-new-created')));
  } finally {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('reconciler: Phase 3 re-issues idempotent execution token when crash occurred after CAS (V17)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-p3-v17-'));
  const dbPath = path.join(tmpDir, 'relay.db');
  const db = new RelayDatabase({ dbPath });
  const store = new RunStore(db);
  const adapter = new MockAdapter();

  try {
    store.insertRun({
      runId: 'run-v17',
      workspaceKey: 'ws-k',
      workspacePath: tmpDir,
      goal: 'V17 test',
      model: { provider: 'test', model: 'test-m' },
      state: 'PREPARING',
      unitCount: 2
    });

    store.insertHandoff({
      handoffId: 'h-v17-1',
      runId: 'run-v17',
      epoch: 1,
      sourceSessionId: 'sess-old',
      targetSessionId: 'sess-target',
      state: 'AUTHORIZED'
    });

    store.setAuthorization('run-v17', {
      inputHeadHash: 'hash-input',
      contractVersion: 1,
      intentWatermark: 1
    });

    let tokenDispatched = false;
    adapter.onAuthorizeExecution = (sessionId, epoch, token) => {
      if (sessionId === 'sess-target' && epoch === 2) {
        tokenDispatched = true;
        return true;
      }
      return false;
    };

    const controller = new RunController({
      store,
      dataDir: tmpDir,
      adapter,
      adapterName: 'claude',
      createCoordinator: (deps) => adapter.createCoordinator(deps)
    });
    controller.rehydrate('run-v17');

    const result = await controller.reconcile();
    assert.strictEqual(result.requiresManualIntervention, false);
    assert.strictEqual(result.recoveredState, 'RUNNING');
    assert.strictEqual(tokenDispatched, true);
  } finally {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 运行测试验证失败**

运行：`node --experimental-strip-types tests/run/reconciler-phase3.test.ts`
预期：FAIL，Phase 3 未实现对账逻辑。

- [ ] **Step 3: 完善 `RunReconciler` Phase 3 对账逻辑**

在 `reconciler.ts` 中实现：
1. 遍历 `store.listPendingOutbox(runId)`：
   - 若 `topic === 'create_session'` 且 handoff 状态为 `CREATING/PREPARING`：
     - 调用 `adapter.hasSession(targetSessionId)`；
     - 若为 true，更新 outbox 为 `DISPATCHED`，handoff 恢复为准备中，推进 ACK；
     - 若为 false 且无法查明，标记 `requiresManualIntervention = true`, `reason = 'session_creation_ambiguous'`。
2. 检查处于 `AUTHORIZED` 的 handoff 记录：
   - 获取 `store.getAuthorization(runId)`，调用 `adapter.authorizeExecution(targetSessionId, nextEpoch, token)` 补发令牌；
   - 补发成功后在事务内更新 handoff 为 `COMPLETED`，追加 `session_chain`，将 run 置为 `RUNNING`。
3. 检查处于 `DRAINING` 态且会话仍在运行的记录：
   - 触发 `interruptOwned` 并等待静止；无法确认静止则置为 `RECOVERY_REQUIRED`（`old_session_quiescence_unconfirmed`）。

- [ ] **Step 4: 运行测试验证通过**

运行：`node --experimental-strip-types tests/run/reconciler-phase3.test.ts`
预期：PASS

- [ ] **Step 5: 提交代码**

```bash
git add packages/controller/src/run/reconciler.ts packages/controller/src/run/engine.ts tests/run/reconciler-phase3.test.ts
git commit -m "feat(reconciler): add Phase 3 outbox session rebind, idempotent token replay and quiescence guard"
```

---

### Task 5: 异常执行边界：部分任务失败 (V07)、长作业/超时 (V26) 与 late cancellation (V33)

**Files:**
- Modify: `packages/controller/src/run/engine.ts:500-600, 750-860`
- Modify: `packages/controller/src/run/prompt.ts`
- Test: `tests/run/edge-boundaries.test.ts`

**Interfaces:**
- Consumes: `RunStore`, `TaskGraph`, `LoopDetector`
- Produces: 
  - V07: `executeUnit` 中测试失败时保持任务状态为 `in_progress`，记录诊断证据，并在 `resume.md` 标注部分完成现场。
  - V26: 外部动作超时或长作业未决时，将 run 标记为 `RECOVERY_REQUIRED`（`external_action_outcome_unknown`），不重试外部副作用。
  - V33: 在 CAS 转让后、令牌消费前检测到取消意图时，递增 epoch 使令牌失效，静止后进入 `CANCELLED`。

- [ ] **Step 1: 编写测试用例 `tests/run/edge-boundaries.test.ts`**

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RelayDatabase } from '../../packages/controller/src/run/db.ts';
import { RunStore } from '../../packages/controller/src/run/store.ts';
import { RunController } from '../../packages/controller/src/run/engine.ts';
import { ControlIntentLog } from '../../packages/controller/src/run/intent.ts';
import { MockAdapter } from '../fixtures/mock-adapter.ts';

test('boundaries: unit failure keeps task in_progress and captures failure signature (V07)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bound-v07-'));
  const dbPath = path.join(tmpDir, 'relay.db');
  const db = new RelayDatabase({ dbPath });
  const store = new RunStore(db);
  const adapter = new MockAdapter();

  try {
    const controller = new RunController({
      store,
      dataDir: tmpDir,
      adapter,
      adapterName: 'claude',
      createCoordinator: (deps) => adapter.createCoordinator(deps)
    });

    controller.startRun({
      runId: 'run-v07',
      workspacePath: tmpDir,
      goal: 'Partial task test',
      model: { provider: 'test', model: 'test-m' },
      tasks: [{ taskId: 'u1', requirementId: 'req-1', title: 'Task 1' }],
      initialUserMessage: 'init'
    });

    // 模拟适配器返回测试失败结果
    adapter.setUnitOutput('run-v07-s1', {
      taskId: 'u1',
      status: 'failed',
      summary: 'Compilation error: cannot find module X'
    });

    const outcome = await controller.tick();
    assert.strictEqual(outcome.kind, 'unit_executed');
    assert.strictEqual(outcome.status, 'failed');

    // 验证任务状态绝未被误标为 completed
    const run = store.getRun('run-v07')!;
    assert.strictEqual(run.state, 'RUNNING');
    const snapshot = JSON.parse(store.getLatestTaskSnapshot('run-v07')!.snapshotJson);
    assert.strictEqual(snapshot[0].status, 'in_progress');
  } finally {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('boundaries: late stop intent after owner CAS invalidates execution token and halts in CANCELLED (V33)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bound-v33-'));
  const dbPath = path.join(tmpDir, 'relay.db');
  const db = new RelayDatabase({ dbPath });
  const store = new RunStore(db);
  const adapter = new MockAdapter();

  try {
    const controller = new RunController({
      store,
      dataDir: tmpDir,
      adapter,
      adapterName: 'claude',
      createCoordinator: (deps) => adapter.createCoordinator(deps),
      faultHook: async (point) => {
        if (point === 'after_owner_cas') {
          // 在 CAS 转让成功后、继续令牌发送前注入 stop_now
          new ControlIntentLog(store).append('run-v33', 'stop_now');
        }
      }
    });

    controller.startRun({
      runId: 'run-v33',
      workspacePath: tmpDir,
      goal: 'Late stop test',
      model: { provider: 'test', model: 'test-m' },
      tasks: [
        { taskId: 'u1', requirementId: 'req-1', title: 'T1' },
        { taskId: 'u2', requirementId: 'req-1', title: 'T2' }
      ],
      initialUserMessage: 'init'
    });

    await controller.tick(); // 执行 u1
    const handoffOutcome = await controller.tick(); // 执行交接并在 after_owner_cas 拦截

    assert.strictEqual(handoffOutcome.kind, 'stopped');
    const run = store.getRun('run-v33')!;
    assert.strictEqual(run.state, 'CANCELLED');
  } finally {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 运行测试验证失败**

运行：`node --experimental-strip-types tests/run/edge-boundaries.test.ts`
预期：FAIL，V33 注入未被正确识别并使令牌作废。

- [ ] **Step 3: 修改 `engine.ts` 实现边界防护**

1. 在 `executeUnit` 中：当 `status === 'failed'` 时，更新任务为 `in_progress` 并持久化 `failureSignature`。
2. 在 `performHandoff` 步骤 7 之后：
   - 检查 `intents.resolve(runId)`；若在 `after_owner_cas` 之后侦测到 `stop_now`，立即递增租约 `epoch`，使刚授权的 epoch 失效。
   - 调用 `adapter.interruptOwned(toSessionId)` 确认静止，标记 `state = 'CANCELLED'`，返回 `{ kind: 'stopped' }`。

- [ ] **Step 4: 运行测试验证通过**

运行：`node --experimental-strip-types tests/run/edge-boundaries.test.ts`
预期：PASS

- [ ] **Step 5: 提交代码**

```bash
git add packages/controller/src/run/engine.ts tests/run/edge-boundaries.test.ts
git commit -m "feat(engine): implement partial task failure diagnostics and post-CAS token invalidation"
```

---

### Task 6: 验收套件 — 快照崩溃与孤立文件清理 (`tests/recovery/snapshot-crash.test.ts`, V16)

**Files:**
- Create: `tests/recovery/snapshot-crash.test.ts`

**Interfaces:**
- Consumes: `RunController`, `RelayDatabase`, `MockAdapter`
- Produces: 完整覆盖 V16 验收测试（半写快照断电损坏、快照未发布的孤立文件清理、恢复选择最近完整快照）。

- [ ] **Step 1: 编写端到端验收测试 `tests/recovery/snapshot-crash.test.ts`**

覆盖场景：
1. 快照写入中崩溃（`during_snapshot_write`），磁盘留下损坏的半写快照文件。重启后 `reconcile()` 安全清理孤立损坏文件，状态回退并重新执行快照。
2. 快照文件已写完但数据库事务未提交前崩溃（`after_snapshot_file_written`）。重启后清理孤立快照，不会被后继会话加载。
3. 验证 5 条恢复机械不变量（单写入者、哈希稳定、零数据丢失等）。

- [ ] **Step 2: 运行测试验证**

运行：`node --experimental-strip-types tests/recovery/snapshot-crash.test.ts`
预期：PASS

- [ ] **Step 3: 提交代码**

```bash
git add tests/recovery/snapshot-crash.test.ts
git commit -m "test(recovery): add V16 snapshot crash and orphan purge acceptance suite"
```

---

### Task 7: 验收套件 — 发信箱对账与幂等令牌重发 (`tests/recovery/outbox-reconcile.test.ts`, V14, V17)

**Files:**
- Create: `tests/recovery/outbox-reconcile.test.ts`

**Interfaces:**
- Consumes: `RunController`, `RelayDatabase`, `MockAdapter`
- Produces: 完整覆盖 V14（创建响应丢失对账）与 V17（ACK 后令牌未达崩溃幂等重发）验收测试。

- [ ] **Step 1: 编写端到端验收测试 `tests/recovery/outbox-reconcile.test.ts`**

覆盖场景：
1. **V14**: 在 `session_create_response_lost` 注入崩溃。重启后 `reconcile()` 查出 outbox 记录，与适配器会话列表比对成功，复用既有 session，不重复创建 worker。
2. **V17**: 在 `after_owner_cas` 注入崩溃。重启后识别 `AUTHORIZED` 状态，只重发幂等继续令牌，顺利交接完成，不重复执行任务。
3. 验证 5 条恢复机械不变量。

- [ ] **Step 2: 运行测试验证**

运行：`node --experimental-strip-types tests/recovery/outbox-reconcile.test.ts`
预期：PASS

- [ ] **Step 3: 提交代码**

```bash
git add tests/recovery/outbox-reconcile.test.ts
git commit -m "test(recovery): add V14 session creation reconcile and V17 token replay acceptance suite"
```

---

### Task 8: 验收套件 — 工作区指纹严格防御 (`tests/recovery/workspace-recovery.test.ts`, V25)

**Files:**
- Create: `tests/recovery/workspace-recovery.test.ts`

**Interfaces:**
- Consumes: `RunController`, `WorkspaceSentinel`, Git CLI
- Produces: 完整覆盖 V25 验收测试（用户中途改文件、切换分支、移动工作区，主控安全停住，绝不破坏用户修改）。

- [ ] **Step 1: 编写端到端验收测试 `tests/recovery/workspace-recovery.test.ts`**

覆盖场景：
1. 交接期间外部 `git checkout` 切换分支，`reconcile()` 侦测到 Commit 失配，转入 `RECOVERY_REQUIRED`。
2. 交接期间外部新增未跟踪文件与修改受控文件，`reconcile()` 侦测到 dirtyFiles 异常，转入 `RECOVERY_REQUIRED`。
3. 断言校验：**绝对没有自动调用 git reset --hard 或 git stash**，用户修改的文件内容完整保留。
4. 验证 5 条恢复机械不变量。

- [ ] **Step 2: 运行测试验证**

运行：`node --experimental-strip-types tests/recovery/workspace-recovery.test.ts`
预期：PASS

- [ ] **Step 3: 提交代码**

```bash
git add tests/recovery/workspace-recovery.test.ts
git commit -m "test(recovery): add V25 workspace fingerprint mismatch and git branch switch defense suite"
```

---

### Task 9: 验收套件 — 僵死进程、重启意图保持与并发取消 (`tests/recovery/crash-recovery.test.ts`, V18, V21, V33)

**Files:**
- Create: `tests/recovery/crash-recovery.test.ts`

**Interfaces:**
- Consumes: `RunController`, `DurableLeaseManager`, `ControlIntentLog`
- Produces: 完整覆盖 V18（旧 worker 挂起静止超时）、V21（停止/关闭后重启不被误判为续跑）、V33（CAS 后令牌消费前并发取消）。

- [x] **Step 1: 编写端到端验收测试 `tests/recovery/crash-recovery.test.ts`**

覆盖场景：
1. **V18**: 旧 worker 静止超时，不凭租约过期强行转交写权，阻断在 `RECOVERY_REQUIRED`。
2. **V21**: 用户发出 `stop_now` 后控制器关闭，重启后依然为 `CANCELLED`，绝不自动续跑。
3. **V33**: 在 CAS 转让成功后、令牌消费前注入取消，递增 epoch 使令牌失效，新会话被终止并保持只读。
4. 验证 5 条恢复机械不变量。

- [x] **Step 2: 运行测试验证**

运行：`node --experimental-strip-types tests/recovery/crash-recovery.test.ts`
预期：PASS

- [x] **Step 3: 提交代码**

```bash
git add tests/recovery/crash-recovery.test.ts
git commit -m "test(recovery): add V18 quiescence timeout, V21 intent persistence and V33 late stop acceptance suite"
```

---

### Task 10: 验收套件 — 部分任务失败与长作业安全 (`tests/recovery/partial-tasks.test.ts`, V07, V26) 与全量套件验证

**Files:**
- Create: `tests/recovery/partial-tasks.test.ts`

**Interfaces:**
- Consumes: `RunController`, `RunStore`
- Produces: 完整覆盖 V07（单元测试失败记录诊断现场）、V26（长作业与超时未知结果不伪报完成、不重复重试），并跑通全部 264+ 测试用例。

- [x] **Step 1: 编写端到端验收测试 `tests/recovery/partial-tasks.test.ts`**

覆盖场景：
1. **V07**: 单元测试失败时任务保持 `in_progress`，记录失败证据与输出，恢复时交接包保留现场，不从头重做。
2. **V26**: 模拟长作业无法跨会话接管、外部动作超时未决，停在 `RECOVERY_REQUIRED`，不重复重放外部动作。
3. 自动化校验全部 5 项机械恢复不变量。

- [x] **Step 2: 运行全部测试套件验证整体绿灯**

运行：`npm test`
预期：全部现有 264 测试 + 新增恢复套件（预估共 280+ 测试）100% 通过，0 失败。

- [x] **Step 3: 提交代码与文档更新**

```bash
git add tests/recovery/partial-tasks.test.ts
git commit -m "test(recovery): add V07 partial failure and V26 long job safety acceptance suite"
```

任务 9、10 已完成。验收结果：全量 310/310 通过，0 失败、0 跳过。详见 docs/decisions/p3-01-task9-10-validation.md。
