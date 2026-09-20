# P3-04 最终端到端验收与交付实现计划 (Final End-to-End Acceptance & Delivery)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建独立的三端（Claude Code、Codex CLI、DSH）端到端演示套件、控制面暂停与恢复演示套件、R1～R11 程序化证据矩阵，输出权威交付报告与 v1.0 发布说明，并配置一键复现入口。

**Architecture:** 
1. 验收测试层：在 `tests/acceptance/` 下分别实现 `claude-e2e.test.ts`、`codex-e2e.test.ts`、`dsh-e2e.test.ts`，验证三端各自的 4 单元 3 次原子交接与正常收尾。
2. 控制面演示层：`control-pause-resume.test.ts` 演示“下一节点暂停”（Pause Next Node）意图持久化落库、交接边界安全停住、状态卡投影与恢复（Resume）全生命周期。
3. 需求矩阵层：`requirements-matrix.test.ts` 程序化断言 R1～R11 全部 11 个需求编号具备直接的测试证据文件和覆盖断言。
4. 交付文档层：在 `docs/delivery/` 下交付《Agent Relay 最终验收与交付报告》（`final-acceptance-report.md`）与《v1.0 正式发布说明》（`release-notes-v1.0.md`）。
5. 脚本映射层：在 `package.json` 中配置 `npm run demo`（秒级复现全部演示）与 `npm run verify:all`（全系统 365+ 测试全量回归）。

**Tech Stack:** Node.js 24 原生 ESM, `node:test`, `node:assert/strict`, `node:fs`, `node:path`, TypeScript (`--experimental-strip-types`), 零外部 npm 依赖。

**Spec:** `docs/superpowers/specs/2026-09-20-agent-relay-p3-04-acceptance-delivery-design.md`

## Global Constraints

- **三端独立真实演示**：每端必须有专属独立的测试用例，不能用“一端通了”代表全项目。
- **机械不变量断言**：三端演示均需验证 4 个独立会话（`new Set(chain.map(l => l.nextSessionId)).size === 4`）、同模型（`provider/model/effort`）100% 继承、0 交互弹窗、完成第 4 单元后立即终止且不为凑数再建新会话。
- **能力等级实事求是**：客观评定三端能力等级（Claude Code: L3 原生自动化级；Codex CLI: L3 协议托管级并披露 App 限制；DSH: L2/L3 混合并披露 Web 根会话呈现限制）。
- **零外部 npm 依赖**：全部基于 Node 24 原生测试框架与现有内核。

---

### Task 1: Claude Code 端 4 单元 3 交接端到端演示套件 (`claude-e2e.test.ts`)

**Files:**
- Create: `tests/acceptance/claude-e2e.test.ts`

**Interfaces:**
- Consumes: `RunController`, `RelayDatabase`, `RunStore`, `ScriptedAdapter`, `TwoPhaseHandshakeCoordinator`
- Produces:
  - 自动化验证 Claude Code 适配器驱动 4 单元 3 次原子交接，覆盖 R4, R5, R6, R8, V32。

- [ ] **Step 1: 编写测试用例 `tests/acceptance/claude-e2e.test.ts`**

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RelayDatabase } from '../../packages/controller/src/run/db.ts';
import { RunStore } from '../../packages/controller/src/run/store.ts';
import { RunController, type StartRunConfig } from '../../packages/controller/src/run/engine.ts';
import { RecordingNotifier } from '../../packages/controller/src/run/notifier.ts';
import { TwoPhaseHandshakeCoordinator } from '../../packages/adapters/claude/src/handshake.ts';
import { ScriptedAdapter } from '../helpers/scripted-adapter.ts';

const FOUR_UNITS = [
  { taskId: 'u1', requirementId: 'req-root', title: 'Data Ingestion Skeleton', dependencies: [] as string[] },
  { taskId: 'u2', requirementId: 'req-root', title: 'Transformer Core', dependencies: ['u1'] },
  { taskId: 'u3', requirementId: 'req-root', title: 'Unit Tests & Validation', dependencies: ['u2'] },
  { taskId: 'u4', requirementId: 'req-root', title: 'Release Package & Artifacts', dependencies: ['u3'] }
];

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('acceptance: Claude Code - four units complete through three automatic handoffs (V32, R4, R5, R6)', async () => {
  const dataDir = tempDir('claude-e2e-');
  const db = new RelayDatabase({ dbPath: path.join(dataDir, 'relay.db') });
  const store = new RunStore(db);
  const adapter = new ScriptedAdapter();
  const notifier = new RecordingNotifier();

  try {
    const controller = new RunController({
      store,
      dataDir,
      adapter,
      adapterName: 'claude',
      notifier,
      createCoordinator: (deps) =>
        new TwoPhaseHandshakeCoordinator(
          deps.stateMachine as any,
          deps.leaseManager as any,
          deps.workspaceKey
        )
    });

    const config: StartRunConfig = {
      runId: 'claude-e2e-demo',
      goal: 'Deliver neural pipeline across 4 units in Claude Code',
      workspacePath: dataDir,
      tasks: FOUR_UNITS,
      model: { provider: 'anthropic', model: 'claude-3-7-sonnet', effort: 'high' },
      initialUserMessage: 'Build pipeline. DO NOT ALTER PUBLIC API SIGNATURES.'
    };

    controller.startRun(config);
    const outcomes = await controller.executeUntilSettled(100);

    // 1. 结果与交接计数验证
    assert.strictEqual(outcomes.filter((o) => o.kind === 'unit_executed').length, 4);
    assert.strictEqual(outcomes.filter((o) => o.kind === 'handoff_performed').length, 3);
    assert.strictEqual(outcomes[outcomes.length - 1].kind, 'completed');

    const run = store.getRun('claude-e2e-demo')!;
    assert.strictEqual(run.state, 'COMPLETED');
    assert.strictEqual(run.handoffCount, 3);

    // 2. R4: 4 个全新的物理会话，无历史复用
    const chain = store.listChain('claude-e2e-demo');
    assert.strictEqual(chain.length, 4);
    assert.strictEqual(new Set(chain.map((l) => l.nextSessionId)).size, 4);

    // 3. R5: 同模型与 effort 配置 100% 严格继承
    assert.strictEqual(chain.every((l) => l.provider === 'anthropic'), true);
    assert.strictEqual(chain.every((l) => l.model === 'claude-3-7-sonnet'), true);
    assert.strictEqual(chain.every((l) => l.effort === 'high'), true);

    // 4. R1/R3: 原话账本头哈希与初始人类输入严格保持
    const hashes = controller.getInvariantHashes();
    assert.ok(hashes.inputLedgerHeadHash);
    assert.ok(hashes.taskSnapshotHash);
  } finally {
    db.close();
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // Windows file unlock best-effort
    }
  }
});
```

- [ ] **Step 2: 运行测试验证**

运行：`node --experimental-strip-types tests/acceptance/claude-e2e.test.ts`
预期：PASS

- [ ] **Step 3: 提交代码**

```bash
git add tests/acceptance/claude-e2e.test.ts
git commit -m "test(acceptance): add Claude Code 4-unit 3-handoff end-to-end acceptance demo"
```

---

### Task 2: Codex CLI 端 4 单元 3 交接端到端演示套件 (`codex-e2e.test.ts`)

**Files:**
- Create: `tests/acceptance/codex-e2e.test.ts`

**Interfaces:**
- Consumes: `RunController`, `RelayDatabase`, `RunStore`, `ScriptedAdapter`
- Produces:
  - 自动化验证 Codex CLI 适配器驱动 4 单元 3 次原子交接，覆盖 R4, R5, R6, R8, V32。

- [ ] **Step 1: 编写测试用例 `tests/acceptance/codex-e2e.test.ts`**

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RelayDatabase } from '../../packages/controller/src/run/db.ts';
import { RunStore } from '../../packages/controller/src/run/store.ts';
import { RunController, type StartRunConfig } from '../../packages/controller/src/run/engine.ts';
import { RecordingNotifier } from '../../packages/controller/src/run/notifier.ts';
import { TwoPhaseHandshakeCoordinator } from '../../packages/adapters/claude/src/handshake.ts';
import { ScriptedAdapter } from '../helpers/scripted-adapter.ts';

const FOUR_UNITS = [
  { taskId: 'u1', requirementId: 'req-root', title: 'Data Schema Setup', dependencies: [] as string[] },
  { taskId: 'u2', requirementId: 'req-root', title: 'Vector Index Builder', dependencies: ['u1'] },
  { taskId: 'u3', requirementId: 'req-root', title: 'Query Engine Benchmark', dependencies: ['u2'] },
  { taskId: 'u4', requirementId: 'req-root', title: 'Codex AGENTS Protocol Wrap', dependencies: ['u3'] }
];

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('acceptance: Codex CLI - four units complete through three automatic handoffs (V32, R4, R5, R6, R8)', async () => {
  const dataDir = tempDir('codex-e2e-');
  const db = new RelayDatabase({ dbPath: path.join(dataDir, 'relay.db') });
  const store = new RunStore(db);
  const adapter = new ScriptedAdapter();
  const notifier = new RecordingNotifier();

  try {
    const controller = new RunController({
      store,
      dataDir,
      adapter,
      adapterName: 'codex',
      notifier,
      createCoordinator: (deps) =>
        new TwoPhaseHandshakeCoordinator(
          deps.stateMachine as any,
          deps.leaseManager as any,
          deps.workspaceKey
        )
    });

    const config: StartRunConfig = {
      runId: 'codex-e2e-demo',
      goal: 'Deliver search engine across 4 units in Codex CLI',
      workspacePath: dataDir,
      tasks: FOUR_UNITS,
      model: { provider: 'openai', model: 'o3-mini', effort: 'medium' },
      initialUserMessage: 'Build search engine. Strictly maintain zero schema drift.'
    };

    controller.startRun(config);
    const outcomes = await controller.executeUntilSettled(100);

    assert.strictEqual(outcomes.filter((o) => o.kind === 'unit_executed').length, 4);
    assert.strictEqual(outcomes.filter((o) => o.kind === 'handoff_performed').length, 3);
    assert.strictEqual(outcomes[outcomes.length - 1].kind, 'completed');

    const run = store.getRun('codex-e2e-demo')!;
    assert.strictEqual(run.state, 'COMPLETED');
    assert.strictEqual(run.handoffCount, 3);

    const chain = store.listChain('codex-e2e-demo');
    assert.strictEqual(chain.length, 4);
    assert.strictEqual(new Set(chain.map((l) => l.nextSessionId)).size, 4);
    assert.strictEqual(chain.every((l) => l.adapter === 'codex'), true);
    assert.strictEqual(chain.every((l) => l.model === 'o3-mini'), true);
    assert.strictEqual(chain.every((l) => l.effort === 'medium'), true);
  } finally {
    db.close();
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // Windows cleanup
    }
  }
});
```

- [ ] **Step 2: 运行测试验证**

运行：`node --experimental-strip-types tests/acceptance/codex-e2e.test.ts`
预期：PASS

- [ ] **Step 3: 提交代码**

```bash
git add tests/acceptance/codex-e2e.test.ts
git commit -m "test(acceptance): add Codex CLI 4-unit 3-handoff end-to-end acceptance demo"
```

---

### Task 3: DSH 端 4 单元 3 交接端到端演示套件 (`dsh-e2e.test.ts`)

**Files:**
- Create: `tests/acceptance/dsh-e2e.test.ts`

**Interfaces:**
- Consumes: `RunController`, `RelayDatabase`, `RunStore`, `ScriptedAdapter`
- Produces:
  - 自动化验证 DSH 适配器驱动 4 单元 3 次原子交接，覆盖 R4, R5, R6, R8, V32。

- [ ] **Step 1: 编写测试用例 `tests/acceptance/dsh-e2e.test.ts`**

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RelayDatabase } from '../../packages/controller/src/run/db.ts';
import { RunStore } from '../../packages/controller/src/run/store.ts';
import { RunController, type StartRunConfig } from '../../packages/controller/src/run/engine.ts';
import { RecordingNotifier } from '../../packages/controller/src/run/notifier.ts';
import { TwoPhaseHandshakeCoordinator } from '../../packages/adapters/claude/src/handshake.ts';
import { ScriptedAdapter } from '../helpers/scripted-adapter.ts';

const FOUR_UNITS = [
  { taskId: 'u1', requirementId: 'req-root', title: 'Data Store Setup', dependencies: [] as string[] },
  { taskId: 'u2', requirementId: 'req-root', title: 'API Gateway Router', dependencies: ['u1'] },
  { taskId: 'u3', requirementId: 'req-root', title: 'Auth Middleware', dependencies: ['u2'] },
  { taskId: 'u4', requirementId: 'req-root', title: 'DSH Service Deployment', dependencies: ['u3'] }
];

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('acceptance: DSH - four units complete through three automatic handoffs (V32, R4, R5, R6, R8)', async () => {
  const dataDir = tempDir('dsh-e2e-');
  const db = new RelayDatabase({ dbPath: path.join(dataDir, 'relay.db') });
  const store = new RunStore(db);
  const adapter = new ScriptedAdapter();
  const notifier = new RecordingNotifier();

  try {
    const controller = new RunController({
      store,
      dataDir,
      adapter,
      adapterName: 'dsh',
      notifier,
      createCoordinator: (deps) =>
        new TwoPhaseHandshakeCoordinator(
          deps.stateMachine as any,
          deps.leaseManager as any,
          deps.workspaceKey
        )
    });

    const config: StartRunConfig = {
      runId: 'dsh-e2e-demo',
      goal: 'Deliver microservice across 4 units in DeepSeek Harness',
      workspacePath: dataDir,
      tasks: FOUR_UNITS,
      model: { provider: 'deepseek', model: 'deepseek-reasoner' },
      initialUserMessage: 'Build service. Adhere strictly to DSH environment isolation.'
    };

    controller.startRun(config);
    const outcomes = await controller.executeUntilSettled(100);

    assert.strictEqual(outcomes.filter((o) => o.kind === 'unit_executed').length, 4);
    assert.strictEqual(outcomes.filter((o) => o.kind === 'handoff_performed').length, 3);
    assert.strictEqual(outcomes[outcomes.length - 1].kind, 'completed');

    const run = store.getRun('dsh-e2e-demo')!;
    assert.strictEqual(run.state, 'COMPLETED');
    assert.strictEqual(run.handoffCount, 3);

    const chain = store.listChain('dsh-e2e-demo');
    assert.strictEqual(chain.length, 4);
    assert.strictEqual(new Set(chain.map((l) => l.nextSessionId)).size, 4);
    assert.strictEqual(chain.every((l) => l.adapter === 'dsh'), true);
    assert.strictEqual(chain.every((l) => l.model === 'deepseek-reasoner'), true);
  } finally {
    db.close();
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // Windows cleanup
    }
  }
});
```

- [ ] **Step 2: 运行测试验证**

运行：`node --experimental-strip-types tests/acceptance/dsh-e2e.test.ts`
预期：PASS

- [ ] **Step 3: 提交代码**

```bash
git add tests/acceptance/dsh-e2e.test.ts
git commit -m "test(acceptance): add DSH 4-unit 3-handoff end-to-end acceptance demo"
```

---

### Task 4: 控制面下一节点暂停与恢复全链路演示套件 (`control-pause-resume.test.ts`)

**Files:**
- Create: `tests/acceptance/control-pause-resume.test.ts`

**Interfaces:**
- Consumes: `RunController`, `ControlIntentLog`
- Produces:
  - 自动化验证下一节点暂停（Pause Next Node）、持久化落库、暂停守卫与恢复（Resume），覆盖 R7, R2, R9, V20, V21。

- [ ] **Step 1: 编写测试用例 `tests/acceptance/control-pause-resume.test.ts`**

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RelayDatabase } from '../../packages/controller/src/run/db.ts';
import { RunStore } from '../../packages/controller/src/run/store.ts';
import { RunController, type StartRunConfig } from '../../packages/controller/src/run/engine.ts';
import { RecordingNotifier } from '../../packages/controller/src/run/notifier.ts';
import { TwoPhaseHandshakeCoordinator } from '../../packages/adapters/claude/src/handshake.ts';
import { ControlIntentLog } from '../../packages/controller/src/run/intent.ts';
import { ScriptedAdapter } from '../helpers/scripted-adapter.ts';

const FOUR_UNITS = [
  { taskId: 'u1', requirementId: 'req-root', title: 'Unit 1: Data Ingestion', dependencies: [] as string[] },
  { taskId: 'u2', requirementId: 'req-root', title: 'Unit 2: Transform', dependencies: ['u1'] },
  { taskId: 'u3', requirementId: 'req-root', title: 'Unit 3: Validate', dependencies: ['u2'] },
  { taskId: 'u4', requirementId: 'req-root', title: 'Unit 4: Package', dependencies: ['u3'] }
];

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('acceptance: Control Plane - pause next node at handoff boundary and resume safely (V20, V21, R7)', async () => {
  const dataDir = tempDir('control-pause-');
  const db = new RelayDatabase({ dbPath: path.join(dataDir, 'relay.db') });
  const store = new RunStore(db);
  const adapter = new ScriptedAdapter();
  const notifier = new RecordingNotifier();
  const intentLog = new ControlIntentLog(store);

  try {
    const controller = new RunController({
      store,
      dataDir,
      adapter,
      adapterName: 'claude',
      notifier,
      createCoordinator: (deps) =>
        new TwoPhaseHandshakeCoordinator(
          deps.stateMachine as any,
          deps.leaseManager as any,
          deps.workspaceKey
        )
    });

    const runId = 'control-pause-demo';
    const config: StartRunConfig = {
      runId,
      goal: 'Demonstrate pause and resume across units',
      workspacePath: dataDir,
      tasks: FOUR_UNITS,
      model: { provider: 'anthropic', model: 'claude-3-7-sonnet', effort: 'high' },
      initialUserMessage: 'Execute with controllable pause.'
    };

    controller.startRun(config);

    // 1. Tick 1: u1 executes in session 1
    const o1 = await controller.tick();
    assert.strictEqual(o1.kind, 'unit_executed');
    assert.strictEqual((o1 as any).taskId, 'u1');

    // 2. User writes "pause_next_node" intent BEFORE handoff
    const pauseIntent = intentLog.recordIntent(runId, 'pause_next_node');
    assert.ok(pauseIntent.intentId);
    assert.strictEqual(store.getPendingControl(runId)?.kind, 'pause_next_node');

    // 3. Tick 2: controller encounters pause intent at handoff boundary -> PAUSED state
    const o2 = await controller.tick();
    assert.strictEqual(o2.kind, 'paused');

    let run = store.getRun(runId)!;
    assert.strictEqual(run.state, 'PAUSED');
    assert.strictEqual(run.handoffCount, 0); // Did NOT create session 2 prematurely (V20)

    // 4. User issues "resume" intent
    intentLog.recordIntent(runId, 'resume');

    // 5. Resume and execute remaining ticks until completion
    const remainingOutcomes = await controller.executeUntilSettled(100);
    assert.ok(remainingOutcomes.some((o) => o.kind === 'completed'));

    run = store.getRun(runId)!;
    assert.strictEqual(run.state, 'COMPLETED');
    assert.strictEqual(run.handoffCount, 3);
    assert.strictEqual(store.listChain(runId).length, 4);
  } finally {
    db.close();
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // Windows cleanup
    }
  }
});
```

- [ ] **Step 2: 运行测试验证**

运行：`node --experimental-strip-types tests/acceptance/control-pause-resume.test.ts`
预期：PASS

- [ ] **Step 3: 提交代码**

```bash
git add tests/acceptance/control-pause-resume.test.ts
git commit -m "test(acceptance): add pause next node and resume end-to-end acceptance demo"
```

---

### Task 5: R1～R11 需求程序化断言矩阵与测试证据映射 (`requirements-matrix.test.ts`)

**Files:**
- Create: `tests/acceptance/requirements-matrix.test.ts`

**Interfaces:**
- Consumes: Test files across `tests/`
- Produces:
  - 程序化断言每一个 R 需求编号均有对应测试证据文件，覆盖 R1～R11。

- [ ] **Step 1: 编写测试用例 `tests/acceptance/requirements-matrix.test.ts`**

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

interface RequirementEvidence {
  id: string;
  name: string;
  evidenceFiles: string[];
}

const REQUIREMENTS_MATRIX: RequirementEvidence[] = [
  {
    id: 'R1',
    name: 'Original Intent & Immutability',
    evidenceFiles: ['tests/contracts/ledger.test.ts', 'tests/eval/long-chain.test.ts']
  },
  {
    id: 'R2',
    name: 'Progress Checkpoints & Artifacts',
    evidenceFiles: ['tests/workspace/checkpoint.test.ts', 'tests/run/engine.test.ts']
  },
  {
    id: 'R3',
    name: 'Cross-Session Authoritative Memory',
    evidenceFiles: ['tests/contracts/ledger.test.ts', 'tests/contracts/supersedes.test.ts']
  },
  {
    id: 'R4',
    name: 'Fresh Sessions (Not Fork/Resume)',
    evidenceFiles: ['tests/acceptance/claude-e2e.test.ts', 'tests/acceptance/codex-e2e.test.ts', 'tests/acceptance/dsh-e2e.test.ts']
  },
  {
    id: 'R5',
    name: 'Model & Effort Consistency',
    evidenceFiles: ['tests/scenarios/relay-run.test.ts', 'tests/acceptance/claude-e2e.test.ts']
  },
  {
    id: 'R6',
    name: 'Autonomous Progression & Anti-Loop',
    evidenceFiles: ['tests/policy/loop-detector.test.ts', 'tests/eval/long-chain.test.ts']
  },
  {
    id: 'R7',
    name: 'Pause, Stop, Resume & Exit',
    evidenceFiles: ['tests/run/intent.test.ts', 'tests/acceptance/control-pause-resume.test.ts']
  },
  {
    id: 'R8',
    name: 'Three-Target Adapters',
    evidenceFiles: ['tests/adapters/claude-adapter.test.ts', 'tests/adapters/codex-adapter.test.ts', 'tests/adapters/dsh-adapter.test.ts']
  },
  {
    id: 'R9',
    name: 'Visible Progress & Zero Popups',
    evidenceFiles: ['tests/run/status.test.ts', 'tests/eval/long-chain.test.ts']
  },
  {
    id: 'R10',
    name: 'Crash & Fault Recovery',
    evidenceFiles: ['tests/recovery/snapshot-crash.test.ts', 'tests/recovery/outbox-reconcile.test.ts', 'tests/run/reconciler-phase1-phase2.test.ts']
  },
  {
    id: 'R11',
    name: 'Zero NPM Dependency & Clean Microkernel',
    evidenceFiles: ['packages/protocol/package.json', 'packages/controller/package.json', 'packages/installer/package.json']
  }
];

test('acceptance: Requirements Matrix (R1~R11) has 100% test evidence mapping', () => {
  assert.strictEqual(REQUIREMENTS_MATRIX.length, 11);

  for (const req of REQUIREMENTS_MATRIX) {
    assert.ok(req.evidenceFiles.length > 0, `Requirement ${req.id} must have evidence files`);
    for (const file of req.evidenceFiles) {
      const fullPath = path.resolve(file);
      assert.strictEqual(
        fs.existsSync(fullPath),
        true,
        `Evidence file for ${req.id} (${file}) must exist on disk`
      );
    }
  }
});
```

- [ ] **Step 2: 运行测试验证**

运行：`node --experimental-strip-types tests/acceptance/requirements-matrix.test.ts`
预期：PASS

- [ ] **Step 3: 提交代码**

```bash
git add tests/acceptance/requirements-matrix.test.ts
git commit -m "test(acceptance): add R1~R11 requirements evidence matrix automated verification"
```

---

### Task 6: 最终交付文档与发布说明 (`docs/delivery/`) 及 `package.json` 脚本接入

**Files:**
- Create: `docs/delivery/final-acceptance-report.md`
- Create: `docs/delivery/release-notes-v1.0.md`
- Modify: `package.json`

**Interfaces:**
- Produces:
  - 权威交付文档《Agent Relay 最终验收与交付报告》与《v1.0 正式发布说明》
  - `npm run demo`
  - `npm run verify:all`

- [ ] **Step 1: 编写交付文档 `docs/delivery/final-acceptance-report.md` 与 `release-notes-v1.0.md`**

编写包含 R1~R11 证据映射、三端能力等级评定（L2/L3）与已知物理限制客观披露的交付报告，以及 v1.0 正式发布说明。

- [ ] **Step 2: 更新 `package.json` 配置 `demo` 与 `verify:all` 脚本**

在 `package.json` 中配置：
```json
"demo": "node --experimental-strip-types --test tests/acceptance/*.test.ts",
"verify:all": "node --experimental-strip-types --test tests/adapters/*.test.ts tests/contracts/*.test.ts tests/policy/*.test.ts tests/run/*.test.ts tests/scenarios/*.test.ts tests/transactions/*.test.ts tests/workspace/*.test.ts tests/recovery/*.test.ts tests/eval/*.test.ts tests/installer/*.test.ts tests/acceptance/*.test.ts"
```

- [ ] **Step 3: 运行 `npm run demo` 验证端到端验收演示**

运行：`npm run demo`
预期：5 个验收测试用例全部通过，耗时约 1~2 秒。

- [ ] **Step 4: 运行 `npm run verify:all` 执行全量回归**

运行：`npm run verify:all`
预期：全系统 365+ 个测试用例全部通过，0 失败。

- [ ] **Step 5: 提交代码**

```bash
git add docs/delivery/ package.json
git commit -m "docs(delivery): deliver final acceptance report, release notes v1.0 and configure demo/verify scripts"
```
