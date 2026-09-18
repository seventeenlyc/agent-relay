# Agent Relay P2-04 设计：运行编排核心 · 会话链 · 状态与控制入口

版本：v1.0；2026-09-18。状态：已与用户逐节确认。

**Spec（上游权威）**：`agent-relay-design/01-需求与用户原话.md` ~ `05-验收与接手说明.md`、`docs/decisions/architecture.md`。
本文是该上游 spec 在 P2-04 范围内的细化，不与其冲突；冲突时以上游为准。

---

## 1. 背景与问题陈述

P0（探针）、P1（微内核原语）、P2-01/02/03（三端适配器）均已交付并合并。但存在一个关键缺口：

**没有任何可运行的编排循环。** P1 交付的是 `InputLedger`、`TaskGraph`、`ScopeGuard`、`TriggerPolicy`、`GlobalBudget`、`LoopDetector`、`WorkspaceSentinel`、`HandoffPackager`、`HandoffStateMachine`、`WorkspaceLeaseManager`、`OutboxQueue` 这批**原语**，全部是内存对象；三轮接力的完整流程目前只在 `tests/scenarios/*.test.ts` 中内联手写。`docs/decisions/architecture.md` §4 已把 `packages/controller/src/engine.ts`（控制器编排核心）规划在内，但尚未实现。

同时，P2-04 的三条验收都无法在没有运行实体的情况下达成：

| 验收要求（`04-开发任务清单.md` P2-04） | 依赖 |
|---|---|
| 连续三次交接没有确认弹窗 | 存在真实运行中的 run |
| 用户取消不会被 crash restart 当成异常重启 | 控制意图跨进程重启存活 |
| 关闭查看窗口后能恢复查看 | 状态持久化 + 可重开投影 |

**P2-04 的目标**：补齐运行编排核心，并交付用户可见、可控的入口，使「一次启用 → 四单元 → 三次自动交接」真正跑通，且用户随时能看进度、随时暂停/停止/继续，意图跨进程重启依然有效。

---

## 2. 已定决策（用户确认）

| 决策 | 选择 | 理由 |
|---|---|---|
| 范围 | **含编排核心** `RunController` | 否则状态入口只能展示测试夹具伪造的数据，三条验收无法真正达成 |
| 入口形态 | **CLI 子命令 + 持久控制意图** | 运行循环由 supervisor 进程持有；CLI 只追加意图行。关窗只是结束查看进程，V21/V22 天然成立；零新依赖，P3-03 可直接包装 |
| 持久化引擎 | **`node:sqlite` 权威库 + 文件不可变材料 + Markdown 可重建投影** | `03-技术设计.md` §3 明确规定；§7 明确「数据库不得指向半写文件」 |

本机已实测（Node v24.14.0，2026-09-18）：

- 直接运行 `.ts` 无需 `--experimental-strip-types`；`.mjs` 可 `import` `.ts`
- `node:sqlite` 免 flag 可用（有 ExperimentalWarning，可用 `--no-warnings` 抑制）
- `PRAGMA journal_mode=WAL` 下跨进程读写**实时可见**（writer/reader 双进程探针通过）
- `node --test` 下 `node:sqlite` 正常工作

---

## 3. 架构

### 3.1 三进程拓扑

```
┌───────────────┐   ① 追加控制意图    ┌──────────────────────────┐
│  CLI 入口      │ ─────────────────► │  权威库 relay.db (WAL)    │
│ agent-relay   │ ◄───────────────── │  runs/intents/chain/...   │
└───────────────┘   ② 读取状态投影    └──────────────────────────┘
                                        ▲ 读意图          ▲ 读投影
                                        │ 写事件/状态      │
                              ┌─────────┴────────┐  ┌────┴──────────┐
                              │  RunController   │  │ StatusProjector│
                              │  (supervisor)    │  │  → state.md    │
                              └────────┬─────────┘  └───────────────┘
                                       │ AgentRelayAdapter SPI
                        ┌──────────────┼──────────────┐
                     Codex          Claude           DSH
```

### 3.2 核心不变量：意图先落库

**CLI 从不直接驱动会话，只向 `control_intents` 追加一行；`RunController` 在每个节点边界读取意图水位并执行。**

这直接实现 `03-技术设计.md` §2「将意图先持久化再派发」，并让以下场景天然成立：

- **V22**（用户只关闭查看终端/页面）：关掉 CLI 只是结束一个查看进程，supervisor 继续按约定运行，重开 CLI 即可定位当前进度。
- **V21**（用户立即停止或关闭控制器后重启）：停止意图已在库中，重启后 `RunController` 先读意图再决定是否续跑，不会当作异常自动重启执行。

### 3.3 写路径规则

**任何状态变更一律先落库、再更新内存对象；读路径使用内存对象。** 进程重启时，内存对象（`InputLedger` / `TaskGraph` / `HandoffStateMachine` / `DurableLeaseManager`）从库**重建**。

P1 模块的对外行为**完全不变**——引擎包裹它们，不侵入改写。P1 模块保持纯内存、可独立测试。

### 3.4 数据目录

`resolveDataDir()` 解析顺序：

1. CLI `--data-dir <path>` 参数
2. 环境变量 `AGENT_RELAY_DATA_DIR`
3. Windows：`%LOCALAPPDATA%\agent-relay`；其他平台：`$XDG_STATE_HOME/agent-relay` 或 `~/.local/state/agent-relay`

默认落在用户级目录而非项目内，满足 `03-技术设计.md` §3「控制器状态应在 agent 的项目编辑权限之外」。

### 3.5 磁盘布局

```
<dataDir>/
  relay.db                          # 单库：所有 run + 全局工作区注册表
  <run-id>/
    handoffs/<handoff-id>/
      manifest.json                 # 不可变材料（临时文件 → rename → 校验哈希）
    state.md                        # 从权威状态重建的用户视图
```

**单一数据库**（而非每 run 一库）的原因：`lease_state` 工作区注册表必须跨 run 全局共享，且单库让「快照文件 + 事务内发布引用」处于同一事务边界内（V16）。

---

## 4. 数据模型（`relay.db`）

### 4.1 表定义

```sql
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 3000;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);  -- 记录 schema_version，用于 P3-03 迁移

CREATE TABLE IF NOT EXISTS runs (
  run_id                     TEXT PRIMARY KEY,
  workspace_key              TEXT NOT NULL,
  workspace_path             TEXT NOT NULL,
  goal                       TEXT NOT NULL,
  provider                   TEXT NOT NULL DEFAULT 'unknown',
  model                      TEXT NOT NULL DEFAULT 'unknown',
  effort                     TEXT,
  state                      TEXT NOT NULL,
  current_session_id         TEXT,
  current_epoch              INTEGER NOT NULL DEFAULT 1,
  handoff_count              INTEGER NOT NULL DEFAULT 0,
  unit_count                 INTEGER NOT NULL,
  -- 当前会话已执行的单元数；新会话接任时归零。用于判定是否该发起下一次交接
  current_session_unit_count INTEGER NOT NULL DEFAULT 0,
  -- 执行权授权时的水位快照（§7 步骤 7 与「令牌消费之后」核对基准）
  authorized_input_hash      TEXT,
  authorized_contract_version INTEGER,
  authorized_intent_watermark INTEGER,
  pause_reason               TEXT,
  blocked_reason             TEXT,
  created_at                 INTEGER NOT NULL,
  updated_at                 INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_active_workspace
  ON runs(workspace_key) WHERE state NOT IN ('CANCELLED','COMPLETED','DISABLED');

CREATE TABLE IF NOT EXISTS control_intents (
  intent_id   TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL,
  kind        TEXT NOT NULL,          -- pause_next_node | stop_now | resume | disable
  payload     TEXT NOT NULL DEFAULT '{}',
  watermark   INTEGER NOT NULL,       -- run 内单调递增
  created_at  INTEGER NOT NULL,
  consumed_at INTEGER,
  UNIQUE(run_id, watermark)
);

CREATE TABLE IF NOT EXISTS session_chain (
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
  superseded_at   INTEGER          -- 该会话被后继会话接替的时刻；NULL 表示当前
);
CREATE INDEX IF NOT EXISTS idx_chain_run ON session_chain(run_id, sequence);

CREATE TABLE IF NOT EXISTS handoffs (
  handoff_id         TEXT PRIMARY KEY,   -- 去重键（V13）
  run_id             TEXT NOT NULL,
  epoch              INTEGER NOT NULL,
  source_session_id  TEXT NOT NULL,
  target_session_id  TEXT,
  state              TEXT NOT NULL,
  manifest_path      TEXT,
  manifest_hash      TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS run_events (
  event_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      TEXT NOT NULL,
  type        TEXT NOT NULL,
  severity    TEXT NOT NULL,          -- record | notify
  session_id  TEXT,
  payload     TEXT NOT NULL DEFAULT '{}',
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_run ON run_events(run_id, event_id);

CREATE TABLE IF NOT EXISTS lease_state (
  workspace_key TEXT PRIMARY KEY,
  current_owner TEXT NOT NULL,
  epoch         INTEGER NOT NULL,
  acquired_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS input_ledger (
  run_id        TEXT NOT NULL,
  seq           INTEGER NOT NULL,
  input_id      TEXT NOT NULL,
  source        TEXT NOT NULL,        -- human | generated_handoff | system_injection
  raw_content   TEXT NOT NULL,
  sha256_hash   TEXT NOT NULL,
  supersedes_id TEXT,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (run_id, seq)
);

CREATE TABLE IF NOT EXISTS task_snapshots (
  run_id        TEXT NOT NULL,
  seq           INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (run_id, seq)
);

CREATE TABLE IF NOT EXISTS ledger_events (
  run_id              TEXT NOT NULL,
  seq                 INTEGER NOT NULL,
  event_id            TEXT NOT NULL,
  type                TEXT NOT NULL,
  session_id          TEXT,
  timestamp           INTEGER NOT NULL,
  payload             TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (run_id, seq)
);  -- AgentRelayEvent 追加式持久化
```

### 4.2 关键约束

- `idx_runs_active_workspace`：**同一工作区同时最多一个活动 run**（V34「重复启用同一工作区返回既有 run」）。终态 run 不占用该唯一索引。
- `handoffs.handoff_id` 为主键：同一 handoff 的重试与重复回调自然去重（V13）。
- `control_intents(run_id, watermark)` 唯一：水位在事务内取 `MAX(watermark)+1`，并发追加不会重号。
- `lease_state` 是**全局表**，其余表按 `run_id` 分区。
- 所有时间戳为 `Date.now()` 毫秒整数。

---

## 5. 控制意图与水位

### 5.1 意图种类

```ts
export type ControlIntentKind = 'pause_next_node' | 'stop_now' | 'resume' | 'disable';
```

| 种类 | 语义 | 对应场景 |
|---|---|---|
| `pause_next_node` | 完成当前可恢复单元并保存检查点，**不创建下一 worker**；立即停止优先级高于它 | V20 |
| `stop_now` | 中断所属动作；确认静止后才标 `CANCELLED`，无法确认则 `RECOVERY_REQUIRED` 但保留取消意图 | V19, V21 |
| `resume` | 从 `PAUSED` 重新核对后恢复（`PAUSED → CHECKPOINTED`） | V22 |
| `disable` | 禁用自动交接，run 进入终态 `DISABLED`，不再自动创建后继会话 | §2 |

### 5.2 优先级

**`stop_now` > `pause_next_node`**；`resume` 与 `disable` 为归属操作，不与前两者竞争。

`RunController` 在每个节点边界按 `watermark` 升序读取未消费意图，取其中优先级最高者执行，并把 `consumed_at` 标记为已消费。

### 5.3 水位与执行权核对

- 水位在追加事务内计算：`watermark = COALESCE(MAX(watermark), 0) + 1`（run 内单调递增，永不复用）。
- 执行权授权时把当时水位写入 `runs.authorized_intent_watermark`（审计与状态卡用途）。
- **执行权门禁以「未消费意图」为准，而非「最大水位」**：水位单调递增且永不复用，因此用一个固定的授权水位去比较会在此后永久为真。正确判据是——

  ```
  pendingIntents(runId) = 所有 consumed_at IS NULL 的意图
  可执行 ⇔ pendingIntents 为空
  ```

  任何未消费的控制意图都会使执行令牌失效，直到该意图被处理（§6.2 的第 3～6 步会消费它们）。

- **原子性要求**：第 7 步的租约 CAS 必须在**一个事务内**先读取 `pendingIntents`，非空则**不执行 CAS**（新会话保持只读，旧 owner 仍持有租约，即「重新整理或暂停」语义）。这样「CAS 之后、令牌消费之前」的控制意图窗口在事务层面不存在。
- 事务提交后、调用 `authorizeExecution` **之前**再核对一次 `pendingIntents`（因为交接过程包含 `await`，意图可能在等待期间到达）；若非空则跳过授权、中断新会话、进入 `PAUSED`。
- 同一核对同时覆盖 `authorized_input_hash`（原话水位）与 `authorized_contract_version`（契约版本修订使旧包与 ACK 失效）。

---

## 6. `RunController` 编排核心

### 6.1 对外 API

```ts
export interface StartRunConfig {
  runId: string;
  goal: string;
  workspacePath: string;              // 物理路径；引擎内部规范化为 workspaceKey
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
  initialUserMessage: string;         // 原始人类输入，写入不可变账本
  scopePaths?: string[];
  forbiddenItems?: string[];
  acceptanceCriteria?: string[];
  maxActiveDurationMs?: number;
}

export interface RunRecord {
  runId: string;
  workspaceKey: string;
  workspacePath: string;
  goal: string;
  state: RunState;
  currentSessionId?: string;
  currentEpoch: number;
  handoffCount: number;
  unitCount: number;
  pauseReason?: string;
  blockedReason?: string;
  createdAt: number;
  updatedAt: number;
}

export type RunState =
  | 'INITIALIZING' | 'RUNNING' | 'DRAINING' | 'CHECKPOINTED' | 'STARTING'
  | 'PREPARING' | 'READY' | 'PAUSED' | 'CANCELLED' | 'DISABLED'
  | 'COMPLETED' | 'RECOVERY_REQUIRED' | 'BLOCKED';

export interface RunControllerOptions {
  store: RunStore;
  adapter: AgentRelayAdapter;
  adapterName: 'codex' | 'claude' | 'dsh';
  createCoordinator: (deps: CoordinatorDeps) => HandshakeCoordinator;
  notifier?: Notifier;
  clock?: () => number;
  maxActiveDurationMs?: number;
}

export interface CoordinatorDeps {
  adapter: AgentRelayAdapter;
  leaseManager: WorkspaceLeaseManager;   // 实为 DurableLeaseManager
  stateMachine: HandoffStateMachine;
  workspaceKey: string;
  runId: string;
}

export type RunTickOutcome =
  | { kind: 'unit_executed'; taskId: string; status: 'completed' | 'partial' | 'failed' }
  | { kind: 'handoff_performed'; handoffId: string; fromSessionId: string; toSessionId: string; epoch: number }
  | { kind: 'paused'; intentId?: string; reason?: string }
  | { kind: 'stopped'; intentId?: string }
  | { kind: 'disabled'; intentId?: string }
  | { kind: 'completed' }
  | { kind: 'blocked'; reason: string }
  | { kind: 'recovery_required'; reason: string };

export class RunController {
  constructor(options: RunControllerOptions);
  public rehydrate(): void;
  public startRun(config: StartRunConfig): RunRecord;
  public tick(): Promise<RunTickOutcome>;
  public executeUntilSettled(maxTicks?: number): Promise<RunTickOutcome[]>;
  public getCurrentSessionId(): string | undefined;
}
```

三个粒度保证可确定性测试：`startRun` 建 run；`tick()` 推进一个节点；`executeUntilSettled()` 循环至终态或阻塞。

### 6.2 单个 tick 的判定顺序

意图优先级：**`stop_now` > `disable` > `pause_next_node` > `resume`**（同级取最小水位，保证确定性与可重放）。

```
1. run = require(runId)
2. if state ∈ {COMPLETED, CANCELLED, DISABLED} → 直接返回对应终态 outcome，不做任何工作
3. pending = intentLog.resolve(runId)           # 未消费意图中优先级最高者
   - stop_now        → consume；中断当前会话并 awaitQuiescence
                       静止确认 → CANCELLED / 无法确认 → RECOVERY_REQUIRED（保留取消意图）
   - disable         → consume；DISABLED
   - pause_next_node → consume；PAUSED（完成当前单元后整理，绝不创建下一 worker）
   - resume          → consume；stateMachine.resume()（PAUSED→CHECKPOINTED）后回到 RUNNING 继续
4. ensureSession()   # 无存活当前会话时创建首个 worker（只读？否——首会话无前驱，直接获授权），
                     # 追加 session_chain 链接（prevSessionId=null，reason='run_started'）并抢占初始租约
5. task = graph.getNextActionableTask()
   if (!task) → COMPLETED + notify → { kind: 'completed' }
6. 触发判定：
   needHandoff = (runs.current_session_unit_count > 0)          # 当前会话已产出过单元
                 && 存在下一可执行单元
                 && triggerPolicy.evaluate(ctx).shouldHandoff    # 单元完成 / 时长上限
   - 否 → 原地执行该单元 → { kind: 'unit_executed' }
   - 是 → performHandoff(task) → { kind: 'handoff_performed' }
```

第 6 步的 `runs.current_session_unit_count` 是**持久化**的（§4.1），因此重启后「该不该发起交接」的判定不依赖内存状态。`resume` 后若当前会话仍然存活，则直接继续使用它，不创建多余会话。

### 6.3 交接八步（落实 `03-技术设计.md` §7）

| 步 | 动作 | 落库/落盘 |
|---|---|---|
| 1 | 记 `handoff_requested`，分配稳定 `handoffId` | `handoffs` 表 INSERT（主键去重 → V13）；`run_events` |
| 2 | 旧 worker 收尾：`requestDrain` + `awaitQuiescence`；超时则记部分检查点 | 状态 `RUNNING → DRAINING → CHECKPOINTED` |
| 3 | 固化快照：原话水位、契约版本、任务快照哈希、模型配置、工作区指纹 | 文件先完整写（临时文件 → fsync → rename → 校验哈希），**再在事务内**发布 `handoffs.manifest_path`（V16） |
| 4 | 创建意图写 durable outbox，去重后 `createFresh`（`readOnly: true`） | `STARTING`；`outbox` + `run_events` |
| 5 | 记录返回 sessionId | `session_chain` 追加链接；`runs.current_session_id` |
| 6 | 解析 ACK，3D 哈希 + 模型核对 | `PREPARING`；失败 → `RECOVERY_REQUIRED`（V10/V12） |
| 7 | 事务内 CAS：核对 `workspace_key`、旧 owner+epoch、输入哈希、契约版本、**意图水位**、pause/cancel 状态 → 更新 owner/epoch → 发放 `EXECUTION_TOKEN` | `lease_state` + `runs.*` 同一事务 |
| 8 | `authorizeExecution`；新会话进入执行；旧会话保留可查 | `READY → RUNNING`；`session_chain` 标记 superseded |

**关键**：第 7 步的 CAS 与 `runs` 状态更新必须在**同一 SQLite 事务**内，杜绝「租约转了但状态没转」的半提交。

### 6.4 单元执行协议

引擎向会话提交单元提示词，要求以标记块回传结果（与各适配器 handshake 的 ACK 标记风格一致）：

```
UNIT_RESULT_START
{"taskId":"unit-1","status":"completed","evidenceHash":"...","summary":"..."}
UNIT_RESULT_END
```

```ts
export type UnitResultStatus = 'completed' | 'partial' | 'failed';
export interface UnitResult {
  taskId: string;
  status: UnitResultStatus;
  evidenceHash?: string;
  summary?: string;
}
export function buildUnitPrompt(task: TaskItem, contract: RequirementContract, runId: string): string;
export function parseUnitResult(output: string): UnitResult | null;
```

完成规则（`03-技术设计.md` §6 安全节点）：

- `completed` **且携带 `evidenceHash`** → `graph.completeTaskWithEvidence()`；缺证据则降级为 `partial`。
- `partial` / `failed` → 任务保持 `in_progress`，记录失败证据与下一个诊断步骤；下一次交接包携带失败证据（V07）。
- 连续 3 次同质失败 → `LoopDetector` 触发 → `BLOCKED`（V23）。

### 6.5 触发上下文与「指标未知」

```ts
const ctx: TriggerContext = {
  unitCompleted, hasMoreUnits,
  compactionCount: 0,          // P2-04 未接入原生压缩事件，显式为 0
  activeDurationMs,
  maxActiveDurationMs
};
```

`03-技术设计.md` §5 明确：「压缩事件不可用时依赖任务边界与活跃时间，**明确显示指标未知**，不能让模型猜」。因此状态卡在未接入压缩事件时显示 `压缩: 未知`，而不是伪造 `0 次`（V09）。

原生事件标准化（`subscribe` / compaction 映射）**不在 P2-04 范围**，见 §11。

---

## 7. 会话链与工作区注册表

### 7.1 `SessionChainLedger`

在 `session_chain` 表上维护旧→新会话链接。每次交接追加一条 `sequence` 递增的链接行，记录前后 session id、适配器、provider/model/effort、epoch、handoff id 与原因。

`agent-relay chain` 渲染为：

```
#  旧会话          新会话          模型                           epoch  原因
1  worker-A        worker-B        deepseek-official/chat         2     unit_completed
2  worker-B        worker-C        deepseek-official/reasoner     3     unit_completed
```

旧会话**保留可查，不自动删除**（§7 步骤 8）。被后继会话接替时写入 `superseded_at`（「封存为 superseded」），链上因此能区分当前会话与历史会话，而不删除任何历史。

### 7.2 工作区 key 规范化（V34）

```ts
export function normalizeWorkspaceKey(workspacePath: string): string;
```

规则：

1. `fs.realpathSync.native()` 解析符号链接与 Windows junction
2. Windows 上大小写折叠（`toLowerCase()`）并按 `\` 统一分隔符
3. 结果绝对路径字符串即为 `workspace_key`

**独立 worktree 有各自不同的 realpath，因此天然不误冲突**；同一物理目录的不同大小写/链接写法解析为同一 key，只保留一个受控写入 owner。

### 7.3 重复启用

`startRun()` 先查 `runs` 中该 `workspace_key` 的活动 run：命中则**返回既有 run 而不新建**（V34「重复启用同一工作区返回既有 run，不能新开另一个独立锁」）。

### 7.4 `DurableLeaseManager`

现有三个适配器的 handshake coordinator 都依赖 `WorkspaceLeaseManager`（内存）。为让单写入者不变量跨进程与重启成立，新增：

```ts
export class DurableLeaseManager {
  constructor(store: RunStore);
  public acquireInitialLease(workspaceKey: string, owner: string, epoch?: number): boolean;
  public compareAndSetOwner(workspaceKey: string, expectedOwner: string, newOwner: string, expectedEpoch: number, newEpoch: number): boolean;
  public getLease(workspaceKey: string): WorkspaceLease | undefined;
  public releaseLease(workspaceKey: string, owner: string): boolean;
}
```

方法签名与内存版**逐一对齐**，语义一致（CAS 拒绝 owner 不符、epoch 不符、`newEpoch <= expectedEpoch`），底层落在 `lease_state` 表。引擎把它注入 coordinator，从而「内存租约」与「持久租约」不再可能分叉。

---

## 8. 状态投影与通知

### 8.1 状态卡（`03-技术设计.md` §12）

```
目标: 完成深度学习流水线三单元实现
进度: 2/4 单元完成（当前: Unit 3 — Transformer Encoder）
验证: Unit 2 已通过 · 证据 hash-evidence-dsh-2
交接: h-2 · worker-B → worker-C · epoch 3
模型: deepseek-official / deepseek-reasoner (effort: high)
压缩: 未知
控制: 无暂停 · 下一动作: 执行 Unit 3
```

硬性要求：

- **不展示虚假的百分比**；任务总数变化必须有原因记录。
- 未接入的指标显示 `未知`，不填 0 冒充实测值。
- 暂停时显示暂停原因；阻塞时显示阻塞原因。

### 8.2 结构化输出与投影

```ts
export interface RunStatusView { /* 目标、进度、验证、交接、模型、控制、下一动作等结构化字段 */ }
export function buildRunStatus(store: RunStore, runId: string): RunStatusView;
export function renderStatusCard(view: RunStatusView): string;
export function renderStatusJson(view: RunStatusView): string;
```

`renderStatusCard(view)` 写入 `<dataDir>/<run-id>/state.md`，作为**可重建投影**——任何时候都能从权威库重新生成，不是第二份真相。

### 8.3 事件与通知

`run_events` 的 `severity` 分两级：

- `record`：正常交接等，**静默记录**（用户无需被打断）
- `notify`：完成、失败、需要用户动作 → 通过 `Notifier` 发出

```ts
export interface RunNotification { runId: string; type: string; severity: 'record' | 'notify'; message: string; payload: Record<string, unknown>; }
export interface Notifier { notify(notification: RunNotification): void; }
export class ConsoleNotifier implements Notifier { /* 默认实现 */ }
export class RecordingNotifier implements Notifier { /* 测试用，可断言 */ }
```

P3-03 可注入 Windows toast 实现，无需改动引擎。

---

## 9. 入口：CLI

```
agent-relay status  [--run <id>] [--data-dir <path>] [--json]
agent-relay chain   [--run <id>] [--data-dir <path>] [--json]
agent-relay pause   [--run <id>] [--data-dir <path>]   # 下一安全节点暂停
agent-relay stop    [--run <id>] [--data-dir <path>]   # 立即停止
agent-relay resume  [--run <id>] [--data-dir <path>]
agent-relay disable [--run <id>] [--data-dir <path>]   # 禁用自动交接
agent-relay watch   [--run <id>] [--data-dir <path>] [--interval <ms>]
```

### 9.1 布局

- `packages/cli/src/cli.ts`：`runCli(argv: string[], deps?: CliDeps): Promise<number>`，返回退出码。参数解析手写（零第三方依赖）。
- `packages/cli/src/render.ts`：状态卡 / 会话链 / 事件的人类可读与 JSON 渲染。
- `bin/agent-relay.mjs`：薄 shim，`import` 上述 `.ts` 并调用 `runCli(process.argv.slice(2))`。

### 9.2 run 解析

`--run` 未给出时：库中活动 run 唯一则取之；多个则报错要求 `--run`；无 run 则退出码 `2`。

### 9.3 退出码

| 码 | 含义 |
|---|---|
| 0 | 成功 |
| 1 | 用法错误（未知子命令/参数） |
| 2 | run 不存在或无法解析 |
| 3 | 当前状态不允许该动作（如对 `COMPLETED` 的 run 执行 `pause`） |

### 9.4 行为约束

- **控制动作必须先落库再打印确认**。CLI 输出确认时，意图已持久化。
- `watch` 以 `--interval`（默认 2000ms）轮询读取投影并刷新；它**不驱动** run，随时 Ctrl-C 退出不影响 run。
- 不读凭据、不联网。

---

## 10. 测试计划

| 文件 | 覆盖 |
|---|---|
| `tests/run/store.test.ts` | schema 幂等迁移、WAL 跨进程可见性、事务回滚、约束（handoff 主键去重、水位唯一、活动 run 唯一索引） |
| `tests/run/intent.test.ts` | 水位单调递增、并发追加不重号、优先级 `stop_now > pause_next_node`、消费标记、重放不重复执行 |
| `tests/run/chain.test.ts` | 链序号连续、字段完整、旧会话保留、superseded 标记 |
| `tests/run/status.test.ts` | 状态卡字段齐全、未接入指标显示「未知」、无虚假百分比、`state.md` 可从库重建 |
| `tests/run/engine.test.ts` | 单 tick 各分支（执行/交接/暂停/停止/禁用/完成/阻塞/需恢复）、水位变化失效执行令牌、连续失败触发 BLOCKED |
| `tests/run/cli.test.ts` | 各子命令输出与退出码、跨进程意图可见性、`watch` 可中断 |
| `tests/scenarios/relay-run.test.ts` | **四单元 / 三次交接完整跑通**；V13 交接去重；V19 水位变化失效旧 ACK；V20 暂停不建后继；V21 取消后重启不自动续跑；V22 关窗重开恢复查看；V33 令牌前后注入取消；V34 路径大小写/链接解析为同一 workspace_key |
| `tests/contracts/handshake-coordinator.test.ts` | 三个 coordinator 均满足统一 `HandshakeCoordinator` 契约 |

另需回归 `adapter-spi.test.ts`（SPI 新增 `getSessionOutput` 后 MockAdapter 同步实现）。

---

## 11. 范围边界

### 在范围内

- SQLite 权威库、迁移、WAL、事务
- 控制意图日志与水位、会话链、交接去重、事件日志、通知
- 工作区 key 规范化与重复启用去重、`DurableLeaseManager`
- `RunController` 编排循环（含 §7 八步交接）
- 单元执行协议（提示词 + 结果解析）
- 统一 `HandshakeCoordinator` 契约 + 三个 coordinator 的对齐（增量别名，不改行为）
- SPI 扩展 `getSessionOutput` + MockAdapter 补齐
- 状态投影（状态卡 / JSON / `state.md`）
- CLI 与 `bin` shim
- 上述测试

### 明确不在范围内（推迟）

| 项 | 归属 |
|---|---|
| 崩溃注入与恢复套件 | P3-01 |
| 原生事件标准化 / `subscribe` / compaction 真实接入 | P3（届时把 `压缩: 未知` 变为实测值） |
| 防漂移与成本对照评测 | P3-02 |
| 安装器、升级迁移、Windows toast、原生入口包装 | P3-03 |
| 多 worker 并行、跨设备、跨模型切换、云端长期记忆 | `03-技术设计.md` §13 明确非必需 |
| 计费 token / 轮次预算的实测接入 | P3-02（需真实用量数据）。P2-04 只接入**活跃时长上限**（`TriggerPolicy` 的 `duration_cap`）与 `maxTicks` 节点上限，并在状态卡中把用量显示为「未知」，不编造精确金额（§12） |

---

## 12. 需要的增量改动（对既有代码）

| 文件 | 改动 | 风险 |
|---|---|---|
| `packages/controller/src/handoff/state-machine.ts` | 新增 `beginStarting()`（`CHECKPOINTED → STARTING`）、`resume()`（`PAUSED → CHECKPOINTED`）、`markRecoveryRequired()`、`resolveRecovery()`；`startNewSession()` 允许从 `STARTING` 进入 | 低：纯新增，现有测试的 `CHECKPOINTED → PREPARING` 路径不变 |
| `packages/controller/src/inputs/ledger.ts` | 新增 `restoreFrom(records: InputRecord[])`：逐条 `validateInputRecord`（含哈希完整性校验）后原样入账，**保留原始 inputId / timestamp / sha256Hash** | 低：纯新增。必需——否则重启后重建的账本会重新生成 ID 与时间戳，导致 `getHeadHash()` 变化，交接包里的 `inputLedgerHeadHash` 全部失效 |
| `packages/controller/src/tasks/graph.ts` | 新增 `restoreFrom(items: TaskItem[])`：校验依赖存在性与无环后原样入图，**保留 status / testEvidenceHash / completedAt** | 低：纯新增。同上，任务快照哈希必须跨重启稳定 |
| `packages/protocol/src/adapter.ts` | `AgentRelayAdapter` 新增 `getSessionOutput(sessionId: string): string` | 低：三个真实适配器已实现该方法 |
| `packages/adapters/mock/src/mock-adapter.ts` | 补齐 `getSessionOutput` | 低 |
| `packages/adapters/claude/src/handshake.ts` | 新增 `buildPreparationPrompt` / `parseAckFromOutput` 规范别名，委托既有 `generatePreparationPrompt` / `extractAckFromText`；声明实现 `HandshakeCoordinator` | 低：纯增量别名 |
| `packages/adapters/codex/src/handshake.ts` | 同上 | 低 |
| `packages/adapters/dsh/src/handshake.ts` | 同上 | 低 |
| `packages/protocol/src/coordinator.ts`（新） | 定义统一 `HandshakeCoordinator` 与 `HandshakeResult` 契约 | 无 |
| `packages/protocol/src/index.ts` | 追加 `export * from './coordinator.ts'` | 无 |
| `packages/controller/src/index.ts` | 追加 `export * from './run/index.ts'` | 无 |

**注意：本项目无 `tsconfig.json`、无 `node_modules`、无类型检查步骤**（`node --experimental-strip-types` 只剥离类型，不做类型校验）。因此接口一致性必须由**契约测试**保证，而不是靠编译器。上表所有「声明实现某接口」的改动都必须在测试中显式断言方法存在与行为一致。

---

## 13. 与 `docs/decisions/architecture.md` 的偏差（已获用户知会）

决策文档 §4 规划的路径是 `packages/controller/src/engine.ts`（单文件，直接位于 `src/` 下）。本设计改为：

```
packages/controller/src/run/
  db.ts        # RelayDatabase：连接、pragma、migrate、transaction
  store.ts     # RunStore：各表类型化访问器
  intent.ts    # ControlIntentLog：追加、读取、优先级裁决、消费标记
  chain.ts     # SessionChainLedger：链接追加与查询
  status.ts    # StatusProjector：状态视图与投影渲染
  events.ts    # RunEventLog：事件追加、严重度分级、通知派发
  notifier.ts  # Notifier / ConsoleNotifier / RecordingNotifier
  prompt.ts    # 单元提示词构造与 UNIT_RESULT 解析
  engine.ts    # RunController（对应决策文档的 engine.ts）
  index.ts     # 汇总导出
```

理由：符合仓库既有的子目录分模块惯例（`inputs/`、`tasks/`、`policy/`、`handoff/`、`workspace/`），且每个文件单一职责、便于独立测试。`engine.ts` 仍是编排核心，只是与其他 run 级关注点同居一个子目录。

---

## 14. 继承的全局约束

- **不可变原话不可覆写**：追加式输入账本，修订通过 `supersedesId` 显式引用，禁止用摘要覆盖历史原话。
- **系统提示隔离**：`generated_handoff` 与人类真实输入严格隔离，不得作为新增的人类授权。
- **单一写入者不变量**：同一物理工作区任何时刻仅一个持有单调递增 epoch CAS 租约的 Owner；取得 `EXECUTION_TOKEN` 前绝对禁止写入。
- **Git 工作区无损保护**：严禁自动执行 `git reset --hard`、`git clean`、`git stash`；用户未暂存改动纳入基线指纹保护。
- **零第三方运行依赖**：纯 Node.js 24 原生标准库（`node:sqlite` 为内置），零外部 runtime npm 依赖。
- **严格 Provider 与 Model 校验**：禁止静默 fallback。
- **交接不要求反复确认**：已授权范围内的正常轮换不再询问用户。
