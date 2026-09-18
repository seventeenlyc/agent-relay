# Agent Relay P2-04 运行编排核心 · 会话链 · 状态与控制入口 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付 Agent Relay 的运行编排核心（`RunController`）、持久化的会话链与控制意图日志、状态投影，以及 CLI 状态/控制入口，使「一次启用 → 四单元 → 三次自动交接」真正跑通，且用户可随时查看进度、暂停、停止、继续，意图跨进程重启依然有效。

**Architecture:** 采用「权威库 + 意图先落库」架构。以 `node:sqlite`（WAL 模式）作为唯一权威状态库，承载 run 记录、追加式控制意图（带单调递增水位）、会话链、交接去重记录、事件日志、跨 run 工作区租约与不可变账本镜像。CLI 从不驱动会话，只向 `control_intents` 追加一行；`RunController`（supervisor 进程）在每个节点边界读取未消费意图并执行，因此关闭查看窗口只是结束一个 CLI 进程。P1 微内核原语保持纯内存、对外行为不变，由引擎从库中重建、写路径先落库再更新内存对象。交接八步中的租约 CAS 与状态更新置于同一 SQLite 事务内，杜绝半提交。

**Tech Stack:** Node.js 24 原生 ES modules（`node:sqlite` 内置，无需第三方依赖）、`node:test`、`node:assert/strict`、`node:crypto`、`node:child_process`、`node:fs`、`node:path`。TypeScript 仅作类型文档（`node --experimental-strip-types` 只剥离类型、**不做类型检查**，接口一致性必须由契约测试保证）。

**Spec:** `docs/superpowers/specs/2026-09-18-agent-relay-p2-04-run-control-design.md`（本计划的上游权威；执行前先通读第 1～14 节）

**上游设计依据:** `agent-relay-design/03-技术设计.md` §2/§5/§6/§7/§12、`agent-relay-design/04-开发任务清单.md` P2-04、`agent-relay-design/05-验收与接手说明.md` V13/V19/V20/V21/V22/V33/V34、`docs/decisions/architecture.md`

## Global Constraints

以下约束适用于**每一个任务**，无需在各任务中重复：

- **不可变原话不可覆写（Immutable Raw Prompts）**：追加式输入账本（Append-Only Input Ledger），用户原始输入原样保留并校验哈希；修订通过 `supersedesId` 显式引用，禁止用大模型摘要覆盖历史原话。
- **系统提示隔离（System Prompt Isolation）**：生成的交接提示（`generated_handoff`）与系统注入严格与人类真实输入隔离，不得作为新增的人类授权。
- **单一写入者不变量（Single-Writer Invariant）**：同一物理工作区在任何时刻仅能由持有单调递增有效 epoch CAS 租约（`newEpoch > expectedEpoch`）的唯一 Owner 写入；新会话在完成只读校验并取得 `EXECUTION_TOKEN` 前绝对禁止写入。
- **Git 工作区无损保护（Lossless Workspace Protection）**：严禁自动执行 `git reset --hard`、`git clean` 或 `git stash`；用户已有未暂存改动必须纳入基线指纹予以保护。
- **全量无第三方运行依赖（Zero Third-Party Dependencies）**：仅用 Node.js 24 原生标准库（`node:sqlite`, `node:test`, `node:crypto`, `node:child_process`, `node:readline`, `node:path`, `node:fs`），零外部 runtime npm 依赖。
- **严格 Provider 与 Model 校验**：禁止静默 fallback；模型不一致必须导致接手检查失败且不产生新的项目写入。
- **交接不要求反复确认**：已授权范围内的正常轮换不再询问用户。
- **禁止虚假指标**：未接入的指标（如压缩次数、计费 token）在状态卡中必须显示「未知」，不得填 0 或编造百分比。

## File Structure

| 路径 | 职责 |
|---|---|
| `packages/controller/src/run/db.ts` | `RelayDatabase`：SQLite 连接、pragma、schema 迁移、可重入事务 |
| `packages/controller/src/run/store.ts` | `RunStore`：全部表类型化访问器 + run 级数据类型定义 |
| `packages/controller/src/run/intent.ts` | `ControlIntentLog`：意图追加、水位、优先级裁决、消费标记 |
| `packages/controller/src/run/chain.ts` | `SessionChainLedger`：会话链追加、查询、封存 |
| `packages/controller/src/run/events.ts` | `RunEventLog`：事件追加、严重度分级、通知派发 |
| `packages/controller/src/run/notifier.ts` | `Notifier` / `ConsoleNotifier` / `RecordingNotifier` |
| `packages/controller/src/run/prompt.ts` | 单元提示词构造与 `UNIT_RESULT` 解析 |
| `packages/controller/src/run/status.ts` | `RunStatusView` 投影、状态卡 / JSON 渲染、`state.md` 写入 |
| `packages/controller/src/run/engine.ts` | `RunController`：编排循环与交接八步 |
| `packages/controller/src/run/index.ts` | 汇总导出 |
| `packages/controller/src/workspace/key.ts` | `normalizeWorkspaceKey`：路径规范化（V34） |
| `packages/controller/src/handoff/durable-lease.ts` | `DurableLeaseManager`：落库版 CAS 租约 |
| `packages/protocol/src/coordinator.ts` | 统一 `HandshakeCoordinator` 契约 |
| `packages/cli/src/cli.ts` | `runCli(argv, deps)`：参数解析、分发、退出码 |
| `packages/cli/src/render.ts` | 状态卡 / 会话链 / 事件的人类可读与 JSON 渲染 |
| `bin/agent-relay.mjs` | 可执行 shim |
| `tests/helpers/scripted-adapter.ts` | 可编排的测试适配器（非测试文件，供引擎测试使用） |

---

### Task 1: 权威存储基础 —— `RelayDatabase` 与 `RunStore`

**Files:**
- Create: `packages/controller/src/run/db.ts`
- Create: `packages/controller/src/run/store.ts`
- Create: `packages/controller/src/run/index.ts`
- Modify: `packages/controller/src/index.ts`
- Modify: `package.json`（test 脚本加入 `tests/run/*.test.ts`）
- Test: `tests/run/store.test.ts`

**Interfaces:**
- Consumes: `node:sqlite` 的 `DatabaseSync`；`packages/protocol/src/types.ts` 的 `InputRecord`、`WorkspaceFingerprint`；`packages/protocol/src/events.ts` 的 `AgentRelayEvent`
- Produces: `RelayDatabase`、`RunStore`，以及类型 `RunState`、`RunRecord`、`ControlIntentKind`、`ControlIntentRecord`、`SessionChainLink`、`HandoffRecord`、`RunEventRecord`、`RunEventSeverity`、`LeaseRow`、`TaskSnapshotRow`、`InputLedgerRow`、`SCHEMA_VERSION`

- [ ] **Step 1: Write the failing test**

Create `tests/run/store.test.ts`:

```typescript
// tests/run/store.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { RelayDatabase } from '../../packages/controller/src/run/db.ts';
import { RunStore } from '../../packages/controller/src/run/store.ts';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-relay-store-'));
}

test('store: migrate is idempotent and records schema version', () => {
  const db = new RelayDatabase({ dbPath: ':memory:' });
  db.migrate();
  db.migrate();
  const row = db.prepare('SELECT value FROM schema_meta WHERE key = ?').get('schema_version') as
    | { value: string }
    | undefined;
  assert.ok(row);
  assert.strictEqual(row?.value, '1');
  db.close();
});

test('store: transaction rolls back every write when the callback throws', () => {
  const db = new RelayDatabase({ dbPath: ':memory:' });
  const store = new RunStore(db);
  store.insertRun({
    runId: 'run-rollback',
    workspaceKey: 'ws-rollback',
    workspacePath: 'C:/tmp/ws-rollback',
    goal: 'rollback test',
    state: 'INITIALIZING',
    unitCount: 3
  });

  assert.throws(() => {
    store.transaction(() => {
      store.updateRunState('run-rollback', 'RUNNING');
      store.appendIntent('run-rollback', 'stop_now');
      throw new Error('boom');
    });
  }, /boom/);

  assert.strictEqual(store.getRun('run-rollback')?.state, 'INITIALIZING');
  assert.deepStrictEqual(store.listIntents('run-rollback'), []);
  db.close();
});

test('store: nested transactions use savepoints and keep outer work on inner failure', () => {
  const db = new RelayDatabase({ dbPath: ':memory:' });
  const store = new RunStore(db);
  store.insertRun({
    runId: 'run-nested',
    workspaceKey: 'ws-nested',
    workspacePath: 'C:/tmp/ws-nested',
    goal: 'nested test',
    state: 'INITIALIZING',
    unitCount: 2
  });

  store.transaction(() => {
    store.updateRunState('run-nested', 'RUNNING');
    assert.throws(() => {
      store.transaction(() => {
        store.appendIntent('run-nested', 'disable');
        throw new Error('inner-boom');
      });
    }, /inner-boom/);
  });

  assert.strictEqual(store.getRun('run-nested')?.state, 'RUNNING');
  assert.deepStrictEqual(store.listIntents('run-nested'), []);
  db.close();
});

test('store: only one active run may hold a workspace key (V34)', () => {
  const db = new RelayDatabase({ dbPath: ':memory:' });
  const store = new RunStore(db);
  store.insertRun({
    runId: 'run-a',
    workspaceKey: 'ws-shared',
    workspacePath: 'C:/tmp/ws-shared',
    goal: 'first',
    state: 'RUNNING',
    unitCount: 1
  });

  assert.throws(() => {
    store.insertRun({
      runId: 'run-b',
      workspaceKey: 'ws-shared',
      workspacePath: 'C:/tmp/ws-shared',
      goal: 'second',
      state: 'RUNNING',
      unitCount: 1
    });
  }, /UNIQUE|constraint/i);

  assert.strictEqual(store.getActiveRunByWorkspace('ws-shared')?.runId, 'run-a');

  // Terminal runs release the workspace key
  store.updateRunState('run-a', 'COMPLETED');
  assert.strictEqual(store.getActiveRunByWorkspace('ws-shared'), undefined);
  store.insertRun({
    runId: 'run-b',
    workspaceKey: 'ws-shared',
    workspacePath: 'C:/tmp/ws-shared',
    goal: 'second',
    state: 'RUNNING',
    unitCount: 1
  });
  assert.strictEqual(store.getActiveRunByWorkspace('ws-shared')?.runId, 'run-b');
  db.close();
});

test('store: handoff ids are a deduplication key (V13)', () => {
  const db = new RelayDatabase({ dbPath: ':memory:' });
  const store = new RunStore(db);
  store.insertRun({
    runId: 'run-h',
    workspaceKey: 'ws-h',
    workspacePath: 'C:/tmp/ws-h',
    goal: 'handoff dedup',
    state: 'RUNNING',
    unitCount: 1
  });

  const first = store.insertHandoff({
    handoffId: 'h-1',
    runId: 'run-h',
    epoch: 1,
    sourceSessionId: 'session-a',
    state: 'REQUESTED'
  });
  assert.strictEqual(first, true);

  const duplicate = store.insertHandoff({
    handoffId: 'h-1',
    runId: 'run-h',
    epoch: 1,
    sourceSessionId: 'session-a',
    state: 'REQUESTED'
  });
  assert.strictEqual(duplicate, false, 'duplicate handoffId must be rejected, not re-inserted');
  assert.strictEqual(store.getHandoff('h-1')?.state, 'REQUESTED');
  db.close();
});

test('store: intent watermarks are monotonic and unique per run', () => {
  const db = new RelayDatabase({ dbPath: ':memory:' });
  const store = new RunStore(db);
  store.insertRun({
    runId: 'run-w',
    workspaceKey: 'ws-w',
    workspacePath: 'C:/tmp/ws-w',
    goal: 'watermark',
    state: 'RUNNING',
    unitCount: 1
  });

  const a = store.appendIntent('run-w', 'pause_next_node');
  const b = store.appendIntent('run-w', 'stop_now');
  assert.strictEqual(a.watermark, 1);
  assert.strictEqual(b.watermark, 2);
  assert.strictEqual(store.getLatestIntentWatermark('run-w'), 2);
  assert.deepStrictEqual(
    store.listIntents('run-w').map((i) => i.kind),
    ['pause_next_node', 'stop_now']
  );

  // Independent runs have independent watermark sequences
  store.insertRun({
    runId: 'run-w2',
    workspaceKey: 'ws-w2',
    workspacePath: 'C:/tmp/ws-w2',
    goal: 'watermark 2',
    state: 'RUNNING',
    unitCount: 1
  });
  assert.strictEqual(store.appendIntent('run-w2', 'disable').watermark, 1);
  db.close();
});

test('store: WAL makes committed writes visible to a separate process (V22)', () => {
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'relay.db');
  const db = new RelayDatabase({ dbPath });
  const store = new RunStore(db);
  store.insertRun({
    runId: 'run-wal',
    workspaceKey: 'ws-wal',
    workspacePath: dir,
    goal: 'cross process',
    state: 'RUNNING',
    unitCount: 2
  });
  store.appendIntent('run-wal', 'pause_next_node');

  const readerScript = fileURLToPath(new URL('../fixtures/read-intents.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [readerScript, dbPath, 'run-wal'], {
    encoding: 'utf8',
    env: { ...process.env }
  });

  assert.strictEqual(result.status, 0, `reader process failed: ${result.stderr}`);
  assert.match(result.stdout, /watermark=1/, 'a separate process must observe the committed intent');
  assert.match(result.stdout, /kind=pause_next_node/);

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('store: lease table enforces single owner with monotonic epoch CAS', () => {
  const db = new RelayDatabase({ dbPath: ':memory:' });
  const store = new RunStore(db);

  assert.strictEqual(store.tryInsertLease('ws-lease', 'session-a', 1), true);
  assert.strictEqual(store.tryInsertLease('ws-lease', 'session-b', 1), false);

  assert.strictEqual(store.casLeaseRow('ws-lease', 'session-a', 'session-b', 1, 2), true);
  assert.strictEqual(store.getLeaseRow('ws-lease')?.currentOwner, 'session-b');
  assert.strictEqual(store.getLeaseRow('ws-lease')?.epoch, 2);

  // Stale owner / stale epoch / non-monotonic epoch all rejected
  assert.strictEqual(store.casLeaseRow('ws-lease', 'session-a', 'rogue', 1, 3), false);
  assert.strictEqual(store.casLeaseRow('ws-lease', 'session-b', 'rogue', 1, 3), false);
  assert.strictEqual(store.casLeaseRow('ws-lease', 'session-b', 'rogue', 2, 2), false);
  assert.strictEqual(store.getLeaseRow('ws-lease')?.currentOwner, 'session-b');

  assert.strictEqual(store.deleteLease('ws-lease', 'rogue'), false);
  assert.strictEqual(store.deleteLease('ws-lease', 'session-b'), true);
  assert.strictEqual(store.getLeaseRow('ws-lease'), undefined);
  db.close();
});
```

- [ ] **Step 2: Create the cross-process reader fixture**

Create `tests/fixtures/read-intents.mjs`:

```javascript
// tests/fixtures/read-intents.mjs
// Standalone reader used to prove WAL cross-process visibility (V22).
import { DatabaseSync } from 'node:sqlite';

const [, , dbPath, runId] = process.argv;
const db = new DatabaseSync(dbPath);
db.exec('PRAGMA busy_timeout = 3000');

const rows = db
  .prepare('SELECT kind, watermark FROM control_intents WHERE run_id = ? ORDER BY watermark ASC')
  .all(runId);

for (const row of rows) {
  process.stdout.write(`watermark=${row.watermark} kind=${row.kind}\n`);
}
db.close();
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --experimental-strip-types --test tests/run/store.test.ts`
Expected: FAIL with "Cannot find module ... src/run/db.ts"

- [ ] **Step 4: Write `packages/controller/src/run/db.ts`**

```typescript
// packages/controller/src/run/db.ts
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const SCHEMA_VERSION = '1';

export interface RelayDatabaseOptions {
  /** 绝对路径，或 ':memory:' 用于测试 */
  dbPath: string;
  busyTimeoutMs?: number;
}

const SCHEMA_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS schema_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS runs (
    run_id                      TEXT PRIMARY KEY,
    workspace_key               TEXT NOT NULL,
    workspace_path              TEXT NOT NULL,
    goal                        TEXT NOT NULL,
    provider                    TEXT NOT NULL DEFAULT 'unknown',
    model                       TEXT NOT NULL DEFAULT 'unknown',
    effort                      TEXT,
    state                       TEXT NOT NULL,
    current_session_id          TEXT,
    current_epoch               INTEGER NOT NULL DEFAULT 1,
    handoff_count               INTEGER NOT NULL DEFAULT 0,
    unit_count                  INTEGER NOT NULL,
    current_session_unit_count  INTEGER NOT NULL DEFAULT 0,
    authorized_input_hash       TEXT,
    authorized_contract_version INTEGER,
    authorized_intent_watermark INTEGER,
    pause_reason                TEXT,
    blocked_reason              TEXT,
    created_at                  INTEGER NOT NULL,
    updated_at                  INTEGER NOT NULL
  )`,

  // 同一物理工作区同时最多一个活动 run（终态 run 不占用该唯一索引）
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_active_workspace
     ON runs(workspace_key)
     WHERE state NOT IN ('CANCELLED', 'COMPLETED', 'DISABLED')`,

  `CREATE TABLE IF NOT EXISTS control_intents (
    intent_id   TEXT PRIMARY KEY,
    run_id      TEXT NOT NULL,
    kind        TEXT NOT NULL,
    payload     TEXT NOT NULL DEFAULT '{}',
    watermark   INTEGER NOT NULL,
    created_at  INTEGER NOT NULL,
    consumed_at INTEGER,
    UNIQUE(run_id, watermark)
  )`,

  `CREATE TABLE IF NOT EXISTS session_chain (
    link_id         TEXT PRIMARY KEY,
    run_id          TEXT NOT NULL,
    sequence        INTEGER NOT NULL,
    prev_session_id TEXT,
    next_session_id TEXT NOT NULL,
    adapter         TEXT NOT NULL,
    provider        TEXT NOT NULL,
    model           TEXT NOT NULL,
    effort          TEXT,
    epoch           INTEGER NOT NULL,
    handoff_id      TEXT,
    reason          TEXT NOT NULL,
    created_at      INTEGER NOT NULL,
    superseded_at   INTEGER
  )`,

  `CREATE INDEX IF NOT EXISTS idx_chain_run ON session_chain(run_id, sequence)`,

  `CREATE TABLE IF NOT EXISTS handoffs (
    handoff_id        TEXT PRIMARY KEY,
    run_id            TEXT NOT NULL,
    epoch             INTEGER NOT NULL,
    source_session_id TEXT NOT NULL,
    target_session_id TEXT,
    state             TEXT NOT NULL,
    manifest_path     TEXT,
    manifest_hash     TEXT,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS run_events (
    event_id   INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id     TEXT NOT NULL,
    type       TEXT NOT NULL,
    severity   TEXT NOT NULL,
    session_id TEXT,
    payload    TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS idx_events_run ON run_events(run_id, event_id)`,

  `CREATE TABLE IF NOT EXISTS lease_state (
    workspace_key TEXT PRIMARY KEY,
    current_owner TEXT NOT NULL,
    epoch         INTEGER NOT NULL,
    acquired_at   INTEGER NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS input_ledger (
    run_id        TEXT NOT NULL,
    seq           INTEGER NOT NULL,
    input_id      TEXT NOT NULL,
    source        TEXT NOT NULL,
    raw_content   TEXT NOT NULL,
    sha256_hash   TEXT NOT NULL,
    supersedes_id TEXT,
    metadata      TEXT,
    created_at    INTEGER NOT NULL,
    PRIMARY KEY (run_id, seq)
  )`,

  `CREATE TABLE IF NOT EXISTS task_snapshots (
    run_id        TEXT NOT NULL,
    seq           INTEGER NOT NULL,
    snapshot_json TEXT NOT NULL,
    snapshot_hash TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    PRIMARY KEY (run_id, seq)
  )`,

  `CREATE TABLE IF NOT EXISTS ledger_events (
    run_id     TEXT NOT NULL,
    seq        INTEGER NOT NULL,
    event_id   TEXT NOT NULL,
    type       TEXT NOT NULL,
    session_id TEXT,
    timestamp  INTEGER NOT NULL,
    payload    TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (run_id, seq)
  )`
];

/**
 * 权威库。负责连接生命周期、pragma、schema 迁移与可重入事务。
 * 所有写操作必须经由 transaction() 包裹以保证原子性。
 */
export class RelayDatabase {
  private readonly handle: DatabaseSync;
  private readonly dbPath: string;
  private depth = 0;
  private closed = false;

  constructor(options: RelayDatabaseOptions) {
    this.dbPath = options.dbPath;
    if (options.dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(options.dbPath), { recursive: true });
    }
    this.handle = new DatabaseSync(options.dbPath);
    this.handle.exec('PRAGMA journal_mode = WAL');
    this.handle.exec(`PRAGMA busy_timeout = ${options.busyTimeoutMs ?? 3000}`);
    this.handle.exec('PRAGMA foreign_keys = ON');
    this.migrate();
  }

  public migrate(): void {
    for (const statement of SCHEMA_STATEMENTS) {
      this.handle.exec(statement);
    }
    this.handle
      .prepare('INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)')
      .run('schema_version', SCHEMA_VERSION);
  }

  public prepare(sql: string) {
    return this.handle.prepare(sql);
  }

  public exec(sql: string): void {
    this.handle.exec(sql);
  }

  /**
   * 可重入事务：最外层用 BEGIN IMMEDIATE / COMMIT，内层用 SAVEPOINT / RELEASE。
   * 回调抛错时回滚到对应层并原样重抛。
   */
  public transaction<T>(fn: () => T): T {
    const isOuter = this.depth === 0;
    if (isOuter) {
      this.handle.exec('BEGIN IMMEDIATE');
    } else {
      this.handle.exec(`SAVEPOINT relay_sp_${this.depth}`);
    }
    this.depth++;
    try {
      const result = fn();
      this.depth--;
      if (isOuter) {
        this.handle.exec('COMMIT');
      } else {
        this.handle.exec(`RELEASE relay_sp_${this.depth}`);
      }
      return result;
    } catch (err) {
      this.depth--;
      try {
        if (isOuter) {
          this.handle.exec('ROLLBACK');
        } else {
          this.handle.exec(`ROLLBACK TO relay_sp_${this.depth}`);
          this.handle.exec(`RELEASE relay_sp_${this.depth}`);
        }
      } catch {
        // 回滚失败时保留原始错误，交由上层处理
      }
      throw err;
    }
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.handle.close();
    } catch {
      // 关闭失败不影响调用方
    }
  }

  public getPath(): string {
    return this.dbPath;
  }
}
```

- [ ] **Step 5: Write `packages/controller/src/run/store.ts`**

```typescript
// packages/controller/src/run/store.ts
import { randomUUID } from 'node:crypto';
import type { InputRecord } from '../../../protocol/src/types.ts';
import type { AgentRelayEvent } from '../../../protocol/src/events.ts';
import type { RelayDatabase } from './db.ts';

export type RunState =
  | 'INITIALIZING'
  | 'RUNNING'
  | 'DRAINING'
  | 'CHECKPOINTED'
  | 'STARTING'
  | 'PREPARING'
  | 'READY'
  | 'PAUSED'
  | 'CANCELLED'
  | 'DISABLED'
  | 'COMPLETED'
  | 'RECOVERY_REQUIRED'
  | 'BLOCKED';

export const TERMINAL_RUN_STATES: RunState[] = ['CANCELLED', 'COMPLETED', 'DISABLED'];

export interface RunRecord {
  runId: string;
  workspaceKey: string;
  workspacePath: string;
  goal: string;
  model: { provider: string; model: string; effort?: string };
  state: RunState;
  currentSessionId?: string;
  currentEpoch: number;
  handoffCount: number;
  unitCount: number;
  currentSessionUnitCount: number;
  authorizedInputHash?: string;
  authorizedContractVersion?: number;
  authorizedIntentWatermark?: number;
  pauseReason?: string;
  blockedReason?: string;
  createdAt: number;
  updatedAt: number;
}

export interface InsertRunParams {
  runId: string;
  workspaceKey: string;
  workspacePath: string;
  goal: string;
  /** 缺省记录为 unknown——绝不猜测模型，状态卡会如实显示「未知」 */
  model?: { provider: string; model: string; effort?: string };
  state: RunState;
  unitCount: number;
  currentEpoch?: number;
}

export interface RunStatePatch {
  currentSessionId?: string | null;
  currentEpoch?: number;
  handoffCount?: number;
  currentSessionUnitCount?: number;
  pauseReason?: string | null;
  blockedReason?: string | null;
}

export type ControlIntentKind = 'pause_next_node' | 'stop_now' | 'resume' | 'disable';

export interface ControlIntentRecord {
  intentId: string;
  runId: string;
  kind: ControlIntentKind;
  payload: Record<string, unknown>;
  watermark: number;
  createdAt: number;
  consumedAt?: number;
}

export interface SessionChainLink {
  linkId: string;
  runId: string;
  sequence: number;
  prevSessionId?: string;
  nextSessionId: string;
  adapter: string;
  provider: string;
  model: string;
  effort?: string;
  epoch: number;
  handoffId?: string;
  reason: string;
  createdAt: number;
  supersededAt?: number;
}

export interface InsertChainLinkParams {
  runId: string;
  sequence: number;
  prevSessionId?: string;
  nextSessionId: string;
  adapter: string;
  provider: string;
  model: string;
  effort?: string;
  epoch: number;
  handoffId?: string;
  reason: string;
}

export interface HandoffRecord {
  handoffId: string;
  runId: string;
  epoch: number;
  sourceSessionId: string;
  targetSessionId?: string;
  state: string;
  manifestPath?: string;
  manifestHash?: string;
  createdAt: number;
  updatedAt: number;
}

export interface InsertHandoffParams {
  handoffId: string;
  runId: string;
  epoch: number;
  sourceSessionId: string;
  targetSessionId?: string;
  state: string;
  manifestPath?: string;
  manifestHash?: string;
}

export interface HandoffPatch {
  targetSessionId?: string;
  state?: string;
  manifestPath?: string;
  manifestHash?: string;
}

export type RunEventSeverity = 'record' | 'notify';

export interface RunEventRecord {
  eventId: number;
  runId: string;
  type: string;
  severity: RunEventSeverity;
  sessionId?: string;
  payload: Record<string, unknown>;
  createdAt: number;
}

export interface LeaseRow {
  workspaceKey: string;
  currentOwner: string;
  epoch: number;
  acquiredAt: number;
}

export interface TaskSnapshotRow {
  runId: string;
  seq: number;
  snapshotJson: string;
  snapshotHash: string;
  createdAt: number;
}

export interface InputLedgerRow {
  seq: number;
  record: InputRecord;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

/**
 * 权威状态访问器。所有方法假定调用方已在需要原子性的场景下用
 * RelayDatabase.transaction() 包裹。
 */
export class RunStore {
  private readonly db: RelayDatabase;
  private readonly now: () => number;

  constructor(db: RelayDatabase, clock: () => number = () => Date.now()) {
    this.db = db;
    this.now = clock;
  }

  public transaction<T>(fn: () => T): T {
    return this.db.transaction(fn);
  }

  // ─── runs ───

  public insertRun(params: InsertRunParams): void {
    const ts = this.now();
    const model = params.model ?? { provider: 'unknown', model: 'unknown' };
    this.db
      .prepare(
        `INSERT INTO runs (
           run_id, workspace_key, workspace_path, goal, provider, model, effort, state,
           current_epoch, handoff_count, unit_count, current_session_unit_count,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 0, ?, ?)`
      )
      .run(
        params.runId,
        params.workspaceKey,
        params.workspacePath,
        params.goal,
        model.provider,
        model.model,
        model.effort ?? null,
        params.state,
        params.currentEpoch ?? 1,
        params.unitCount,
        ts,
        ts
      );
  }

  public getRun(runId: string): RunRecord | undefined {
    const row = this.db.prepare('SELECT * FROM runs WHERE run_id = ?').get(runId) as
      | Record<string, unknown>
      | undefined;
    return row ? this.mapRun(row) : undefined;
  }

  public getActiveRunByWorkspace(workspaceKey: string): RunRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM runs
          WHERE workspace_key = ?
            AND state NOT IN ('CANCELLED', 'COMPLETED', 'DISABLED')
          ORDER BY created_at ASC LIMIT 1`
      )
      .get(workspaceKey) as Record<string, unknown> | undefined;
    return row ? this.mapRun(row) : undefined;
  }

  public listRuns(): RunRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM runs ORDER BY created_at ASC')
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapRun(row));
  }

  public updateRunState(runId: string, state: RunState, patch: RunStatePatch = {}): void {
    const existing = this.getRun(runId);
    if (!existing) {
      throw new Error(`RunStore: run ${runId} not found`);
    }
    this.db
      .prepare(
        `UPDATE runs SET
           state = ?,
           current_session_id = ?,
           current_epoch = ?,
           handoff_count = ?,
           current_session_unit_count = ?,
           pause_reason = ?,
           blocked_reason = ?,
           updated_at = ?
         WHERE run_id = ?`
      )
      .run(
        state,
        patch.currentSessionId === undefined ? existing.currentSessionId ?? null : patch.currentSessionId,
        patch.currentEpoch ?? existing.currentEpoch,
        patch.handoffCount ?? existing.handoffCount,
        patch.currentSessionUnitCount ?? existing.currentSessionUnitCount,
        patch.pauseReason === undefined ? existing.pauseReason ?? null : patch.pauseReason,
        patch.blockedReason === undefined ? existing.blockedReason ?? null : patch.blockedReason,
        this.now(),
        runId
      );
  }

  public setAuthorization(
    runId: string,
    params: { inputHeadHash: string; contractVersion: number; intentWatermark: number }
  ): void {
    this.db
      .prepare(
        `UPDATE runs SET
           authorized_input_hash = ?,
           authorized_contract_version = ?,
           authorized_intent_watermark = ?,
           updated_at = ?
         WHERE run_id = ?`
      )
      .run(params.inputHeadHash, params.contractVersion, params.intentWatermark, this.now(), runId);
  }

  // ─── control intents ───

  public getLatestIntentWatermark(runId: string): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(watermark), 0) AS w FROM control_intents WHERE run_id = ?')
      .get(runId) as { w: number } | undefined;
    return row ? row.w : 0;
  }

  public appendIntent(
    runId: string,
    kind: ControlIntentKind,
    payload: Record<string, unknown> = {}
  ): ControlIntentRecord {
    const watermark = this.getLatestIntentWatermark(runId) + 1;
    const record: ControlIntentRecord = {
      intentId: randomUUID(),
      runId,
      kind,
      payload,
      watermark,
      createdAt: this.now()
    };
    this.db
      .prepare(
        `INSERT INTO control_intents (intent_id, run_id, kind, payload, watermark, created_at, consumed_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`
      )
      .run(record.intentId, runId, kind, JSON.stringify(payload), watermark, record.createdAt);
    return record;
  }

  public listIntents(runId: string, afterWatermark = 0): ControlIntentRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM control_intents
          WHERE run_id = ? AND watermark > ?
          ORDER BY watermark ASC`
      )
      .all(runId, afterWatermark) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapIntent(row));
  }

  public listPendingIntents(runId: string): ControlIntentRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM control_intents
          WHERE run_id = ? AND consumed_at IS NULL
          ORDER BY watermark ASC`
      )
      .all(runId) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapIntent(row));
  }

  public markIntentConsumed(intentId: string, at?: number): void {
    this.db
      .prepare('UPDATE control_intents SET consumed_at = ? WHERE intent_id = ? AND consumed_at IS NULL')
      .run(at ?? this.now(), intentId);
  }

  // ─── session chain ───

  public nextChainSequence(runId: string): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(sequence), 0) AS s FROM session_chain WHERE run_id = ?')
      .get(runId) as { s: number } | undefined;
    return (row ? row.s : 0) + 1;
  }

  public insertChainLink(params: InsertChainLinkParams): SessionChainLink {
    const link: SessionChainLink = {
      linkId: randomUUID(),
      runId: params.runId,
      sequence: params.sequence,
      prevSessionId: params.prevSessionId,
      nextSessionId: params.nextSessionId,
      adapter: params.adapter,
      provider: params.provider,
      model: params.model,
      effort: params.effort,
      epoch: params.epoch,
      handoffId: params.handoffId,
      reason: params.reason,
      createdAt: this.now()
    };
    this.db
      .prepare(
        `INSERT INTO session_chain (
           link_id, run_id, sequence, prev_session_id, next_session_id,
           adapter, provider, model, effort, epoch, handoff_id, reason, created_at, superseded_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
      )
      .run(
        link.linkId,
        link.runId,
        link.sequence,
        link.prevSessionId ?? null,
        link.nextSessionId,
        link.adapter,
        link.provider,
        link.model,
        link.effort ?? null,
        link.epoch,
        link.handoffId ?? null,
        link.reason,
        link.createdAt
      );
    return link;
  }

  public listChain(runId: string): SessionChainLink[] {
    const rows = this.db
      .prepare('SELECT * FROM session_chain WHERE run_id = ? ORDER BY sequence ASC')
      .all(runId) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapChainLink(row));
  }

  public getLatestChainLink(runId: string): SessionChainLink | undefined {
    const links = this.listChain(runId);
    return links.length > 0 ? links[links.length - 1] : undefined;
  }

  public markSessionSuperseded(sessionId: string, at?: number): void {
    this.db
      .prepare('UPDATE session_chain SET superseded_at = ? WHERE next_session_id = ? AND superseded_at IS NULL')
      .run(at ?? this.now(), sessionId);
  }

  public findChainLinksBySession(sessionId: string): SessionChainLink[] {
    const rows = this.db
      .prepare('SELECT * FROM session_chain WHERE next_session_id = ? ORDER BY sequence ASC')
      .all(sessionId) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapChainLink(row));
  }

  // ─── handoffs ───

  public insertHandoff(params: InsertHandoffParams): boolean {
    const ts = this.now();
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO handoffs (
           handoff_id, run_id, epoch, source_session_id, target_session_id,
           state, manifest_path, manifest_hash, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        params.handoffId,
        params.runId,
        params.epoch,
        params.sourceSessionId,
        params.targetSessionId ?? null,
        params.state,
        params.manifestPath ?? null,
        params.manifestHash ?? null,
        ts,
        ts
      );
    return Number(result.changes) > 0;
  }

  public getHandoff(handoffId: string): HandoffRecord | undefined {
    const row = this.db.prepare('SELECT * FROM handoffs WHERE handoff_id = ?').get(handoffId) as
      | Record<string, unknown>
      | undefined;
    return row ? this.mapHandoff(row) : undefined;
  }

  public updateHandoff(handoffId: string, patch: HandoffPatch): void {
    const existing = this.getHandoff(handoffId);
    if (!existing) {
      throw new Error(`RunStore: handoff ${handoffId} not found`);
    }
    this.db
      .prepare(
        `UPDATE handoffs SET
           target_session_id = ?, state = ?, manifest_path = ?, manifest_hash = ?, updated_at = ?
         WHERE handoff_id = ?`
      )
      .run(
        patch.targetSessionId ?? existing.targetSessionId ?? null,
        patch.state ?? existing.state,
        patch.manifestPath ?? existing.manifestPath ?? null,
        patch.manifestHash ?? existing.manifestHash ?? null,
        this.now(),
        handoffId
      );
  }

  // ─── run events ───

  public insertEvent(params: {
    runId: string;
    type: string;
    severity: RunEventSeverity;
    sessionId?: string;
    payload?: Record<string, unknown>;
  }): RunEventRecord {
    const createdAt = this.now();
    const payload = params.payload ?? {};
    const result = this.db
      .prepare(
        `INSERT INTO run_events (run_id, type, severity, session_id, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(params.runId, params.type, params.severity, params.sessionId ?? null, JSON.stringify(payload), createdAt);
    return {
      eventId: Number(result.lastInsertRowid),
      runId: params.runId,
      type: params.type,
      severity: params.severity,
      sessionId: params.sessionId,
      payload,
      createdAt
    };
  }

  public listEvents(runId: string, afterEventId = 0): RunEventRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM run_events WHERE run_id = ? AND event_id > ? ORDER BY event_id ASC')
      .all(runId, afterEventId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      eventId: row.event_id as number,
      runId: row.run_id as string,
      type: row.type as string,
      severity: row.severity as RunEventSeverity,
      sessionId: asString(row.session_id),
      payload: JSON.parse(row.payload as string) as Record<string, unknown>,
      createdAt: row.created_at as number
    }));
  }

  // ─── lease registry（全局，跨 run） ───

  public getLeaseRow(workspaceKey: string): LeaseRow | undefined {
    const row = this.db.prepare('SELECT * FROM lease_state WHERE workspace_key = ?').get(workspaceKey) as
      | Record<string, unknown>
      | undefined;
    if (!row) return undefined;
    return {
      workspaceKey: row.workspace_key as string,
      currentOwner: row.current_owner as string,
      epoch: row.epoch as number,
      acquiredAt: row.acquired_at as number
    };
  }

  public tryInsertLease(workspaceKey: string, owner: string, epoch: number): boolean {
    const result = this.db
      .prepare('INSERT OR IGNORE INTO lease_state (workspace_key, current_owner, epoch, acquired_at) VALUES (?, ?, ?, ?)')
      .run(workspaceKey, owner, epoch, this.now());
    return Number(result.changes) > 0;
  }

  public casLeaseRow(
    workspaceKey: string,
    expectedOwner: string,
    newOwner: string,
    expectedEpoch: number,
    newEpoch: number
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE lease_state
            SET current_owner = ?, epoch = ?, acquired_at = ?
          WHERE workspace_key = ? AND current_owner = ? AND epoch = ? AND ? > ?`
      )
      .run(newOwner, newEpoch, this.now(), workspaceKey, expectedOwner, expectedEpoch, newEpoch, expectedEpoch);
    return Number(result.changes) > 0;
  }

  public deleteLease(workspaceKey: string, owner: string): boolean {
    const result = this.db
      .prepare('DELETE FROM lease_state WHERE workspace_key = ? AND current_owner = ?')
      .run(workspaceKey, owner);
    return Number(result.changes) > 0;
  }

  // ─── input ledger（不可变原话镜像） ───

  public nextInputSeq(runId: string): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM input_ledger WHERE run_id = ?')
      .get(runId) as { s: number } | undefined;
    return (row ? row.s : 0) + 1;
  }

  public appendInputRow(runId: string, seq: number, record: InputRecord): void {
    this.db
      .prepare(
        `INSERT INTO input_ledger (
           run_id, seq, input_id, source, raw_content, sha256_hash, supersedes_id, metadata, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        runId,
        seq,
        record.inputId,
        record.source,
        record.rawContent,
        record.sha256Hash,
        record.supersedesId ?? null,
        record.metadata ? JSON.stringify(record.metadata) : null,
        record.timestamp
      );
  }

  public listInputs(runId: string): InputLedgerRow[] {
    const rows = this.db
      .prepare('SELECT * FROM input_ledger WHERE run_id = ? ORDER BY seq ASC')
      .all(runId) as Array<Record<string, unknown>>;
    return rows.map((row) => {
      const metadataRaw = asString(row.metadata);
      const record: InputRecord = {
        inputId: row.input_id as string,
        source: row.source as InputRecord['source'],
        timestamp: row.created_at as number,
        rawContent: row.raw_content as string,
        sha256Hash: row.sha256_hash as string,
        supersedesId: asString(row.supersedes_id),
        metadata: metadataRaw ? (JSON.parse(metadataRaw) as Record<string, unknown>) : undefined
      };
      return { seq: row.seq as number, record };
    });
  }

  // ─── task snapshots ───

  public nextTaskSnapshotSeq(runId: string): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM task_snapshots WHERE run_id = ?')
      .get(runId) as { s: number } | undefined;
    return (row ? row.s : 0) + 1;
  }

  public appendTaskSnapshot(runId: string, seq: number, snapshotJson: string, snapshotHash: string): void {
    this.db
      .prepare(
        `INSERT INTO task_snapshots (run_id, seq, snapshot_json, snapshot_hash, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(runId, seq, snapshotJson, snapshotHash, this.now());
  }

  public getLatestTaskSnapshot(runId: string): TaskSnapshotRow | undefined {
    const row = this.db
      .prepare('SELECT * FROM task_snapshots WHERE run_id = ? ORDER BY seq DESC LIMIT 1')
      .get(runId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      runId: row.run_id as string,
      seq: row.seq as number,
      snapshotJson: row.snapshot_json as string,
      snapshotHash: row.snapshot_hash as string,
      createdAt: row.created_at as number
    };
  }

  // ─── AgentRelayEvent 追加式持久化 ───

  public nextLedgerEventSeq(runId: string): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM ledger_events WHERE run_id = ?')
      .get(runId) as { s: number } | undefined;
    return (row ? row.s : 0) + 1;
  }

  public appendLedgerEvent(runId: string, seq: number, event: AgentRelayEvent): void {
    this.db
      .prepare(
        `INSERT INTO ledger_events (run_id, seq, event_id, type, session_id, timestamp, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(runId, seq, event.eventId, event.type, event.sessionId, event.timestamp, JSON.stringify(event.payload));
  }

  public listLedgerEvents(runId: string): AgentRelayEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM ledger_events WHERE run_id = ? ORDER BY seq ASC')
      .all(runId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      eventId: row.event_id as string,
      type: row.type as AgentRelayEvent['type'],
      runId,
      sessionId: row.session_id as string,
      timestamp: row.timestamp as number,
      payload: JSON.parse(row.payload as string) as Record<string, unknown>
    }));
  }

  // ─── mappers ───

  private mapRun(row: Record<string, unknown>): RunRecord {
    return {
      runId: row.run_id as string,
      workspaceKey: row.workspace_key as string,
      workspacePath: row.workspace_path as string,
      goal: row.goal as string,
      model: {
        provider: row.provider as string,
        model: row.model as string,
        effort: asString(row.effort)
      },
      state: row.state as RunState,
      currentSessionId: asString(row.current_session_id),
      currentEpoch: row.current_epoch as number,
      handoffCount: row.handoff_count as number,
      unitCount: row.unit_count as number,
      currentSessionUnitCount: row.current_session_unit_count as number,
      authorizedInputHash: asString(row.authorized_input_hash),
      authorizedContractVersion: asNumber(row.authorized_contract_version),
      authorizedIntentWatermark: asNumber(row.authorized_intent_watermark),
      pauseReason: asString(row.pause_reason),
      blockedReason: asString(row.blocked_reason),
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number
    };
  }

  private mapIntent(row: Record<string, unknown>): ControlIntentRecord {
    return {
      intentId: row.intent_id as string,
      runId: row.run_id as string,
      kind: row.kind as ControlIntentKind,
      payload: JSON.parse(row.payload as string) as Record<string, unknown>,
      watermark: row.watermark as number,
      createdAt: row.created_at as number,
      consumedAt: asNumber(row.consumed_at)
    };
  }

  private mapChainLink(row: Record<string, unknown>): SessionChainLink {
    return {
      linkId: row.link_id as string,
      runId: row.run_id as string,
      sequence: row.sequence as number,
      prevSessionId: asString(row.prev_session_id),
      nextSessionId: row.next_session_id as string,
      adapter: row.adapter as string,
      provider: row.provider as string,
      model: row.model as string,
      effort: asString(row.effort),
      epoch: row.epoch as number,
      handoffId: asString(row.handoff_id),
      reason: row.reason as string,
      createdAt: row.created_at as number,
      supersededAt: asNumber(row.superseded_at)
    };
  }

  private mapHandoff(row: Record<string, unknown>): HandoffRecord {
    return {
      handoffId: row.handoff_id as string,
      runId: row.run_id as string,
      epoch: row.epoch as number,
      sourceSessionId: row.source_session_id as string,
      targetSessionId: asString(row.target_session_id),
      state: row.state as string,
      manifestPath: asString(row.manifest_path),
      manifestHash: asString(row.manifest_hash),
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number
    };
  }
}
```

- [ ] **Step 6: Write `packages/controller/src/run/index.ts` and wire the package export**

Create `packages/controller/src/run/index.ts`:

```typescript
export * from './db.ts';
export * from './store.ts';
```

Modify `packages/controller/src/index.ts` to add the run barrel (keep existing lines, append):

```typescript
export * from './inputs/index.ts';
export * from './tasks/index.ts';
export * from './policy/index.ts';
export * from './workspace/index.ts';
export * from './handoff/index.ts';
export * from './run/index.ts';
```

- [ ] **Step 7: Add the new test directory to the test script**

Modify `package.json`:

```json
{
  "name": "agent-relay-workspace",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --experimental-strip-types --test tests/adapters/*.test.ts tests/contracts/*.test.ts tests/policy/*.test.ts tests/run/*.test.ts tests/scenarios/*.test.ts tests/transactions/*.test.ts tests/workspace/*.test.ts",
    "test:contracts": "node --experimental-strip-types --test tests/contracts/*.test.ts",
    "test:scenarios": "node --experimental-strip-types --test tests/scenarios/*.test.ts"
  }
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `node --experimental-strip-types --test tests/run/store.test.ts`
Expected: PASS (8 tests pass)

- [ ] **Step 9: Run the full suite to confirm no regression**

Run: `npm test`
Expected: PASS, 146 existing tests plus the 8 new ones, 0 failures

- [ ] **Step 10: Commit**

```bash
git add packages/controller/src/run/db.ts packages/controller/src/run/store.ts packages/controller/src/run/index.ts packages/controller/src/index.ts tests/run/store.test.ts tests/fixtures/read-intents.mjs package.json
git commit -m "feat(controller/run): add RelayDatabase and RunStore authoritative SQLite store"
```

---

### Task 2: 控制意图日志、会话链、事件日志与通知

**Files:**
- Create: `packages/controller/src/run/notifier.ts`
- Create: `packages/controller/src/run/events.ts`
- Create: `packages/controller/src/run/intent.ts`
- Create: `packages/controller/src/run/chain.ts`
- Modify: `packages/controller/src/run/index.ts`
- Test: `tests/run/intent.test.ts`
- Test: `tests/run/chain.test.ts`

**Interfaces:**
- Consumes: `RunStore`, `ControlIntentKind`, `ControlIntentRecord`, `RunEventRecord`, `RunEventSeverity`, `SessionChainLink` from `./store.ts`
- Produces: `ControlIntentLog`、`SessionChainLedger`、`RunEventLog`、`Notifier`、`ConsoleNotifier`、`RecordingNotifier`、`RunNotification`、`classifySeverity`、`PendingControl`

- [ ] **Step 1: Write the failing test for intents**

Create `tests/run/intent.test.ts`:

```typescript
// tests/run/intent.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { RelayDatabase } from '../../packages/controller/src/run/db.ts';
import { RunStore } from '../../packages/controller/src/run/store.ts';
import { ControlIntentLog } from '../../packages/controller/src/run/intent.ts';

function setup(runId = 'run-intent') {
  const db = new RelayDatabase({ dbPath: ':memory:' });
  const store = new RunStore(db);
  store.insertRun({
    runId,
    workspaceKey: `ws-${runId}`,
    workspacePath: `C:/tmp/${runId}`,
    goal: 'intent test',
    state: 'RUNNING',
    unitCount: 4
  });
  return { db, store, log: new ControlIntentLog(store), runId };
}

test('intent: append assigns strictly increasing watermarks starting at 1', () => {
  const { db, log, runId } = setup();
  assert.strictEqual(log.getWatermark(runId), 0);
  assert.strictEqual(log.append(runId, 'pause_next_node').watermark, 1);
  assert.strictEqual(log.append(runId, 'resume').watermark, 2);
  assert.strictEqual(log.getWatermark(runId), 2);
  db.close();
});

test('intent: resolve picks stop_now ahead of a later-arriving pause', () => {
  const { db, log, runId } = setup();
  log.append(runId, 'pause_next_node');
  log.append(runId, 'stop_now');

  const resolved = log.resolve(runId);
  assert.ok(resolved);
  assert.strictEqual(resolved?.kind, 'stop_now');
  assert.strictEqual(resolved?.watermark, 2);
  db.close();
});

test('intent: resolve prefers the lowest watermark among equal-priority intents', () => {
  const { db, log, runId } = setup();
  const first = log.append(runId, 'stop_now');
  log.append(runId, 'stop_now');

  const resolved = log.resolve(runId);
  assert.strictEqual(resolved?.intentId, first.intentId, 'the earliest stop intent must win');
  db.close();
});

test('intent: priority order is stop_now > disable > pause_next_node > resume', () => {
  const { db, log, runId } = setup();
  log.append(runId, 'resume');
  log.append(runId, 'pause_next_node');
  assert.strictEqual(log.resolve(runId)?.kind, 'pause_next_node');

  log.append(runId, 'disable');
  assert.strictEqual(log.resolve(runId)?.kind, 'disable');

  log.append(runId, 'stop_now');
  assert.strictEqual(log.resolve(runId)?.kind, 'stop_now');
  db.close();
});

test('intent: consume removes an intent from resolution and is idempotent', () => {
  const { db, log, runId } = setup();
  const intent = log.append(runId, 'pause_next_node');
  assert.strictEqual(log.hasPending(runId), true);

  log.consume(intent.intentId);
  assert.strictEqual(log.hasPending(runId), false);
  assert.strictEqual(log.resolve(runId), null);

  // Second consume must not throw or resurrect the intent
  log.consume(intent.intentId);
  assert.strictEqual(log.hasPending(runId), false);
  db.close();
});

test('intent: replaying the same intent list never double-executes (V13)', () => {
  const { db, log, runId } = setup();
  log.append(runId, 'stop_now');

  const firstPass = log.resolve(runId);
  assert.ok(firstPass);
  log.consume(firstPass!.intentId);

  // A rescheduled controller tick reads the same table again
  const secondPass = log.resolve(runId);
  assert.strictEqual(secondPass, null, 'a consumed intent must never be resolved twice');
  db.close();
});

test('intent: a later pause does not resurrect after a stop was consumed', () => {
  const { db, log, runId } = setup();
  const stop = log.append(runId, 'stop_now');
  log.consume(stop.intentId);

  const pause = log.append(runId, 'pause_next_node');
  assert.strictEqual(log.resolve(runId)?.intentId, pause.intentId);
  assert.strictEqual(log.getWatermark(runId), 2, 'watermarks never reset after consumption');
  db.close();
});
```

- [ ] **Step 2: Write the failing test for the session chain**

Create `tests/run/chain.test.ts`:

```typescript
// tests/run/chain.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { RelayDatabase } from '../../packages/controller/src/run/db.ts';
import { RunStore } from '../../packages/controller/src/run/store.ts';
import { SessionChainLedger } from '../../packages/controller/src/run/chain.ts';

function setup(runId = 'run-chain') {
  const db = new RelayDatabase({ dbPath: ':memory:' });
  const store = new RunStore(db);
  store.insertRun({
    runId,
    workspaceKey: `ws-${runId}`,
    workspacePath: `C:/tmp/${runId}`,
    goal: 'chain test',
    state: 'RUNNING',
    unitCount: 4
  });
  return { db, store, chain: new SessionChainLedger(store), runId };
}

test('chain: first link is the run-started session with no predecessor', () => {
  const { db, chain, runId } = setup();
  const link = chain.append({
    runId,
    nextSessionId: 'worker-A',
    adapter: 'dsh',
    provider: 'deepseek-official',
    model: 'deepseek-chat',
    effort: 'high',
    epoch: 1,
    reason: 'run_started'
  });

  assert.strictEqual(link.sequence, 1);
  assert.strictEqual(link.prevSessionId, undefined);
  assert.strictEqual(chain.currentSessionId(runId), 'worker-A');
  db.close();
});

test('chain: handoff links form a contiguous sequence and preserve the old session (R4)', () => {
  const { db, chain, runId } = setup();
  chain.append({
    runId,
    nextSessionId: 'worker-A',
    adapter: 'dsh',
    provider: 'deepseek-official',
    model: 'deepseek-chat',
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
    epoch: 3,
    handoffId: 'h-2',
    reason: 'unit_completed'
  });

  const links = chain.list(runId);
  assert.deepStrictEqual(
    links.map((l) => l.sequence),
    [1, 2, 3]
  );
  assert.deepStrictEqual(
    links.map((l) => l.nextSessionId),
    ['worker-A', 'worker-B', 'worker-C']
  );
  assert.strictEqual(chain.currentSessionId(runId), 'worker-C');
  assert.strictEqual(links[1].handoffId, 'h-1');
  assert.strictEqual(links[2].model, 'deepseek-reasoner');
  db.close();
});

test('chain: superseding marks the previous session without deleting history', () => {
  const { db, chain, runId } = setup();
  chain.append({
    runId,
    nextSessionId: 'worker-A',
    adapter: 'claude',
    provider: 'anthropic',
    model: 'claude-3-7-sonnet',
    epoch: 1,
    reason: 'run_started'
  });
  chain.append({
    runId,
    prevSessionId: 'worker-A',
    nextSessionId: 'worker-B',
    adapter: 'claude',
    provider: 'anthropic',
    model: 'claude-3-7-sonnet',
    epoch: 2,
    handoffId: 'h-1',
    reason: 'unit_completed'
  });

  chain.supersede('worker-A');
  const links = chain.list(runId);
  assert.strictEqual(links.length, 2, 'history must never be deleted');
  assert.ok(typeof links[0].supersededAt === 'number');
  assert.strictEqual(links[1].supersededAt, undefined);
  assert.strictEqual(chain.getActiveSessionId(runId), 'worker-B');
  db.close();
});

test('chain: markSuperseded is idempotent and rejects unknown sessions', () => {
  const { db, chain, runId } = setup();
  chain.append({
    runId,
    nextSessionId: 'worker-A',
    adapter: 'codex',
    provider: 'openai',
    model: 'gpt-5.6-luna',
    epoch: 1,
    reason: 'run_started'
  });

  chain.supersede('worker-A');
  const firstStamp = chain.list(runId)[0].supersededAt;
  chain.supersede('worker-A');
  assert.strictEqual(chain.list(runId)[0].supersededAt, firstStamp, 'second supersede must not change the timestamp');

  assert.throws(() => chain.supersede('nonexistent'), /unknown session/i);
  db.close();
});

test('chain: two runs keep independent chain sequences', () => {
  const db = new RelayDatabase({ dbPath: ':memory:' });
  const store = new RunStore(db);
  for (const runId of ['run-x', 'run-y']) {
    store.insertRun({
      runId,
      workspaceKey: `ws-${runId}`,
      workspacePath: `C:/tmp/${runId}`,
      goal: 'multi-run chain',
      state: 'RUNNING',
      unitCount: 1
    });
  }
  const chain = new SessionChainLedger(store);

  chain.append({
    runId: 'run-x',
    nextSessionId: 'x-1',
    adapter: 'dsh',
    provider: 'deepseek-official',
    model: 'deepseek-chat',
    epoch: 1,
    reason: 'run_started'
  });
  const link = chain.append({
    runId: 'run-y',
    nextSessionId: 'y-1',
    adapter: 'dsh',
    provider: 'deepseek-official',
    model: 'deepseek-chat',
    epoch: 1,
    reason: 'run_started'
  });

  assert.strictEqual(link.sequence, 1, 'sequence must be per-run, not global');
  db.close();
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --experimental-strip-types --test tests/run/intent.test.ts tests/run/chain.test.ts`
Expected: FAIL with "Cannot find module ... src/run/intent.ts"

- [ ] **Step 4: Write `packages/controller/src/run/notifier.ts`**

```typescript
// packages/controller/src/run/notifier.ts
import type { RunEventSeverity } from './store.ts';

export interface RunNotification {
  runId: string;
  type: string;
  severity: RunEventSeverity;
  message: string;
  payload: Record<string, unknown>;
}

export interface Notifier {
  notify(notification: RunNotification): void;
}

/** 默认实现：把 notify 级事件写到 stderr，不打断 stdout 的结构化输出。 */
export class ConsoleNotifier implements Notifier {
  public notify(notification: RunNotification): void {
    process.stderr.write(`[agent-relay] ${notification.type}: ${notification.message}\n`);
  }
}

/** 测试用实现：把所有通知保存在内存中供断言。 */
export class RecordingNotifier implements Notifier {
  public readonly notifications: RunNotification[] = [];

  public notify(notification: RunNotification): void {
    this.notifications.push({ ...notification, payload: { ...notification.payload } });
  }

  public ofType(type: string): RunNotification[] {
    return this.notifications.filter((n) => n.type === type);
  }

  public clear(): void {
    this.notifications.length = 0;
  }
}
```

- [ ] **Step 5: Write `packages/controller/src/run/events.ts`**

```typescript
// packages/controller/src/run/events.ts
import type { RunStore, RunEventRecord, RunEventSeverity } from './store.ts';
import type { Notifier } from './notifier.ts';

/**
 * notify 级事件会打断用户（完成 / 失败 / 需要动作）；其余为静默记录。
 * 正常交接必须静默——「不要求用户点击每次接手」。
 */
const NOTIFY_TYPES = new Set<string>([
  'run_completed',
  'unit_failed',
  'run_blocked',
  'recovery_required',
  'user_action_required'
]);

export function classifySeverity(type: string): RunEventSeverity {
  return NOTIFY_TYPES.has(type) ? 'notify' : 'record';
}

const MESSAGES: Record<string, (payload: Record<string, unknown>) => string> = {
  run_completed: (p) => `run ${p.runId} completed ${p.completedUnits}/${p.totalUnits} units`,
  unit_failed: (p) => `unit ${p.taskId} reported ${p.status}: ${p.summary ?? 'no summary'}`,
  run_blocked: (p) => `run blocked: ${p.reason}`,
  recovery_required: (p) => `recovery required: ${p.reason}`,
  user_action_required: (p) => `user action required: ${p.reason}`
};

export function describeEvent(type: string, payload: Record<string, unknown>): string {
  const describe = MESSAGES[type];
  return describe ? describe(payload) : type;
}

export class RunEventLog {
  private readonly store: RunStore;
  private readonly notifier: Notifier;

  constructor(store: RunStore, notifier: Notifier) {
    this.store = store;
    this.notifier = notifier;
  }

  public record(params: {
    runId: string;
    type: string;
    sessionId?: string;
    payload?: Record<string, unknown>;
    severity?: RunEventSeverity;
  }): RunEventRecord {
    const severity = params.severity ?? classifySeverity(params.type);
    const payload = { runId: params.runId, ...(params.payload ?? {}) };
    const event = this.store.insertEvent({
      runId: params.runId,
      type: params.type,
      severity,
      sessionId: params.sessionId,
      payload
    });

    if (severity === 'notify') {
      this.notifier.notify({
        runId: params.runId,
        type: params.type,
        severity,
        message: describeEvent(params.type, payload),
        payload
      });
    }
    return event;
  }

  public list(runId: string, afterEventId = 0): RunEventRecord[] {
    return this.store.listEvents(runId, afterEventId);
  }
}
```

- [ ] **Step 6: Write `packages/controller/src/run/intent.ts`**

```typescript
// packages/controller/src/run/intent.ts
import type { RunStore, ControlIntentKind, ControlIntentRecord } from './store.ts';

export interface PendingControl {
  intentId: string;
  kind: ControlIntentKind;
  watermark: number;
  payload: Record<string, unknown>;
  createdAt: number;
}

/** 数值越小优先级越高。同级取最小水位，保证裁决可重放。 */
const PRIORITY: Record<ControlIntentKind, number> = {
  stop_now: 0,
  disable: 1,
  pause_next_node: 2,
  resume: 3
};

/**
 * 追加式控制意图日志。意图是 CLI 与 supervisor 之间唯一的控制通道：
 * CLI 只追加，RunController 在每个节点边界读取并消费。
 */
export class ControlIntentLog {
  private readonly store: RunStore;

  constructor(store: RunStore) {
    this.store = store;
  }

  public append(
    runId: string,
    kind: ControlIntentKind,
    payload: Record<string, unknown> = {}
  ): ControlIntentRecord {
    return this.store.transaction(() => this.store.appendIntent(runId, kind, payload));
  }

  public getWatermark(runId: string): number {
    return this.store.getLatestIntentWatermark(runId);
  }

  public listPending(runId: string): ControlIntentRecord[] {
    return this.store.listPendingIntents(runId);
  }

  public hasPending(runId: string): boolean {
    return this.listPending(runId).length > 0;
  }

  /** 按优先级（同级按水位升序）返回唯一待处理意图；没有则返回 null。 */
  public resolve(runId: string): PendingControl | null {
    const pending = this.listPending(runId);
    if (pending.length === 0) return null;

    const winner = pending.reduce((best, candidate) => {
      const bestRank = PRIORITY[best.kind];
      const candidateRank = PRIORITY[candidate.kind];
      if (candidateRank < bestRank) return candidate;
      if (candidateRank === bestRank && candidate.watermark < best.watermark) return candidate;
      return best;
    }, pending[0]);

    return {
      intentId: winner.intentId,
      kind: winner.kind,
      watermark: winner.watermark,
      payload: winner.payload,
      createdAt: winner.createdAt
    };
  }

  public consume(intentId: string): void {
    this.store.markIntentConsumed(intentId);
  }

  /** 未消费意图数量——非 0 时执行令牌失效（§5.3）。 */
  public pendingCount(runId: string): number {
    return this.listPending(runId).length;
  }
}
```

- [ ] **Step 7: Write `packages/controller/src/run/chain.ts`**

```typescript
// packages/controller/src/run/chain.ts
import type { RunStore, SessionChainLink, InsertChainLinkParams } from './store.ts';

/**
 * 会话链：旧 → 新会话链接的追加式账本。
 * 历史会话只封存（supersededAt）不删除，满足「旧会话保留可查，不自动删除」。
 */
export class SessionChainLedger {
  private readonly store: RunStore;

  constructor(store: RunStore) {
    this.store = store;
  }

  public append(params: Omit<InsertChainLinkParams, 'sequence'>): SessionChainLink {
    return this.store.transaction(() => {
      const sequence = this.store.nextChainSequence(params.runId);
      return this.store.insertChainLink({ ...params, sequence });
    });
  }

  public list(runId: string): SessionChainLink[] {
    return this.store.listChain(runId);
  }

  public currentSessionId(runId: string): string | undefined {
    const latest = this.store.getLatestChainLink(runId);
    return latest?.nextSessionId;
  }

  public getActiveSessionId(runId: string): string | undefined {
    const links = this.store.listChain(runId);
    const active = [...links].reverse().find((l) => l.supersededAt === undefined);
    return active?.nextSessionId;
  }

  public supersede(sessionId: string): void {
    this.store.transaction(() => {
      const links = this.store.findChainLinksBySession(sessionId);
      if (links.length === 0) {
        throw new Error(`SessionChainLedger: unknown session ${sessionId}`);
      }
      if (links.every((link) => link.supersededAt !== undefined)) {
        return; // 已封存，保持不变（幂等）
      }
      this.store.markSessionSuperseded(sessionId);
    });
  }
}
```

- [ ] **Step 8: Update the run barrel export**

Modify `packages/controller/src/run/index.ts`:

```typescript
export * from './db.ts';
export * from './store.ts';
export * from './notifier.ts';
export * from './events.ts';
export * from './intent.ts';
export * from './chain.ts';
```

- [ ] **Step 9: Run tests to verify they pass**

Run: `node --experimental-strip-types --test tests/run/intent.test.ts tests/run/chain.test.ts`
Expected: PASS (12 tests pass)

- [ ] **Step 10: Run the full suite**

Run: `npm test`
Expected: PASS, 0 failures

- [ ] **Step 11: Commit**

```bash
git add packages/controller/src/run/notifier.ts packages/controller/src/run/events.ts packages/controller/src/run/intent.ts packages/controller/src/run/chain.ts packages/controller/src/run/index.ts tests/run/intent.test.ts tests/run/chain.test.ts
git commit -m "feat(controller/run): add control intent log, session chain ledger and run event log"
```

---

### Task 3: 工作区 key 规范化与 `DurableLeaseManager`

**Files:**
- Create: `packages/controller/src/workspace/key.ts`
- Create: `packages/controller/src/handoff/durable-lease.ts`
- Modify: `packages/controller/src/workspace/index.ts`
- Modify: `packages/controller/src/handoff/index.ts`
- Test: `tests/workspace/key.test.ts`
- Test: `tests/transactions/durable-lease.test.ts`

**Interfaces:**
- Consumes: `RunStore`、`LeaseRow` from `../run/store.ts`；`WorkspaceLease` from `./lease.ts`
- Produces: `normalizeWorkspaceKey(workspacePath: string): string`、`DurableLeaseManager`

- [ ] **Step 1: Write the failing test for workspace key normalization**

Create `tests/workspace/key.test.ts`:

```typescript
// tests/workspace/key.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeWorkspaceKey } from '../../packages/controller/src/workspace/key.ts';

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('key: relative and absolute forms of the same directory resolve identically', () => {
  const dir = makeTempDir('agent-relay-key-');
  const absolute = normalizeWorkspaceKey(dir);
  const relative = normalizeWorkspaceKey(path.relative(process.cwd(), dir));
  assert.strictEqual(relative, absolute);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('key: a junction and its target resolve to the same workspace key (V34)', () => {
  const target = makeTempDir('agent-relay-target-');
  const linkParent = makeTempDir('agent-relay-link-');
  const link = path.join(linkParent, 'linked-workspace');

  try {
    fs.symlinkSync(target, link, 'junction');
  } catch (err) {
    // Junction creation requires no privileges on Windows; on other platforms
    // fall back to a directory symlink and skip if the platform refuses both.
    try {
      fs.symlinkSync(target, link, 'dir');
    } catch {
      fs.rmSync(target, { recursive: true, force: true });
      fs.rmSync(linkParent, { recursive: true, force: true });
      throw new Error(`cannot create link for V34 test: ${(err as Error).message}`);
    }
  }

  assert.strictEqual(
    normalizeWorkspaceKey(link),
    normalizeWorkspaceKey(target),
    'a junction and its target must share one workspace key'
  );

  fs.rmSync(linkParent, { recursive: true, force: true });
  fs.rmSync(target, { recursive: true, force: true });
});

test('key: case-variant paths resolve identically on Windows (V34)', () => {
  if (process.platform !== 'win32') {
    // Windows 是本项目第一验证环境；大小写不敏感语义仅在 Windows 上成立。
    return;
  }
  const dir = makeTempDir('agent-relay-case-');
  const upper = dir.toUpperCase();
  const lower = dir.toLowerCase();
  assert.notStrictEqual(upper, lower, 'the test path must actually differ in case');
  assert.strictEqual(normalizeWorkspaceKey(upper), normalizeWorkspaceKey(lower));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('key: independent directories never collide, including sibling worktrees', () => {
  const a = makeTempDir('agent-relay-wt-a-');
  const b = makeTempDir('agent-relay-wt-b-');
  assert.notStrictEqual(normalizeWorkspaceKey(a), normalizeWorkspaceKey(b));
  fs.rmSync(a, { recursive: true, force: true });
  fs.rmSync(b, { recursive: true, force: true });
});

test('key: a non-existent path still normalizes deterministically and does not throw', () => {
  const ghost = path.join(os.tmpdir(), 'agent-relay-nonexistent-xyz', 'nested');
  const first = normalizeWorkspaceKey(ghost);
  const second = normalizeWorkspaceKey(ghost);
  assert.strictEqual(first, second);
  assert.ok(first.length > 0);
});
```

- [ ] **Step 2: Write the failing test for the durable lease**

Create `tests/transactions/durable-lease.test.ts`:

```typescript
// tests/transactions/durable-lease.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RelayDatabase } from '../../packages/controller/src/run/db.ts';
import { RunStore } from '../../packages/controller/src/run/store.ts';
import { DurableLeaseManager } from '../../packages/controller/src/handoff/durable-lease.ts';

function makeManager() {
  const db = new RelayDatabase({ dbPath: ':memory:' });
  const store = new RunStore(db);
  return { db, store, lease: new DurableLeaseManager(store) };
}

test('durable-lease: acquireInitialLease refuses a second owner for the same workspace', () => {
  const { db, lease } = makeManager();
  assert.strictEqual(lease.acquireInitialLease('ws-1', 'owner-1', 1), true);
  assert.strictEqual(lease.acquireInitialLease('ws-1', 'owner-2', 1), false);
  assert.strictEqual(lease.getLease('ws-1')?.currentOwner, 'owner-1');
  db.close();
});

test('durable-lease: CAS enforces owner, epoch and monotonicity (R10, V34)', () => {
  const { db, lease } = makeManager();
  lease.acquireInitialLease('ws-1', 'session-a', 1);

  assert.strictEqual(lease.compareAndSetOwner('ws-1', 'session-a', 'session-b', 1, 2), true);
  assert.strictEqual(lease.getLease('ws-1')?.currentOwner, 'session-b');
  assert.strictEqual(lease.getLease('ws-1')?.epoch, 2);

  assert.strictEqual(lease.compareAndSetOwner('ws-1', 'session-a', 'rogue', 1, 3), false, 'stale owner rejected');
  assert.strictEqual(lease.compareAndSetOwner('ws-1', 'session-b', 'rogue', 1, 3), false, 'stale epoch rejected');
  assert.strictEqual(lease.compareAndSetOwner('ws-1', 'session-b', 'rogue', 2, 2), false, 'epoch must increase');
  assert.strictEqual(lease.getLease('ws-1')?.currentOwner, 'session-b');
  db.close();
});

test('durable-lease: compareAndSetOwner returns false for an unknown workspace', () => {
  const { db, lease } = makeManager();
  assert.strictEqual(lease.compareAndSetOwner('missing', 'a', 'b', 1, 2), false);
  db.close();
});

test('durable-lease: getLease returns a defensive copy', () => {
  const { db, lease } = makeManager();
  lease.acquireInitialLease('ws-1', 'owner-1', 1);
  const snapshot = lease.getLease('ws-1');
  assert.ok(snapshot);
  snapshot!.currentOwner = 'mutated';
  assert.strictEqual(lease.getLease('ws-1')?.currentOwner, 'owner-1');
  db.close();
});

test('durable-lease: releaseLease requires the correct owner', () => {
  const { db, lease } = makeManager();
  lease.acquireInitialLease('ws-1', 'owner-1', 1);
  assert.strictEqual(lease.releaseLease('ws-1', 'wrong-owner'), false);
  assert.strictEqual(lease.releaseLease('ws-1', 'owner-1'), true);
  assert.strictEqual(lease.getLease('ws-1'), undefined);
  db.close();
});

test('durable-lease: independent workspaces operate in isolation (V31)', () => {
  const { db, lease } = makeManager();
  lease.acquireInitialLease('ws-a', 'owner-a', 1);
  lease.acquireInitialLease('ws-b', 'owner-b', 1);

  assert.strictEqual(lease.compareAndSetOwner('ws-a', 'owner-a', 'owner-a2', 1, 2), true);
  assert.strictEqual(lease.getLease('ws-b')?.currentOwner, 'owner-b');
  assert.strictEqual(lease.getLease('ws-b')?.epoch, 1);
  db.close();
});

test('durable-lease: ownership survives a controller restart (V21)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-relay-lease-'));
  const dbPath = path.join(dir, 'relay.db');

  const db1 = new RelayDatabase({ dbPath });
  const lease1 = new DurableLeaseManager(new RunStore(db1));
  lease1.acquireInitialLease('ws-persist', 'session-a', 1);
  lease1.compareAndSetOwner('ws-persist', 'session-a', 'session-b', 1, 2);
  db1.close();

  // Simulate a fresh controller process opening the same database
  const db2 = new RelayDatabase({ dbPath });
  const lease2 = new DurableLeaseManager(new RunStore(db2));
  assert.strictEqual(lease2.getLease('ws-persist')?.currentOwner, 'session-b');
  assert.strictEqual(lease2.getLease('ws-persist')?.epoch, 2);
  assert.strictEqual(
    lease2.compareAndSetOwner('ws-persist', 'session-a', 'rogue', 1, 3),
    false,
    'a restarted controller must still reject the superseded owner'
  );
  db2.close();

  fs.rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --experimental-strip-types --test tests/workspace/key.test.ts tests/transactions/durable-lease.test.ts`
Expected: FAIL with "Cannot find module ... src/workspace/key.ts"

- [ ] **Step 4: Write `packages/controller/src/workspace/key.ts`**

```typescript
// packages/controller/src/workspace/key.ts
import fs from 'node:fs';
import path from 'node:path';

/**
 * 把物理工作区路径规范化为跨 run、跨客户端一致的 workspace_key（V34）。
 *
 * 规则：
 *  1. 解析为绝对路径
 *  2. 用 realpathSync.native 解析符号链接与 Windows junction
 *  3. Windows 上折叠大小写（该平台文件系统大小写不敏感）
 *
 * 独立 worktree 的 realpath 各不相同，因此不会被误判为同一工作区。
 */
export function normalizeWorkspaceKey(workspacePath: string): string {
  const resolved = path.resolve(workspacePath);

  let real = resolved;
  try {
    real = fs.realpathSync.native(resolved);
  } catch {
    // 路径不存在（尚未创建的工作区）时退回绝对路径，保持确定性
    real = resolved;
  }

  const normalized = path.normalize(real);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
```

- [ ] **Step 5: Write `packages/controller/src/handoff/durable-lease.ts`**

```typescript
// packages/controller/src/handoff/durable-lease.ts
import type { RunStore } from '../run/store.ts';
import type { WorkspaceLease } from './lease.ts';

/**
 * 落库版单写入者 CAS 租约。方法签名与内存版 WorkspaceLeaseManager 逐一对齐，
 * 因此可以直接注入三个适配器的 handshake coordinator，使内存与磁盘租约不再可能分叉。
 *
 * 与内存版一致的不变量：owner 不符、epoch 不符、或 newEpoch <= expectedEpoch 时 CAS 失败。
 */
export class DurableLeaseManager {
  private readonly store: RunStore;

  constructor(store: RunStore) {
    this.store = store;
  }

  public acquireInitialLease(workspaceKey: string, owner: string, epoch = 1): boolean {
    return this.store.transaction(() => {
      if (this.store.getLeaseRow(workspaceKey)) {
        return false;
      }
      return this.store.tryInsertLease(workspaceKey, owner, epoch);
    });
  }

  public compareAndSetOwner(
    workspaceKey: string,
    expectedOwner: string,
    newOwner: string,
    expectedEpoch: number,
    newEpoch: number
  ): boolean {
    if (newEpoch <= expectedEpoch) {
      return false;
    }
    return this.store.transaction(() =>
      this.store.casLeaseRow(workspaceKey, expectedOwner, newOwner, expectedEpoch, newEpoch)
    );
  }

  public getLease(workspaceKey: string): WorkspaceLease | undefined {
    const row = this.store.getLeaseRow(workspaceKey);
    if (!row) return undefined;
    return {
      workspaceKey: row.workspaceKey,
      currentOwner: row.currentOwner,
      epoch: row.epoch,
      acquiredAt: row.acquiredAt
    };
  }

  public releaseLease(workspaceKey: string, owner: string): boolean {
    return this.store.transaction(() => this.store.deleteLease(workspaceKey, owner));
  }
}
```

- [ ] **Step 6: Wire the barrel exports**

Modify `packages/controller/src/workspace/index.ts`:

```typescript
export * from './sentinel.ts';
export * from './checkpoint.ts';
export * from './key.ts';
```

Modify `packages/controller/src/handoff/index.ts`:

```typescript
export * from './lease.ts';
export * from './outbox.ts';
export * from './state-machine.ts';
export * from './durable-lease.ts';
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `node --experimental-strip-types --test tests/workspace/key.test.ts tests/transactions/durable-lease.test.ts`
Expected: PASS (12 tests pass)

- [ ] **Step 8: Run the full suite**

Run: `npm test`
Expected: PASS, 0 failures

- [ ] **Step 9: Commit**

```bash
git add packages/controller/src/workspace/key.ts packages/controller/src/workspace/index.ts packages/controller/src/handoff/durable-lease.ts packages/controller/src/handoff/index.ts tests/workspace/key.test.ts tests/transactions/durable-lease.test.ts
git commit -m "feat(controller): add workspace key normalization and durable CAS lease manager"
```

---

### Task 4: 统一 `HandshakeCoordinator` 契约与 SPI `getSessionOutput`

**Files:**
- Create: `packages/protocol/src/coordinator.ts`
- Modify: `packages/protocol/src/index.ts`
- Modify: `packages/protocol/src/adapter.ts`
- Modify: `packages/adapters/mock/src/mock-adapter.ts`
- Modify: `packages/adapters/claude/src/handshake.ts`
- Modify: `packages/adapters/codex/src/handshake.ts`
- Modify: `packages/adapters/dsh/src/handshake.ts`
- Test: `tests/contracts/handshake-coordinator.test.ts`
- Modify: `tests/contracts/adapter-spi.test.ts`

**Interfaces:**
- Consumes: `HandoffPackManifest`, `HandoffAckPacket` from `./types.ts`；`HandoffStateMachine`、`WorkspaceLeaseManager` from `packages/controller`
- Produces: `HandshakeCoordinator`、`HandshakeResult`（protocol 层规范版本）；三个 coordinator 的规范方法 `buildPreparationPrompt` / `parseAckFromOutput`；`AgentRelayAdapter.getSessionOutput`

**背景（实现者必读）**：三个适配器的 coordinator 存在历史命名与提示词方言差异——

| 适配器 | 类名 | 构造签名 | 原提示词方法 | 原 ACK 解析方法 | 提示词方言 |
|---|---|---|---|---|---|
| claude | `TwoPhaseHandshakeCoordinator` | `(stateMachine, leaseManager, workspaceKey)` | `generatePreparationPrompt` | `extractAckFromText` → `HandoffAckPacket \| undefined` | manifest JSON 代码块 |
| codex | `CodexHandshakeCoordinator` | `(stateMachine, leaseManager, workspaceKey)` | `generatePreparationPrompt` | `extractAckFromText` → `HandoffAckPacket \| undefined` | manifest JSON 代码块 |
| dsh | `DshHandshakeCoordinator` | `({ adapter, leaseManager, stateMachine, workspaceKey })` | `buildPreparationPrompt` | `parseAckFromOutput` → `HandoffAckPacket \| null` | `KEY: value` 标记行 |

本任务**只做增量对齐**：新增规范方法作为既有方法的委托别名，不修改任何既有方法的行为与签名，因此既有测试无需改动。方言差异保留（由共享 skill 负责覆盖），但契约测试必须断言三者都能在规范的只读准备提示词上工作。

- [ ] **Step 1: Write the failing contract test**

Create `tests/contracts/handshake-coordinator.test.ts`:

```typescript
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

  stateMachine.requestHandoff('unit_completed');
  stateMachine.checkpointCompleted(manifest.handoffId);
  stateMachine.startNewSession('target-session');

  const coordinator = build(stateMachine, leaseManager, WORKSPACE_KEY);

  const prompt = coordinator.buildPreparationPrompt(manifest);
  assert.ok(prompt.length > 0, 'buildPreparationPrompt must return a non-empty prompt');
  // Both dialects must declare read-only mode; DSH spells it `READ_ONLY`, Codex/Claude `READ-ONLY`.
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test tests/contracts/handshake-coordinator.test.ts`
Expected: FAIL with "Cannot find module ... protocol/src/coordinator.ts"

- [ ] **Step 3: Write `packages/protocol/src/coordinator.ts`**

```typescript
// packages/protocol/src/coordinator.ts
import type { HandoffPackManifest, HandoffAckPacket } from './types.ts';

export interface HandshakeResult {
  success: boolean;
  executionToken?: string;
  epoch?: number;
  error?: string;
}

/**
 * 两阶段只读握手的跨适配器契约。
 *
 * 约定：
 *  - buildPreparationPrompt 返回必须以只读方式启动新会话的提示词，并携带 handoffId 等核对字段。
 *  - parseAckFromOutput 从会话输出中提取 HandoffAckPacket；无法解析时返回 null（不得抛错）。
 *  - verifyAckAndAuthorize 校验 3D 哈希与有效模型，并在状态机处于 PREPARING 时执行 CAS 租约转移；
 *    失败必须返回 { success: false }，且不得留下已转移的租约。
 *  - startNewSession 把状态机从 CHECKPOINTED/STARTING 推进到 PREPARING 并记录新 owner。
 *
 * 提示词方言按适配器不同（Codex/Claude 用 manifest JSON，DSH 用 KEY: value 标记行）；
 * 契约只要求两者都声明只读模式并携带 handoffId，具体方言由共享 skill 覆盖。
 */
export interface HandshakeCoordinator {
  startNewSession(newSessionId: string): void;
  buildPreparationPrompt(manifest: HandoffPackManifest): string;
  parseAckFromOutput(text: string): HandoffAckPacket | null;
  verifyAckAndAuthorize(manifest: HandoffPackManifest, ack: HandoffAckPacket): HandshakeResult;
}
```

- [ ] **Step 4: Export the coordinator contract and extend the SPI**

Modify `packages/protocol/src/index.ts` (add one line):

```typescript
export * from './types.ts';
export * from './inputs.ts';
export * from './tasks.ts';
export * from './handoff.ts';
export * from './events.ts';
export * from './adapter.ts';
export * from './coordinator.ts';
```

Modify `packages/protocol/src/adapter.ts` — add `getSessionOutput` to `AgentRelayAdapter` (after `interruptOwned`):

```typescript
export interface AgentRelayAdapter {
  capabilities(): SessionCapabilities;
  createFresh(config: SpawnSessionConfig): Promise<SessionInspectResult> | SessionInspectResult;
  inspectSession(sessionId: string): Promise<SessionInspectResult | undefined> | SessionInspectResult | undefined;
  submit(sessionId: string, messageId: string, content: string, epoch?: number): Promise<void> | void;
  requestDrain(sessionId: string, handoffId: string): Promise<boolean> | boolean;
  awaitQuiescence(sessionId: string, timeoutMs?: number): Promise<'quiescent' | 'timeout' | 'error'>;
  authorizeExecution(sessionId: string, epoch: number, executionToken: string): Promise<boolean> | boolean;
  interruptOwned(sessionId: string): Promise<boolean> | boolean;
  /** 会话累计的可读输出；交接 ACK 与单元结果都从这里解析。未知会话返回空字符串。 */
  getSessionOutput(sessionId: string): string;
}
```

- [ ] **Step 5: Add the canonical aliases to the three coordinators**

Modify `packages/adapters/claude/src/handshake.ts`. Add the import for the contract at the top (after the existing imports), change the class declaration, and append the two alias methods **inside** the class right after `generatePreparationPrompt`:

```typescript
import type { HandshakeCoordinator } from '../../../protocol/src/coordinator.ts';
```

```typescript
export class TwoPhaseHandshakeCoordinator implements HandshakeCoordinator {
```

```typescript
  /** 契约别名：引擎只依赖规范方法名，方言差异由各适配器自行决定。 */
  public buildPreparationPrompt(manifest: HandoffPackManifest): string {
    return this.generatePreparationPrompt(manifest);
  }
```

and right after `extractAckFromText`:

```typescript
  public parseAckFromOutput(text: string): HandoffAckPacket | null {
    return this.extractAckFromText(text) ?? null;
  }
```

Apply the **identical** two method additions and the `implements HandshakeCoordinator` clause to `packages/adapters/codex/src/handshake.ts` (class `CodexHandshakeCoordinator`; same import path depth).

Modify `packages/adapters/dsh/src/handshake.ts`: add the import and change the class declaration only — DSH already names its methods canonically:

```typescript
import type { HandshakeCoordinator } from '../../../protocol/src/coordinator.ts';
```

```typescript
export class DshHandshakeCoordinator implements HandshakeCoordinator {
```

- [ ] **Step 6: Implement `getSessionOutput` on MockAdapter**

Modify `packages/adapters/mock/src/mock-adapter.ts`:

Add a field next to `sessions`:

```typescript
  public readonly output: Map<string, string[]> = new Map();
```

Change `submit` so it records content (currently the parameter is `_content`):

```typescript
  public submit(sessionId: string, _messageId: string, content: string, _epoch?: number): void {
    const sess = this.sessions.get(sessionId);
    if (!sess || !sess.active) {
      throw new Error(`Cannot submit to inactive or nonexistent session: ${sessionId}`);
    }
    const chunks = this.output.get(sessionId) ?? [];
    chunks.push(content);
    this.output.set(sessionId, chunks);
  }

  public getSessionOutput(sessionId: string): string {
    return (this.output.get(sessionId) ?? []).join('\n');
  }
```

Also clear output on `createFresh` for a reused session id, at the end of `createFresh` before the `return`:

```typescript
    this.output.set(sid, []);
```

- [ ] **Step 7: Extend the SPI contract test to cover `getSessionOutput`**

Modify `tests/contracts/adapter-spi.test.ts` — in the **MockAdapter** test, after `await adapter.submit('sess-test-1', 'msg-1', 'Hello world');` add:

```typescript
  assert.strictEqual(typeof adapter.getSessionOutput('sess-test-1'), 'string');
  assert.match(adapter.getSessionOutput('sess-test-1'), /Hello world/);
  assert.strictEqual(adapter.getSessionOutput('nonexistent-session'), '');
```

In the **Claude**, **Codex** and **DSH** tests, add the same shape assertion with their own session id, e.g. after the `createFresh` assertions:

```typescript
  assert.strictEqual(typeof adapter.getSessionOutput('sess-spi-claude'), 'string');
```

(use `'sess-spi-codex'` and `'sess-spi-dsh'` respectively; before any assertion that kills the session, so output is readable).

- [ ] **Step 8: Run tests to verify they pass**

Run: `node --experimental-strip-types --test tests/contracts/handshake-coordinator.test.ts tests/contracts/adapter-spi.test.ts`
Expected: PASS (4 coordinator tests + 4 adapter tests)

- [ ] **Step 9: Run the full suite**

Run: `npm test`
Expected: PASS, 0 failures (the alias additions must not alter any existing handshake behaviour)

- [ ] **Step 10: Commit**

```bash
git add packages/protocol/src/coordinator.ts packages/protocol/src/index.ts packages/protocol/src/adapter.ts packages/adapters/claude/src/handshake.ts packages/adapters/codex/src/handshake.ts packages/adapters/dsh/src/handshake.ts packages/adapters/mock/src/mock-adapter.ts tests/contracts/handshake-coordinator.test.ts tests/contracts/adapter-spi.test.ts
git commit -m "feat(protocol): add unified HandshakeCoordinator contract and getSessionOutput SPI member"
```

---

### Task 5: 状态机增量转移与 P1 原语的可重建导入

**Files:**
- Modify: `packages/controller/src/handoff/state-machine.ts`
- Modify: `packages/controller/src/inputs/ledger.ts`
- Modify: `packages/controller/src/tasks/graph.ts`
- Modify: `tests/transactions/handoff-transaction.test.ts`（追加状态机转移测试）
- Modify: `tests/contracts/inputs.test.ts`（追加账本重建测试）
- Modify: `tests/contracts/tasks.test.ts`（追加任务图重建测试）

**Interfaces:**
- Consumes: `InputRecord`、`TaskItem` from `packages/protocol`
- Produces: `HandoffStateMachine.beginStarting()`、`.resume()`、`.markRecoveryRequired()`、`.resolveRecovery()`，且 `startNewSession()` 可从 `STARTING` 进入；`InputLedger.restoreFrom(records: InputRecord[])`；`TaskGraph.restoreFrom(items: TaskItem[])`

**为何必需**：`InputLedger` 的 `appendUserMessage` / `appendSystemHandoff` 会重新生成 `inputId` 与 `timestamp` 并重算哈希，因此无法用它们重建账本——重建后的 `getHeadHash()` 会变化，交接包里的 `inputLedgerHeadHash` 将全部失效。`restoreFrom` 必须逐字还原原始记录。同理，`TaskGraph` 的 `addTask` 只能创建 `pending` 任务，无法还原 `status` / `testEvidenceHash` / `completedAt`，任务快照哈希将无法跨重启稳定。

- [ ] **Step 1: Write the failing state machine test**

Append to `tests/transactions/handoff-transaction.test.ts`:

```typescript
test('state-machine: supports the STARTING leg and recovery transitions required by the engine (V14, V20)', () => {
  const sm = new HandoffStateMachine('run-sm-2', 'session-a', 1);
  assert.strictEqual(sm.getState(), 'RUNNING');

  sm.requestHandoff('unit_completed');
  sm.checkpointCompleted('h-ckpt');
  assert.strictEqual(sm.getState(), 'CHECKPOINTED');

  // STARTING models the window where the create intent is durable but the
  // create result may still be unknown (V14).
  sm.beginStarting();
  assert.strictEqual(sm.getState(), 'STARTING');

  // startNewSession must accept STARTING as well as CHECKPOINTED
  sm.startNewSession('session-b');
  assert.strictEqual(sm.getState(), 'PREPARING');
  assert.strictEqual(sm.getCurrentOwner(), 'session-b');

  // PREPARING -> RECOVERY_REQUIRED when the ACK cannot be reconciled
  sm.markRecoveryRequired();
  assert.strictEqual(sm.getState(), 'RECOVERY_REQUIRED');

  // RECOVERY_REQUIRED -> CHECKPOINTED once the state is re-established
  sm.resolveRecovery();
  assert.strictEqual(sm.getState(), 'CHECKPOINTED');

  // PAUSED -> CHECKPOINTED on user resume (03-技术设计.md §7)
  const sm2 = new HandoffStateMachine('run-sm-3', 'session-x', 1);
  sm2.pause();
  assert.strictEqual(sm2.getState(), 'PAUSED');
  sm2.resume();
  assert.strictEqual(sm2.getState(), 'CHECKPOINTED');
});

test('state-machine: new transitions reject invalid source states', () => {
  const sm = new HandoffStateMachine('run-sm-4', 'session-a', 1);

  assert.throws(() => sm.beginStarting(), /Cannot begin starting session in state RUNNING/);
  assert.throws(() => sm.resolveRecovery(), /Cannot resolve recovery in state RUNNING/);
  assert.throws(() => sm.resume(), /Cannot resume in state RUNNING/);

  sm.requestHandoff('unit_completed');
  assert.throws(() => sm.beginStarting(), /Cannot begin starting session in state DRAINING/);
  // 无法确认旧写入静止时 DRAINING 必须能进入恢复态（03-技术设计.md §7、§6.3 第 2 步；Task 8 交接第 2 步依赖它）
  sm.markRecoveryRequired();
  assert.strictEqual(sm.getState(), 'RECOVERY_REQUIRED');
});
```

- [ ] **Step 2: Write the failing ledger restore test**

Append to `tests/contracts/inputs.test.ts`:

```typescript
test('ledger: restoreFrom reproduces the exact head hash and rejects tampered records', () => {
  const original = new InputLedger();
  original.appendUserMessage('Build the pipeline with a read-only handoff');
  original.appendUserMessage('Also do not change the public API', original.getAllRecords()[0].inputId);
  original.appendSystemHandoff('generated handoff material must not become human authority');

  const snapshot = original.getAllRecords();
  const expectedHead = original.getHeadHash();

  const restored = new InputLedger();
  restored.restoreFrom(snapshot);

  assert.strictEqual(restored.getHeadHash(), expectedHead, 'head hash must survive a restore verbatim');
  assert.deepStrictEqual(
    restored.getAllRecords().map((r) => r.inputId),
    snapshot.map((r) => r.inputId),
    'input ids must not be regenerated'
  );
  assert.deepStrictEqual(
    restored.getAllRecords().map((r) => r.timestamp),
    snapshot.map((r) => r.timestamp),
    'timestamps must not be regenerated'
  );
  assert.strictEqual(restored.getHumanInputs().length, 2);
  assert.strictEqual(restored.getAllRecords().length, 3);

  // Tampered content must be rejected outright
  const tampered = snapshot.map((r) => ({ ...r, rawContent: `${r.rawContent} (edited)` }));
  const victim = new InputLedger();
  assert.throws(() => victim.restoreFrom(tampered), /hash mismatch/);
  assert.strictEqual(victim.getAllRecords().length, 0, 'a rejected restore must leave the ledger untouched');

  // Restoring twice must not duplicate records
  restored.restoreFrom(snapshot);
  assert.strictEqual(restored.getAllRecords().length, 3);
  assert.strictEqual(restored.getHeadHash(), expectedHead);
});
```

- [ ] **Step 3: Write the failing task graph restore test**

Append to `tests/contracts/tasks.test.ts`:

```typescript
test('tasks: restoreFrom preserves status, evidence and completedAt across a rebuild', () => {
  const original = new TaskGraph();
  original.addTask({ taskId: 'u1', requirementId: 'req-1', title: 'Unit 1' });
  original.addTask({ taskId: 'u2', requirementId: 'req-1', title: 'Unit 2', dependencies: ['u1'] });
  original.addTask({ taskId: 'u3', requirementId: 'req-1', title: 'Unit 3', dependencies: ['u2'] });
  original.completeTaskWithEvidence('u1', 'evidence-u1');
  original.updateTaskStatus('u2', 'in_progress');

  const snapshot = original.getAllTasks();
  const expectedHash = original.computeSnapshotHash();

  const restored = new TaskGraph();
  restored.restoreFrom(snapshot);

  assert.strictEqual(restored.computeSnapshotHash(), expectedHash, 'snapshot hash must survive a rebuild');
  assert.strictEqual(restored.getTask('u1')?.status, 'completed');
  assert.strictEqual(restored.getTask('u1')?.testEvidenceHash, 'evidence-u1');
  assert.strictEqual(restored.getTask('u1')?.completedAt, original.getTask('u1')?.completedAt);
  assert.strictEqual(restored.getTask('u2')?.status, 'in_progress');
  assert.strictEqual(restored.getTask('u3')?.status, 'pending');
  assert.deepStrictEqual(restored.getTask('u2')?.dependencies, ['u1']);

  // A completed task without evidence must be rejected
  assert.throws(
    () => new TaskGraph().restoreFrom([{ ...snapshot[0], status: 'completed', testEvidenceHash: undefined }]),
    /completed status requires testEvidenceHash|evidence/i
  );

  // A dependency on a task that does not exist must be rejected
  assert.throws(
    () => new TaskGraph().restoreFrom([{ ...snapshot[2], dependencies: ['ghost'] }]),
    /unknown dependency/i
  );

  // Restoring twice must not duplicate tasks
  restored.restoreFrom(snapshot);
  assert.strictEqual(restored.getAllTasks().length, 3);
  assert.strictEqual(restored.computeSnapshotHash(), expectedHash);
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `node --experimental-strip-types --test tests/transactions/handoff-transaction.test.ts tests/contracts/inputs.test.ts tests/contracts/tasks.test.ts`
Expected: FAIL with "sm.beginStarting is not a function" and "restored.restoreFrom is not a function"

- [ ] **Step 5: Add the new transitions to `HandoffStateMachine`**

Modify `packages/controller/src/handoff/state-machine.ts` — replace `startNewSession` and append the new methods after `receiveAck` / before `pause`:

```typescript
  public startNewSession(newSessionId: string): void {
    if (this.state !== 'CHECKPOINTED' && this.state !== 'STARTING') {
      throw new Error(`Cannot start new session in state ${this.state}`);
    }
    this.state = 'PREPARING';
    this.currentOwner = newSessionId;
  }
```

```typescript
  /** 用户继续：PAUSED → CHECKPOINTED，随后必须重新核对才可再次交接。 */
  public resume(): void {
    if (this.state !== 'PAUSED') {
      throw new Error(`Cannot resume in state ${this.state}`);
    }
    this.state = 'CHECKPOINTED';
  }

  /** CHECKPOINTED → STARTING：创建意图已持久化，但创建结果可能仍未知（V14）。 */
  public beginStarting(): void {
    if (this.state !== 'CHECKPOINTED') {
      throw new Error(`Cannot begin starting session in state ${this.state}`);
    }
    this.state = 'STARTING';
  }

  /** 无法确认旧写入静止或创建结果不确定时进入恢复态。 */
  public markRecoveryRequired(): void {
    if (this.state !== 'DRAINING' && this.state !== 'STARTING' && this.state !== 'PREPARING') {
      throw new Error(`Cannot mark recovery required in state ${this.state}`);
    }
    this.state = 'RECOVERY_REQUIRED';
  }

  /** 查明状态后回到 CHECKPOINTED 以便重新封装。 */
  public resolveRecovery(): void {
    if (this.state !== 'RECOVERY_REQUIRED') {
      throw new Error(`Cannot resolve recovery in state ${this.state}`);
    }
    this.state = 'CHECKPOINTED';
  }
```

- [ ] **Step 6: Add `restoreFrom` to `InputLedger`**

Modify `packages/controller/src/inputs/ledger.ts` — add after `appendSystemHandoff`:

```typescript
  /**
   * 从持久化记录逐字重建账本（重启恢复用）。
   * 每条记录都经过 validateInputRecord（含 sha256 完整性校验）；任何一条被篡改即整体拒绝，
   * 不留下半还原状态。原始 inputId / timestamp / sha256Hash 一律保留，因此 getHeadHash() 可稳定复现。
   */
  public restoreFrom(records: InputRecord[]): void {
    if (records.length === 0) {
      return;
    }
    const staged: InputRecord[] = [];
    for (const record of records) {
      const copy: InputRecord = {
        inputId: record.inputId,
        source: record.source,
        timestamp: record.timestamp,
        rawContent: record.rawContent,
        sha256Hash: record.sha256Hash,
        supersedesId: record.supersedesId,
        metadata: record.metadata
      };
      validateInputRecord(copy);
      Object.freeze(copy);
      if (this.records.some((existing) => existing.inputId === copy.inputId)) {
        continue; // 幂等：已存在的记录不重复追加
      }
      staged.push(copy);
    }
    this.records.push(...staged);
  }
```

- [ ] **Step 7: Add `restoreFrom` to `TaskGraph`**

Modify `packages/controller/src/tasks/graph.ts` — add after `addTask`:

```typescript
  /**
   * 从持久化快照逐字重建任务图（重启恢复用）。
   * 保留 status / testEvidenceHash / completedAt，因此 computeSnapshotHash() 可稳定复现。
   * 校验：依赖必须存在、不得自引用、不得成环、completed 必须携带证据。
   * 任何一条不合法即整体拒绝，不留下半还原状态。
   */
  public restoreFrom(items: TaskItem[]): void {
    if (items.length === 0) {
      return;
    }

    const staged: TaskItem[] = [];
    const stagedById = new Map<string, TaskItem>();
    for (const item of items) {
      const existing = this.tasks.get(item.taskId) ?? stagedById.get(item.taskId);
      if (existing) {
        continue; // 幂等：已存在的任务不重复还原
      }
      const copy: TaskItem = {
        taskId: item.taskId,
        requirementId: item.requirementId,
        title: item.title,
        description: item.description,
        dependencies: [...item.dependencies],
        status: item.status,
        allowedPaths: [...item.allowedPaths],
        expectedArtifacts: [...item.expectedArtifacts],
        testEvidenceHash: item.testEvidenceHash,
        completedAt: item.completedAt
      };
      validateTaskItem(copy);
      if (copy.dependencies.includes(copy.taskId)) {
        throw new Error(`TaskGraph: Task ${copy.taskId} cannot depend on itself`);
      }
      if (copy.status === 'completed' && !copy.testEvidenceHash) {
        throw new Error(`TaskGraph: Task ${copy.taskId} completed status requires testEvidenceHash`);
      }
      staged.push(copy);
      stagedById.set(copy.taskId, copy);
    }

    for (const task of staged) {
      for (const dep of task.dependencies) {
        if (!this.tasks.has(dep) && !stagedById.has(dep)) {
          throw new Error(`TaskGraph: Task ${task.taskId} has unknown dependency ${dep}`);
        }
        if (this.wouldCreateCycle(dep, task.taskId)) {
          throw new Error(`TaskGraph: Restoring task ${task.taskId} creates a circular dependency with ${dep}`);
        }
      }
    }

    for (const task of staged) {
      this.tasks.set(task.taskId, task);
    }
  }
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `node --experimental-strip-types --test tests/transactions/handoff-transaction.test.ts tests/contracts/inputs.test.ts tests/contracts/tasks.test.ts`
Expected: PASS (all existing tests plus the 3 new ones)

- [ ] **Step 9: Run the full suite**

Run: `npm test`
Expected: PASS, 0 failures

- [ ] **Step 10: Commit**

```bash
git add packages/controller/src/handoff/state-machine.ts packages/controller/src/inputs/ledger.ts packages/controller/src/tasks/graph.ts tests/transactions/handoff-transaction.test.ts tests/contracts/inputs.test.ts tests/contracts/tasks.test.ts
git commit -m "feat(controller): add engine-required state transitions and verbatim restoreFrom on ledger and task graph"
```

---

### Task 6: 单元执行协议 —— 提示词构造与 `UNIT_RESULT` 解析

**Files:**
- Create: `packages/controller/src/run/prompt.ts`
- Modify: `packages/controller/src/run/index.ts`
- Test: `tests/run/prompt.test.ts`

**Interfaces:**
- Consumes: `TaskItem`、`RequirementContract` from `packages/protocol/src/types.ts`
- Produces: `UNIT_RESULT_START`、`UNIT_RESULT_END`、`UnitResultStatus`、`UnitResult`、`buildRunBriefing`、`buildUnitPrompt`、`parseUnitResult`、`normalizeUnitResult`

- [ ] **Step 1: Write the failing test**

Create `tests/run/prompt.test.ts`:

```typescript
// tests/run/prompt.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  UNIT_RESULT_START,
  UNIT_RESULT_END,
  buildRunBriefing,
  buildUnitPrompt,
  parseUnitResult,
  normalizeUnitResult
} from '../../packages/controller/src/run/prompt.ts';
import { InputLedger } from '../../packages/controller/src/inputs/ledger.ts';
import { deriveContractFromLedger } from '../../packages/controller/src/inputs/supersedes.ts';
import { TaskGraph } from '../../packages/controller/src/tasks/graph.ts';

function makeContext() {
  const ledger = new InputLedger();
  ledger.appendUserMessage('Build the ingestion pipeline. Do not change the public API.');
  const contract = deriveContractFromLedger(ledger);
  const graph = new TaskGraph();
  graph.addTask({
    taskId: 'unit-2',
    requirementId: 'req-root',
    title: 'Transformer Encoder',
    description: 'Implement the encoder layer',
    allowedPaths: ['packages/model'],
    expectedArtifacts: ['packages/model/encoder.ts']
  });
  return { ledger, contract, graph, task: graph.getTask('unit-2')! };
}

test('prompt: buildRunBriefing carries goal, forbidden items and read-only handoff rules', () => {
  const { ledger, contract } = makeContext();
  const briefing = buildRunBriefing({ goal: 'Ship the pipeline', contract, runId: 'run-1' });

  assert.match(briefing, /Ship the pipeline/);
  assert.match(briefing, /Do not change the public API/);
  assert.match(briefing, /generated_handoff/);
  assert.ok(briefing.includes('run-1'));
});

test('prompt: buildUnitPrompt emits machine-readable markers for the unit and its bounds', () => {
  const { contract, task } = makeContext();
  const prompt = buildUnitPrompt({ task, contract, runId: 'run-1' });

  assert.ok(prompt.includes('TASK_ID: unit-2'), 'task id must be machine-readable');
  assert.ok(prompt.includes('RUN_ID: run-1'));
  assert.match(prompt, /Transformer Encoder/);
  assert.match(prompt, /packages\/model/);
  assert.match(prompt, /packages\/model\/encoder\.ts/);
  assert.ok(prompt.includes(UNIT_RESULT_START), 'the prompt must state the required reply format');
  assert.ok(prompt.includes(UNIT_RESULT_END));
  assert.ok(prompt.includes('"status"'));
});

test('prompt: parseUnitResult reads the last complete result block', () => {
  const first = `${UNIT_RESULT_START}\n{"taskId":"unit-1","status":"completed","evidenceHash":"ev-1"}\n${UNIT_RESULT_END}`;
  const second = `${UNIT_RESULT_START}\n{"taskId":"unit-2","status":"partial","summary":"tests failing"}\n${UNIT_RESULT_END}`;

  const parsed = parseUnitResult(`noise\n${first}\nmore noise\n${second}\ntrailing`);
  assert.ok(parsed);
  assert.strictEqual(parsed?.taskId, 'unit-2');
  assert.strictEqual(parsed?.status, 'partial');
  assert.strictEqual(parsed?.summary, 'tests failing');
});

test('prompt: parseUnitResult returns null for missing, unterminated or invalid blocks', () => {
  assert.strictEqual(parseUnitResult(''), null);
  assert.strictEqual(parseUnitResult('no blocks here'), null);
  assert.strictEqual(parseUnitResult(`${UNIT_RESULT_START}\n{"taskId":"x"`), null, 'unterminated block');
  assert.strictEqual(parseUnitResult(`${UNIT_RESULT_START}\nnot json\n${UNIT_RESULT_END}`), null);
  assert.strictEqual(
    parseUnitResult(`${UNIT_RESULT_START}\n{"status":"completed"}\n${UNIT_RESULT_END}`),
    null,
    'a result without a taskId is not usable'
  );
  assert.strictEqual(
    parseUnitResult(`${UNIT_RESULT_START}\n{"taskId":"t","status":"nonsense"}\n${UNIT_RESULT_END}`),
    null,
    'unknown status must be rejected rather than coerced'
  );
});

test('prompt: normalizeUnitResult downgrades a completion without evidence to partial', () => {
  const withoutEvidence = normalizeUnitResult({ taskId: 'unit-1', status: 'completed' });
  assert.strictEqual(withoutEvidence.status, 'partial');
  assert.match(withoutEvidence.summary ?? '', /evidence/i);

  const withEvidence = normalizeUnitResult({ taskId: 'unit-1', status: 'completed', evidenceHash: 'ev-1' });
  assert.strictEqual(withEvidence.status, 'completed');
  assert.strictEqual(withEvidence.evidenceHash, 'ev-1');

  const blankEvidence = normalizeUnitResult({ taskId: 'unit-1', status: 'completed', evidenceHash: '   ' });
  assert.strictEqual(blankEvidence.status, 'partial');

  const failed = normalizeUnitResult({ taskId: 'unit-1', status: 'failed', summary: 'build broken' });
  assert.strictEqual(failed.status, 'failed');
  assert.strictEqual(failed.summary, 'build broken');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test tests/run/prompt.test.ts`
Expected: FAIL with "Cannot find module ... src/run/prompt.ts"

- [ ] **Step 3: Write `packages/controller/src/run/prompt.ts`**

```typescript
// packages/controller/src/run/prompt.ts
import type { TaskItem, RequirementContract } from '../../../protocol/src/types.ts';

export const UNIT_RESULT_START = 'UNIT_RESULT_START';
export const UNIT_RESULT_END = 'UNIT_RESULT_END';

export type UnitResultStatus = 'completed' | 'partial' | 'failed';

export interface UnitResult {
  taskId: string;
  status: UnitResultStatus;
  evidenceHash?: string;
  summary?: string;
}

const VALID_STATUSES: UnitResultStatus[] = ['completed', 'partial', 'failed'];

/**
 * 首次会话的启动简报。明确声明本提示是 generated_handoff（系统生成），
 * 不是新的人类授权——对应 V28 的系统提示隔离。
 */
export function buildRunBriefing(params: {
  goal: string;
  contract: RequirementContract;
  runId: string;
}): string {
  const lines: string[] = [
    '<<<AGENT_RELAY_RUN_BRIEFING>>>',
    'SOURCE: generated_handoff',
    `RUN_ID: ${params.runId}`,
    `GOAL: ${params.goal}`,
    'INSTRUCTION: The text below is controller-generated context, not a new human authorization.'
  ];

  if (params.contract.forbiddenItems.length > 0) {
    lines.push('FORBIDDEN_ITEMS:');
    for (const item of params.contract.forbiddenItems) {
      lines.push(`  - ${item}`);
    }
  }

  if (params.contract.acceptanceCriteria.length > 0) {
    lines.push('ACCEPTANCE_CRITERIA:');
    for (const item of params.contract.acceptanceCriteria) {
      lines.push(`  - ${item}`);
    }
  }

  lines.push('<<<END_AGENT_RELAY_RUN_BRIEFING>>>');
  return lines.join('\n');
}

/** 单个工作单元的提示词。携带机器可读标记，便于结果解析与范围守卫复核。 */
export function buildUnitPrompt(params: {
  task: TaskItem;
  contract: RequirementContract;
  runId: string;
}): string {
  const { task, contract } = params;
  const lines: string[] = [
    '<<<AGENT_RELAY_UNIT>>>',
    'SOURCE: generated_handoff',
    `RUN_ID: ${params.runId}`,
    `TASK_ID: ${task.taskId}`,
    `TASK_TITLE: ${task.title}`,
    `REQUIREMENT_ID: ${task.requirementId}`
  ];

  if (task.description) {
    lines.push(`TASK_DESCRIPTION: ${task.description}`);
  }
  if (contract.goals.length > 0) {
    lines.push(`GOALS: ${contract.goals.join(' | ')}`);
  }
  if (contract.forbiddenItems.length > 0) {
    lines.push('FORBIDDEN_ITEMS:');
    for (const item of contract.forbiddenItems) {
      lines.push(`  - ${item}`);
    }
  }
  if (task.allowedPaths.length > 0) {
    lines.push(`ALLOWED_PATHS: ${task.allowedPaths.join(', ')}`);
  }
  if (task.expectedArtifacts.length > 0) {
    lines.push(`EXPECTED_ARTIFACTS: ${task.expectedArtifacts.join(', ')}`);
  }

  lines.push(
    'INSTRUCTION: Complete only this unit. Do not begin the next unit. Do not add unrequested scope.',
    'When the unit reaches a verifiable boundary, reply with exactly one result block in this format:',
    UNIT_RESULT_START,
    '{"taskId":"' + task.taskId + '","status":"completed|partial|failed","evidenceHash":"<hash of the passing verification>","summary":"<one line>"}',
    UNIT_RESULT_END,
    'A "completed" status without evidenceHash will be treated as partial.',
    '<<<END_AGENT_RELAY_UNIT>>>'
  );
  return lines.join('\n');
}

/** 解析输出中**最后一段**完整结果块（会话输出跨单元累积，最近的一段属于当前单元）。 */
export function parseUnitResult(output: string): UnitResult | null {
  const endIndex = output.lastIndexOf(UNIT_RESULT_END);
  if (endIndex === -1) return null;

  const startIndex = output.lastIndexOf(UNIT_RESULT_START, endIndex);
  if (startIndex === -1 || startIndex >= endIndex) return null;

  const raw = output.slice(startIndex + UNIT_RESULT_START.length, endIndex).trim();
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const candidate = parsed as Record<string, unknown>;
  const taskId = candidate.taskId;
  const status = candidate.status;
  if (typeof taskId !== 'string' || taskId.trim() === '') return null;
  if (typeof status !== 'string' || !VALID_STATUSES.includes(status as UnitResultStatus)) return null;

  const result: UnitResult = { taskId, status: status as UnitResultStatus };
  if (typeof candidate.evidenceHash === 'string') result.evidenceHash = candidate.evidenceHash;
  if (typeof candidate.summary === 'string') result.summary = candidate.summary;
  return result;
}

/**
 * 完成态必须有当前版本的通过证据（03-技术设计.md §6）：缺证据的 completed 降级为 partial，
 * 任务保持 in_progress，下一次交接包携带失败证据与下一个诊断步骤（V07）。
 */
export function normalizeUnitResult(result: UnitResult): UnitResult {
  if (result.status !== 'completed') {
    return result;
  }
  if (typeof result.evidenceHash === 'string' && result.evidenceHash.trim() !== '') {
    return result;
  }
  return {
    taskId: result.taskId,
    status: 'partial',
    summary: result.summary
      ? `${result.summary} (downgraded: completed requires an evidence hash)`
      : 'Downgraded to partial: completed requires an evidence hash'
  };
}
```

- [ ] **Step 4: Update the run barrel export**

Modify `packages/controller/src/run/index.ts`:

```typescript
export * from './db.ts';
export * from './store.ts';
export * from './notifier.ts';
export * from './events.ts';
export * from './intent.ts';
export * from './chain.ts';
export * from './prompt.ts';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --experimental-strip-types --test tests/run/prompt.test.ts`
Expected: PASS (5 tests pass)

- [ ] **Step 6: Commit**

```bash
git add packages/controller/src/run/prompt.ts packages/controller/src/run/index.ts tests/run/prompt.test.ts
git commit -m "feat(controller/run): add unit prompt protocol and UNIT_RESULT parsing"
```

---

### Task 7: 状态投影 —— `RunStatusView`、状态卡与 `state.md`

**Files:**
- Create: `packages/controller/src/run/status.ts`
- Modify: `packages/controller/src/run/index.ts`
- Test: `tests/run/status.test.ts`

**Interfaces:**
- Consumes: `RunStore`、`RunRecord`、`RunState`、`TaskSnapshotRow` from `./store.ts`；`TaskItem` from `packages/protocol/src/types.ts`
- Produces: `RunStatusView`、`buildRunStatus(store, runId)`、`renderStatusCard(view)`、`renderStatusJson(view)`、`writeStateProjection(dataDir, view)`

- [ ] **Step 1: Write the failing test**

Create `tests/run/status.test.ts`:

```typescript
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
  assert.strictEqual(view.control.nextAction, 'Execute Unit 3: Autoregressive Decoder');
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
  assert.match(card, /^控制: 无暂停 · 下一动作: Execute Unit 3/m);
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test tests/run/status.test.ts`
Expected: FAIL with "Cannot find module ... src/run/status.ts"

- [ ] **Step 3: Write `packages/controller/src/run/status.ts`**

```typescript
// packages/controller/src/run/status.ts
import fs from 'node:fs';
import path from 'node:path';
import type { TaskItem } from '../../../protocol/src/types.ts';
import type { RunStore, RunState, SessionChainLink } from './store.ts';

export interface RunStatusView {
  runId: string;
  goal: string;
  state: RunState;
  workspaceKey: string;
  session: { currentSessionId?: string; epoch: number; handoffCount: number };
  progress: {
    completed: number;
    total: number;
    currentTaskId?: string;
    currentTaskTitle?: string;
    currentTaskIndex?: number;
  };
  verification: { taskId?: string; taskIndex?: number; evidenceHash?: string; verified: boolean };
  handoff: { handoffId?: string; fromSessionId?: string; toSessionId?: string; epoch: number } | null;
  model: { provider: string; model: string; effort?: string } | null;
  context: { compaction: 'unknown' | number };
  usage: 'unknown';
  control: {
    paused: boolean;
    pauseReason?: string;
    blockedReason?: string;
    nextAction: string;
  };
}

function parseTasks(store: RunStore, runId: string): TaskItem[] {
  const snapshot = store.getLatestTaskSnapshot(runId);
  if (!snapshot) return [];
  try {
    const parsed = JSON.parse(snapshot.snapshotJson);
    return Array.isArray(parsed) ? (parsed as TaskItem[]) : [];
  } catch {
    return [];
  }
}

function pickCurrentTask(tasks: TaskItem[]): { task?: TaskItem; index?: number } {
  const inProgressIndex = tasks.findIndex((t) => t.status === 'in_progress');
  if (inProgressIndex !== -1) {
    return { task: tasks[inProgressIndex], index: inProgressIndex + 1 };
  }
  const pendingIndex = tasks.findIndex((t) => t.status === 'pending');
  if (pendingIndex !== -1) {
    return { task: tasks[pendingIndex], index: pendingIndex + 1 };
  }
  return {};
}

function describeNextAction(state: RunState, task?: TaskItem, taskIndex?: number): string {
  if (state === 'COMPLETED') return 'None (run completed)';
  if (state === 'CANCELLED') return 'None (run cancelled)';
  if (state === 'DISABLED') return 'None (auto-handoff disabled)';
  if (state === 'PAUSED') return 'Awaiting resume';
  if (state === 'BLOCKED') return 'Awaiting diagnosis';
  if (state === 'RECOVERY_REQUIRED') return 'Awaiting recovery';
  if (!task) return 'None (no executable unit)';
  return `Execute Unit ${taskIndex}: ${task.title}`;
}

export function buildRunStatus(store: RunStore, runId: string): RunStatusView {
  const run = store.getRun(runId);
  if (!run) {
    throw new Error(`buildRunStatus: unknown run ${runId}`);
  }

  const tasks = parseTasks(store, runId);
  const completed = tasks.filter((t) => t.status === 'completed').length;
  const { task: currentTask, index: currentIndex } = pickCurrentTask(tasks);

  let lastCompletedIndex: number | undefined;
  for (let i = tasks.length - 1; i >= 0; i--) {
    if (tasks[i].status === 'completed') {
      lastCompletedIndex = i + 1;
      break;
    }
  }
  const lastCompleted = lastCompletedIndex !== undefined ? tasks[lastCompletedIndex - 1] : undefined;
  const verification = {
    taskId: lastCompleted?.taskId,
    taskIndex: lastCompletedIndex,
    evidenceHash: lastCompleted?.testEvidenceHash,
    verified: Boolean(lastCompleted?.testEvidenceHash)
  };

  const chain: SessionChainLink[] = store.listChain(runId);
  const latestLink = chain.length > 0 ? chain[chain.length - 1] : undefined;

  const handoff =
    latestLink && latestLink.handoffId
      ? {
          handoffId: latestLink.handoffId,
          fromSessionId: latestLink.prevSessionId,
          toSessionId: latestLink.nextSessionId,
          epoch: latestLink.epoch
        }
      : null;

  const model = latestLink
    ? { provider: latestLink.provider, model: latestLink.model, effort: latestLink.effort }
    : null;

  return {
    runId: run.runId,
    goal: run.goal,
    state: run.state,
    workspaceKey: run.workspaceKey,
    session: {
      currentSessionId: run.currentSessionId,
      epoch: run.currentEpoch,
      handoffCount: run.handoffCount
    },
    progress: {
      completed,
      total: tasks.length > 0 ? tasks.length : run.unitCount,
      currentTaskId: currentTask?.taskId,
      currentTaskTitle: currentTask?.title,
      currentTaskIndex: currentIndex
    },
    verification,
    handoff,
    model,
    // 压缩事件与计费用量尚未接入（P2-04 范围外），必须显示未知而不是 0（V09）
    context: { compaction: 'unknown' },
    usage: 'unknown',
    control: {
      paused: run.state === 'PAUSED',
      pauseReason: run.pauseReason,
      blockedReason: run.blockedReason,
      nextAction: describeNextAction(run.state, currentTask, currentIndex)
    }
  };
}

export function renderStatusCard(view: RunStatusView): string {
  const lines: string[] = [];

  lines.push(`目标: ${view.goal}`);
  lines.push(
    `进度: ${view.progress.completed}/${view.progress.total} 单元完成` +
      (view.progress.currentTaskId
        ? `（当前: Unit ${view.progress.currentTaskIndex} — ${view.progress.currentTaskTitle}）`
        : '')
  );

  if (view.verification.verified) {
    lines.push(`验证: Unit ${view.verification.taskIndex ?? '?'} 已通过 · 证据 ${view.verification.evidenceHash}`);
  } else {
    lines.push('验证: 暂无通过证据');
  }

  if (view.handoff) {
    lines.push(
      `交接: ${view.handoff.handoffId ?? 'n/a'} · ${view.handoff.fromSessionId ?? 'n/a'} → ` +
        `${view.handoff.toSessionId ?? 'n/a'} · epoch ${view.handoff.epoch}`
    );
  } else {
    lines.push('交接: 无');
  }

  if (view.model) {
    const effort = view.model.effort ? ` (effort: ${view.model.effort})` : '';
    lines.push(`模型: ${view.model.provider} / ${view.model.model}${effort}`);
  } else {
    lines.push('模型: 未知');
  }

  lines.push(`压缩: ${view.context.compaction === 'unknown' ? '未知' : `${view.context.compaction} 次`}`);
  lines.push(`用量: ${view.usage === 'unknown' ? '未知' : view.usage}`);

  const controlParts: string[] = [];
  if (view.control.paused) {
    controlParts.push(`已暂停${view.control.pauseReason ? ` · 原因: ${view.control.pauseReason}` : ''}`);
  } else if (view.control.blockedReason) {
    controlParts.push(`已阻塞 · 原因: ${view.control.blockedReason}`);
  } else {
    controlParts.push('无暂停');
  }
  controlParts.push(`下一动作: ${view.control.nextAction}`);
  lines.push(`控制: ${controlParts.join(' · ')}`);

  return lines.join('\n') + '\n';
}

export function renderStatusJson(view: RunStatusView): string {
  return JSON.stringify(view, null, 2);
}

/** 把状态卡写入 <dataDir>/<runId>/state.md，返回写入路径。投影随时可从权威库重建。 */
export function writeStateProjection(dataDir: string, view: RunStatusView): string {
  const dir = path.join(dataDir, view.runId);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, 'state.md');
  const staging = `${target}.tmp`;
  fs.writeFileSync(staging, renderStatusCard(view), 'utf8');
  fs.renameSync(staging, target);
  return target;
}
```

- [ ] **Step 4: Update the run barrel export**

Modify `packages/controller/src/run/index.ts`:

```typescript
export * from './db.ts';
export * from './store.ts';
export * from './notifier.ts';
export * from './events.ts';
export * from './intent.ts';
export * from './chain.ts';
export * from './prompt.ts';
export * from './status.ts';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --experimental-strip-types --test tests/run/status.test.ts`
Expected: PASS (7 tests pass)

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS, 0 failures

- [ ] **Step 7: Commit**

```bash
git add packages/controller/src/run/status.ts packages/controller/src/run/index.ts tests/run/status.test.ts
git commit -m "feat(controller/run): add run status projection, status card and state.md rebuild"
```

---

### Task 8: `RunController` 编排核心

**Files:**
- Create: `tests/helpers/scripted-adapter.ts`
- Create: `packages/controller/src/run/engine.ts`
- Modify: `packages/controller/src/run/index.ts`
- Test: `tests/run/engine.test.ts`

**Interfaces:**
- Consumes: 全部 run 层模块 + `InputLedger`、`TaskGraph`、`TriggerPolicy`、`LoopDetector`、`WorkspaceSentinel`、`HandoffPackager`、`HandoffStateMachine`、`DurableLeaseManager`、`normalizeWorkspaceKey`、`AgentRelayAdapter`、`HandshakeCoordinator`
- Produces: `RunController`、`RunControllerOptions`、`CoordinatorDeps`、`StartRunConfig`、`RunTickOutcome`

**实现者必读的三条设计约束：**

1. **写路径规则**：任何状态变更一律先落库、再更新内存对象。内存对象（`InputLedger` / `TaskGraph` / `HandoffStateMachine`）在 `loadRun()` 中从库重建。`startRun()` 绝不先在内存对象上写、再落库。
2. **租约 CAS 与状态更新同事务**：交接第 7 步必须在 `store.transaction()` 内**先读未消费意图**，非空则不执行 CAS（新会话保持只读、旧 owner 仍持租约）；为空才调用 `coordinator.verifyAckAndAuthorize()`（同一事务）。事务提交后、`authorizeExecution` 之前再核对一次（防御性，覆盖交接途中到达的意图）。
3. **每个 tick 只做一件事**：执行一个单元，或完成一次交接，或处理一个终态。`executeUntilSettled()` 反复调用 `tick()`。当前模型下每个会话只执行一个单元，因此「四单元」产生「四会话、三交接」，正好满足验收要求。

- [ ] **Step 1: Write the scripted adapter helper**

Create `tests/helpers/scripted-adapter.ts` (not a test file — the glob only picks up `tests/**/*.test.ts`):

```typescript
// tests/helpers/scripted-adapter.ts
import type {
  AgentRelayAdapter,
  SessionCapabilities,
  SessionInspectResult,
  SpawnSessionConfig
} from '../../packages/protocol/src/adapter.ts';
import type { HandoffAckPacket, HandoffPackManifest } from '../../packages/protocol/src/types.ts';
import {
  UNIT_RESULT_START,
  UNIT_RESULT_END,
  type UnitResultStatus
} from '../../packages/controller/src/run/prompt.ts';

export interface ScriptedUnitReply {
  status: UnitResultStatus;
  evidenceHash?: string;
  summary?: string;
}

export interface ScriptedAdapterOptions {
  /** 覆盖某个会话上报的有效模型（测 V10 模型不一致） */
  modelOverrides?: Record<string, { provider: string; model: string; effort?: string }>;
  /** 覆盖某个 taskId 的单元执行结果；缺省为 completed + 自动证据哈希 */
  unitReplies?: Record<string, ScriptedUnitReply>;
  /** 在 createFresh 之后调用，用于在交接窗口中途注入控制意图（V33） */
  onCreateFresh?: (sessionId: string, config: SpawnSessionConfig) => void;
  /** 在 authorizeExecution 之后调用，用于在令牌送达后注入控制意图（V33 令牌消费之后） */
  onAuthorize?: (sessionId: string) => void;
}

interface ScriptedSession {
  sessionId: string;
  model: { provider: string; model: string; effort?: string };
  active: boolean;
  readOnly: boolean;
  cwd: string;
  output: string[];
  executionAuthorized: boolean;
  epoch?: number;
  executionToken?: string;
  draining: boolean;
}

interface ManifestFields {
  handoffId: string;
  inputHeadHash: string;
  taskHash: string;
  treeHash: string;
  runId: string;
}

function markerValue(prompt: string, key: string): string | null {
  const match = new RegExp(`^${key}:\\s*(\\S+)\\s*$`, 'm').exec(prompt);
  return match ? match[1] : null;
}

/** 同时支持 DSH 的 `KEY: value` 方言与 Codex/Claude 的 manifest JSON 方言。 */
function extractManifestFields(prompt: string): ManifestFields | null {
  const handoffId = markerValue(prompt, 'HANDOFF_ID');
  const inputHeadHash = markerValue(prompt, 'INPUT_HEAD_HASH');
  const taskHash = markerValue(prompt, 'TASK_SNAPSHOT_HASH');
  const treeHash = markerValue(prompt, 'WORKSPACE_TREE_HASH');
  const runId = markerValue(prompt, 'RUN_ID');
  if (handoffId && inputHeadHash && taskHash && treeHash && runId) {
    return { handoffId, inputHeadHash, taskHash, treeHash, runId };
  }

  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(prompt);
  if (fenced) {
    try {
      const manifest = JSON.parse(fenced[1].trim()) as HandoffPackManifest;
      if (manifest.handoffId && manifest.inputLedgerHeadHash && manifest.workspaceFingerprint) {
        return {
          handoffId: manifest.handoffId,
          inputHeadHash: manifest.inputLedgerHeadHash,
          taskHash: manifest.taskSnapshotHash,
          treeHash: manifest.workspaceFingerprint.treeHash,
          runId: manifest.runId
        };
      }
    } catch {
      // 方言不匹配，交给调用方判定为无法应答
    }
  }
  return null;
}

function isPreparationPrompt(prompt: string): boolean {
  return /READ-?ONLY/i.test(prompt) && /HANDOFF/i.test(prompt);
}

export class ScriptedAdapter implements AgentRelayAdapter {
  public readonly sessions = new Map<string, ScriptedSession>();
  public readonly submitted: Array<{ sessionId: string; content: string; epoch?: number }> = [];
  public readonly authorizations: Array<{ sessionId: string; epoch: number; token: string }> = [];
  public readonly interrupted: string[] = [];
  public readonly created: string[] = [];
  private readonly options: ScriptedAdapterOptions;

  constructor(options: ScriptedAdapterOptions = {}) {
    this.options = options;
  }

  public capabilities(): SessionCapabilities {
    return {
      level: 'L3',
      streamJsonSupported: true,
      modelEffortPreservation: true,
      nativeRevealSupported: false,
      headlessSupported: true,
      cancellationSupported: true
    };
  }

  public createFresh(config: SpawnSessionConfig): SessionInspectResult {
    const sessionId = config.sessionId!;
    const override = this.options.modelOverrides?.[sessionId];
    const model = override ?? config.model ?? { provider: 'scripted', model: 'scripted-model' };

    const session: ScriptedSession = {
      sessionId,
      model,
      active: true,
      readOnly: config.readOnly === true,
      cwd: config.cwd ?? process.cwd(),
      output: [],
      executionAuthorized: config.readOnly !== true,
      draining: false
    };
    this.sessions.set(sessionId, session);
    this.created.push(sessionId);

    if (config.initialPrompt) {
      this.respond(session, config.initialPrompt);
    }

    this.options.onCreateFresh?.(sessionId, config);

    return {
      sessionId,
      active: true,
      effectiveModel: model,
      cwd: session.cwd,
      exitCode: null
    };
  }

  public inspectSession(sessionId: string): SessionInspectResult | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    return {
      sessionId: session.sessionId,
      active: session.active,
      effectiveModel: session.model,
      cwd: session.cwd,
      exitCode: session.active ? null : 0
    };
  }

  public submit(sessionId: string, _messageId: string, content: string, epoch?: number): void {
    const session = this.sessions.get(sessionId);
    if (!session || !session.active) {
      throw new Error(`Cannot submit to inactive or nonexistent session ${sessionId}`);
    }
    this.submitted.push({ sessionId, content, epoch });
    this.respond(session, content);
  }

  public requestDrain(sessionId: string, _handoffId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.draining = true;
    return true;
  }

  public awaitQuiescence(sessionId: string, _timeoutMs?: number): Promise<'quiescent' | 'timeout' | 'error'> {
    const session = this.sessions.get(sessionId);
    if (!session) return Promise.resolve('error');
    return Promise.resolve('quiescent');
  }

  public authorizeExecution(sessionId: string, epoch: number, executionToken: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.executionAuthorized = true;
    session.readOnly = false;
    session.epoch = epoch;
    session.executionToken = executionToken;
    this.authorizations.push({ sessionId, epoch, token: executionToken });
    this.options.onAuthorize?.(sessionId);
    return true;
  }

  public interruptOwned(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.active = false;
    this.interrupted.push(sessionId);
    return true;
  }

  public getSessionOutput(sessionId: string): string {
    const session = this.sessions.get(sessionId);
    return session ? session.output.join('\n') : '';
  }

  /** 会话是否曾获得执行权（用于断言「未授权不得写入」）。 */
  public wasAuthorized(sessionId: string): boolean {
    return this.authorizations.some((a) => a.sessionId === sessionId);
  }

  private respond(session: ScriptedSession, prompt: string): void {
    if (isPreparationPrompt(prompt)) {
      const fields = extractManifestFields(prompt);
      if (fields) {
        const ack: HandoffAckPacket = {
          handoffId: fields.handoffId,
          runId: fields.runId,
          newSessionId: session.sessionId,
          effectiveModel: { ...session.model },
          verifiedInputHeadHash: fields.inputHeadHash,
          verifiedTaskSnapshotHash: fields.taskHash,
          verifiedWorkspaceHash: fields.treeHash,
          ackTimestamp: Date.now()
        };
        session.output.push(`Verification complete.\nHANDOFF_ACK_START\n${JSON.stringify(ack)}\nHANDOFF_ACK_END`);
      } else {
        session.output.push('Preparation material could not be parsed; no ACK emitted.');
      }
      return;
    }

    const taskId = markerValue(prompt, 'TASK_ID');
    if (taskId) {
      const reply = this.options.unitReplies?.[taskId] ?? {
        status: 'completed' as UnitResultStatus,
        evidenceHash: `evidence-${taskId}`,
        summary: `unit ${taskId} finished`
      };
      const result = {
        taskId,
        status: reply.status,
        evidenceHash: reply.evidenceHash,
        summary: reply.summary
      };
      session.output.push(`${UNIT_RESULT_START}\n${JSON.stringify(result)}\n${UNIT_RESULT_END}`);
      return;
    }

    session.output.push('Acknowledged.');
  }
}
```

- [ ] **Step 2: Write the failing engine test**

Create `tests/run/engine.test.ts`:

```typescript
// tests/run/engine.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RelayDatabase } from '../../packages/controller/src/run/db.ts';
import { RunStore } from '../../packages/controller/src/run/store.ts';
import { RunController, type StartRunConfig } from '../../packages/controller/src/run/engine.ts';
import { RecordingNotifier } from '../../packages/controller/src/run/notifier.ts';
import { ControlIntentLog } from '../../packages/controller/src/run/intent.ts';
import { normalizeWorkspaceKey } from '../../packages/controller/src/workspace/key.ts';
import { WorkspaceLeaseManager } from '../../packages/controller/src/handoff/lease.ts';
import { HandoffStateMachine } from '../../packages/controller/src/handoff/state-machine.ts';
import { TwoPhaseHandshakeCoordinator } from '../../packages/adapters/claude/src/handshake.ts';
import { ScriptedAdapter } from '../helpers/scripted-adapter.ts';

const TASKS = [
  { taskId: 'u1', requirementId: 'req-root', title: 'Data Ingestion', dependencies: [] as string[] },
  { taskId: 'u2', requirementId: 'req-root', title: 'Transformer Encoder', dependencies: ['u1'] },
  { taskId: 'u3', requirementId: 'req-root', title: 'Autoregressive Decoder', dependencies: ['u2'] },
  { taskId: 'u4', requirementId: 'req-root', title: 'Loss and Optimizer', dependencies: ['u3'] }
];

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function setup(options: {
  adapter?: ScriptedAdapter;
  dataDir?: string;
  dbPath?: string;
  notifier?: RecordingNotifier;
} = {}) {
  const dataDir = options.dataDir ?? makeTempDir('agent-relay-engine-');
  const dbPath = options.dbPath ?? path.join(dataDir, 'relay.db');
  const db = new RelayDatabase({ dbPath });
  const store = new RunStore(db);
  const adapter = options.adapter ?? new ScriptedAdapter();
  const notifier = options.notifier ?? new RecordingNotifier();

  const controller = new RunController({
    store,
    dataDir,
    adapter,
    adapterName: 'claude',
    notifier,
    createCoordinator: (deps) =>
      new TwoPhaseHandshakeCoordinator(
        deps.stateMachine as HandoffStateMachine,
        deps.leaseManager as unknown as WorkspaceLeaseManager,
        deps.workspaceKey
      )
  });

  const config: StartRunConfig = {
    runId: 'run-engine-1',
    goal: 'Ship the ingestion pipeline',
    workspacePath: dataDir,
    tasks: TASKS,
    model: { provider: 'anthropic', model: 'claude-3-7-sonnet', effort: 'high' },
    initialUserMessage: 'Build the ingestion pipeline. Do not change the public API.'
  };

  return { db, store, adapter, notifier, controller, config, dataDir, dbPath };
}

test('engine: startRun persists the run, the immutable human input and the initial snapshot', () => {
  const { db, store, controller, config, dataDir } = setup();
  const run = controller.startRun(config);

  assert.strictEqual(run.runId, 'run-engine-1');
  assert.strictEqual(run.state, 'INITIALIZING');
  assert.strictEqual(run.unitCount, 4);
  assert.strictEqual(run.workspaceKey, normalizeWorkspaceKey(dataDir));
  assert.deepStrictEqual(run.model, { provider: 'anthropic', model: 'claude-3-7-sonnet', effort: 'high' });

  const inputs = store.listInputs('run-engine-1');
  assert.strictEqual(inputs.length, 1);
  assert.strictEqual(inputs[0].record.source, 'human');
  assert.strictEqual(inputs[0].record.rawContent, config.initialUserMessage);
  assert.ok(inputs[0].record.sha256Hash);

  const snapshot = store.getLatestTaskSnapshot('run-engine-1');
  assert.ok(snapshot);
  assert.strictEqual((JSON.parse(snapshot!.snapshotJson) as unknown[]).length, 4);
  db.close();
});

test('engine: startRun returns the existing run when the workspace is already active (V34)', () => {
  const { db, controller, config, dataDir } = setup();
  const first = controller.startRun(config);

  const second = controller.startRun({ ...config, runId: 'run-engine-2', goal: 'Different goal' });
  assert.strictEqual(second.runId, first.runId, 'a duplicate activation must not open a second run');
  assert.strictEqual(second.goal, 'Ship the ingestion pipeline');

  const runCount = db.prepare('SELECT COUNT(*) AS c FROM runs').get() as { c: number };
  assert.strictEqual(runCount.c, 1, 'a duplicate activation must not insert a second run row');
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('engine: executeUntilSettled drives four units through three handoffs with silent rotation', async () => {
  const { db, store, adapter, notifier, controller, config, dataDir } = setup();
  controller.startRun(config);

  const outcomes = await controller.executeUntilSettled();
  assert.deepStrictEqual(
    outcomes.map((o) => o.kind),
    [
      'unit_executed',
      'handoff_performed',
      'unit_executed',
      'handoff_performed',
      'unit_executed',
      'handoff_performed',
      'unit_executed',
      'completed'
    ]
  );
  assert.deepStrictEqual(
    outcomes.filter((o) => o.kind === 'unit_executed').map((o) => (o as { taskId: string }).taskId),
    ['u1', 'u2', 'u3', 'u4']
  );

  // Four sessions, three handoffs
  const chain = store.listChain('run-engine-1');
  assert.strictEqual(chain.length, 4);
  assert.deepStrictEqual(chain.map((l) => l.sequence), [1, 2, 3, 4]);
  assert.deepStrictEqual(chain.map((l) => l.epoch), [1, 2, 3, 4]);
  assert.strictEqual(chain[0].prevSessionId, undefined);
  assert.strictEqual(chain[0].reason, 'run_started');
  assert.deepStrictEqual(
    chain.slice(1).map((l) => l.handoffId),
    ['h-run-engine-1-1', 'h-run-engine-1-2', 'h-run-engine-1-3']
  );
  assert.deepStrictEqual(
    chain.slice(1).map((l) => l.prevSessionId),
    [chain[0].nextSessionId, chain[1].nextSessionId, chain[2].nextSessionId]
  );

  // Every session preserved, all but the last superseded
  assert.strictEqual(chain.filter((l) => l.supersededAt !== undefined).length, 3);
  assert.strictEqual(chain[3].supersededAt, undefined);

  // Each session ran exactly one unit and only after authorization
  for (const link of chain) {
    assert.strictEqual(adapter.wasAuthorized(link.nextSessionId), true);
  }
  assert.strictEqual(adapter.interrupted.length, 3, 'each superseded worker is reaped');

  // Single writer: ownership advanced monotonically through the chain, then the
  // finished run releases the workspace lease so the workspace can be reused.
  const run = store.getRun('run-engine-1');
  assert.strictEqual(run?.state, 'COMPLETED');
  assert.strictEqual(run?.handoffCount, 3);
  assert.strictEqual(run?.currentSessionId, chain[3].nextSessionId);
  assert.strictEqual(run?.currentEpoch, 4);
  assert.strictEqual(store.getLeaseRow(run!.workspaceKey), undefined, 'a finished run releases its lease');
  assert.deepStrictEqual(
    [1, 2, 3].map((n) => store.getHandoff(`h-run-engine-1-${n}`)?.state),
    ['COMPLETED', 'COMPLETED', 'COMPLETED']
  );
  assert.deepStrictEqual(
    [1, 2, 3].map((n) => store.getHandoff(`h-run-engine-1-${n}`)?.targetSessionId),
    chain.slice(1).map((l) => l.nextSessionId)
  );

  // The last handoff snapshot is on disk and referenced by the database (V16)
  const manifestPath = store.getHandoff('h-run-engine-1-3')!.manifestPath!;
  assert.strictEqual(fs.existsSync(manifestPath), true);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { handoffId: string; runId: string };
  assert.strictEqual(manifest.handoffId, 'h-run-engine-1-3');
  assert.strictEqual(manifest.runId, 'run-engine-1');

  // All four units completed with evidence
  const tasks = JSON.parse(store.getLatestTaskSnapshot('run-engine-1')!.snapshotJson) as Array<{
    taskId: string;
    status: string;
    testEvidenceHash?: string;
  }>;
  assert.deepStrictEqual(tasks.map((t) => t.status), ['completed', 'completed', 'completed', 'completed']);
  assert.deepStrictEqual(tasks.map((t) => t.testEvidenceHash), ['evidence-u1', 'evidence-u2', 'evidence-u3', 'evidence-u4']);

  // Three consecutive handoffs must not ask the user for anything
  assert.deepStrictEqual(
    notifier.notifications.map((n) => n.type),
    ['run_completed'],
    'handoff rotation must stay silent; only completion notifies'
  );
  assert.strictEqual(notifier.ofType('run_completed').length, 1);
  assert.strictEqual(notifier.notifications.every((n) => n.severity === 'notify'), true);

  // state.md exists and reflects the finished run
  const statePath = path.join(dataDir, 'run-engine-1', 'state.md');
  assert.strictEqual(fs.existsSync(statePath), true);
  assert.match(fs.readFileSync(statePath, 'utf8'), /^进度: 4\/4 单元完成/m);

  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('engine: generated prompts never enter the human input ledger (V28)', async () => {
  const { db, store, controller, config, dataDir } = setup();
  controller.startRun(config);
  await controller.executeUntilSettled();

  const inputs = store.listInputs('run-engine-1');
  assert.strictEqual(inputs.length, 1, 'only the original human message may be recorded');
  assert.strictEqual(inputs.every((i) => i.record.source === 'human'), true);
  assert.strictEqual(inputs[0].record.rawContent, config.initialUserMessage);
  assert.doesNotMatch(inputs[0].record.rawContent, /UNIT_RESULT_START|AGENT_RELAY_UNIT/);

  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('engine: pause_next_node stops at the node boundary without creating the next worker (V20)', async () => {
  const { db, store, adapter, controller, config, dataDir } = setup();
  controller.startRun(config);

  // Complete unit 1, then pause before the handoff tick
  const first = await controller.tick();
  assert.strictEqual(first.kind, 'unit_executed');

  new ControlIntentLog(store).append('run-engine-1', 'pause_next_node');

  const second = await controller.tick();
  assert.strictEqual(second.kind, 'paused');
  assert.strictEqual((second as { reason?: string }).reason, 'user_pause_next_node');

  const run = store.getRun('run-engine-1');
  assert.strictEqual(run?.state, 'PAUSED');
  assert.strictEqual(run?.handoffCount, 0, 'no handoff may be started while pausing');
  assert.strictEqual(store.listChain('run-engine-1').length, 1, 'no successor session may be created');
  assert.strictEqual(adapter.created.length, 1);
  assert.strictEqual(adapter.authorizations.length, 1);

  // A paused run stays put no matter how often it is ticked
  const third = await controller.tick();
  assert.strictEqual(third.kind, 'paused');
  assert.strictEqual(adapter.created.length, 1);

  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('engine: resume continues in the existing session and still finishes the run (V22)', async () => {
  const { db, store, controller, config, dataDir } = setup();
  controller.startRun(config);
  const intents = new ControlIntentLog(store);

  await controller.tick();
  intents.append('run-engine-1', 'pause_next_node');
  assert.strictEqual((await controller.tick()).kind, 'paused');

  intents.append('run-engine-1', 'resume');
  const resumed = await controller.tick();
  assert.strictEqual(resumed.kind, 'handoff_performed', 'resume returns to the node boundary and continues');

  const outcomes = await controller.executeUntilSettled();
  assert.strictEqual(outcomes[outcomes.length - 1].kind, 'completed');
  assert.strictEqual(store.getRun('run-engine-1')?.state, 'COMPLETED');

  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('engine: stop_now cancels the run and a restarted controller never resumes it (V21)', async () => {
  const { db, store, adapter, controller, config, dataDir, dbPath } = setup();
  controller.startRun(config);
  await controller.tick();

  const intents = new ControlIntentLog(store);
  const stop = intents.append('run-engine-1', 'stop_now');

  const stopped = await controller.tick();
  assert.strictEqual(stopped.kind, 'stopped');
  assert.strictEqual((stopped as { intentId?: string }).intentId, stop.intentId);
  assert.strictEqual(store.getRun('run-engine-1')?.state, 'CANCELLED');

  const createdBeforeRestart = adapter.created.length;
  const submittedBeforeRestart = adapter.submitted.length;
  db.close();

  // A brand new controller process reads the same database
  const restartedDb = new RelayDatabase({ dbPath });
  const restartedStore = new RunStore(restartedDb);
  const restartedAdapter = new ScriptedAdapter();
  const restartedController = new RunController({
    store: restartedStore,
    dataDir,
    adapter: restartedAdapter,
    adapterName: 'claude',
    createCoordinator: (deps) =>
      new TwoPhaseHandshakeCoordinator(
        deps.stateMachine as HandoffStateMachine,
        deps.leaseManager as unknown as WorkspaceLeaseManager,
        deps.workspaceKey
      )
  });
  const rehydrated = restartedController.rehydrate('run-engine-1');
  assert.strictEqual(rehydrated?.state, 'CANCELLED');

  const outcome = await restartedController.tick();
  assert.strictEqual(outcome.kind, 'stopped');
  assert.strictEqual(restartedAdapter.created.length, 0, 'a cancelled run must never spawn a new worker after restart');
  assert.strictEqual(restartedAdapter.submitted.length, 0);

  // And the original counts are untouched
  assert.strictEqual(adapter.created.length, createdBeforeRestart);
  assert.strictEqual(adapter.submitted.length, submittedBeforeRestart);

  restartedDb.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('engine: a control intent arriving during the handoff window blocks the CAS and keeps one owner (V33)', async () => {
  let intents: ControlIntentLog | null = null;
  const adapter = new ScriptedAdapter({
    onCreateFresh: (sessionId) => {
      if (sessionId.endsWith('-s2')) {
        intents!.append('run-engine-1', 'pause_next_node');
      }
    }
  });
  const { db, store, controller, config, dataDir } = setup({ adapter });
  controller.startRun(config);

  intents = new ControlIntentLog(store);

  await controller.tick(); // unit 1 in session s1
  const handoffTick = await controller.tick();

  assert.strictEqual(handoffTick.kind, 'paused');
  const run = store.getRun('run-engine-1');
  assert.strictEqual(run?.state, 'PAUSED');
  assert.strictEqual(run?.currentSessionId?.endsWith('-s1'), true, 'ownership must not transfer');
  assert.strictEqual(store.getLeaseRow(run!.workspaceKey)?.currentOwner, run!.currentSessionId);
  assert.strictEqual(store.getLeaseRow(run!.workspaceKey)?.epoch, 1, 'the lease epoch must not advance');
  assert.strictEqual(adapter.wasAuthorized(`${run!.runId}-s2`), false, 'the new session must stay read-only');
  assert.ok(adapter.interrupted.includes(`${run!.runId}-s2`), 'the unprepared session is reaped');

  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('engine: a control intent delivered with the execution token invalidates it before any write (V33)', async () => {
  let intents: ControlIntentLog | null = null;
  const adapter = new ScriptedAdapter({
    onAuthorize: (sessionId) => {
      if (sessionId.endsWith('-s2')) {
        intents!.append('run-engine-1', 'stop_now');
      }
    }
  });
  const { db, store, controller, config, dataDir } = setup({ adapter });
  controller.startRun(config);

  intents = new ControlIntentLog(store);

  await controller.tick(); // unit 1 in session s1
  const outcomes = await controller.executeUntilSettled();

  assert.strictEqual(outcomes[0].kind, 'handoff_performed');
  assert.strictEqual(outcomes[1].kind, 'stopped', 'the stale token must not be spent on a new unit');
  assert.strictEqual(store.getRun('run-engine-1')?.state, 'CANCELLED');

  // s2 was authorized, but never submitted a unit prompt
  const s2Submits = adapter.submitted.filter((s) => s.sessionId.endsWith('-s2'));
  assert.strictEqual(s2Submits.length, 0, 'no write may be dispatched under a superseded intent watermark');

  // Only unit 1 completed
  const tasks = JSON.parse(store.getLatestTaskSnapshot('run-engine-1')!.snapshotJson) as Array<{ status: string }>;
  assert.deepStrictEqual(tasks.map((t) => t.status), ['completed', 'pending', 'pending', 'pending']);

  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('engine: an ACK reporting a different model fails the handoff without a second writer (V10)', async () => {
  const adapter = new ScriptedAdapter({
    modelOverrides: {
      'run-engine-1-s2': { provider: 'anthropic', model: 'claude-3-5-haiku', effort: 'low' }
    }
  });
  const { db, store, controller, config, dataDir } = setup({ adapter });
  controller.startRun(config);
  await controller.tick();

  const outcome = await controller.tick();
  assert.strictEqual(outcome.kind, 'recovery_required');
  assert.match((outcome as { reason: string }).reason, /Model mismatch/i);

  const run = store.getRun('run-engine-1');
  assert.strictEqual(run?.state, 'RECOVERY_REQUIRED');
  assert.strictEqual(run?.currentSessionId?.endsWith('-s1'), true);
  assert.strictEqual(store.getLeaseRow(run!.workspaceKey)?.epoch, 1, 'a failed handshake must not advance the lease');
  assert.strictEqual(adapter.wasAuthorized('run-engine-1-s2'), false);

  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('engine: three identical failures block the run across sessions (V23)', async () => {
  const adapter = new ScriptedAdapter({
    unitReplies: { u1: { status: 'failed', summary: 'build broken' } }
  });
  const { db, store, notifier, controller, config, dataDir } = setup({ adapter });
  controller.startRun(config);

  const outcomes = await controller.executeUntilSettled();
  assert.strictEqual(outcomes[outcomes.length - 1].kind, 'blocked');

  const run = store.getRun('run-engine-1');
  assert.strictEqual(run?.state, 'BLOCKED');
  assert.match(run?.blockedReason ?? '', /loop_detected_u1/);
  assert.strictEqual(store.listChain('run-engine-1').length, 3, 'failures span two handoffs, then stop');

  const failedOutcomes = outcomes.filter(
    (o) => o.kind === 'unit_executed' && (o as { status: string }).status === 'failed'
  );
  assert.strictEqual(failedOutcomes.length, 3);
  assert.strictEqual(notifier.ofType('run_blocked').length, 1);

  // The unit stays in progress rather than being falsely completed (V07)
  const tasks = JSON.parse(store.getLatestTaskSnapshot('run-engine-1')!.snapshotJson) as Array<{
    taskId: string;
    status: string;
    testEvidenceHash?: string;
  }>;
  assert.strictEqual(tasks[0].status, 'in_progress');
  assert.strictEqual(tasks[0].testEvidenceHash, undefined);

  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('engine: a completion without an evidence hash is downgraded to partial (V07)', async () => {
  const adapter = new ScriptedAdapter({
    unitReplies: { u1: { status: 'completed', summary: 'looks good to me' } }
  });
  const { db, store, controller, config, dataDir } = setup({ adapter });
  controller.startRun(config);

  const outcome = await controller.tick();
  assert.strictEqual(outcome.kind, 'unit_executed');
  assert.strictEqual((outcome as { status: string }).status, 'partial');

  const tasks = JSON.parse(store.getLatestTaskSnapshot('run-engine-1')!.snapshotJson) as Array<{
    taskId: string;
    status: string;
  }>;
  assert.strictEqual(tasks[0].status, 'in_progress');
  assert.strictEqual(store.getRun('run-engine-1')?.state, 'RUNNING');

  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('engine: rehydrate rebuilds ledger and task graph hashes verbatim (V22)', async () => {
  const dataDir = makeTempDir('agent-relay-rehydrate-');
  const dbPath = path.join(dataDir, 'relay.db');
  const first = setup({ dataDir, dbPath });
  first.controller.startRun(first.config);
  await first.controller.tick();

  const hashes = first.controller.getInvariantHashes();
  assert.ok(hashes.inputLedgerHeadHash.length > 0);
  assert.ok(hashes.taskSnapshotHash.length > 0);
  first.db.close();

  const secondDb = new RelayDatabase({ dbPath });
  const secondStore = new RunStore(secondDb);
  const secondController = new RunController({
    store: secondStore,
    dataDir,
    adapter: new ScriptedAdapter(),
    adapterName: 'claude',
    createCoordinator: (deps) =>
      new TwoPhaseHandshakeCoordinator(
        deps.stateMachine as HandoffStateMachine,
        deps.leaseManager as unknown as WorkspaceLeaseManager,
        deps.workspaceKey
      )
  });

  secondController.rehydrate('run-engine-1');
  assert.deepStrictEqual(secondController.getInvariantHashes(), hashes);

  // The rebuilt run continues correctly instead of restarting from scratch
  secondController.tick();
  const tasks = JSON.parse(secondStore.getLatestTaskSnapshot('run-engine-1')!.snapshotJson) as Array<{
    status: string;
  }>;
  assert.strictEqual(tasks[0].status, 'completed', 'restored task state must be preserved');

  secondDb.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --experimental-strip-types --test tests/run/engine.test.ts`
Expected: FAIL with "Cannot find module ... src/run/engine.ts"

- [ ] **Step 4: Write `packages/controller/src/run/engine.ts`**

```typescript
// packages/controller/src/run/engine.ts
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { computeSha256 } from '../../../protocol/src/index.ts';
import type { AgentRelayAdapter } from '../../../protocol/src/adapter.ts';
import type { HandshakeCoordinator } from '../../../protocol/src/coordinator.ts';
import type { HandoffPackManifest, TaskItem } from '../../../protocol/src/types.ts';
import { InputLedger } from '../inputs/ledger.ts';
import { deriveContractFromLedger } from '../inputs/supersedes.ts';
import { TaskGraph } from '../tasks/graph.ts';
import { TriggerPolicy } from '../policy/trigger.ts';
import { LoopDetector } from '../policy/loop-detector.ts';
import { WorkspaceSentinel } from '../workspace/sentinel.ts';
import { normalizeWorkspaceKey } from '../workspace/key.ts';
import { HandoffPackager } from '../workspace/checkpoint.ts';
import { HandoffStateMachine } from '../handoff/state-machine.ts';
import { DurableLeaseManager } from '../handoff/durable-lease.ts';
import { RunStore, type RunRecord, type RunState } from './store.ts';
import { ControlIntentLog, type PendingControl } from './intent.ts';
import { SessionChainLedger } from './chain.ts';
import { RunEventLog } from './events.ts';
import { ConsoleNotifier, type Notifier } from './notifier.ts';
import {
  buildRunBriefing,
  buildUnitPrompt,
  normalizeUnitResult,
  parseUnitResult,
  type UnitResultStatus
} from './prompt.ts';
import { buildRunStatus, writeStateProjection } from './status.ts';

export interface StartRunConfig {
  runId: string;
  goal: string;
  /** 物理工作区路径；引擎内部规范化为 workspaceKey */
  workspacePath: string;
  tasks: Array<{
    taskId: string;
    requirementId: string;
    title: string;
    description?: string;
    dependencies?: string[];
    allowedPaths?: string[];
    expectedArtifacts?: string[];
  }>;
  model: { provider: string; model: string; effort?: string };
  /** 原始人类输入，原样写入不可变账本 */
  initialUserMessage: string;
}

export interface CoordinatorDeps {
  adapter: AgentRelayAdapter;
  leaseManager: DurableLeaseManager;
  stateMachine: HandoffStateMachine;
  workspaceKey: string;
  runId: string;
}

export interface RunControllerOptions {
  store: RunStore;
  dataDir: string;
  adapter: AgentRelayAdapter;
  adapterName: 'codex' | 'claude' | 'dsh';
  createCoordinator: (deps: CoordinatorDeps) => HandshakeCoordinator;
  notifier?: Notifier;
  clock?: () => number;
  quiescenceTimeoutMs?: number;
  maxActiveDurationMs?: number;
}

export type RunTickOutcome =
  | { kind: 'unit_executed'; taskId: string; status: UnitResultStatus }
  | { kind: 'handoff_performed'; handoffId: string; fromSessionId: string; toSessionId: string; epoch: number }
  | { kind: 'paused'; intentId?: string; reason?: string }
  | { kind: 'stopped'; intentId?: string }
  | { kind: 'disabled'; intentId?: string }
  | { kind: 'completed' }
  | { kind: 'blocked'; reason: string }
  | { kind: 'recovery_required'; reason: string };

interface ResolvedSession {
  sessionId: string;
}

export class RunController {
  private readonly store: RunStore;
  private readonly dataDir: string;
  private readonly adapter: AgentRelayAdapter;
  private readonly adapterName: 'codex' | 'claude' | 'dsh';
  private readonly createCoordinator: (deps: CoordinatorDeps) => HandshakeCoordinator;
  private readonly notifier: Notifier;
  private readonly clock: () => number;
  private readonly quiescenceTimeoutMs: number;
  private readonly maxActiveDurationMs: number;
  private readonly packager = new HandoffPackager();

  private readonly events: RunEventLog;
  private readonly intents: ControlIntentLog;
  private readonly chain: SessionChainLedger;
  private readonly leaseManager: DurableLeaseManager;

  private runId = '';
  private ledger = new InputLedger();
  private graph = new TaskGraph();
  private sentinel: WorkspaceSentinel | null = null;
  private stateMachine: HandoffStateMachine | null = null;
  private triggerPolicy: TriggerPolicy;
  private loopDetector = new LoopDetector();

  constructor(options: RunControllerOptions) {
    this.store = options.store;
    this.dataDir = options.dataDir;
    this.adapter = options.adapter;
    this.adapterName = options.adapterName;
    this.createCoordinator = options.createCoordinator;
    this.notifier = options.notifier ?? new ConsoleNotifier();
    this.clock = options.clock ?? (() => Date.now());
    this.quiescenceTimeoutMs = options.quiescenceTimeoutMs ?? 30_000;
    this.maxActiveDurationMs = options.maxActiveDurationMs ?? 45 * 60 * 1000;

    this.events = new RunEventLog(this.store, this.notifier);
    this.intents = new ControlIntentLog(this.store);
    this.chain = new SessionChainLedger(this.store);
    this.leaseManager = new DurableLeaseManager(this.store);
    this.triggerPolicy = new TriggerPolicy({ maxActiveDurationMs: this.maxActiveDurationMs });
  }

  // ─── 生命周期 ───

  public startRun(config: StartRunConfig): RunRecord {
    const workspaceKey = normalizeWorkspaceKey(config.workspacePath);
    const existing = this.store.getActiveRunByWorkspace(workspaceKey);
    if (existing) {
      this.loadRun(existing.runId);
      this.events.record({
        runId: existing.runId,
        type: 'duplicate_activation_ignored',
        payload: { requestedRunId: config.runId }
      });
      return existing;
    }

    this.store.transaction(() => {
      this.store.insertRun({
        runId: config.runId,
        workspaceKey,
        workspacePath: path.resolve(config.workspacePath),
        goal: config.goal,
        state: 'INITIALIZING',
        unitCount: config.tasks.length
      });

      // 人类原始输入：追加式账本 + 落库镜像
      const bootstrapLedger = new InputLedger();
      const record = bootstrapLedger.appendUserMessage(config.initialUserMessage);
      this.store.appendInputRow(config.runId, this.store.nextInputSeq(config.runId), record);

      // 权威任务图：落库初始快照
      const bootstrapGraph = new TaskGraph();
      for (const task of config.tasks) {
        bootstrapGraph.addTask(task);
      }
      this.store.appendTaskSnapshot(
        config.runId,
        this.store.nextTaskSnapshotSeq(config.runId),
        JSON.stringify(bootstrapGraph.getAllTasks()),
        bootstrapGraph.computeSnapshotHash()
      );
    });

    this.loadRun(config.runId);
    this.events.record({
      runId: config.runId,
      type: 'run_started',
      payload: { goal: config.goal, workspaceKey, unitCount: config.tasks.length }
    });
    this.persistStatusProjection();
    return this.store.getRun(config.runId)!;
  }

  public rehydrate(runId: string): RunRecord | undefined {
    const run = this.store.getRun(runId);
    if (!run) return undefined;
    this.loadRun(runId);
    return run;
  }

  public getCurrentSessionId(): string | undefined {
    return this.runId ? this.store.getRun(this.runId)?.currentSessionId : undefined;
  }

  /** 跨重启必须稳定一致的两个不变量哈希（账本与任务图）。 */
  public getInvariantHashes(): { inputLedgerHeadHash: string; taskSnapshotHash: string } {
    return {
      inputLedgerHeadHash: this.ledger.getHeadHash(),
      taskSnapshotHash: this.graph.computeSnapshotHash()
    };
  }

  // ─── 编排循环 ───

  public async tick(): Promise<RunTickOutcome> {
    const run = this.requireRun();

    if (run.state === 'COMPLETED') return { kind: 'completed' };
    if (run.state === 'CANCELLED') return { kind: 'stopped' };
    if (run.state === 'DISABLED') return { kind: 'disabled' };
    if (run.state === 'BLOCKED') return { kind: 'blocked', reason: run.blockedReason ?? 'blocked' };
    if (run.state === 'RECOVERY_REQUIRED') {
      return { kind: 'recovery_required', reason: run.blockedReason ?? 'recovery_required' };
    }

    // PAUSED 是静止态：只有 resume（继续）或停止类意图（stop_now / disable）才能离开，
    // 否则必须原地停住——暂停期间绝不发起交接（V20）。
    if (run.state === 'PAUSED') {
      const pendingWhilePaused = this.intents.resolve(this.runId);
      const canProceed =
        pendingWhilePaused !== null &&
        (pendingWhilePaused.kind === 'resume' ||
          pendingWhilePaused.kind === 'stop_now' ||
          pendingWhilePaused.kind === 'disable');
      if (!canProceed) {
        return { kind: 'paused', reason: run.pauseReason ?? 'paused' };
      }
    }

    // 3. 控制意图（停止类优先）
    const pending = this.intents.resolve(this.runId);
    if (pending) {
      const outcome = await this.applyControlIntent(pending, run);
      if (outcome) return outcome;
    }

    const refreshed = this.requireRun();

    // 4. 确保存在存活的当前会话
    const sessionResult = await this.ensureSession(refreshed);
    if ('kind' in sessionResult) return sessionResult;

    const current = this.requireRun();

    // 5. 下一可执行单元
    const task = this.graph.getNextActionableTask();
    if (!task) {
      this.store.transaction(() => {
        this.store.updateRunState(this.runId, 'COMPLETED', {
          pauseReason: null,
          blockedReason: null
        });
        this.releaseWorkspaceLease(current);
        this.events.record({
          runId: this.runId,
          type: 'run_completed',
          payload: {
            completedUnits: this.graph.getAllTasks().filter((t) => t.status === 'completed').length,
            totalUnits: current.unitCount
          }
        });
        this.persistTaskSnapshot();
      });
      this.persistStatusProjection();
      return { kind: 'completed' };
    }

    // 6. 交接 or 原地执行
    if (current.currentSessionUnitCount > 0 && this.triggerPolicySaysHandoff()) {
      return this.performHandoff(task, current);
    }
    return this.executeUnit(task, current);
  }

  public async executeUntilSettled(maxTicks = 100): Promise<RunTickOutcome[]> {
    const outcomes: RunTickOutcome[] = [];
    for (let i = 0; i < maxTicks; i++) {
      const outcome = await this.tick();
      outcomes.push(outcome);
      if (outcome.kind !== 'unit_executed' && outcome.kind !== 'handoff_performed') {
        break;
      }
    }
    return outcomes;
  }

  // ─── 控制意图 ───

  /** 处理一个控制意图。返回 null 表示已处理完但本 tick 应继续推进。 */
  private async applyControlIntent(
    pending: PendingControl,
    run: RunRecord
  ): Promise<RunTickOutcome | null> {
    switch (pending.kind) {
      case 'stop_now': {
        this.intents.consume(pending.intentId);
        this.events.record({
          runId: this.runId,
          type: 'control_stop_received',
          payload: { intentId: pending.intentId, watermark: pending.watermark }
        });

        const sessionId = run.currentSessionId;
        if (sessionId) {
          await this.adapter.interruptOwned(sessionId);
          const quiescence = await this.adapter.awaitQuiescence(sessionId, this.quiescenceTimeoutMs);
          if (quiescence !== 'quiescent') {
            this.store.updateRunState(this.runId, 'RECOVERY_REQUIRED', {
              blockedReason: 'stop_quiescence_unconfirmed',
              pauseReason: null
            });
            this.events.record({
              runId: this.runId,
              type: 'recovery_required',
              payload: { reason: 'stop_quiescence_unconfirmed' }
            });
            this.persistStatusProjection();
            return { kind: 'recovery_required', reason: 'stop_quiescence_unconfirmed' };
          }
        }

        this.store.updateRunState(this.runId, 'CANCELLED', { pauseReason: null, blockedReason: null });
        this.releaseWorkspaceLease(run);
        this.events.record({ runId: this.runId, type: 'run_cancelled', payload: { intentId: pending.intentId } });
        this.persistStatusProjection();
        return { kind: 'stopped', intentId: pending.intentId };
      }

      case 'disable': {
        this.intents.consume(pending.intentId);
        this.store.updateRunState(this.runId, 'DISABLED', { pauseReason: null });
        this.releaseWorkspaceLease(run);
        this.events.record({ runId: this.runId, type: 'run_disabled', payload: { intentId: pending.intentId } });
        this.persistStatusProjection();
        return { kind: 'disabled', intentId: pending.intentId };
      }

      case 'pause_next_node': {
        this.intents.consume(pending.intentId);
        this.store.updateRunState(this.runId, 'PAUSED', { pauseReason: 'user_pause_next_node' });
        this.events.record({ runId: this.runId, type: 'run_paused', payload: { intentId: pending.intentId } });
        this.persistStatusProjection();
        return { kind: 'paused', intentId: pending.intentId, reason: 'user_pause_next_node' };
      }

      case 'resume': {
        this.intents.consume(pending.intentId);
        if (this.stateMachine && this.stateMachine.getState() === 'PAUSED') {
          this.stateMachine.resume();
        }
        this.store.updateRunState(this.runId, 'RUNNING', { pauseReason: null });
        this.events.record({ runId: this.runId, type: 'run_resumed', payload: { intentId: pending.intentId } });
        this.persistStatusProjection();
        return null;
      }
    }
  }

  // ─── 会话 ───

  private async ensureSession(run: RunRecord): Promise<ResolvedSession | RunTickOutcome> {
    const currentSessionId = run.currentSessionId;
    if (currentSessionId) {
      const inspect = await this.adapter.inspectSession(currentSessionId);
      if (inspect?.active) {
        return { sessionId: currentSessionId };
      }
      // 旧进程的会话已不可用：P2-04 到此为止，交由 P3-01 处理恢复细节。
      this.store.updateRunState(this.runId, 'RECOVERY_REQUIRED', {
        blockedReason: `current_session_lost:${currentSessionId}`
      });
      this.events.record({
        runId: this.runId,
        type: 'recovery_required',
        payload: { reason: `current_session_lost:${currentSessionId}` }
      });
      this.persistStatusProjection();
      return { kind: 'recovery_required', reason: `current_session_lost:${currentSessionId}` };
    }

    const sequence = this.store.nextChainSequence(this.runId);
    const sessionId = `${this.runId}-s${sequence}`;
    const contract = deriveContractFromLedger(this.ledger);

    await this.adapter.createFresh({
      sessionId,
      runId: this.runId,
      cwd: run.workspacePath,
      model: run.model ?? { provider: 'unknown', model: 'unknown' },
      readOnly: false,
      initialPrompt: buildRunBriefing({ goal: run.goal, contract, runId: this.runId })
    });

    this.store.transaction(() => {
      this.chain.append({
        runId: this.runId,
        nextSessionId: sessionId,
        adapter: this.adapterName,
        provider: run.model.provider,
        model: run.model.model,
        effort: run.model.effort,
        epoch: run.currentEpoch,
        reason: 'run_started'
      });
      this.leaseManager.acquireInitialLease(run.workspaceKey, sessionId, run.currentEpoch);
      this.store.updateRunState(this.runId, 'RUNNING', {
        currentSessionId: sessionId,
        currentSessionUnitCount: 0
      });
    });

    this.events.record({
      runId: this.runId,
      type: 'session_created',
      sessionId,
      payload: { reason: 'run_started' }
    });
    this.persistStatusProjection();
    return { sessionId };
  }

  // ─── 单元执行 ───

  private async executeUnit(task: TaskItem, run: RunRecord): Promise<RunTickOutcome> {
    const sessionId = run.currentSessionId;
    if (!sessionId) {
      throw new Error('RunController: executeUnit requires a current session');
    }

    const contract = deriveContractFromLedger(this.ledger);
    const prompt = buildUnitPrompt({ task, contract, runId: this.runId });

    this.graph.updateTaskStatus(task.taskId, 'in_progress');
    this.events.record({
      runId: this.runId,
      type: 'unit_started',
      sessionId,
      payload: { taskId: task.taskId }
    });

    await this.adapter.submit(sessionId, `unit-${task.taskId}-${randomUUID()}`, prompt, run.currentEpoch);

    const quiescence = await this.adapter.awaitQuiescence(sessionId, this.quiescenceTimeoutMs);
    if (quiescence !== 'quiescent') {
      this.store.transaction(() => {
        this.store.updateRunState(this.runId, 'BLOCKED', {
          blockedReason: `quiescence_${quiescence}`
        });
        this.events.record({
          runId: this.runId,
          type: 'run_blocked',
          sessionId,
          payload: { reason: `quiescence_${quiescence}`, taskId: task.taskId }
        });
        this.persistTaskSnapshot();
      });
      this.persistStatusProjection();
      return { kind: 'blocked', reason: `quiescence_${quiescence}` };
    }

    const raw = parseUnitResult(this.adapter.getSessionOutput(sessionId));
    const result = raw && raw.taskId === task.taskId ? normalizeUnitResult(raw) : null;
    const nextUnitCount = run.currentSessionUnitCount + 1;

    if (result && result.status === 'completed') {
      const evidenceHash = result.evidenceHash!;
      this.store.transaction(() => {
        this.graph.completeTaskWithEvidence(task.taskId, evidenceHash);
        this.store.updateRunState(this.runId, 'RUNNING', { currentSessionUnitCount: nextUnitCount });
        this.events.record({
          runId: this.runId,
          type: 'unit_completed',
          sessionId,
          payload: { taskId: task.taskId, evidenceHash }
        });
        this.persistTaskSnapshot();
      });
      this.persistStatusProjection();
      return { kind: 'unit_executed', taskId: task.taskId, status: 'completed' };
    }

    const status: UnitResultStatus = result?.status ?? 'failed';
    const failureSignature = result
      ? `unit_${result.status}:${task.taskId}:${result.summary ?? ''}`
      : `unit_result_missing:${task.taskId}`;
    this.loopDetector.recordFailure(failureSignature);
    const blocked = this.loopDetector.isLoopBlocked();

    this.store.transaction(() => {
      this.events.record({
        runId: this.runId,
        type: 'unit_failed',
        sessionId,
        payload: {
          taskId: task.taskId,
          status,
          summary: result?.summary ?? 'no UNIT_RESULT block found in session output',
          signature: failureSignature
        }
      });
      this.store.updateRunState(this.runId, blocked ? 'BLOCKED' : 'RUNNING', {
        currentSessionUnitCount: nextUnitCount,
        blockedReason: blocked ? `loop_detected_${task.taskId}` : null
      });
      if (blocked) {
        this.events.record({
          runId: this.runId,
          type: 'run_blocked',
          sessionId,
          payload: { reason: `loop_detected_${task.taskId}`, taskId: task.taskId }
        });
      }
      this.persistTaskSnapshot();
    });
    this.persistStatusProjection();

    if (blocked) {
      return { kind: 'blocked', reason: `loop_detected_${task.taskId}` };
    }
    return { kind: 'unit_executed', taskId: task.taskId, status };
  }

  // ─── 交接八步 ───

  private async performHandoff(task: TaskItem, run: RunRecord): Promise<RunTickOutcome> {
    const fromSessionId = run.currentSessionId;
    if (!fromSessionId) {
      throw new Error('RunController: performHandoff requires a current session');
    }

    const handoffId = `h-${this.runId}-${run.handoffCount + 1}`;

    // 步骤 1：记录交接意图（handoffId 为主键，天然去重，V13）
    const inserted = this.store.transaction(() =>
      this.store.insertHandoff({
        handoffId,
        runId: this.runId,
        epoch: run.currentEpoch,
        sourceSessionId: fromSessionId,
        state: 'REQUESTED'
      })
    );
    if (!inserted) {
      this.store.updateRunState(this.runId, 'BLOCKED', { blockedReason: 'duplicate_handoff_id' });
      this.events.record({
        runId: this.runId,
        type: 'run_blocked',
        payload: { reason: 'duplicate_handoff_id', handoffId }
      });
      this.persistStatusProjection();
      return { kind: 'blocked', reason: 'duplicate_handoff_id' };
    }
    this.events.record({
      runId: this.runId,
      type: 'handoff_requested',
      sessionId: fromSessionId,
      payload: { handoffId, taskId: task.taskId, epoch: run.currentEpoch }
    });

    // 步骤 2：旧 worker 收尾并确认静止
    this.stateMachine = new HandoffStateMachine(this.runId, fromSessionId, run.currentEpoch);
    this.stateMachine.requestHandoff('unit_completed');
    this.store.updateRunState(this.runId, 'DRAINING');

    await this.adapter.requestDrain(fromSessionId, handoffId);
    const oldQuiescence = await this.adapter.awaitQuiescence(fromSessionId, this.quiescenceTimeoutMs);
    if (oldQuiescence !== 'quiescent') {
      this.stateMachine.markRecoveryRequired();
      this.store.updateRunState(this.runId, 'RECOVERY_REQUIRED', {
        blockedReason: `old_session_quiescence_${oldQuiescence}`
      });
      this.events.record({
        runId: this.runId,
        type: 'recovery_required',
        payload: { reason: `old_session_quiescence_${oldQuiescence}` }
      });
      this.persistStatusProjection();
      return { kind: 'recovery_required', reason: `old_session_quiescence_${oldQuiescence}` };
    }

    this.stateMachine.checkpointCompleted(handoffId);
    this.store.updateRunState(this.runId, 'CHECKPOINTED');

    // 步骤 3：先完整写快照文件，再在事务内发布引用（V16）
    const manifest = this.packager.createManifest({
      handoffId,
      runId: this.runId,
      epoch: run.currentEpoch,
      sourceSessionId: fromSessionId,
      targetModel: run.model,
      ledger: this.ledger,
      taskGraph: this.graph,
      sentinel: this.sentinel ?? undefined
    });
    const published = this.publishManifestFile(handoffId, manifest);
    this.store.transaction(() => {
      this.store.updateHandoff(handoffId, {
        state: 'SNAPSHOTTED',
        manifestPath: published.filePath,
        manifestHash: published.hash
      });
    });
    this.events.record({
      runId: this.runId,
      type: 'handoff_snapshot_published',
      payload: { handoffId, manifestPath: published.filePath, manifestHash: published.hash }
    });

    // 步骤 4：创建意图已持久化在 handoffs 行上，去重后创建只读接手会话
    const sequence = this.store.nextChainSequence(this.runId);
    const toSessionId = `${this.runId}-s${sequence}`;

    this.stateMachine.beginStarting();
    this.store.updateRunState(this.runId, 'STARTING');
    this.store.transaction(() => {
      this.store.updateHandoff(handoffId, { state: 'CREATING', targetSessionId: toSessionId });
    });
    this.events.record({
      runId: this.runId,
      type: 'session_create_requested',
      sessionId: toSessionId,
      payload: { handoffId, readOnly: true }
    });

    const coordinator = this.createCoordinator({
      adapter: this.adapter,
      leaseManager: this.leaseManager,
      stateMachine: this.stateMachine,
      workspaceKey: run.workspaceKey,
      runId: this.runId
    });
    coordinator.startNewSession(toSessionId);
    this.store.updateRunState(this.runId, 'PREPARING');

    // 步骤 5：只读门控启动，记录返回的会话 ID
    await this.adapter.createFresh({
      sessionId: toSessionId,
      runId: this.runId,
      cwd: run.workspacePath,
      model: run.model,
      readOnly: true,
      initialPrompt: coordinator.buildPreparationPrompt(manifest)
    });

    const newQuiescence = await this.adapter.awaitQuiescence(toSessionId, this.quiescenceTimeoutMs);
    if (newQuiescence !== 'quiescent') {
      this.stateMachine.markRecoveryRequired();
      this.store.updateRunState(this.runId, 'RECOVERY_REQUIRED', {
        blockedReason: `new_session_quiescence_${newQuiescence}`
      });
      this.events.record({
        runId: this.runId,
        type: 'recovery_required',
        payload: { reason: `new_session_quiescence_${newQuiescence}` }
      });
      this.persistStatusProjection();
      return { kind: 'recovery_required', reason: `new_session_quiescence_${newQuiescence}` };
    }

    // 步骤 6：解析并核对 ACK
    const ack = coordinator.parseAckFromOutput(this.adapter.getSessionOutput(toSessionId));
    if (!ack) {
      this.stateMachine.markRecoveryRequired();
      this.store.updateRunState(this.runId, 'RECOVERY_REQUIRED', { blockedReason: 'ack_not_received' });
      this.events.record({
        runId: this.runId,
        type: 'recovery_required',
        payload: { reason: 'ack_not_received', handoffId }
      });
      this.persistStatusProjection();
      return { kind: 'recovery_required', reason: 'ack_not_received' };
    }

    // 步骤 7：同一事务内先核对未消费意图，再做 CAS 与状态更新（§5.3 / §6.3）
    const transactionResult = this.store.transaction(() => {
      const stillPending = this.intents.resolve(this.runId);
      if (stillPending) {
        return { blockedBy: stillPending } as const;
      }

      const authResult = coordinator.verifyAckAndAuthorize(manifest, ack);
      if (authResult.success) {
        this.store.updateRunState(this.runId, 'RUNNING', {
          currentSessionId: toSessionId,
          currentEpoch: authResult.epoch!,
          handoffCount: run.handoffCount + 1,
          currentSessionUnitCount: 0,
          pauseReason: null,
          blockedReason: null
        });
        this.store.setAuthorization(this.runId, {
          inputHeadHash: this.ledger.getHeadHash(),
          contractVersion: deriveContractFromLedger(this.ledger).version,
          intentWatermark: this.intents.getWatermark(this.runId)
        });
        this.store.updateHandoff(handoffId, { state: 'AUTHORIZED', targetSessionId: toSessionId });
      }
      return { authResult } as const;
    });

    if ('blockedBy' in transactionResult) {
      await this.adapter.interruptOwned(toSessionId);
      this.store.updateRunState(this.runId, 'PAUSED', {
        pauseReason: `control_intent_${transactionResult.blockedBy.kind}`
      });
      this.events.record({
        runId: this.runId,
        type: 'handoff_blocked_by_control_intent',
        sessionId: toSessionId,
        payload: { handoffId, intentId: transactionResult.blockedBy.intentId }
      });
      this.persistStatusProjection();
      return {
        kind: 'paused',
        intentId: transactionResult.blockedBy.intentId,
        reason: 'control_intent_arrived_during_handoff'
      };
    }

    const authResult = transactionResult.authResult;
    if (!authResult.success) {
      this.stateMachine.markRecoveryRequired();
      this.store.updateRunState(this.runId, 'RECOVERY_REQUIRED', {
        blockedReason: authResult.error ?? 'handshake_failed'
      });
      this.events.record({
        runId: this.runId,
        type: 'recovery_required',
        payload: { reason: authResult.error ?? 'handshake_failed', handoffId }
      });
      this.persistStatusProjection();
      return { kind: 'recovery_required', reason: authResult.error ?? 'handshake_failed' };
    }

    // 防御性复核：交接包含 await，意图可能在事务提交后、授权前到达
    const lateIntent = this.intents.resolve(this.runId);
    if (lateIntent) {
      await this.adapter.interruptOwned(toSessionId);
      this.store.updateRunState(this.runId, 'PAUSED', {
        pauseReason: `control_intent_${lateIntent.kind}`
      });
      this.events.record({
        runId: this.runId,
        type: 'handoff_blocked_by_control_intent',
        sessionId: toSessionId,
        payload: { handoffId, intentId: lateIntent.intentId, stage: 'pre_authorize' }
      });
      this.persistStatusProjection();
      return {
        kind: 'paused',
        intentId: lateIntent.intentId,
        reason: 'control_intent_arrived_before_authorize'
      };
    }

    // 步骤 8：送达执行令牌，旧会话封存并回收
    const authorized = await this.adapter.authorizeExecution(toSessionId, authResult.epoch!, authResult.executionToken!);
    if (!authorized) {
      this.stateMachine.markRecoveryRequired();
      this.store.updateRunState(this.runId, 'RECOVERY_REQUIRED', {
        blockedReason: 'authorize_execution_failed'
      });
      this.events.record({
        runId: this.runId,
        type: 'recovery_required',
        payload: { reason: 'authorize_execution_failed', handoffId }
      });
      this.persistStatusProjection();
      return { kind: 'recovery_required', reason: 'authorize_execution_failed' };
    }

    this.store.transaction(() => {
      this.chain.append({
        runId: this.runId,
        prevSessionId: fromSessionId,
        nextSessionId: toSessionId,
        adapter: this.adapterName,
        provider: run.model.provider,
        model: run.model.model,
        effort: run.model.effort,
        epoch: authResult.epoch!,
        handoffId,
        reason: 'unit_completed'
      });
      this.chain.supersede(fromSessionId);
      this.store.updateHandoff(handoffId, { state: 'COMPLETED', targetSessionId: toSessionId });
      this.events.record({
        runId: this.runId,
        type: 'handoff_completed',
        sessionId: toSessionId,
        payload: {
          handoffId,
          fromSessionId,
          toSessionId,
          epoch: authResult.epoch
        }
      });
      this.persistTaskSnapshot();
    });

    await this.adapter.interruptOwned(fromSessionId);
    this.persistStatusProjection();

    return {
      kind: 'handoff_performed',
      handoffId,
      fromSessionId,
      toSessionId,
      epoch: authResult.epoch!
    };
  }

  // ─── 内部工具 ───

  private requireRun(): RunRecord {
    const run = this.store.getRun(this.runId);
    if (!run) {
      throw new Error(`RunController: run ${this.runId} not found`);
    }
    return run;
  }

  /**
   * 终态 run 释放工作区租约，使同一工作区可被重新启用。
   * 租约是锁而不是历史：会话链与事件日志才是历史，它们不被删除。
   */
  private releaseWorkspaceLease(run: RunRecord): void {
    const sessionId = run.currentSessionId;
    this.store.transaction(() => {
      if (sessionId) {
        this.leaseManager.releaseLease(run.workspaceKey, sessionId);
      } else {
        const lease = this.leaseManager.getLease(run.workspaceKey);
        if (lease) {
          this.leaseManager.releaseLease(run.workspaceKey, lease.currentOwner);
        }
      }
    });
  }

  private triggerPolicySaysHandoff(): boolean {
    const run = this.requireRun();
    const decision = this.triggerPolicy.evaluate({
      unitCompleted: run.currentSessionUnitCount > 0,
      hasMoreUnits: this.graph.getNextActionableTask() !== undefined,
      // 压缩事件尚未接入（P2-04 范围外）：显式传 0 并在状态卡显示「未知」（V09）
      compactionCount: 0,
      activeDurationMs: this.clock() - run.updatedAt,
      maxActiveDurationMs: this.maxActiveDurationMs
    });
    return decision.shouldHandoff;
  }

  private publishManifestFile(
    handoffId: string,
    manifest: HandoffPackManifest
  ): { filePath: string; hash: string } {
    const dir = path.join(this.dataDir, this.runId, 'handoffs', handoffId);
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, 'manifest.json');
    const staging = `${target}.tmp`;
    const json = JSON.stringify(manifest, null, 2);
    fs.writeFileSync(staging, json, 'utf8');
    fs.renameSync(staging, target);
    return { filePath: target, hash: computeSha256(json) };
  }

  private persistTaskSnapshot(): void {
    this.store.appendTaskSnapshot(
      this.runId,
      this.store.nextTaskSnapshotSeq(this.runId),
      JSON.stringify(this.graph.getAllTasks()),
      this.graph.computeSnapshotHash()
    );
  }

  private persistStatusProjection(): void {
    if (!this.runId) return;
    try {
      writeStateProjection(this.dataDir, buildRunStatus(this.store, this.runId));
    } catch {
      // 投影失败不影响权威状态
    }
  }

  private loadRun(runId: string): void {
    const run = this.store.getRun(runId);
    if (!run) {
      throw new Error(`RunController: run ${runId} not found`);
    }

    this.runId = runId;
    this.sentinel = new WorkspaceSentinel(run.workspacePath);
    this.stateMachine = null;
    this.triggerPolicy = new TriggerPolicy({ maxActiveDurationMs: this.maxActiveDurationMs });

    this.ledger = new InputLedger();
    this.ledger.restoreFrom(this.store.listInputs(runId).map((row) => row.record));

    this.graph = new TaskGraph();
    const snapshot = this.store.getLatestTaskSnapshot(runId);
    if (snapshot) {
      this.graph.restoreFrom(JSON.parse(snapshot.snapshotJson) as TaskItem[]);
    }

    // 无进展计数必须跨会话与重启继承（V23）：从事件日志重放失败签名
    this.loopDetector = new LoopDetector();
    for (const event of this.events.list(runId)) {
      if (event.type === 'unit_failed' && typeof event.payload.signature === 'string') {
        this.loopDetector.recordFailure(event.payload.signature);
      }
    }
  }
}
```

**注意**：`ensureSession` 与 `performHandoff` 都读取 `run.model`（在 `runs` 表上以 `provider` / `model` / `effort` 三列持久化，Task 1 已交付；`startRun` 写入 `config.model`）。**绝不猜测模型**——缺省值必须是 `unknown`，由状态卡如实显示「未知」。

- [ ] **Step 5: Confirm the run model interface exists (delivered by Task 1)**

`RunController` 依赖 `RunRecord.model` 与 `InsertRunParams.model?`，二者已在 Task 1 加入
`packages/controller/src/run/db.ts` 与 `packages/controller/src/run/store.ts`。写引擎前先确认：

```bash
grep -n "model" packages/controller/src/run/store.ts
```

期望看到：`InsertRunParams.model?`（可选）、`RunRecord.model`（必填，缺省为
`{ provider: 'unknown', model: 'unknown' }`）、以及 `mapRun` 中对 `provider` / `model` / `effort` 的映射。
若有缺失，按 Task 1 Step 5 的写法补齐，不要绕过——**绝不猜测模型**，缺省必须如实记为 `unknown`，
由状态卡显示「未知」。

- [ ] **Step 6: Update the run barrel export**

Modify `packages/controller/src/run/index.ts`:

```typescript
export * from './db.ts';
export * from './store.ts';
export * from './notifier.ts';
export * from './events.ts';
export * from './intent.ts';
export * from './chain.ts';
export * from './prompt.ts';
export * from './status.ts';
export * from './engine.ts';
```

- [ ] **Step 7: Run test to verify it passes**

Run: `node --experimental-strip-types --test tests/run/engine.test.ts`
Expected: PASS (12 tests pass)

- [ ] **Step 8: Run the full suite**

Run: `npm test`
Expected: PASS, 0 failures

- [ ] **Step 9: Commit**

```bash
git add packages/controller/src/run/engine.ts packages/controller/src/run/index.ts tests/helpers/scripted-adapter.ts tests/run/engine.test.ts
git commit -m "feat(controller/run): implement RunController orchestration core with atomic handoff CAS"
```

---

### Task 9: CLI 状态与控制入口

**Files:**
- Create: `packages/cli/package.json`
- Create: `packages/cli/src/render.ts`
- Create: `packages/cli/src/cli.ts`
- Create: `bin/agent-relay.mjs`
- Test: `tests/run/cli.test.ts`

**Interfaces:**
- Consumes: `RelayDatabase`、`RunStore`、`ControlIntentLog`、`SessionChainLedger`、`buildRunStatus`、`renderStatusCard`、`renderStatusJson`、`RunState`、`SessionChainLink`
- Produces: `runCli(argv, deps): Promise<number>`、`CliIo`、`CliDeps`、`resolveDataDir(explicit, env): string`、`renderChain(links): string`

**关键约束**：控制动作必须**先落库再打印确认**；CLI 从不驱动会话。`watch` 只轮询读取投影，随时 Ctrl-C 退出不影响 run。

- [ ] **Step 1: Write the failing test**

Create `tests/run/cli.test.ts`:

```typescript
// tests/run/cli.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { RelayDatabase } from '../../packages/controller/src/run/db.ts';
import { RunStore } from '../../packages/controller/src/run/store.ts';
import { SessionChainLedger } from '../../packages/controller/src/run/chain.ts';
import { runCli, type CliIo } from '../../packages/cli/src/cli.ts';

const BIN_PATH = fileURLToPath(new URL('../../bin/agent-relay.mjs', import.meta.url));

function capture(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      out: (line: string) => out.push(line),
      err: (line: string) => err.push(line)
    },
    out,
    err
  };
}

function seed(dataDir: string, runId = 'run-cli-1', state: 'RUNNING' | 'PAUSED' = 'RUNNING') {
  const db = new RelayDatabase({ dbPath: path.join(dataDir, 'relay.db') });
  const store = new RunStore(db);
  store.insertRun({
    runId,
    workspaceKey: 'ws-cli',
    workspacePath: 'C:/tmp/ws-cli',
    goal: 'Ship the CLI entrance',
    model: { provider: 'anthropic', model: 'claude-3-7-sonnet', effort: 'high' },
    state,
    unitCount: 2
  });
  store.appendTaskSnapshot(
    runId,
    1,
    JSON.stringify([
      {
        taskId: 'u1',
        requirementId: 'req-root',
        title: 'Unit One',
        description: '',
        dependencies: [],
        status: 'completed',
        allowedPaths: [],
        expectedArtifacts: [],
        testEvidenceHash: 'ev-u1',
        completedAt: 1
      },
      {
        taskId: 'u2',
        requirementId: 'req-root',
        title: 'Unit Two',
        description: '',
        dependencies: ['u1'],
        status: 'pending',
        allowedPaths: [],
        expectedArtifacts: []
      }
    ]),
    'snap-1'
  );
  const chain = new SessionChainLedger(store);
  chain.append({
    runId,
    nextSessionId: 'worker-A',
    adapter: 'claude',
    provider: 'anthropic',
    model: 'claude-3-7-sonnet',
    effort: 'high',
    epoch: 1,
    reason: 'run_started'
  });
  return { db, store };
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-relay-cli-'));
}

test('cli: status prints the status card with exit code 0', async () => {
  const dataDir = tempDir();
  const { db } = seed(dataDir);
  db.close();

  const { io, out } = capture();
  const code = await runCli(['status', '--data-dir', dataDir], { io });

  assert.strictEqual(code, 0);
  const text = out.join('\n');
  assert.match(text, /^目标: Ship the CLI entrance/m);
  assert.match(text, /^进度: 1\/2 单元完成/m);
  assert.match(text, /^压缩: 未知/m);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('cli: status --json emits parseable structured output', async () => {
  const dataDir = tempDir();
  const { db } = seed(dataDir);
  db.close();

  const { io, out } = capture();
  const code = await runCli(['status', '--data-dir', dataDir, '--json'], { io });

  assert.strictEqual(code, 0);
  const parsed = JSON.parse(out.join('\n')) as Record<string, unknown>;
  assert.strictEqual(parsed.runId, 'run-cli-1');
  assert.strictEqual(parsed.state, 'RUNNING');
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('cli: chain lists session links in order', async () => {
  const dataDir = tempDir();
  const { db, store } = seed(dataDir);
  new SessionChainLedger(store).append({
    runId: 'run-cli-1',
    prevSessionId: 'worker-A',
    nextSessionId: 'worker-B',
    adapter: 'claude',
    provider: 'anthropic',
    model: 'claude-3-7-sonnet',
    epoch: 2,
    handoffId: 'h-1',
    reason: 'unit_completed'
  });
  db.close();

  const { io, out } = capture();
  const code = await runCli(['chain', '--data-dir', dataDir], { io });

  assert.strictEqual(code, 0);
  const text = out.join('\n');
  assert.match(text, /worker-A/);
  assert.match(text, /worker-B/);
  assert.match(text, /unit_completed/);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('cli: control actions persist the intent before printing confirmation', async () => {
  const dataDir = tempDir();
  const { db, store } = seed(dataDir);
  db.close();

  const paused = capture();
  assert.strictEqual(await runCli(['pause', '--data-dir', dataDir], { io: paused.io }), 0);
  assert.match(paused.out.join('\n'), /watermark 1/);

  const inspection = new RelayDatabase({ dbPath: path.join(dataDir, 'relay.db') });
  const inspectionStore = new RunStore(inspection);
  const pending = inspectionStore.listPendingIntents('run-cli-1');
  assert.strictEqual(pending.length, 1, 'the intent must already be durable when confirmation is printed');
  assert.strictEqual(pending[0].kind, 'pause_next_node');
  assert.strictEqual(pending[0].watermark, 1);

  const stopped = capture();
  assert.strictEqual(await runCli(['stop', '--data-dir', dataDir], { io: stopped.io }), 0);
  assert.strictEqual(inspectionStore.listPendingIntents('run-cli-1').length, 2);
  assert.strictEqual(inspectionStore.getLatestIntentWatermark('run-cli-1'), 2);

  inspection.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('cli: run selection fails with exit code 2 when no run or several runs exist', async () => {
  const empty = tempDir();
  const missing = capture();
  assert.strictEqual(await runCli(['status', '--data-dir', empty], { io: missing.io }), 2);
  assert.match(missing.err.join('\n'), /no run/i);
  fs.rmSync(empty, { recursive: true, force: true });

  const ambiguous = tempDir();
  const { db } = seed(ambiguous, 'run-cli-1');
  const store = new RunStore(db);
  store.insertRun({
    runId: 'run-cli-2',
    workspaceKey: 'ws-cli-2',
    workspacePath: 'C:/tmp/ws-cli-2',
    goal: 'Second run',
    model: { provider: 'anthropic', model: 'claude-3-7-sonnet' },
    state: 'RUNNING',
    unitCount: 1
  });
  db.close();

  const several = capture();
  assert.strictEqual(await runCli(['status', '--data-dir', ambiguous], { io: several.io }), 2);
  assert.match(several.err.join('\n'), /--run/);

  // --run disambiguates
  const explicit = capture();
  assert.strictEqual(
    await runCli(['status', '--data-dir', ambiguous, '--run', 'run-cli-2'], { io: explicit.io }),
    0
  );
  assert.match(explicit.out.join('\n'), /Second run/);
  fs.rmSync(ambiguous, { recursive: true, force: true });
});

test('cli: unknown commands and bad usage exit with code 1', async () => {
  const dataDir = tempDir();
  const { db } = seed(dataDir);
  db.close();

  const noCommand = capture();
  assert.strictEqual(await runCli([], { io: noCommand.io }), 1);
  assert.match(noCommand.err.join('\n'), /usage/i);

  const unknown = capture();
  assert.strictEqual(await runCli(['frobnicate', '--data-dir', dataDir], { io: unknown.io }), 1);
  assert.match(unknown.err.join('\n'), /unknown command/i);

  const missingValue = capture();
  assert.strictEqual(await runCli(['status', '--data-dir', dataDir, '--run'], { io: missingValue.io }), 1);
  assert.match(missingValue.err.join('\n'), /--run requires a value/);

  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('cli: actions that the current state forbids exit with code 3', async () => {
  const dataDir = tempDir();
  const { db } = seed(dataDir, 'run-cli-1', 'RUNNING');
  db.close();

  const resumeRunning = capture();
  assert.strictEqual(await runCli(['resume', '--data-dir', dataDir], { io: resumeRunning.io }), 3);
  assert.match(resumeRunning.err.join('\n'), /resume/i);

  const inspection = new RelayDatabase({ dbPath: path.join(dataDir, 'relay.db') });
  new RunStore(inspection).updateRunState('run-cli-1', 'PAUSED', { pauseReason: 'test' });
  inspection.close();

  const resumePaused = capture();
  assert.strictEqual(await runCli(['resume', '--data-dir', dataDir], { io: resumePaused.io }), 0);
  assert.match(resumePaused.out.join('\n'), /resumed|resume/i);

  const completed = new RelayDatabase({ dbPath: path.join(dataDir, 'relay.db') });
  new RunStore(completed).updateRunState('run-cli-1', 'COMPLETED');
  completed.close();

  const pauseCompleted = capture();
  assert.strictEqual(await runCli(['pause', '--data-dir', dataDir], { io: pauseCompleted.io }), 3);
  assert.match(pauseCompleted.err.join('\n'), /COMPLETED/);

  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('cli: watch refreshes a bounded number of times and can be interrupted', async () => {
  const dataDir = tempDir();
  const { db } = seed(dataDir);
  db.close();

  const { io, out } = capture();
  const code = await runCli(['watch', '--data-dir', dataDir, '--interval', '1', '--iterations', '2'], { io });

  assert.strictEqual(code, 0);
  const refreshes = out.filter((line) => line.startsWith('目标:')).length;
  assert.strictEqual(refreshes, 2, 'watch must refresh exactly the requested number of times');
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('cli: the real bin shim writes a durable intent visible to the supervisor process (V22)', () => {
  const dataDir = tempDir();
  const { db, store } = seed(dataDir);
  db.close();

  // A separate OS process performs the control action
  const result = spawnSync(process.execPath, [BIN_PATH, 'stop', '--data-dir', dataDir, '--run', 'run-cli-1'], {
    encoding: 'utf8',
    env: { ...process.env }
  });
  assert.strictEqual(result.status, 0, `bin shim failed: ${result.stderr}`);
  assert.match(result.stdout, /watermark 1/);

  // The supervisor-side connection observes it without sharing memory
  const supervisorDb = new RelayDatabase({ dbPath: path.join(dataDir, 'relay.db') });
  const supervisorStore = new RunStore(supervisorDb);
  const pending = supervisorStore.listPendingIntents('run-cli-1');
  assert.strictEqual(pending.length, 1);
  assert.strictEqual(pending[0].kind, 'stop_now');
  assert.strictEqual(pending[0].watermark, 1);
  assert.strictEqual(store.getRun('run-cli-1')?.state, 'RUNNING', 'the shim must not drive the run itself');

  supervisorDb.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test tests/run/cli.test.ts`
Expected: FAIL with "Cannot find module ... packages/cli/src/cli.ts"

- [ ] **Step 3: Write `packages/cli/package.json`**

```json
{
  "name": "@agent-relay/cli",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": {
    "agent-relay": "../../bin/agent-relay.mjs"
  }
}
```

- [ ] **Step 4: Write `packages/cli/src/render.ts`**

```typescript
// packages/cli/src/render.ts
import type { SessionChainLink } from '../../controller/src/run/store.ts';

const COLUMNS: Array<{ header: string; width: number }> = [
  { header: '#', width: 3 },
  { header: '旧会话', width: 22 },
  { header: '新会话', width: 22 },
  { header: '模型', width: 34 },
  { header: 'epoch', width: 5 },
  { header: '原因', width: 18 }
];

function cell(value: string, width: number): string {
  if (value.length <= width) return value.padEnd(width);
  return `${value.slice(0, Math.max(0, width - 1))}…`;
}

export function renderChain(links: SessionChainLink[]): string {
  if (links.length === 0) {
    return '（无会话链记录）\n';
  }

  const header = COLUMNS.map((c) => cell(c.header, c.width)).join(' ');
  const divider = COLUMNS.map((c) => '-'.repeat(c.width)).join(' ');
  const rows = links.map((link) =>
    [
      cell(String(link.sequence), COLUMNS[0].width),
      cell(link.prevSessionId ?? '(新 run)', COLUMNS[1].width),
      cell(link.nextSessionId, COLUMNS[2].width),
      cell(`${link.provider}/${link.model}${link.effort ? ` (${link.effort})` : ''}`, COLUMNS[3].width),
      cell(String(link.epoch), COLUMNS[4].width),
      cell(link.reason, COLUMNS[5].width)
    ].join(' ')
  );

  return [header, divider, ...rows].join('\n') + '\n';
}
```

- [ ] **Step 5: Write `packages/cli/src/cli.ts`**

```typescript
// packages/cli/src/cli.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RelayDatabase } from '../../controller/src/run/db.ts';
import { RunStore, TERMINAL_RUN_STATES, type RunRecord } from '../../controller/src/run/store.ts';
import { ControlIntentLog, type ControlIntentKind } from '../../controller/src/run/intent.ts';
import { SessionChainLedger } from '../../controller/src/run/chain.ts';
import { buildRunStatus, renderStatusCard, renderStatusJson } from '../../controller/src/run/status.ts';
import { renderChain } from './render.ts';

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

export interface CliDeps {
  io?: CliIo;
  env?: NodeJS.ProcessEnv;
}

const USAGE = [
  '用法 (usage): agent-relay <command> [--run <id>] [--data-dir <path>] [options]',
  '',
  '命令:',
  '  status    显示状态卡（--json 输出结构化结果）',
  '  chain     显示旧→新会话链',
  '  pause     在下一安全节点暂停（不创建下一执行会话）',
  '  stop      立即停止',
  '  resume    从暂停中继续',
  '  disable   禁用自动交接',
  '  watch     轮询刷新状态卡（--interval <ms>，--iterations <n>）'
].join('\n');

const COMMANDS = ['status', 'chain', 'pause', 'stop', 'resume', 'disable', 'watch'] as const;
type Command = (typeof COMMANDS)[number];

interface ParsedArgs {
  command: Command;
  runId?: string;
  dataDir?: string;
  json: boolean;
  intervalMs: number;
  iterations?: number;
}

class UsageError extends Error {}
class NotFoundError extends Error {}

export function resolveDataDir(explicit: string | undefined, env: NodeJS.ProcessEnv): string {
  if (explicit) return path.resolve(explicit);
  if (env.AGENT_RELAY_DATA_DIR) return path.resolve(env.AGENT_RELAY_DATA_DIR);
  if (process.platform === 'win32') {
    const localAppData = env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
    return path.join(localAppData, 'agent-relay');
  }
  const stateHome = env.XDG_STATE_HOME ?? path.join(os.homedir(), '.local', 'state');
  return path.join(stateHome, 'agent-relay');
}

function parseArgs(argv: string[]): ParsedArgs {
  if (argv.length === 0) {
    throw new UsageError('missing command');
  }
  const command = argv[0] as Command;
  if (!COMMANDS.includes(command)) {
    throw new UsageError(`unknown command: ${argv[0]}`);
  }

  const parsed: ParsedArgs = { command, json: false, intervalMs: 2000 };

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    const takeValue = (): string => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new UsageError(`${arg} requires a value`);
      }
      i++;
      return value;
    };

    switch (arg) {
      case '--run':
        parsed.runId = takeValue();
        break;
      case '--data-dir':
        parsed.dataDir = takeValue();
        break;
      case '--json':
        parsed.json = true;
        break;
      case '--interval':
        parsed.intervalMs = Number(takeValue());
        if (!Number.isFinite(parsed.intervalMs) || parsed.intervalMs < 0) {
          throw new UsageError('--interval must be a non-negative number');
        }
        break;
      case '--iterations':
        parsed.iterations = Number(takeValue());
        if (!Number.isInteger(parsed.iterations) || parsed.iterations < 1) {
          throw new UsageError('--iterations must be a positive integer');
        }
        break;
      default:
        throw new UsageError(`unknown option: ${arg}`);
    }
  }

  return parsed;
}

function isTerminal(run: RunRecord): boolean {
  return TERMINAL_RUN_STATES.includes(run.state);
}

function resolveRun(store: RunStore, requested: string | undefined): RunRecord {
  if (requested) {
    const run = store.getRun(requested);
    if (!run) throw new NotFoundError(`no run with id ${requested}`);
    return run;
  }

  const active = store.listRuns().filter((run) => !isTerminal(run));
  if (active.length === 0) {
    throw new NotFoundError('no run found; specify --run or start a run first');
  }
  if (active.length > 1) {
    throw new NotFoundError(`several active runs found; specify one with --run (${active.map((r) => r.runId).join(', ')})`);
  }
  return active[0];
}

function openStore(dataDir: string): { db: RelayDatabase; store: RunStore } | null {
  const dbPath = path.join(dataDir, 'relay.db');
  if (!fs.existsSync(dbPath)) {
    return null;
  }
  const db = new RelayDatabase({ dbPath });
  return { db, store: new RunStore(db) };
}

const INTENT_GUARD: Record<'pause' | 'stop' | 'resume' | 'disable', { kind: ControlIntentKind; allows: (run: RunRecord) => boolean; rejection: string }> = {
  pause: {
    kind: 'pause_next_node',
    allows: (run) => !isTerminal(run),
    rejection: 'cannot pause a run in state'
  },
  stop: {
    kind: 'stop_now',
    allows: (run) => !isTerminal(run),
    rejection: 'cannot stop a run in state'
  },
  resume: {
    kind: 'resume',
    allows: (run) => run.state === 'PAUSED',
    rejection: 'cannot resume a run in state'
  },
  disable: {
    kind: 'disable',
    allows: (run) => !isTerminal(run),
    rejection: 'cannot disable a run in state'
  }
};

export async function runCli(argv: string[], deps: CliDeps = {}): Promise<number> {
  const io: CliIo = deps.io ?? {
    out: (line: string) => process.stdout.write(`${line}\n`),
    err: (line: string) => process.stderr.write(`${line}\n`)
  };
  const env = deps.env ?? process.env;

  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    io.err((err as Error).message);
    io.err(USAGE);
    return 1;
  }

  const dataDir = resolveDataDir(args.dataDir, env);
  const opened = openStore(dataDir);
  if (!opened) {
    io.err(`no run found: ${path.join(dataDir, 'relay.db')} does not exist`);
    return 2;
  }
  const { db, store } = opened;

  try {
    const run = resolveRun(store, args.runId);

    switch (args.command) {
      case 'status': {
        const view = buildRunStatus(store, run.runId);
        io.out(args.json ? renderStatusJson(view) : renderStatusCard(view).trimEnd());
        return 0;
      }

      case 'chain': {
        const links = new SessionChainLedger(store).list(run.runId);
        if (args.json) {
          io.out(JSON.stringify(links, null, 2));
        } else {
          io.out(renderChain(links).trimEnd());
        }
        return 0;
      }

      case 'watch': {
        const iterations = args.iterations ?? Number.POSITIVE_INFINITY;
        for (let i = 0; i < iterations; i++) {
          if (i > 0 && args.intervalMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, args.intervalMs));
          }
          const view = buildRunStatus(store, run.runId);
          io.out(args.json ? renderStatusJson(view) : renderStatusCard(view).trimEnd());
          if (TERMINAL_RUN_STATES.includes(view.state)) {
            break;
          }
        }
        return 0;
      }

      default: {
        const action = args.command as 'pause' | 'stop' | 'resume' | 'disable';
        const rule = INTENT_GUARD[action];
        if (!rule.allows(run)) {
          io.err(`${rule.rejection} ${run.state}`);
          return 3;
        }
        // 先落库，再打印确认——确认输出即代表意图已持久化
        const intent = new ControlIntentLog(store).append(run.runId, rule.kind);
        io.out(`${action} requested for run ${run.runId} (watermark ${intent.watermark}, intent ${intent.intentId})`);
        return 0;
      }
    }
  } catch (err) {
    if (err instanceof NotFoundError) {
      io.err(err.message);
      return 2;
    }
    io.err(`error: ${(err as Error).message}`);
    return 1;
  } finally {
    db.close();
  }
}
```

- [ ] **Step 6: Write `bin/agent-relay.mjs`**

```javascript
#!/usr/bin/env node
// bin/agent-relay.mjs
// 薄 shim：Node 24 可直接运行 .ts，因此这里只负责转发 argv 与退出码。
import { runCli } from '../packages/cli/src/cli.ts';

const exitCode = await runCli(process.argv.slice(2));
process.exit(exitCode);
```

- [ ] **Step 7: Run test to verify it passes**

Run: `node --experimental-strip-types --test tests/run/cli.test.ts`
Expected: PASS (9 tests pass)

- [ ] **Step 8: Run the full suite**

Run: `npm test`
Expected: PASS, 0 failures

- [ ] **Step 9: Commit**

```bash
git add packages/cli/src/cli.ts packages/cli/src/render.ts packages/cli/package.json bin/agent-relay.mjs tests/run/cli.test.ts
git commit -m "feat(cli): add agent-relay status and control entrance over durable intents"
```

---

### Task 10: 端到端验收 —— 四单元/三次交接、真实 DSH 进程与全部场景

**Files:**
- Modify: `tests/fixtures/mock-dsh-sdk-server.mjs`
- Test: `tests/scenarios/relay-run.test.ts`

**Interfaces:**
- Consumes: `RunController`、`ScriptedAdapter`、`DshAdapter`、`DshHandshakeCoordinator`、`runCli`、`RelayDatabase`、`RunStore`
- Produces: S01/V13/V21/V22/V31/V33/V34 的端到端证据，以及一次真实 DSH 子进程的交接记录

- [ ] **Step 1: Extend the DSH mock server to answer unit prompts**

Modify `tests/fixtures/mock-dsh-sdk-server.mjs` — insert this branch **before** the final `else` in the `session/prompt` handler (i.e. after the `text.startsWith('echo:')` branch):

```javascript
    } else if (/TASK_ID:\s*\S+/.test(text)) {
      const taskId = text.match(/TASK_ID:\s*(\S+)/)[1];
      const evidenceHash = `evidence-${taskId}`;
      sendNotification('session.event', {
        sessionId,
        event: 'assistant/message',
        text:
          'UNIT_RESULT_START\n' +
          JSON.stringify({ taskId, status: 'completed', evidenceHash, summary: `unit ${taskId} finished` }) +
          '\nUNIT_RESULT_END'
      });
    } else if (text.startsWith('echo:')) {
```

- [ ] **Step 2: Write the end-to-end scenario test**

Create `tests/scenarios/relay-run.test.ts`:

```typescript
// tests/scenarios/relay-run.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RelayDatabase } from '../../packages/controller/src/run/db.ts';
import { RunStore } from '../../packages/controller/src/run/store.ts';
import { RunController, type StartRunConfig } from '../../packages/controller/src/run/engine.ts';
import { ControlIntentLog } from '../../packages/controller/src/run/intent.ts';
import { RecordingNotifier } from '../../packages/controller/src/run/notifier.ts';
import { buildRunStatus, renderStatusCard, writeStateProjection } from '../../packages/controller/src/run/status.ts';
import { WorkspaceLeaseManager } from '../../packages/controller/src/handoff/lease.ts';
import { HandoffStateMachine } from '../../packages/controller/src/handoff/state-machine.ts';
import { DurableLeaseManager } from '../../packages/controller/src/handoff/durable-lease.ts';
import { normalizeWorkspaceKey } from '../../packages/controller/src/workspace/key.ts';
import { TwoPhaseHandshakeCoordinator } from '../../packages/adapters/claude/src/handshake.ts';
import { DshAdapter } from '../../packages/adapters/dsh/src/dsh-adapter.ts';
import { DshHandshakeCoordinator } from '../../packages/adapters/dsh/src/handshake.ts';
import { runCli, type CliIo } from '../../packages/cli/src/cli.ts';
import { ScriptedAdapter } from '../helpers/scripted-adapter.ts';

const MOCK_DSH_SERVER = fileURLToPath(new URL('../fixtures/mock-dsh-sdk-server.mjs', import.meta.url));

const FOUR_UNITS = [
  { taskId: 'u1', requirementId: 'req-root', title: 'Data Ingestion', dependencies: [] as string[] },
  { taskId: 'u2', requirementId: 'req-root', title: 'Transformer Encoder', dependencies: ['u1'] },
  { taskId: 'u3', requirementId: 'req-root', title: 'Autoregressive Decoder', dependencies: ['u2'] },
  { taskId: 'u4', requirementId: 'req-root', title: 'Loss and Optimizer', dependencies: ['u3'] }
];

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function capture(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l) => out.push(l), err: (l) => err.push(l) }, out, err };
}

function claudeCoordinator() {
  return (deps: {
    stateMachine: unknown;
    leaseManager: unknown;
    workspaceKey: string;
  }) =>
    new TwoPhaseHandshakeCoordinator(
      deps.stateMachine as HandoffStateMachine,
      deps.leaseManager as WorkspaceLeaseManager,
      deps.workspaceKey
    );
}

test('scenarios: S01 - four units complete through three automatic handoffs driven by RunController', async () => {
  const dataDir = tempDir('agent-relay-s01-');
  const db = new RelayDatabase({ dbPath: path.join(dataDir, 'relay.db') });
  const store = new RunStore(db);
  const adapter = new ScriptedAdapter();
  const notifier = new RecordingNotifier();

  const controller = new RunController({
    store,
    dataDir,
    adapter,
    adapterName: 'claude',
    notifier,
    createCoordinator: claudeCoordinator()
  });

  const config: StartRunConfig = {
    runId: 'relay-run-001',
    goal: 'Build the deep learning pipeline across four units',
    workspacePath: dataDir,
    tasks: FOUR_UNITS,
    model: { provider: 'anthropic', model: 'claude-3-7-sonnet', effort: 'high' },
    initialUserMessage: 'Build the pipeline. Do not change the public API.'
  };

  controller.startRun(config);
  const outcomes = await controller.executeUntilSettled();

  assert.strictEqual(outcomes.filter((o) => o.kind === 'unit_executed').length, 4);
  assert.strictEqual(outcomes.filter((o) => o.kind === 'handoff_performed').length, 3);
  assert.strictEqual(outcomes[outcomes.length - 1].kind, 'completed');

  const run = store.getRun('relay-run-001')!;
  assert.strictEqual(run.state, 'COMPLETED');
  assert.strictEqual(run.handoffCount, 3);
  assert.strictEqual(store.listChain('relay-run-001').length, 4);

  // R4/R5: four distinct sessions, no history reuse, model preserved on every link
  const chain = store.listChain('relay-run-001');
  assert.strictEqual(new Set(chain.map((l) => l.nextSessionId)).size, 4);
  assert.strictEqual(chain.every((l) => l.model === 'claude-3-7-sonnet'), true);
  assert.strictEqual(chain.every((l) => l.effort === 'high'), true);

  // R1: the original wording is intact and never overwritten
  const inputs = store.listInputs('relay-run-001');
  assert.strictEqual(inputs.length, 1);
  assert.strictEqual(inputs[0].record.rawContent, config.initialUserMessage);

  // R6: three consecutive handoffs with zero confirmation prompts
  assert.deepStrictEqual(notifier.notifications.map((n) => n.type), ['run_completed']);

  // R9: the entrance shows the finished run
  const view = buildRunStatus(store, 'relay-run-001');
  assert.strictEqual(view.progress.completed, 4);
  assert.strictEqual(view.progress.total, 4);
  assert.match(renderStatusCard(view), /^进度: 4\/4 单元完成/m);

  const status = capture();
  assert.strictEqual(await runCli(['status', '--data-dir', dataDir], { io: status.io }), 0);
  assert.match(status.out.join('\n'), /4\/4 单元完成/);

  const chainOutput = capture();
  assert.strictEqual(await runCli(['chain', '--data-dir', dataDir, '--json'], { io: chainOutput.io }), 0);
  assert.strictEqual((JSON.parse(chainOutput.out.join('\n')) as unknown[]).length, 4);

  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('scenarios: V22 - closing the viewer and reopening it recovers the current progress', async () => {
  const dataDir = tempDir('agent-relay-v22-');
  const db = new RelayDatabase({ dbPath: path.join(dataDir, 'relay.db') });
  const store = new RunStore(db);
  const controller = new RunController({
    store,
    dataDir,
    adapter: new ScriptedAdapter(),
    adapterName: 'claude',
    notifier: new RecordingNotifier(),
    createCoordinator: claudeCoordinator()
  });

  controller.startRun({
    runId: 'relay-run-v22',
    goal: 'Pause and resume across viewer restarts',
    workspacePath: dataDir,
    tasks: FOUR_UNITS,
    model: { provider: 'anthropic', model: 'claude-3-7-sonnet' },
    initialUserMessage: 'Ship it.'
  });

  await controller.tick(); // unit 1
  await controller.tick(); // handoff to session 2

  // First viewer opens and closes (nothing is held between invocations)
  const first = capture();
  assert.strictEqual(await runCli(['status', '--data-dir', dataDir], { io: first.io }), 0);

  // The run advanced further while no viewer existed
  await controller.tick(); // unit 2 in session 2

  // Reopening the viewer recovers the newer progress from the authoritative store
  const second = capture();
  assert.strictEqual(await runCli(['status', '--data-dir', dataDir], { io: second.io }), 0);
  assert.match(second.out.join('\n'), /^进度: 2\/4 单元完成/m);
  assert.notStrictEqual(second.out.join('\n'), first.out.join('\n'));

  // The projection file on disk is a rebuildable projection, not a second source of truth
  const projectionPath = path.join(dataDir, 'relay-run-v22', 'state.md');
  assert.strictEqual(fs.existsSync(projectionPath), true);
  const projectionBefore = fs.readFileSync(projectionPath, 'utf8');
  fs.rmSync(projectionPath);
  writeStateProjection(dataDir, buildRunStatus(store, 'relay-run-v22'));
  assert.strictEqual(fs.readFileSync(projectionPath, 'utf8'), projectionBefore);

  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('scenarios: V21 - a CLI stop is honoured and never treated as an abnormal restart', async () => {
  const dataDir = tempDir('agent-relay-v21-');
  const dbPath = path.join(dataDir, 'relay.db');
  const db = new RelayDatabase({ dbPath });
  const store = new RunStore(db);
  const adapter = new ScriptedAdapter();
  const controller = new RunController({
    store,
    dataDir,
    adapter,
    adapterName: 'claude',
    notifier: new RecordingNotifier(),
    createCoordinator: claudeCoordinator()
  });

  controller.startRun({
    runId: 'relay-run-v21',
    goal: 'Cancel mid-run',
    workspacePath: dataDir,
    tasks: FOUR_UNITS,
    model: { provider: 'anthropic', model: 'claude-3-7-sonnet' },
    initialUserMessage: 'Go.'
  });
  await controller.tick();

  // The user cancels through the entrance, not through the controller API
  const stop = capture();
  assert.strictEqual(await runCli(['stop', '--data-dir', dataDir], { io: stop.io }), 0);
  assert.strictEqual((await controller.tick()).kind, 'stopped');
  assert.strictEqual(store.getRun('relay-run-v21')?.state, 'CANCELLED');

  const sessionCount = adapter.created.length;
  const submitCount = adapter.submitted.length;
  db.close();

  // A restart must read the persisted cancel intent and stay put
  const restartedDb = new RelayDatabase({ dbPath });
  const restartedStore = new RunStore(restartedDb);
  const restartedAdapter = new ScriptedAdapter();
  const restarted = new RunController({
    store: restartedStore,
    dataDir,
    adapter: restartedAdapter,
    adapterName: 'claude',
    notifier: new RecordingNotifier(),
    createCoordinator: claudeCoordinator()
  });
  restarted.rehydrate('relay-run-v21');

  const resumeAttempt = capture();
  const exitCode = await runCli(['resume', '--data-dir', dataDir], { io: resumeAttempt.io });
  assert.strictEqual(exitCode, 3, 'a cancelled run must reject resume after restart');

  const outcome = await restarted.tick();
  assert.strictEqual(outcome.kind, 'stopped');
  assert.strictEqual(restartedAdapter.created.length, 0);
  assert.strictEqual(restartedAdapter.submitted.length, 0);

  // No new intent may be introduced by the restart itself
  assert.strictEqual(restartedStore.listPendingIntents('relay-run-v21').length, 0);
  assert.strictEqual(adapter.created.length, sessionCount);
  assert.strictEqual(adapter.submitted.length, submitCount);

  restartedDb.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('scenarios: V13 - duplicate handoffs are deduplicated by handoffId', async () => {
  const dataDir = tempDir('agent-relay-v13-');
  const db = new RelayDatabase({ dbPath: path.join(dataDir, 'relay.db') });
  const store = new RunStore(db);
  const controller = new RunController({
    store,
    dataDir,
    adapter: new ScriptedAdapter(),
    adapterName: 'claude',
    notifier: new RecordingNotifier(),
    createCoordinator: claudeCoordinator()
  });

  controller.startRun({
    runId: 'relay-run-v13',
    goal: 'Deduplicate handoffs',
    workspacePath: dataDir,
    tasks: FOUR_UNITS,
    model: { provider: 'anthropic', model: 'claude-3-7-sonnet' },
    initialUserMessage: 'Go.'
  });
  await controller.tick();

  // Replaying the same handoff id must be refused at the storage layer
  const insert = () =>
    store.insertHandoff({
      handoffId: 'h-relay-run-v13-1',
      runId: 'relay-run-v13',
      epoch: 1,
      sourceSessionId: 'relay-run-v13-s1',
      state: 'REQUESTED'
    });
  assert.strictEqual(insert(), true);
  assert.strictEqual(insert(), false, 'a replayed handoff must not create a second record');

  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('scenarios: V34 - case and link variants of one directory share a single run', async () => {
  const dataDir = tempDir('agent-relay-v34-');
  const workspaceDir = path.join(dataDir, 'workspace');
  fs.mkdirSync(workspaceDir);
  const linkParent = path.join(dataDir, 'links');
  fs.mkdirSync(linkParent);
  const linked = path.join(linkParent, 'linked-workspace');

  try {
    fs.symlinkSync(workspaceDir, linked, 'junction');
  } catch {
    fs.symlinkSync(workspaceDir, linked, 'dir');
  }

  const db = new RelayDatabase({ dbPath: path.join(dataDir, 'relay.db') });
  const store = new RunStore(db);
  const controller = new RunController({
    store,
    dataDir,
    adapter: new ScriptedAdapter(),
    adapterName: 'claude',
    notifier: new RecordingNotifier(),
    createCoordinator: claudeCoordinator()
  });

  assert.strictEqual(normalizeWorkspaceKey(workspaceDir), normalizeWorkspaceKey(linked));

  const base: StartRunConfig = {
    runId: 'relay-run-v34-a',
    goal: 'Single owner per physical workspace',
    workspacePath: workspaceDir,
    tasks: FOUR_UNITS,
    model: { provider: 'anthropic', model: 'claude-3-7-sonnet' },
    initialUserMessage: 'Go.'
  };
  const first = controller.startRun(base);
  const second = controller.startRun({ ...base, runId: 'relay-run-v34-b', workspacePath: linked });

  assert.strictEqual(second.runId, first.runId, 'both paths must resolve to the same controlled run');
  assert.strictEqual(store.listRuns().length, 1);

  // An independent worktree never collides
  const sibling = path.join(dataDir, 'sibling-worktree');
  fs.mkdirSync(sibling);
  assert.notStrictEqual(normalizeWorkspaceKey(sibling), normalizeWorkspaceKey(workspaceDir));
  const third = controller.startRun({ ...base, runId: 'relay-run-v34-c', workspacePath: sibling });
  assert.strictEqual(third.runId, 'relay-run-v34-c');
  assert.strictEqual(store.listRuns().length, 2);

  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('scenarios: V31 - two independent workspaces relay in isolation', async () => {
  const dataDir = tempDir('agent-relay-v31-');
  const workspaceA = path.join(dataDir, 'ws-a');
  const workspaceB = path.join(dataDir, 'ws-b');
  fs.mkdirSync(workspaceA);
  fs.mkdirSync(workspaceB);

  const db = new RelayDatabase({ dbPath: path.join(dataDir, 'relay.db') });
  const store = new RunStore(db);
  const adapters = { a: new ScriptedAdapter(), b: new ScriptedAdapter() };
  const makeController = (adapter: ScriptedAdapter) =>
    new RunController({
      store,
      dataDir,
      adapter,
      adapterName: 'claude',
      notifier: new RecordingNotifier(),
      createCoordinator: claudeCoordinator()
    });

  for (const [key, workspacePath, runId] of [
    ['a', workspaceA, 'relay-run-a'],
    ['b', workspaceB, 'relay-run-b']
  ] as const) {
    makeController(adapters[key]).startRun({
      runId,
      goal: `Run ${runId}`,
      workspacePath,
      tasks: FOUR_UNITS,
      model: { provider: 'anthropic', model: 'claude-3-7-sonnet' },
      initialUserMessage: 'Go.'
    });
  }

  // Interleave the two runs; neither may disturb the other
  const controllerA = makeController(adapters.a);
  const controllerB = makeController(adapters.b);
  controllerA.rehydrate('relay-run-a');
  controllerB.rehydrate('relay-run-b');

  await controllerA.tick();
  await controllerB.tick();
  await controllerA.tick();
  await controllerB.tick();

  assert.strictEqual(store.getRun('relay-run-a')?.handoffCount, 1);
  assert.strictEqual(store.getRun('relay-run-b')?.handoffCount, 1);
  assert.strictEqual(store.getLeaseRow(normalizeWorkspaceKey(workspaceA))?.currentOwner, 'relay-run-a-s2');
  assert.strictEqual(store.getLeaseRow(normalizeWorkspaceKey(workspaceB))?.currentOwner, 'relay-run-b-s2');
  assert.strictEqual(store.listChain('relay-run-a').length, 2);
  assert.strictEqual(store.listChain('relay-run-b').length, 2);

  const outcomes = await controllerA.executeUntilSettled();
  assert.strictEqual(outcomes[outcomes.length - 1].kind, 'completed');
  assert.strictEqual(store.getRun('relay-run-b')?.state, 'RUNNING', 'run B must be untouched by run A finishing');

  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('scenarios: real DSH adapter - one handoff across two dedicated worker processes', async () => {
  const dataDir = tempDir('agent-relay-dsh-');
  const workspaceDir = path.join(dataDir, 'workspace');
  fs.mkdirSync(workspaceDir);

  const db = new RelayDatabase({ dbPath: path.join(dataDir, 'relay.db') });
  const store = new RunStore(db);
  const adapter = new DshAdapter({
    runnerOptions: {
      binPath: process.execPath,
      extraArgsPrefix: [MOCK_DSH_SERVER],
      startupGracePeriodMs: 50
    }
  });
  const notifier = new RecordingNotifier();

  const controller = new RunController({
    store,
    dataDir,
    adapter,
    adapterName: 'dsh',
    notifier,
    createCoordinator: (deps) =>
      new DshHandshakeCoordinator({
        adapter: adapter,
        leaseManager: deps.leaseManager as unknown as WorkspaceLeaseManager,
        stateMachine: deps.stateMachine,
        workspaceKey: deps.workspaceKey
      })
  });

  try {
    controller.startRun({
      runId: 'relay-run-dsh',
      goal: 'Two units over real DSH worker processes',
      workspacePath: workspaceDir,
      tasks: FOUR_UNITS.slice(0, 2),
      model: { provider: 'deepseek-official', model: 'deepseek-chat', effort: 'high' },
      initialUserMessage: 'Run two units. Do not change the public API.'
    });

    const outcomes = await controller.executeUntilSettled();
    assert.deepStrictEqual(
      outcomes.map((o) => o.kind),
      ['unit_executed', 'handoff_performed', 'unit_executed', 'completed']
    );

    const chain = store.listChain('relay-run-dsh');
    assert.strictEqual(chain.length, 2);
    assert.strictEqual(chain[0].adapter, 'dsh');
    assert.strictEqual(chain[1].model, 'deepseek-chat');
    assert.strictEqual(chain[1].effort, 'high');

    // The first worker process is gone; the second one is the only live owner
    assert.strictEqual(adapter.inspectSession('relay-run-dsh-s1')?.active, false);
    assert.strictEqual(adapter.inspectSession('relay-run-dsh-s2')?.active, true);

    const run = store.getRun('relay-run-dsh')!;
    assert.strictEqual(store.getLeaseRow(run.workspaceKey), undefined, 'the finished run releases the lease');
    assert.deepStrictEqual(
      (JSON.parse(store.getLatestTaskSnapshot('relay-run-dsh')!.snapshotJson) as Array<{ status: string }>).map(
        (t) => t.status
      ),
      ['completed', 'completed']
    );
    assert.deepStrictEqual(notifier.notifications.map((n) => n.type), ['run_completed']);
  } finally {
    await adapter.shutdown();
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: Run the scenario test**

Run: `node --experimental-strip-types --test tests/scenarios/relay-run.test.ts`
Expected: PASS (7 tests pass)

- [ ] **Step 4: Run the full workspace regression**

Run: `npm test`
Expected: PASS, 0 failures, clean exit code 0

- [ ] **Step 5: Confirm the acceptance checklist**

Verify each item explicitly and record the evidence in the commit message:

- 四单元/三次交接自动完成，人工续跑次数为 0 → S01 断言了 4 个 `unit_executed`、3 个 `handoff_performed`、`completed`
- 连续三次交接没有确认弹窗 → S01 断言 `notifier.notifications` 仅含 `run_completed`
- 取消不会被 crash restart 当成异常重启 → V21 断言重启后 `stopped`、零新会话、零新提交
- 关闭查看窗口后能恢复查看 → V22 断言重开 CLI 读到更新的进度，且 `state.md` 可重建
- 状态入口展示目标/任务/交接原因/旧新会话/模型/阻塞状态 → S01 与 `tests/run/status.test.ts` 断言
- 下一节点暂停不创建下一 worker → `tests/run/engine.test.ts` 的 V20 用例
- 意图先持久化再派发 → `tests/run/cli.test.ts` 断言打印确认时意图已在库中
- 真实子进程交接 → DSH 用例断言两个独占 worker 会话与进程回收

- [ ] **Step 6: Commit**

```bash
git add tests/scenarios/relay-run.test.ts tests/fixtures/mock-dsh-sdk-server.mjs
git commit -m "test(scenarios): add end-to-end run control acceptance suite (S01, V13, V21, V22, V31, V34)"
```

---

## 完成后的收尾

全部任务完成后，使用 `superpowers:finishing-a-development-branch` 技能完成分支集成：

1. 在**当前要合并的树**上重跑 `npm test`（不接受本会话早期的绿色结果）
2. 确认工作区干净（`git status`）
3. 向用户呈现集成选项（本地合并 / 推送并创建 PR / 保持分支）
4. 按用户选择执行，不得自行决定合并

**强制要求**：分支集成必须等用户在菜单中明确选择之后才执行——合并到共享分支属于必须询问的操作。
