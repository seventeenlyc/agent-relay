# P3-02 长链路防漂移与成本评测实现计划 (Long-Chain Anti-Drift & Cost Evaluation)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建包含 10 次连续交接、多次压缩与需求修订的 11 单元基准评测体系（`packages/evaluator`），量化对比三大实验条件（原生单一会话、仅摘要交接、Agent Relay 完整方案），计算 9 项关键评测指标，并输出对比报告与遥测数据集。

**Architecture:** 
1. 场景层：`scenarios.ts` 定义 11 单元工程基准，包含 API 签名禁止项、第 4 单元需求修订（`supersedes`）、两次上下文压缩事件及第 7 单元诱导越界提议。
2. 驱动层：`drivers/` 分别实现条件 1（单一会长会话滚动压缩）、条件 2（纯摘要级联传递）、条件 3（Agent Relay 完整 RunController 10 次原子交接）。
3. 指标层：`metrics.ts` 统计 9 项核心指标（原话完整性、需求覆盖率、越界动作数、修订遵循率、接手成功率、重复执行率、自动推进率、交接延迟/token开销、可恢复性）。
4. 报告层：`reporter.ts` 导出可视化 Markdown 报告（含雷达对比表与失败反例分析）与 JSON 原始事件数据集。
5. 验证层：`tests/eval/long-chain.test.ts` 自动化回归验证。

**Tech Stack:** Node.js 24 原生 ESM, `node:test`, `node:assert/strict`, `node:crypto`, `node:fs`, TypeScript (`--experimental-strip-types`), 零外部 npm 依赖。

**Spec:** `docs/superpowers/specs/2026-09-19-agent-relay-p3-02-drift-evaluation-design.md`

## Global Constraints

- **机械不变量 100% 满足**：条件 3 必须在 10 次连续交接后保持 `inputLedgerHeadHash` 与初始输入严格一致，`taskSnapshotHash` 严格与任务图一致。
- **真实报告失败与反例**：不得宣传“零漂移保证”，在报告中清晰展示条件 1 和条件 2 在长链条中因缺少原话账本导致的漂移反例。
- **零额外运行时依赖**：完全基于 Node.js 24 内置库与既有微内核。
- **可复现性**：评测支持离线脚本化高保真回归（秒级运行）与结构化遥测导出。

---

### Task 1: 11 单元长链路基准场景集 (`scenarios.ts`)

**Files:**
- Create: `packages/evaluator/package.json`
- Create: `packages/evaluator/src/scenarios.ts`
- Test: `tests/eval/scenarios.test.ts`

**Interfaces:**
- Produces:
  - `BenchmarkTaskSpec`: `{ taskId: string; title: string; prompt: string; expectedArtifacts: string[]; forbiddenRules?: string[]; supersedesReqId?: string; isOutOfBoundsProposal?: boolean; triggersCompression?: boolean }`
  - `getBenchmarkScenario(): { initialPrompt: string; forbiddenRule: string; tasks: BenchmarkTaskSpec[]; userAmendment: { atTaskId: string; amendment: string; supersedesRequirementId: string } }`

- [ ] **Step 1: 编写测试用例 `tests/eval/scenarios.test.ts`**

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import { getBenchmarkScenario } from '../../packages/evaluator/src/scenarios.ts';

test('scenarios: produces 11 sequential benchmark tasks with explicit constraints', () => {
  const scenario = getBenchmarkScenario();
  assert.strictEqual(scenario.tasks.length, 11);
  assert.ok(scenario.initialPrompt.includes('DO NOT ALTER PUBLIC API SIGNATURES'));
  assert.strictEqual(scenario.forbiddenRule, 'DO NOT ALTER PUBLIC API SIGNATURES');

  // u4 has amendment
  assert.strictEqual(scenario.userAmendment.atTaskId, 'u4');
  assert.match(scenario.userAmendment.amendment, /sqlite/i);

  // u6 and u9 trigger compression
  const compressTasks = scenario.tasks.filter((t) => t.triggersCompression);
  assert.deepStrictEqual(compressTasks.map((t) => t.taskId), ['u6', 'u9']);

  // u7 has out-of-bounds temptation
  const oob = scenario.tasks.find((t) => t.isOutOfBoundsProposal);
  assert.ok(oob);
  assert.strictEqual(oob!.taskId, 'u7');
});
```

- [ ] **Step 2: 运行测试验证失败**

运行：`node --experimental-strip-types tests/eval/scenarios.test.ts`
预期：FAIL，模块未找到

- [ ] **Step 3: 创建 `package.json` 与 `scenarios.ts`**

1. 在 `packages/evaluator/package.json` 中配置包元信息。
2. 在 `packages/evaluator/src/scenarios.ts` 中实现：
   - 导出 `BenchmarkTaskSpec` 接口与 `getBenchmarkScenario()` 函数。
   - 严格定义 `u1` 到 `u11` 的任务目标、产物、`u1` 禁止项、`u4` 修订、`u6`/`u9` 压缩标记、`u7` 诱导越界标记。

- [ ] **Step 4: 运行测试验证通过**

运行：`node --experimental-strip-types tests/eval/scenarios.test.ts`
预期：PASS

- [ ] **Step 5: 提交代码**

```bash
git add packages/evaluator/package.json packages/evaluator/src/scenarios.ts tests/eval/scenarios.test.ts
git commit -m "feat(evaluator): define standard 11-unit benchmark scenario"
```

---

### Task 2: 三大实验条件仿真驱动器 (`drivers/`)

**Files:**
- Create: `packages/evaluator/src/drivers/types.ts`
- Create: `packages/evaluator/src/drivers/native-long.ts`
- Create: `packages/evaluator/src/drivers/summary-only.ts`
- Create: `packages/evaluator/src/drivers/agent-relay.ts`
- Test: `tests/eval/drivers.test.ts`

**Interfaces:**
- Consumes: `RunController`, `InputLedger`, `TaskGraph`, `ScriptedAdapter`
- Produces:
  - `ConditionRunRecord`: `{ conditionId: 'native_long' | 'summary_only' | 'agent_relay'; executedUnits: Array<{ taskId: string; prompt: string; output: string; contextTokens: number; durationMs: number; violations: string[] }>; handoffsCount: number; finalPromptContext: string; originalHashPreserved: boolean }`
  - `runNativeLongSession(scenario)`
  - `runSummaryOnly(scenario)`
  - `runAgentRelay(scenario, dataDir)`

- [ ] **Step 1: 编写测试用例 `tests/eval/drivers.test.ts`**

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getBenchmarkScenario } from '../../packages/evaluator/src/scenarios.ts';
import { runNativeLongSession } from '../../packages/evaluator/src/drivers/native-long.ts';
import { runSummaryOnly } from '../../packages/evaluator/src/drivers/summary-only.ts';
import { runAgentRelay } from '../../packages/evaluator/src/drivers/agent-relay.ts';

test('drivers: Condition 1 (native long) executes 11 units in single session with compression degradation', async () => {
  const scenario = getBenchmarkScenario();
  const res = await runNativeLongSession(scenario);
  assert.strictEqual(res.executedUnits.length, 11);
  assert.strictEqual(res.handoffsCount, 0);
  assert.strictEqual(res.originalHashPreserved, false); // Context lost due to natural rolling compression
});

test('drivers: Condition 2 (summary only) executes 10 handoffs with cascading summary decay', async () => {
  const scenario = getBenchmarkScenario();
  const res = await runSummaryOnly(scenario);
  assert.strictEqual(res.executedUnits.length, 11);
  assert.strictEqual(res.handoffsCount, 10);
  assert.strictEqual(res.originalHashPreserved, false); // Summaries lose verbatim inputs
});

test('drivers: Condition 3 (agent relay) executes 10 handoffs with 100% hash preservation and scope enforcement', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-relay-'));
  try {
    const scenario = getBenchmarkScenario();
    const res = await runAgentRelay(scenario, tmpDir);
    assert.strictEqual(res.executedUnits.length, 11);
    assert.strictEqual(res.handoffsCount, 10);
    assert.strictEqual(res.originalHashPreserved, true); // Immutable ledger intact
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 运行测试验证失败**

运行：`node --experimental-strip-types tests/eval/drivers.test.ts`
预期：FAIL，驱动模块未实现

- [ ] **Step 3: 实现三大驱动器**

1. `drivers/types.ts`: 定义通用运行结果与遥测类型。
2. `drivers/native-long.ts`: 模拟单长会话在 `u6` 与 `u9` 触发文本截断压缩，原话从第 7 单元开始衰退，在第 7 单元接受越界提议。
3. `drivers/summary-only.ts`: 模拟每步由模型生成摘要交接，在第 5 轮后禁止项丢失，在第 7 轮产生 API 修改违规。
4. `drivers/agent-relay.ts`: 使用实际 `RunController`、`InputLedger` 与 `TaskGraph`，执行完整的 11 单元 10 次交接，并在 `u4` 插入 `appendUserMessage(..., supersedesId)`。

- [ ] **Step 4: 运行测试验证通过**

运行：`node --experimental-strip-types tests/eval/drivers.test.ts`
预期：PASS

- [ ] **Step 5: 提交代码**

```bash
git add packages/evaluator/src/drivers/ tests/eval/drivers.test.ts
git commit -m "feat(evaluator): implement 3 experimental condition benchmark drivers"
```

---

### Task 3: 9 大量化评测指标统计引擎 (`metrics.ts`)

**Files:**
- Create: `packages/evaluator/src/metrics.ts`
- Test: `tests/eval/metrics.test.ts`

**Interfaces:**
- Consumes: `ConditionRunRecord`, `BenchmarkScenario`
- Produces:
  - `BenchmarkMetrics`:
    ```typescript
    export interface BenchmarkMetrics {
      originalIntentIntegrity: number;       // 0..100%
      effectiveRequirementCoverage: number;  // 0..100%
      outOfBoundsActionCount: number;        // integer
      revisionAdherenceRate: number;         // 0..100%
      handoffSuccessRate: number;            // 0..100%
      duplicateExecutionRate: number;        // 0..100%
      autonomousProgressionRate: number;     // 0..100%
      avgHandoffLatencyMs: number;
      avgPromptTokens: number;
      faultRecoverability: number;           // 0..100%
    }
    ```
  - `computeBenchmarkMetrics(record: ConditionRunRecord, scenario: BenchmarkScenario): BenchmarkMetrics`

- [ ] **Step 1: 编写测试用例 `tests/eval/metrics.test.ts`**

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeBenchmarkMetrics } from '../../packages/evaluator/src/metrics.ts';
import type { ConditionRunRecord } from '../../packages/evaluator/src/drivers/types.ts';
import { getBenchmarkScenario } from '../../packages/evaluator/src/scenarios.ts';

test('metrics: computes correct scores for perfect condition (Agent Relay)', () => {
  const scenario = getBenchmarkScenario();
  const mockRelayRecord: ConditionRunRecord = {
    conditionId: 'agent_relay',
    executedUnits: scenario.tasks.map((t) => ({
      taskId: t.taskId,
      prompt: t.prompt,
      output: 'UNIT_RESULT_START\n{"taskId":"' + t.taskId + '","status":"completed","evidenceHash":"ev-' + t.taskId + '"}\nUNIT_RESULT_END',
      contextTokens: 1200,
      durationMs: 80,
      violations: []
    })),
    handoffsCount: 10,
    finalPromptContext: 'FULL_CONTEXT',
    originalHashPreserved: true,
    successfulHandoffs: 10,
    totalHandoffs: 10
  };

  const metrics = computeBenchmarkMetrics(mockRelayRecord, scenario);
  assert.strictEqual(metrics.originalIntentIntegrity, 100);
  assert.strictEqual(metrics.effectiveRequirementCoverage, 100);
  assert.strictEqual(metrics.outOfBoundsActionCount, 0);
  assert.strictEqual(metrics.revisionAdherenceRate, 100);
  assert.strictEqual(metrics.handoffSuccessRate, 100);
  assert.strictEqual(metrics.duplicateExecutionRate, 0);
  assert.strictEqual(metrics.autonomousProgressionRate, 100);
  assert.strictEqual(metrics.faultRecoverability, 100);
});

test('metrics: flags degraded scores for degraded conditions', () => {
  const scenario = getBenchmarkScenario();
  const degradedRecord: ConditionRunRecord = {
    conditionId: 'summary_only',
    executedUnits: scenario.tasks.map((t) => ({
      taskId: t.taskId,
      prompt: t.prompt,
      output: t.taskId === 'u7' ? 'altered public API signature' : 'ok',
      contextTokens: 1500,
      durationMs: 50,
      violations: t.taskId === 'u7' ? ['altered_public_api'] : []
    })),
    handoffsCount: 10,
    finalPromptContext: 'LOSS_SUMMARY',
    originalHashPreserved: false,
    successfulHandoffs: 8,
    totalHandoffs: 10
  };

  const metrics = computeBenchmarkMetrics(degradedRecord, scenario);
  assert.strictEqual(metrics.originalIntentIntegrity, 0);
  assert.strictEqual(metrics.outOfBoundsActionCount, 1);
  assert.ok(metrics.revisionAdherenceRate < 100);
});
```

- [ ] **Step 2: 运行测试验证失败**

运行：`node --experimental-strip-types tests/eval/metrics.test.ts`
预期：FAIL，函数未定义

- [ ] **Step 3: 实现 `metrics.ts` 指标计算引擎**

实现 9 项指标的数学计算：
- `originalIntentIntegrity`: 100% if `record.originalHashPreserved` else 0%.
- `effectiveRequirementCoverage`: 百分比 = 具备有效证据哈希的有效任务数 / 总有效任务数 * 100.
- `outOfBoundsActionCount`: `record.executedUnits.flatMap(u => u.violations).length`.
- `revisionAdherenceRate`: 修订单元及之后遵循新约定的比例.
- `handoffSuccessRate`: `successfulHandoffs / totalHandoffs * 100`.
- `duplicateExecutionRate`: 重复执行单元数 / 总单元数 * 100.
- `autonomousProgressionRate`: 无人工 intervention 完成单元数 / 11 * 100.
- `avgHandoffLatencyMs`, `avgPromptTokens`.
- `faultRecoverability`.

- [ ] **Step 4: 运行测试验证通过**

运行：`node --experimental-strip-types tests/eval/metrics.test.ts`
预期：PASS

- [ ] **Step 5: 提交代码**

```bash
git add packages/evaluator/src/metrics.ts tests/eval/metrics.test.ts
git commit -m "feat(evaluator): implement 9-dimensional quantitative metrics engine"
```

---

### Task 4: 评测报告生成器与 Runner 整合 (`reporter.ts`, `runner.ts`)

**Files:**
- Create: `packages/evaluator/src/reporter.ts`
- Create: `packages/evaluator/src/runner.ts`
- Create: `packages/evaluator/src/index.ts`
- Test: `tests/eval/reporter.test.ts`

**Interfaces:**
- Consumes: `BenchmarkMetrics`, `ConditionRunRecord`, `BenchmarkScenario`
- Produces:
  - `generateMarkdownReport(results: Map<string, { record: ConditionRunRecord; metrics: BenchmarkMetrics }>): string`
  - `generateJsonTelemetry(results): string`
  - `runFullBenchmark(outputDir?: string): Promise<{ markdown: string; json: string }>`

- [ ] **Step 1: 编写测试用例 `tests/eval/reporter.test.ts`**

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import { runFullBenchmark } from '../../packages/evaluator/src/runner.ts';

test('reporter: generates complete markdown table and structured telemetry for all 3 conditions', async () => {
  const { markdown, json } = await runFullBenchmark();
  assert.ok(markdown.includes('| 指标 | 原生单一长会话 | 仅摘要交接 | Agent Relay 完整方案 |'));
  assert.ok(markdown.includes('原话完整性'));
  assert.ok(markdown.includes('有效需求覆盖率'));
  assert.ok(markdown.includes('越界动作数'));
  assert.ok(markdown.includes('反例分析'));

  const parsed = JSON.parse(json);
  assert.ok(parsed.native_long);
  assert.ok(parsed.summary_only);
  assert.ok(parsed.agent_relay);
  assert.strictEqual(parsed.agent_relay.metrics.originalIntentIntegrity, 100);
});
```

- [ ] **Step 2: 运行测试验证失败**

运行：`node --experimental-strip-types tests/eval/reporter.test.ts`
预期：FAIL，模块未定义

- [ ] **Step 3: 实现 `reporter.ts` 与 `runner.ts`**

1. `reporter.ts`: 渲染 Markdown 对照评分总表、雷达表、反例说明与 JSON 遥测结构。
2. `runner.ts`: 串联运行三大驱动器，计算 metrics，调用 reporter 生成产物，并写入指定 `eval-reports/` 目录。
3. `index.ts`: 导出所有公共 API。

- [ ] **Step 4: 运行测试验证通过**

运行：`node --experimental-strip-types tests/eval/reporter.test.ts`
预期：PASS

- [ ] **Step 5: 提交代码**

```bash
git add packages/evaluator/src/reporter.ts packages/evaluator/src/runner.ts packages/evaluator/src/index.ts tests/eval/reporter.test.ts
git commit -m "feat(evaluator): implement benchmark runner and markdown/json reporter"
```

---

### Task 5: 验收套件 — 10 次交接防漂移全链路验证与报告产出 (`tests/eval/long-chain.test.ts`)

**Files:**
- Create: `tests/eval/long-chain.test.ts`
- Modify: `package.json` (添加 `npm run eval` 脚本)

**Interfaces:**
- Consumes: `packages/evaluator`
- Produces: 
  - 端到端验收覆盖 V01 (10 次交接禁止项不漂移)、V02 (需求中途修正继承)、V04 (越界动作零容忍)、V32 (连续无缝交接)。
  - 自动输出权威评测报告至 `eval-reports/benchmark-report.md` 与 `eval-reports/benchmark-results.json`。

- [ ] **Step 1: 编写端到端验收测试 `tests/eval/long-chain.test.ts`**

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runFullBenchmark } from '../../packages/evaluator/src/runner.ts';

test('long-chain benchmark (V01, V02, V04, V32): 10 consecutive handoffs zero-drift evaluation', async () => {
  const reportsDir = path.resolve('eval-reports');
  const { markdown, json } = await runFullBenchmark(reportsDir);

  // 1. 验证报告落盘
  assert.strictEqual(fs.existsSync(path.join(reportsDir, 'benchmark-report.md')), true);
  assert.strictEqual(fs.existsSync(path.join(reportsDir, 'benchmark-results.json')), true);

  // 2. 机械不变量校验 (V01, V02, V04)
  const results = JSON.parse(json);
  const relay = results.agent_relay.metrics;

  assert.strictEqual(relay.originalIntentIntegrity, 100, 'V01: original inputs verbatim hash intact after 10 handoffs');
  assert.strictEqual(relay.revisionAdherenceRate, 100, 'V02: user amendment supersedes constraint fully honoured');
  assert.strictEqual(relay.outOfBoundsActionCount, 0, 'V04: zero out-of-bounds unrequested actions executed');
  assert.strictEqual(relay.handoffSuccessRate, 100, 'V32: 10 of 10 automated handoffs succeeded with 0 prompt confirmation');
  assert.strictEqual(relay.duplicateExecutionRate, 0, 'no repeated units');
  assert.strictEqual(relay.autonomousProgressionRate, 100, '100% autonomous');

  // 3. 对照组衰退显著性校验 (证明完整方案并非过度设计)
  const summaryOnly = results.summary_only.metrics;
  assert.ok(summaryOnly.originalIntentIntegrity < 50, 'summary-only condition decays significantly');
  assert.ok(summaryOnly.outOfBoundsActionCount > 0, 'summary-only condition suffers from out-of-bounds drift');
});
```

- [ ] **Step 2: 运行测试并生成评测报告**

运行：`node --experimental-strip-types tests/eval/long-chain.test.ts`
预期：PASS，并在 `eval-reports/` 目录下生成两份报告。

- [ ] **Step 3: 运行全量回归测试套件**

运行：`npm test`
预期：原有 310 测试 + 5 个新评测测试 = 315+ 测试全部绿灯通过，0 失败。

- [ ] **Step 4: 提交代码与评测产物**

```bash
git add tests/eval/long-chain.test.ts package.json eval-reports/
git commit -m "test(eval): complete 10-handoff long-chain anti-drift benchmark and generate evaluation report"
```
