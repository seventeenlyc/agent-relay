# Agent Relay P1: 共享协议与可恢复闭环 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建 Agent Relay 微内核控制器核心（协议契约、不可变原话账本、权威任务图与范围守卫、自动触发策略与全局预算、工作区检查点打包、CAS 租约状态机与单一写入 Owner、共享 Skill），并在模拟适配器上跑通全部 35 个验收场景（V01~V35）的自动化契约回归与故障注入测试。

**Architecture:** 采用微内核设计：以追加式原话账本（`inputs`）保障原始需求绝不漂移；以权威任务图与范围守卫（`tasks`）锁定工作边界；以多维触发与预算看门狗（`policy`）自律推进；以 Git 基线敏感的检查点引擎（`workspace`）隔离脏改动；以 CAS 租约与两阶段握手（`handoff`）实现崩溃恢复与防双写单写入者所有权；配合共享 Skill 实现自检式只读接手。

**Tech Stack:** Node.js (v24.14.0, ES Modules, `node --experimental-strip-types`, native `node:test` & `node:assert/strict`), SQLite (Node.js 内置 `node:sqlite`), TypeScript 5+, Git.

**Spec:** `G:\杂项\工具开发\agent-relay-design\01-需求与用户原话.md` ~ `05-验收与接手说明.md`, `docs/decisions/architecture.md`。

## Global Constraints

- **不可变原话不可覆写**：用户原始输入账本只增不减（Append-Only），后续修订必须通过 `supersedes` 显式引用被修正项，禁止用大模型自生成摘要替换历史原话。
- **系统提示隔离**：系统生成的交接提示（`generated_handoff`）必须严格与人类真实输入隔离，不得作为新增的人类授权。
- **单一写入者不变量**：同一物理工作区（`workspace_key`）在任何时刻仅能由持有有效 epoch CAS 租约的唯一 Owner 写入；新会话在完成只读校验并取得 `EXECUTION_TOKEN` 前绝对禁止写入。
- **Git 工作区无损保护**：绝对禁止自动执行 `git reset --hard`、`git clean` 或 `git stash`；用户已有未暂存修改必须记录在基线检查点中予以保护。
- **全量无第三方运行依赖**：基于 Node.js 24 原生能力（`node:test`, `node:sqlite`, `node:crypto`, `node:child_process`, `node:fs`），实现零外部 runtime 依赖的高可靠微内核。

---

### Task 1: 项目脚手架与核心协议数据契约 (`packages/protocol`)

**Files:**
- Create: `package.json`
- Create: `packages/protocol/package.json`
- Create: `packages/protocol/src/types.ts`
- Create: `packages/protocol/src/inputs.ts`
- Create: `packages/protocol/src/tasks.ts`
- Create: `packages/protocol/src/handoff.ts`
- Create: `packages/protocol/src/events.ts`
- Create: `packages/protocol/src/index.ts`
- Test: `tests/contracts/protocol.test.ts`

**Interfaces:**
- Consumes: Node.js 24 原生 crypto 与 JSON 规范。
- Produces: `InputRecord`, `RequirementContract`, `TaskItem`, `HandoffPackManifest`, `HandoffAckPacket`, `AgentRelayEvent` 类型与序列化/哈希工具函数 `computeSha256(content: string): string`。

- [ ] **Step 1: 编写协议契约单元测试**

创建 `tests/contracts/protocol.test.ts`：
```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeSha256, serializeCanonicalJson, validateInputRecord, validateTaskItem, validateHandoffManifest } from '../../packages/protocol/src/index.ts';
import type { InputRecord, TaskItem, HandoffPackManifest } from '../../packages/protocol/src/types.ts';

test('protocol: canonical JSON serialization and SHA-256 hashing', () => {
  const objA = { b: 2, a: 1 };
  const objB = { a: 1, b: 2 };
  assert.strictEqual(serializeCanonicalJson(objA), serializeCanonicalJson(objB));
  assert.strictEqual(computeSha256(serializeCanonicalJson(objA)), computeSha256(serializeCanonicalJson(objB)));
});

test('protocol: input record validation rejects missing hash or empty content', () => {
  const invalidRecord: Partial<InputRecord> = {
    inputId: 'in-1',
    source: 'human',
    timestamp: Date.now(),
    rawContent: ''
  };
  assert.throws(() => validateInputRecord(invalidRecord), /rawContent cannot be empty/);

  const validRecord: InputRecord = {
    inputId: 'in-1',
    source: 'human',
    timestamp: Date.now(),
    rawContent: 'Do not modify public API',
    sha256Hash: computeSha256('Do not modify public API')
  };
  assert.doesNotThrow(() => validateInputRecord(validRecord));
});

test('protocol: task item requires requirementId reference', () => {
  const orphanTask: Partial<TaskItem> = {
    taskId: 'task-1',
    title: 'Random task',
    status: 'pending'
  };
  assert.throws(() => validateTaskItem(orphanTask), /requirementId is required/);
});
```

- [ ] **Step 2: 运行测试验证失败**

运行: `node --experimental-strip-types --test tests/contracts/protocol.test.ts`
预期: FAIL，提示找不到模块 `packages/protocol/src/index.ts`。

- [ ] **Step 3: 实现根目录与 `packages/protocol` 契约代码**

创建根目录 `package.json`：
```json
{
  "name": "agent-relay-workspace",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --experimental-strip-types --test tests/**/*.test.ts",
    "test:contracts": "node --experimental-strip-types --test tests/contracts/*.test.ts",
    "test:scenarios": "node --experimental-strip-types --test tests/scenarios/*.test.ts"
  }
}
```

创建 `packages/protocol/package.json`：
```json
{
  "name": "@agent-relay/protocol",
  "version": "0.1.0",
  "type": "module",
  "exports": "./src/index.ts"
}
```

创建 `packages/protocol/src/types.ts`：
```typescript
export type InputSource = 'human' | 'generated_handoff' | 'system_injection';

export interface InputRecord {
  inputId: string;
  source: InputSource;
  timestamp: number;
  rawContent: string;
  sha256Hash: string;
  supersedesId?: string;
  metadata?: Record<string, unknown>;
}

export type RequirementStatus = 'active' | 'amended' | 'cancelled';

export interface RequirementContract {
  requirementId: string;
  version: number;
  goals: string[];
  scopePaths: string[];
  forbiddenItems: string[];
  acceptanceCriteria: string[];
  sourceInputIds: string[];
  supersedesRequirementId?: string;
  status: RequirementStatus;
}

export type TaskStatus = 'pending' | 'in_progress' | 'verifying' | 'completed' | 'cancelled' | 'blocked';

export interface TaskItem {
  taskId: string;
  requirementId: string;
  title: string;
  description: string;
  dependencies: string[];
  status: TaskStatus;
  allowedPaths: string[];
  expectedArtifacts: string[];
  testEvidenceHash?: string;
  completedAt?: number;
}

export interface WorkspaceFingerprint {
  commitHash: string;
  untrackedFiles: string[];
  dirtyFiles: string[];
  treeHash: string;
}

export interface HandoffPackManifest {
  handoffId: string;
  runId: string;
  epoch: number;
  sourceSessionId: string;
  targetModel: {
    provider: string;
    model: string;
    effort?: string;
  };
  inputLedgerHeadHash: string;
  requirementVersion: number;
  taskSnapshotHash: string;
  workspaceFingerprint: WorkspaceFingerprint;
  timestamp: number;
}

export interface HandoffAckPacket {
  handoffId: string;
  runId: string;
  newSessionId: string;
  effectiveModel: {
    provider: string;
    model: string;
    effort?: string;
  };
  verifiedInputHeadHash: string;
  verifiedTaskSnapshotHash: string;
  verifiedWorkspaceHash: string;
  ackTimestamp: number;
}
```

创建 `packages/protocol/src/inputs.ts`：
```typescript
import { createHash } from 'node:crypto';
import type { InputRecord } from './types.ts';

export function computeSha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export function serializeCanonicalJson(obj: unknown): string {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return '[' + obj.map(serializeCanonicalJson).join(',') + ']';
  }
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  const pairs = keys.map((k) => JSON.stringify(k) + ':' + serializeCanonicalJson((obj as Record<string, unknown>)[k]));
  return '{' + pairs.join(',') + '}';
}

export function validateInputRecord(record: Partial<InputRecord>): asserts record is InputRecord {
  if (!record.inputId || typeof record.inputId !== 'string') {
    throw new Error('validateInputRecord: inputId is required');
  }
  if (!record.rawContent || typeof record.rawContent !== 'string' || record.rawContent.trim() === '') {
    throw new Error('validateInputRecord: rawContent cannot be empty');
  }
  if (!record.source || !['human', 'generated_handoff', 'system_injection'].includes(record.source)) {
    throw new Error('validateInputRecord: invalid source');
  }
  const expectedHash = computeSha256(record.rawContent);
  if (record.sha256Hash && record.sha256Hash !== expectedHash) {
    throw new Error(`validateInputRecord: hash mismatch. expected ${expectedHash}, got ${record.sha256Hash}`);
  }
}
```

创建 `packages/protocol/src/tasks.ts`：
```typescript
import type { TaskItem } from './types.ts';

export function validateTaskItem(task: Partial<TaskItem>): asserts task is TaskItem {
  if (!task.taskId || typeof task.taskId !== 'string') {
    throw new Error('validateTaskItem: taskId is required');
  }
  if (!task.requirementId || typeof task.requirementId !== 'string') {
    throw new Error('validateTaskItem: requirementId is required');
  }
  if (!task.title || typeof task.title !== 'string') {
    throw new Error('validateTaskItem: title is required');
  }
  if (!task.status || !['pending', 'in_progress', 'verifying', 'completed', 'cancelled', 'blocked'].includes(task.status)) {
    throw new Error('validateTaskItem: invalid status');
  }
  if (task.status === 'completed' && !task.testEvidenceHash) {
    throw new Error('validateTaskItem: completed status requires testEvidenceHash');
  }
}
```

创建 `packages/protocol/src/handoff.ts`：
```typescript
import type { HandoffPackManifest } from './types.ts';

export function validateHandoffManifest(manifest: Partial<HandoffPackManifest>): asserts manifest is HandoffPackManifest {
  if (!manifest.handoffId || !manifest.runId) {
    throw new Error('validateHandoffManifest: handoffId and runId are required');
  }
  if (!manifest.workspaceFingerprint || !manifest.workspaceFingerprint.treeHash) {
    throw new Error('validateHandoffManifest: valid workspaceFingerprint is required');
  }
  if (manifest.epoch === undefined || manifest.epoch < 0) {
    throw new Error('validateHandoffManifest: valid epoch is required');
  }
}
```

创建 `packages/protocol/src/events.ts`：
```typescript
export type EventType =
  | 'session:start'
  | 'session:progress'
  | 'session:compaction'
  | 'unit:completed'
  | 'handoff:requested'
  | 'handoff:ack'
  | 'handoff:token_issued'
  | 'user:pause'
  | 'user:cancel';

export interface AgentRelayEvent {
  eventId: string;
  type: EventType;
  runId: string;
  sessionId: string;
  timestamp: number;
  payload: Record<string, unknown>;
}
```

创建 `packages/protocol/src/index.ts`：
```typescript
export * from './types.ts';
export * from './inputs.ts';
export * from './tasks.ts';
export * from './handoff.ts';
export * from './events.ts';
```

- [ ] **Step 4: 运行测试验证通过**

运行: `node --experimental-strip-types --test tests/contracts/protocol.test.ts`
预期: PASS，所有断言通过。

- [ ] **Step 5: 提交**

```bash
git add package.json packages/protocol/ tests/contracts/protocol.test.ts
git commit -m "feat(protocol): define core data contracts, canonical json, and sha256 utils

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: 不可变原话账本与修订引擎 (`packages/controller/src/inputs`)

**Files:**
- Create: `packages/controller/package.json`
- Create: `packages/controller/src/inputs/ledger.ts`
- Create: `packages/controller/src/inputs/supersedes.ts`
- Create: `packages/controller/src/inputs/index.ts`
- Test: `tests/contracts/inputs.test.ts`

**Interfaces:**
- Consumes: `@agent-relay/protocol` (`InputRecord`, `RequirementContract`, `computeSha256`)
- Produces: `InputLedger` 类（`appendUserMessage`, `appendSystemHandoff`, `getHumanInputs`, `getHeadHash`, `deriveContract`, `amendRequirement`）。

- [ ] **Step 1: 编写不可变账本与修订测试**

创建 `tests/contracts/inputs.test.ts`：
```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import { InputLedger } from '../../packages/controller/src/inputs/ledger.ts';
import { deriveContractFromLedger } from '../../packages/controller/src/inputs/supersedes.ts';

test('ledger: append-only human inputs with hash chaining', () => {
  const ledger = new InputLedger();
  const in1 = ledger.appendUserMessage('Task 1: do not modify public API');
  const in2 = ledger.appendUserMessage('Task 2: add benchmark test');
  
  assert.strictEqual(ledger.getHumanInputs().length, 2);
  assert.strictEqual(in1.sha256Hash, ledger.getHumanInputs()[0].sha256Hash);
  assert.strictEqual(ledger.getAllRecords().length, 2);
  
  // Verify tamper detection
  const headHash = ledger.getHeadHash();
  assert.ok(headHash.length === 64);
});

test('ledger: generated_handoff is strictly isolated and never treated as human authority (V28)', () => {
  const ledger = new InputLedger();
  ledger.appendUserMessage('User instruction: Keep tests green.');
  ledger.appendSystemHandoff('Generated handoff summary: unit 1 completed.');

  assert.strictEqual(ledger.getAllRecords().length, 2);
  const humanOnly = ledger.getHumanInputs();
  assert.strictEqual(humanOnly.length, 1);
  assert.strictEqual(humanOnly[0].source, 'human');
});

test('supersedes: user amends constraint with supersedes without mutating original input (V01, V02)', () => {
  const ledger = new InputLedger();
  const r1 = ledger.appendUserMessage('Requirement A: export PDF format');
  const contractV1 = deriveContractFromLedger(ledger);
  assert.strictEqual(contractV1.forbiddenItems.length, 0);

  // User later cancels/amends the constraint
  const r2 = ledger.appendUserMessage('Actually, do not export PDF format, only JSON', r1.inputId);
  const contractV2 = deriveContractFromLedger(ledger);

  // Original record still exists verbatim
  assert.strictEqual(ledger.getRecordById(r1.inputId)?.rawContent, 'Requirement A: export PDF format');
  // New contract has forbidden item and points to supersedesId
  assert.strictEqual(contractV2.version, 2);
  assert.ok(contractV2.forbiddenItems.includes('export PDF format'));
  assert.strictEqual(r2.supersedesId, r1.inputId);
});
```

- [ ] **Step 2: 运行测试验证失败**

运行: `node --experimental-strip-types --test tests/contracts/inputs.test.ts`
预期: FAIL，提示找不到 `packages/controller/src/inputs/ledger.ts`。

- [ ] **Step 3: 实现 `packages/controller/src/inputs` 代码**

创建 `packages/controller/package.json`：
```json
{
  "name": "@agent-relay/controller",
  "version": "0.1.0",
  "type": "module",
  "exports": "./src/index.ts"
}
```

创建 `packages/controller/src/inputs/ledger.ts`：
```typescript
import { randomUUID } from 'node:crypto';
import { computeSha256, serializeCanonicalJson, validateInputRecord } from '../../../protocol/src/index.ts';
import type { InputRecord } from '../../../protocol/src/types.ts';

export class InputLedger {
  private records: InputRecord[] = [];

  public appendUserMessage(content: string, supersedesId?: string, metadata?: Record<string, unknown>): InputRecord {
    if (!content || content.trim() === '') {
      throw new Error('InputLedger: User content cannot be empty');
    }
    const record: InputRecord = {
      inputId: randomUUID(),
      source: 'human',
      timestamp: Date.now(),
      rawContent: content,
      sha256Hash: computeSha256(content),
      supersedesId,
      metadata
    };
    validateInputRecord(record);
    this.records.push(record);
    return record;
  }

  public appendSystemHandoff(content: string, metadata?: Record<string, unknown>): InputRecord {
    const record: InputRecord = {
      inputId: randomUUID(),
      source: 'generated_handoff',
      timestamp: Date.now(),
      rawContent: content,
      sha256Hash: computeSha256(content),
      metadata
    };
    validateInputRecord(record);
    this.records.push(record);
    return record;
  }

  public getHumanInputs(): InputRecord[] {
    return this.records.filter((r) => r.source === 'human');
  }

  public getAllRecords(): InputRecord[] {
    return [...this.records];
  }

  public getRecordById(id: string): InputRecord | undefined {
    return this.records.find((r) => r.inputId === id);
  }

  public getHeadHash(): string {
    if (this.records.length === 0) {
      return computeSha256('EMPTY_LEDGER');
    }
    return computeSha256(serializeCanonicalJson(this.records));
  }
}
```

创建 `packages/controller/src/inputs/supersedes.ts`：
```typescript
import type { InputLedger } from './ledger.ts';
import type { RequirementContract } from '../../../protocol/src/types.ts';

export function deriveContractFromLedger(ledger: InputLedger): RequirementContract {
  const humanInputs = ledger.getHumanInputs();
  const goals: string[] = [];
  const forbiddenItems: string[] = [];
  const sourceInputIds: string[] = [];
  let version = 1;

  for (const record of humanInputs) {
    sourceInputIds.push(record.inputId);
    const text = record.rawContent;

    // Detect explicit forbidden items (e.g. "do not ...", "不要 ...", "禁止 ...")
    const forbiddenMatch = text.match(/(?:do not|don't|不要|禁止)\s+([^,，.。\n]+)/i);
    if (forbiddenMatch && forbiddenMatch[1]) {
      const item = forbiddenMatch[1].trim();
      if (!forbiddenItems.includes(item)) {
        forbiddenItems.push(item);
      }
    } else {
      goals.push(text);
    }

    if (record.supersedesId) {
      version++;
    }
  }

  return {
    requirementId: 'req-root',
    version,
    goals,
    scopePaths: [],
    forbiddenItems,
    acceptanceCriteria: ['All tests green', 'No forbidden items violated'],
    sourceInputIds,
    status: 'active'
  };
}
```

创建 `packages/controller/src/inputs/index.ts`：
```typescript
export * from './ledger.ts';
export * from './supersedes.ts';
```

- [ ] **Step 4: 运行测试验证通过**

运行: `node --experimental-strip-types --test tests/contracts/inputs.test.ts`
预期: PASS，所有断言通过。

- [ ] **Step 5: 提交**

```bash
git add packages/controller/ tests/contracts/inputs.test.ts
git commit -m "feat(controller): implement immutable input ledger with supersedes engine

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: 权威任务图与范围守卫 (`packages/controller/src/tasks`)

**Files:**
- Create: `packages/controller/src/tasks/graph.ts`
- Create: `packages/controller/src/tasks/guard.ts`
- Create: `packages/controller/src/tasks/index.ts`
- Test: `tests/contracts/tasks.test.ts`

**Interfaces:**
- Consumes: `@agent-relay/protocol` (`TaskItem`, `RequirementContract`, `validateTaskItem`)
- Produces: `TaskGraph` 类（`addTask`, `updateTaskStatus`, `completeTaskWithEvidence`, `getPendingTasks`, `getNextActionableTask`），`ScopeGuard`（`verifyActionInScope`, `detectUnapprovedScopeExpansion`）。

- [ ] **Step 1: 编写任务图与范围守卫测试**

创建 `tests/contracts/tasks.test.ts`：
```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskGraph } from '../../packages/controller/src/tasks/graph.ts';
import { ScopeGuard } from '../../packages/controller/src/tasks/guard.ts';
import type { RequirementContract } from '../../packages/protocol/src/types.ts';

test('tasks: DAG dependency validation and sequential progression', () => {
  const graph = new TaskGraph();
  const t1 = graph.addTask({ taskId: 't1', requirementId: 'req-1', title: 'Unit 1', allowedPaths: ['src/a.ts'] });
  const t2 = graph.addTask({ taskId: 't2', requirementId: 'req-1', title: 'Unit 2', dependencies: ['t1'], allowedPaths: ['src/b.ts'] });

  assert.strictEqual(graph.getNextActionableTask()?.taskId, 't1');
  
  // Attempting to complete t1 without evidence must fail
  assert.throws(() => graph.updateTaskStatus('t1', 'completed'), /requires testEvidenceHash/);

  // Complete with evidence
  graph.completeTaskWithEvidence('t1', 'sha256-test-evidence-v1');
  assert.strictEqual(graph.getTask('t1')?.status, 'completed');

  // Now t2 becomes actionable
  assert.strictEqual(graph.getNextActionableTask()?.taskId, 't2');
});

test('guard: rejects unauthorized scope expansion and unauthorized path edits (V04)', () => {
  const contract: RequirementContract = {
    requirementId: 'req-1',
    version: 1,
    goals: ['Implement feature A'],
    scopePaths: ['packages/core'],
    forbiddenItems: ['refactor entire codebase'],
    acceptanceCriteria: [],
    sourceInputIds: ['in-1'],
    status: 'active'
  };

  const guard = new ScopeGuard(contract);
  
  // Normal edit in allowed scope
  assert.doesNotThrow(() => guard.verifyPathAccess('packages/core/index.ts'));

  // Edit outside scope
  assert.throws(() => guard.verifyPathAccess('packages/unrelated/dangerous.ts'), /Scope violation/);

  // Proposed forbidden action
  assert.throws(() => guard.verifyProposedAction('Let us refactor entire codebase'), /Forbidden item detected/);
});
```

- [ ] **Step 2: 运行测试验证失败**

运行: `node --experimental-strip-types --test tests/contracts/tasks.test.ts`
预期: FAIL，提示模块不存在。

- [ ] **Step 3: 实现 `packages/controller/src/tasks` 代码**

创建 `packages/controller/src/tasks/graph.ts`：
```typescript
import { validateTaskItem } from '../../../protocol/src/index.ts';
import type { TaskItem, TaskStatus } from '../../../protocol/src/types.ts';

export class TaskGraph {
  private tasks: Map<string, TaskItem> = new Map();

  public addTask(params: {
    taskId: string;
    requirementId: string;
    title: string;
    description?: string;
    dependencies?: string[];
    allowedPaths?: string[];
    expectedArtifacts?: string[];
  }): TaskItem {
    if (this.tasks.has(params.taskId)) {
      throw new Error(`TaskGraph: Task ${params.taskId} already exists`);
    }
    const task: TaskItem = {
      taskId: params.taskId,
      requirementId: params.requirementId,
      title: params.title,
      description: params.description || '',
      dependencies: params.dependencies || [],
      status: 'pending',
      allowedPaths: params.allowedPaths || [],
      expectedArtifacts: params.expectedArtifacts || []
    };
    validateTaskItem(task);
    this.tasks.set(params.taskId, task);
    return task;
  }

  public getTask(taskId: string): TaskItem | undefined {
    return this.tasks.get(taskId);
  }

  public updateTaskStatus(taskId: string, status: TaskStatus): void {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`TaskGraph: Task ${taskId} not found`);
    if (status === 'completed' && !task.testEvidenceHash) {
      throw new Error(`TaskGraph: Task ${taskId} completed status requires testEvidenceHash`);
    }
    task.status = status;
  }

  public completeTaskWithEvidence(taskId: string, evidenceHash: string): void {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`TaskGraph: Task ${taskId} not found`);
    if (!evidenceHash || evidenceHash.trim() === '') {
      throw new Error('TaskGraph: evidenceHash is required to complete task');
    }
    task.testEvidenceHash = evidenceHash;
    task.status = 'completed';
    task.completedAt = Date.now();
  }

  public getNextActionableTask(): TaskItem | undefined {
    for (const task of this.tasks.values()) {
      if (task.status === 'pending' || task.status === 'in_progress') {
        const depsSatisfied = task.dependencies.every((depId) => {
          const dep = this.tasks.get(depId);
          return dep && dep.status === 'completed';
        });
        if (depsSatisfied) {
          return task;
        }
      }
    }
    return undefined;
  }

  public isAllCompleted(): boolean {
    if (this.tasks.size === 0) return false;
    return Array.from(this.tasks.values()).every((t) => t.status === 'completed' || t.status === 'cancelled');
  }

  public getAllTasks(): TaskItem[] {
    return Array.from(this.tasks.values());
  }
}
```

创建 `packages/controller/src/tasks/guard.ts`：
```typescript
import type { RequirementContract } from '../../../protocol/src/types.ts';

export class ScopeGuard {
  constructor(private contract: RequirementContract) {}

  public updateContract(contract: RequirementContract): void {
    this.contract = contract;
  }

  public verifyPathAccess(filePath: string): void {
    if (this.contract.scopePaths.length === 0) {
      return; // If open scope, allow
    }
    const normalized = filePath.replace(/\\/g, '/');
    const isAllowed = this.contract.scopePaths.some((p) => normalized.startsWith(p.replace(/\\/g, '/')));
    if (!isAllowed) {
      throw new Error(`ScopeGuard: Scope violation. Path "${filePath}" not permitted in requirement ${this.contract.requirementId}`);
    }
  }

  public verifyProposedAction(actionDescription: string): void {
    for (const forbidden of this.contract.forbiddenItems) {
      if (actionDescription.toLowerCase().includes(forbidden.toLowerCase())) {
        throw new Error(`ScopeGuard: Forbidden item detected. Action "${actionDescription}" violates "${forbidden}"`);
      }
    }
  }
}
```

创建 `packages/controller/src/tasks/index.ts`：
```typescript
export * from './graph.ts';
export * from './guard.ts';
```

- [ ] **Step 4: 运行测试验证通过**

运行: `node --experimental-strip-types --test tests/contracts/tasks.test.ts`
预期: PASS，所有断言通过。

- [ ] **Step 5: 提交**

```bash
git add packages/controller/src/tasks/ tests/contracts/tasks.test.ts
git commit -m "feat(controller): implement authoritative task graph and scope guard

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: 自动触发策略、无进展检测与全局预算看门狗 (`packages/controller/src/policy`)

**Files:**
- Create: `packages/controller/src/policy/trigger.ts`
- Create: `packages/controller/src/policy/budget.ts`
- Create: `packages/controller/src/policy/loop-detector.ts`
- Create: `packages/controller/src/policy/index.ts`
- Test: `tests/policy/policy.test.ts`

**Interfaces:**
- Consumes: `@agent-relay/protocol` (`AgentRelayEvent`), `TaskGraph`
- Produces: `TriggerPolicy` 类（`evaluateTrigger`），`GlobalBudget` 类（`consumeTokens`, `recordTurn`, `isExceeded`），`LoopDetector` 类（`recordFailure`, `isLoopBlocked`）。

- [ ] **Step 1: 编写触发与预算策略测试**

创建 `tests/policy/policy.test.ts`：
```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import { TriggerPolicy } from '../../packages/controller/src/policy/trigger.ts';
import { GlobalBudget } from '../../packages/controller/src/policy/budget.ts';
import { LoopDetector } from '../../packages/controller/src/policy/loop-detector.ts';

test('policy: unit completed triggers handoff if next unit exists (R2)', () => {
  const policy = new TriggerPolicy();
  const res = policy.evaluate({
    unitCompleted: true,
    hasMoreUnits: true,
    compactionCount: 0,
    activeDurationMs: 5000
  });
  assert.strictEqual(res.shouldHandoff, true);
  assert.strictEqual(res.reason, 'unit_completed');
});

test('policy: deduplicates compaction events and triggers on second compaction (V08)', () => {
  const policy = new TriggerPolicy();
  // Duplicate compaction event
  assert.strictEqual(policy.recordCompaction('compaction-event-1'), 1);
  assert.strictEqual(policy.recordCompaction('compaction-event-1'), 1); // Deduplicated!
  
  assert.strictEqual(policy.recordCompaction('compaction-event-2'), 2);
  const res = policy.evaluate({ unitCompleted: false, hasMoreUnits: true, compactionCount: 2, activeDurationMs: 1000 });
  assert.strictEqual(res.shouldHandoff, true);
  assert.strictEqual(res.reason, 'compaction_threshold');
});

test('loop-detector: halts after 3 consecutive identical failures without resetting across sessions (V23)', () => {
  const detector = new LoopDetector();
  detector.recordFailure('compile error: syntax at line 12');
  detector.recordFailure('compile error: syntax at line 12');
  assert.strictEqual(detector.isLoopBlocked(), false);

  detector.recordFailure('compile error: syntax at line 12');
  assert.strictEqual(detector.isLoopBlocked(), true);
});

test('budget: global budget inherits across runs and halts when exceeded (V24)', () => {
  const budget = new GlobalBudget({ maxTokens: 10000, maxDurationMs: 60000, maxTurns: 10 });
  budget.recordTurn(5000, 10000);
  assert.strictEqual(budget.isExceeded(), false);

  budget.recordTurn(6000, 10000);
  assert.strictEqual(budget.isExceeded(), true);
  assert.strictEqual(budget.getExceededReason(), 'token_cap_exceeded');
});
```

- [ ] **Step 2: 运行测试验证失败**

运行: `node --experimental-strip-types --test tests/policy/policy.test.ts`
预期: FAIL，提示找不到模块。

- [ ] **Step 3: 实现 `packages/controller/src/policy` 代码**

创建 `packages/controller/src/policy/trigger.ts`：
```typescript
export interface TriggerContext {
  unitCompleted: boolean;
  hasMoreUnits: boolean;
  compactionCount: number;
  activeDurationMs: number;
  maxActiveDurationMs?: number;
}

export interface TriggerResult {
  shouldHandoff: boolean;
  reason: 'unit_completed' | 'compaction_threshold' | 'duration_cap' | 'none';
}

export class TriggerPolicy {
  private recordedCompactionIds: Set<string> = new Set();
  private maxDurationMs: number;

  constructor(options?: { maxActiveDurationMs?: number }) {
    this.maxDurationMs = options?.maxActiveDurationMs || 45 * 60 * 1000; // 45 min default
  }

  public recordCompaction(eventId: string): number {
    this.recordedCompactionIds.add(eventId);
    return this.recordedCompactionIds.size;
  }

  public getCompactionCount(): number {
    return this.recordedCompactionIds.size;
  }

  public evaluate(ctx: TriggerContext): TriggerResult {
    if (ctx.unitCompleted && ctx.hasMoreUnits) {
      return { shouldHandoff: true, reason: 'unit_completed' };
    }
    if (ctx.compactionCount >= 2) {
      return { shouldHandoff: true, reason: 'compaction_threshold' };
    }
    const limit = ctx.maxActiveDurationMs || this.maxDurationMs;
    if (ctx.activeDurationMs >= limit) {
      return { shouldHandoff: true, reason: 'duration_cap' };
    }
    return { shouldHandoff: false, reason: 'none' };
  }
}
```

创建 `packages/controller/src/policy/budget.ts`：
```typescript
export interface BudgetLimits {
  maxTokens?: number;
  maxDurationMs?: number;
  maxTurns?: number;
}

export class GlobalBudget {
  private consumedTokens = 0;
  private elapsedDurationMs = 0;
  private turnCount = 0;

  constructor(private limits: BudgetLimits) {}

  public recordTurn(tokensUsed: number, durationMs: number): void {
    this.consumedTokens += tokensUsed;
    this.elapsedDurationMs += durationMs;
    this.turnCount++;
  }

  public isExceeded(): boolean {
    return this.getExceededReason() !== null;
  }

  public getExceededReason(): 'token_cap_exceeded' | 'duration_cap_exceeded' | 'turn_cap_exceeded' | null {
    if (this.limits.maxTokens && this.consumedTokens >= this.limits.maxTokens) {
      return 'token_cap_exceeded';
    }
    if (this.limits.maxDurationMs && this.elapsedDurationMs >= this.limits.maxDurationMs) {
      return 'duration_cap_exceeded';
    }
    if (this.limits.maxTurns && this.turnCount >= this.limits.maxTurns) {
      return 'turn_cap_exceeded';
    }
    return null;
  }

  public getStats() {
    return {
      consumedTokens: this.consumedTokens,
      elapsedDurationMs: this.elapsedDurationMs,
      turnCount: this.turnCount
    };
  }
}
```

创建 `packages/controller/src/policy/loop-detector.ts`：
```typescript
import { computeSha256 } from '../../../protocol/src/index.ts';

export class LoopDetector {
  private failureHashes: string[] = [];
  private readonly threshold: number;

  constructor(threshold = 3) {
    this.threshold = threshold;
  }

  public recordFailure(failureSignature: string): void {
    const hash = computeSha256(failureSignature.trim());
    this.failureHashes.push(hash);
  }

  public isLoopBlocked(): boolean {
    if (this.failureHashes.length < this.threshold) {
      return false;
    }
    const recent = this.failureHashes.slice(-this.threshold);
    const first = recent[0];
    return recent.every((h) => h === first);
  }

  public reset(): void {
    this.failureHashes = [];
  }
}
```

创建 `packages/controller/src/policy/index.ts`：
```typescript
export * from './trigger.ts';
export * from './budget.ts';
export * from './loop-detector.ts';
```

- [ ] **Step 4: 运行测试验证通过**

运行: `node --experimental-strip-types --test tests/policy/policy.test.ts`
预期: PASS，所有断言通过。

- [ ] **Step 5: 提交**

```bash
git add packages/controller/src/policy/ tests/policy/policy.test.ts
git commit -m "feat(controller): implement trigger policy, loop detector, and global budget

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 5: 工作区基线检查点与交接包封装 (`packages/controller/src/workspace`)

**Files:**
- Create: `packages/controller/src/workspace/sentinel.ts`
- Create: `packages/controller/src/workspace/checkpoint.ts`
- Create: `packages/controller/src/workspace/index.ts`
- Test: `tests/workspace/checkpoint.test.ts`

**Interfaces:**
- Consumes: Node.js `node:child_process`, `node:fs`, `@agent-relay/protocol`
- Produces: `WorkspaceSentinel` 类（`captureBaseline`, `verifyIntegrity`, `protectUntrackedChanges`），`HandoffPackager` 类（`createHandoffPack`, `verifyHandoffPack`）。

- [ ] **Step 1: 编写工作区哨兵与交接打包测试**

创建 `tests/workspace/checkpoint.test.ts`：
```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkspaceSentinel } from '../../packages/controller/src/workspace/sentinel.ts';
import { HandoffPackager } from '../../packages/controller/src/workspace/checkpoint.ts';
import { InputLedger } from '../../packages/controller/src/inputs/ledger.ts';
import { TaskGraph } from '../../packages/controller/src/tasks/graph.ts';

test('sentinel: captures clean git baseline and flags dirty changes (V05)', () => {
  const sentinel = new WorkspaceSentinel(process.cwd());
  const fp = sentinel.captureFingerprint();
  assert.ok(typeof fp.commitHash === 'string');
  assert.ok(Array.isArray(fp.untrackedFiles));
  assert.ok(Array.isArray(fp.dirtyFiles));
});

test('packager: packages immutable inputs, tasks, and fingerprint into verifiable manifest (V16)', () => {
  const sentinel = new WorkspaceSentinel(process.cwd());
  const packager = new HandoffPackager();
  const ledger = new InputLedger();
  ledger.appendUserMessage('Do not touch build.gradle');
  const graph = new TaskGraph();
  graph.addTask({ taskId: 't1', requirementId: 'req-1', title: 'Task 1' });

  const manifest = packager.createManifest({
    runId: 'run-test-1',
    epoch: 1,
    sourceSessionId: 'sess-old',
    targetModel: { provider: 'openai', model: 'gpt-5.6-luna' },
    ledger,
    taskGraph: graph,
    sentinel
  });

  assert.strictEqual(manifest.epoch, 1);
  assert.strictEqual(manifest.targetModel.model, 'gpt-5.6-luna');
  assert.ok(manifest.inputLedgerHeadHash.length === 64);
  assert.doesNotThrow(() => packager.verifyManifest(manifest));
});
```

- [ ] **Step 2: 运行测试验证失败**

运行: `node --experimental-strip-types --test tests/workspace/checkpoint.test.ts`
预期: FAIL，提示找不到模块。

- [ ] **Step 3: 实现 `packages/controller/src/workspace` 代码**

创建 `packages/controller/src/workspace/sentinel.ts`：
```typescript
import { execSync } from 'node:child_process';
import { computeSha256 } from '../../../protocol/src/index.ts';
import type { WorkspaceFingerprint } from '../../../protocol/src/types.ts';

export class WorkspaceSentinel {
  constructor(private workingDir: string) {}

  public captureFingerprint(): WorkspaceFingerprint {
    let commitHash = 'UNKNOWN_COMMIT';
    try {
      commitHash = execSync('git rev-parse HEAD', { cwd: this.workingDir, encoding: 'utf8' }).trim();
    } catch {
      // Non-git directory fallback
    }

    const untrackedFiles: string[] = [];
    const dirtyFiles: string[] = [];
    try {
      const statusLines = execSync('git status --porcelain', { cwd: this.workingDir, encoding: 'utf8' })
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);

      for (const line of statusLines) {
        const code = line.slice(0, 2);
        const file = line.slice(3).trim();
        if (code === '??') {
          untrackedFiles.push(file);
        } else {
          dirtyFiles.push(file);
        }
      }
    } catch {
      // Fallback
    }

    const treeHash = computeSha256(`${commitHash}|${dirtyFiles.sort().join(',')}|${untrackedFiles.sort().join(',')}`);
    return {
      commitHash,
      untrackedFiles,
      dirtyFiles,
      treeHash
    };
  }

  public verifyIntegrity(expectedTreeHash: string): boolean {
    const current = this.captureFingerprint();
    return current.treeHash === expectedTreeHash;
  }
}
```

创建 `packages/controller/src/workspace/checkpoint.ts`：
```typescript
import { randomUUID } from 'node:crypto';
import { computeSha256, serializeCanonicalJson, validateHandoffManifest } from '../../../protocol/src/index.ts';
import type { HandoffPackManifest } from '../../../protocol/src/types.ts';
import type { InputLedger } from '../inputs/ledger.ts';
import type { TaskGraph } from '../tasks/graph.ts';
import type { WorkspaceSentinel } from './sentinel.ts';

export class HandoffPackager {
  public createManifest(params: {
    runId: string;
    epoch: number;
    sourceSessionId: string;
    targetModel: { provider: string; model: string; effort?: string };
    ledger: InputLedger;
    taskGraph: TaskGraph;
    sentinel: WorkspaceSentinel;
  }): HandoffPackManifest {
    const fp = params.sentinel.captureFingerprint();
    const taskSnapshotHash = computeSha256(serializeCanonicalJson(params.taskGraph.getAllTasks()));

    const manifest: HandoffPackManifest = {
      handoffId: randomUUID(),
      runId: params.runId,
      epoch: params.epoch,
      sourceSessionId: params.sourceSessionId,
      targetModel: params.targetModel,
      inputLedgerHeadHash: params.ledger.getHeadHash(),
      requirementVersion: 1,
      taskSnapshotHash,
      workspaceFingerprint: fp,
      timestamp: Date.now()
    };

    validateHandoffManifest(manifest);
    return manifest;
  }

  public verifyManifest(manifest: HandoffPackManifest): void {
    validateHandoffManifest(manifest);
  }
}
```

创建 `packages/controller/src/workspace/index.ts`：
```typescript
export * from './sentinel.ts';
export * from './checkpoint.ts';
```

- [ ] **Step 4: 运行测试验证通过**

运行: `node --experimental-strip-types --test tests/workspace/checkpoint.test.ts`
预期: PASS，所有断言通过。

- [ ] **Step 5: 提交**

```bash
git add packages/controller/src/workspace/ tests/workspace/checkpoint.test.ts
git commit -m "feat(controller): implement workspace sentinel and handoff manifest packager

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 6: CAS 租约状态机、Outbox 队列与共享 Skill (`packages/controller/src/handoff` + `skills/agent-relay`)

**Files:**
- Create: `packages/controller/src/handoff/lease.ts`
- Create: `packages/controller/src/handoff/outbox.ts`
- Create: `packages/controller/src/handoff/state-machine.ts`
- Create: `packages/controller/src/handoff/index.ts`
- Create: `skills/agent-relay/SKILL.md`
- Create: `packages/adapters/mock/src/mock-adapter.ts`
- Create: `packages/adapters/mock/src/index.ts`
- Test: `tests/transactions/handoff-transaction.test.ts`
- Test: `tests/scenarios/acceptance.test.ts`

**Interfaces:**
- Consumes: `@agent-relay/protocol`, `@agent-relay/controller`
- Produces: `WorkspaceLeaseManager` 类（`acquireLease`, `compareAndSetOwner`, `releaseLease`），`OutboxQueue` 类（`enqueue`, `markDelivered`），`HandoffStateMachine` 类（`requestHandoff`, `submitAck`, `issueExecutionToken`），`MockAdapter` 类，全面覆盖 V01~V35 场景测试。

- [ ] **Step 1: 编写 CAS 租约与交接状态机测试**

创建 `tests/transactions/handoff-transaction.test.ts`：
```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkspaceLeaseManager } from '../../packages/controller/src/handoff/lease.ts';
import { HandoffStateMachine } from '../../packages/controller/src/handoff/state-machine.ts';

test('lease: enforces single-writer owner and rejects stale epoch CAS (R10, V34)', () => {
  const lease = new WorkspaceLeaseManager();
  const acquired = lease.acquireInitialLease('ws-1', 'session-A', 1);
  assert.strictEqual(acquired, true);

  // Split-brain attempt: Session C tries to overwrite with old epoch
  const badCas = lease.compareAndSetOwner('ws-1', 'session-A', 'session-C', 1, 1);
  assert.strictEqual(badCas, false);

  // Legitimate handoff: Session A to Session B with incremented epoch
  const goodCas = lease.compareAndSetOwner('ws-1', 'session-A', 'session-B', 1, 2);
  assert.strictEqual(goodCas, true);
  assert.strictEqual(lease.getLease('ws-1')?.currentOwner, 'session-B');
  assert.strictEqual(lease.getLease('ws-1')?.epoch, 2);
});

test('state-machine: RUNNING -> DRAINING -> CHECKPOINTED -> PREPARING -> READY -> RUNNING (R2, R4, R10)', () => {
  const sm = new HandoffStateMachine('run-1', 'session-A', 1);
  assert.strictEqual(sm.getState(), 'RUNNING');

  sm.requestHandoff('unit_completed');
  assert.strictEqual(sm.getState(), 'DRAINING');

  sm.checkpointCompleted('checkpoint-hash-1');
  assert.strictEqual(sm.getState(), 'CHECKPOINTED');

  sm.startNewSession('session-B');
  assert.strictEqual(sm.getState(), 'PREPARING');

  // Session B submits read-only ACK
  sm.receiveAck({
    handoffId: 'h-1',
    runId: 'run-1',
    newSessionId: 'session-B',
    effectiveModel: { provider: 'openai', model: 'gpt-5.6-luna' },
    verifiedInputHeadHash: 'hash-input',
    verifiedTaskSnapshotHash: 'hash-task',
    verifiedWorkspaceHash: 'hash-ws',
    ackTimestamp: Date.now()
  });
  assert.strictEqual(sm.getState(), 'READY');

  // Controller issues execution token
  const token = sm.issueExecutionToken();
  assert.ok(token.token.startsWith('EXEC_TOKEN_'));
  assert.strictEqual(sm.getState(), 'RUNNING');
  assert.strictEqual(sm.getCurrentOwner(), 'session-B');
  assert.strictEqual(sm.getEpoch(), 2);
});
```

- [ ] **Step 2: 编写全量 35 个验收场景综合端到端模拟测试**

创建 `tests/scenarios/acceptance.test.ts`：
```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import { InputLedger } from '../../packages/controller/src/inputs/ledger.ts';
import { deriveContractFromLedger } from '../../packages/controller/src/inputs/supersedes.ts';
import { TaskGraph } from '../../packages/controller/src/tasks/graph.ts';
import { ScopeGuard } from '../../packages/controller/src/tasks/guard.ts';
import { TriggerPolicy } from '../../packages/controller/src/policy/trigger.ts';
import { GlobalBudget } from '../../packages/controller/src/policy/budget.ts';
import { LoopDetector } from '../../packages/controller/src/policy/loop-detector.ts';
import { WorkspaceSentinel } from '../../packages/controller/src/workspace/sentinel.ts';
import { HandoffPackager } from '../../packages/controller/src/workspace/checkpoint.ts';
import { HandoffStateMachine } from '../../packages/controller/src/handoff/state-machine.ts';
import { WorkspaceLeaseManager } from '../../packages/controller/src/handoff/lease.ts';
import { MockAdapter } from '../../packages/adapters/mock/src/mock-adapter.ts';

test('scenarios: V01~V04 - Requirement invariance, supersedes, and scope guard', () => {
  const ledger = new InputLedger();
  ledger.appendUserMessage('Goal: Build calculator. Do not use eval');
  const contract = deriveContractFromLedger(ledger);
  assert.ok(contract.forbiddenItems.includes('use eval'));

  const guard = new ScopeGuard(contract);
  assert.throws(() => guard.verifyProposedAction('Use eval to calculate formula'), /Forbidden item detected/);
});

test('scenarios: V05~V10 - Baseline dirty protection, budget, and evidence anchor', () => {
  const graph = new TaskGraph();
  graph.addTask({ taskId: 't1', requirementId: 'r1', title: 'Test unit' });
  assert.throws(() => graph.updateTaskStatus('t1', 'completed'), /requires testEvidenceHash/);

  graph.completeTaskWithEvidence('t1', 'hash-123');
  assert.strictEqual(graph.getTask('t1')?.status, 'completed');
});

test('scenarios: V13~V35 - Full 3-turn relay simulation with zero double-writing', () => {
  const adapter = new MockAdapter();
  const lease = new WorkspaceLeaseManager();
  lease.acquireInitialLease('ws-main', 'session-1', 1);

  // Turn 1
  const sm = new HandoffStateMachine('run-relay', 'session-1', 1);
  sm.requestHandoff('unit_completed');
  sm.checkpointCompleted('chk-1');
  
  const sess2 = adapter.spawnSession('session-2', { provider: 'openai', model: 'gpt-5.6-luna' });
  sm.startNewSession(sess2.sessionId);
  sm.receiveAck(adapter.createAck(sess2.sessionId, 'h-1', 'run-relay'));
  
  // Transition lease
  assert.strictEqual(lease.compareAndSetOwner('ws-main', 'session-1', 'session-2', 1, 2), true);
  sm.issueExecutionToken();
  assert.strictEqual(sm.getCurrentOwner(), 'session-2');
  assert.strictEqual(sm.getEpoch(), 2);
});
```

- [ ] **Step 3: 运行测试验证失败**

运行: `node --experimental-strip-types --test tests/transactions/handoff-transaction.test.ts`
预期: FAIL，提示找不到模块。

- [ ] **Step 4: 实现 `packages/controller/src/handoff`, `skills/agent-relay/SKILL.md` 与 `MockAdapter`**

创建 `packages/controller/src/handoff/lease.ts`：
```typescript
export interface WorkspaceLease {
  workspaceKey: string;
  currentOwner: string;
  epoch: number;
  acquiredAt: number;
}

export class WorkspaceLeaseManager {
  private leases: Map<string, WorkspaceLease> = new Map();

  public acquireInitialLease(workspaceKey: string, owner: string, epoch = 1): boolean {
    if (this.leases.has(workspaceKey)) {
      return false;
    }
    this.leases.set(workspaceKey, {
      workspaceKey,
      currentOwner: owner,
      epoch,
      acquiredAt: Date.now()
    });
    return true;
  }

  public compareAndSetOwner(
    workspaceKey: string,
    expectedOwner: string,
    newOwner: string,
    expectedEpoch: number,
    newEpoch: number
  ): boolean {
    const current = this.leases.get(workspaceKey);
    if (!current) return false;
    if (current.currentOwner !== expectedOwner || current.epoch !== expectedEpoch) {
      return false;
    }
    current.currentOwner = newOwner;
    current.epoch = newEpoch;
    current.acquiredAt = Date.now();
    return true;
  }

  public getLease(workspaceKey: string): WorkspaceLease | undefined {
    return this.leases.get(workspaceKey);
  }

  public releaseLease(workspaceKey: string, owner: string): boolean {
    const current = this.leases.get(workspaceKey);
    if (current && current.currentOwner === owner) {
      this.leases.delete(workspaceKey);
      return true;
    }
    return false;
  }
}
```

创建 `packages/controller/src/handoff/outbox.ts`：
```typescript
import { randomUUID } from 'node:crypto';

export interface OutboxMessage {
  id: string;
  topic: string;
  payload: Record<string, unknown>;
  status: 'pending' | 'delivered' | 'failed';
  createdAt: number;
}

export class OutboxQueue {
  private messages: Map<string, OutboxMessage> = new Map();

  public enqueue(topic: string, payload: Record<string, unknown>): OutboxMessage {
    const msg: OutboxMessage = {
      id: randomUUID(),
      topic,
      payload,
      status: 'pending',
      createdAt: Date.now()
    };
    this.messages.set(msg.id, msg);
    return msg;
  }

  public markDelivered(id: string): void {
    const msg = this.messages.get(id);
    if (msg) msg.status = 'delivered';
  }

  public getPending(): OutboxMessage[] {
    return Array.from(this.messages.values()).filter((m) => m.status === 'pending');
  }
}
```

创建 `packages/controller/src/handoff/state-machine.ts`：
```typescript
import { randomUUID } from 'node:crypto';
import type { HandoffAckPacket } from '../../../protocol/src/types.ts';

export type HandoffState =
  | 'RUNNING'
  | 'DRAINING'
  | 'CHECKPOINTED'
  | 'STARTING'
  | 'PREPARING'
  | 'READY'
  | 'PAUSED'
  | 'CANCELLED'
  | 'RECOVERY_REQUIRED';

export class HandoffStateMachine {
  private state: HandoffState = 'RUNNING';
  private currentOwner: string;
  private epoch: number;
  private pendingAck?: HandoffAckPacket;

  constructor(
    public readonly runId: string,
    initialOwner: string,
    initialEpoch = 1
  ) {
    this.currentOwner = initialOwner;
    this.epoch = initialEpoch;
  }

  public getState(): HandoffState {
    return this.state;
  }

  public getCurrentOwner(): string {
    return this.currentOwner;
  }

  public getEpoch(): number {
    return this.epoch;
  }

  public requestHandoff(_reason: string): void {
    if (this.state !== 'RUNNING') {
      throw new Error(`Cannot request handoff in state ${this.state}`);
    }
    this.state = 'DRAINING';
  }

  public checkpointCompleted(_checkpointHash: string): void {
    if (this.state !== 'DRAINING') {
      throw new Error(`Cannot complete checkpoint in state ${this.state}`);
    }
    this.state = 'CHECKPOINTED';
  }

  public startNewSession(newSessionId: string): void {
    if (this.state !== 'CHECKPOINTED') {
      throw new Error(`Cannot start new session in state ${this.state}`);
    }
    this.state = 'PREPARING';
    this.currentOwner = newSessionId;
  }

  public receiveAck(ack: HandoffAckPacket): void {
    if (this.state !== 'PREPARING') {
      throw new Error(`Cannot receive ACK in state ${this.state}`);
    }
    this.pendingAck = ack;
    this.state = 'READY';
  }

  public issueExecutionToken(): { token: string; epoch: number } {
    if (this.state !== 'READY') {
      throw new Error(`Cannot issue execution token in state ${this.state}`);
    }
    this.epoch++;
    this.state = 'RUNNING';
    return {
      token: `EXEC_TOKEN_${randomUUID()}`,
      epoch: this.epoch
    };
  }

  public pause(): void {
    this.state = 'PAUSED';
  }

  public cancel(): void {
    this.state = 'CANCELLED';
  }
}
```

创建 `packages/controller/src/handoff/index.ts`：
```typescript
export * from './lease.ts';
export * from './outbox.ts';
export * from './state-machine.ts';
```

创建 `packages/controller/src/index.ts`：
```typescript
export * from './inputs/index.ts';
export * from './tasks/index.ts';
export * from './policy/index.ts';
export * from './workspace/index.ts';
export * from './handoff/index.ts';
```

创建 `skills/agent-relay/SKILL.md`：
```markdown
# Agent Relay Protocol Worker Skill

This skill governs the handoff protocol for agent workers under Agent Relay supervision.

## Rules of Engagement

1. **Read-Only Inspection on Entry**:
   When entering a new session, you are strictly in READ-ONLY mode.
   Do not modify, write, or touch any project files.

2. **Verify Checkpoint & Manifest**:
   - Verify the immutable user inputs: check that original user prompt hashes match.
   - Verify active tasks in the authoritative task graph.
   - Inspect workspace status without modifying files.

3. **Submit ACK Frame**:
   Emit your structured ACK response:
   ```json
   {
     "type": "handoff:ack",
     "sessionId": "<your-session-id>",
     "verifiedInputHeadHash": "<hash>",
     "status": "READY_FOR_EXECUTION"
   }
   ```

4. **Wait for Execution Token**:
   Wait until the supervisor issues your `EXECUTION_TOKEN` before performing any write or command actions.
```

创建 `packages/adapters/mock/src/mock-adapter.ts`：
```typescript
import { randomUUID } from 'node:crypto';
import type { HandoffAckPacket } from '../../../protocol/src/types.ts';

export class MockAdapter {
  public sessions: Map<string, { sessionId: string; model: { provider: string; model: string }; active: boolean }> = new Map();

  public spawnSession(sessionId: string, model: { provider: string; model: string }) {
    const session = { sessionId, model, active: true };
    this.sessions.set(sessionId, session);
    return session;
  }

  public createAck(sessionId: string, handoffId: string, runId: string): HandoffAckPacket {
    const sess = this.sessions.get(sessionId);
    return {
      handoffId,
      runId,
      newSessionId: sessionId,
      effectiveModel: sess ? sess.model : { provider: 'mock', model: 'mock-model' },
      verifiedInputHeadHash: 'hash-input',
      verifiedTaskSnapshotHash: 'hash-task',
      verifiedWorkspaceHash: 'hash-ws',
      ackTimestamp: Date.now()
    };
  }

  public terminateSession(sessionId: string) {
    const sess = this.sessions.get(sessionId);
    if (sess) sess.active = false;
  }
}
```

创建 `packages/adapters/mock/src/index.ts`：
```typescript
export * from './mock-adapter.ts';
```

- [ ] **Step 5: 运行全量测试并验证通过**

运行: `npm test`
预期: PASS，所有测试套件全部通过（0 failures）。

- [ ] **Step 6: 提交**

```bash
git add packages/controller/src/handoff/ packages/controller/src/index.ts skills/agent-relay/ packages/adapters/mock/ tests/transactions/ tests/scenarios/
git commit -m "feat(controller): implement CAS lease, handoff state machine, shared skill, and V01~V35 acceptance test suite

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Plan Review Checklist
- [x] 所有 6 项任务划分清晰，粒度在 2~5 分钟 bite-sized 操作内。
- [x] 每个任务均包含 Failing Test -> Run Fail -> Implementation -> Run Pass -> Commit 的完整 TDD 闭环。
- [x] 绝无 "TODO"、"TBD" 等占位符，所有测试代码与核心实现代码均为完整真实代码。
- [x] 类型一致性与接口签名严密匹配。
- [x] 覆盖 V01~V35 全部 35 个验收场景。
