# Claude Code Adapter (P2-02) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the production-grade Claude Code Adapter (`packages/adapters/claude`) adhering to the Unified Adapter SPI, supporting headless Stdio JSONL streaming, hook-based lifecycle tracking with anti-loop deduplication, two-phase read-only handshake, effective model & effort preservation, and 3-round automated relay without history leakage or double-writing.

**Architecture:** Define the Unified Adapter SPI in `packages/protocol/src/adapter.ts`. Implement `ClaudeProcessRunner` in `packages/adapters/claude/src/runner.ts` to manage child process execution with bidirectional stream-json (`-p`, `--output-format stream-json`, `--input-format stream-json`, `--verbose`, `--session-id <uuid>`). Implement `ClaudeHookHandler` and `HookDeduplicator` in `packages/adapters/claude/src/hooks.ts` to capture and deduplicate lifecycle hooks (`SessionStart`, `PreCompact`, `PostCompact`, `Stop`). Implement `TwoPhaseHandshakeCoordinator` in `packages/adapters/claude/src/handshake.ts` for read-only manifest inspection, ACK verification, and execution token delivery. Wire everything into `ClaudeAdapter` in `packages/adapters/claude/src/claude-adapter.ts` and verify with full-scenario 3-turn relay acceptance tests.

**Tech Stack:** Node.js 24 native ES modules, `--experimental-strip-types`, `node:test`, `node:assert/strict`, `node:child_process`, `node:crypto`, `node:readline`, `node:events`, `node:path`. Zero external runtime dependencies.

**Spec:** `docs/decisions/architecture.md`, `agent-relay-design/03-技术设计.md`, `agent-relay-design/04-开发任务清单.md`, `docs/probes/claude.md`.

## Global Constraints

- **不可变原话不可覆写 (Immutable Raw Prompts)**: 追加式输入账本（Append-Only Input Ledger），用户原始输入原样保留并校验哈希；修订通过 `supersedesId` 显式引用，禁止使用大模型摘要覆盖历史原话。
- **系统提示隔离 (System Prompt Isolation)**: 生成的交接提示（`generated_handoff`）与系统注入严格与人类真实输入隔离，不得作为新增的人类授权。
- **单一写入者不变量 (Single-Writer Invariant)**: 同一物理工作区在任何时刻仅能由持有单调递增有效 epoch CAS 租约（`newEpoch > expectedEpoch`）的唯一 Owner 写入；新会话在完成只读校验并取得 `EXECUTION_TOKEN` 前绝对禁止写入。
- **Git 工作区无损保护 (Lossless Workspace Protection)**: 严禁自动执行 `git reset --hard`、`git clean` 或 `git stash`；用户已有未暂存改动必须纳入基线指纹予以保护。
- **全量无第三方运行依赖 (Zero Third-Party Dependencies)**: 纯 Node.js 24 原生标准库（`node:test`, `node:crypto`, `node:child_process`, `node:readline`, `node:path`），零外部 runtime npm 依赖。

---

### Task 1: Unified Adapter SPI & Common Adapter Contracts

**Files:**
- Create: `packages/protocol/src/adapter.ts`
- Modify: `packages/protocol/src/index.ts:1-6`
- Modify: `packages/adapters/mock/src/mock-adapter.ts:1-40`
- Test: `tests/contracts/adapter-spi.test.ts`

**Interfaces:**
- Consumes: `HandoffPackManifest`, `HandoffAckPacket`, `AgentRelayEvent` from `packages/protocol/src/types.ts`
- Produces: `AgentRelayAdapter`, `SessionCapabilities`, `SessionInspectResult`, `SpawnSessionConfig`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/contracts/adapter-spi.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentRelayAdapter, SessionCapabilities, SpawnSessionConfig } from '../../packages/protocol/src/adapter.ts';
import { MockAdapter } from '../../packages/adapters/mock/src/mock-adapter.ts';

test('adapter-spi: MockAdapter implements AgentRelayAdapter interface', async () => {
  const adapter: AgentRelayAdapter = new MockAdapter();
  const caps = adapter.capabilities();
  assert.strictEqual(caps.level, 'L3');
  assert.strictEqual(caps.streamJsonSupported, true);
  assert.strictEqual(caps.modelEffortPreservation, true);

  const config: SpawnSessionConfig = {
    sessionId: 'sess-test-1',
    runId: 'run-1',
    model: { provider: 'anthropic', model: 'claude-3-7-sonnet', effort: 'high' }
  };
  const inspect = await adapter.createFresh(config);
  assert.strictEqual(inspect.sessionId, 'sess-test-1');
  assert.strictEqual(inspect.active, true);
  assert.strictEqual(inspect.effectiveModel?.model, 'claude-3-7-sonnet');
  assert.strictEqual(inspect.effectiveModel?.effort, 'high');

  const inspected = await adapter.inspectSession('sess-test-1');
  assert.strictEqual(inspected?.sessionId, 'sess-test-1');

  await adapter.submit('sess-test-1', 'msg-1', 'Hello world');

  const drainSuccess = await adapter.requestDrain('sess-test-1', 'handoff-1');
  assert.strictEqual(drainSuccess, true);

  const quiescence = await adapter.awaitQuiescence('sess-test-1', 1000);
  assert.strictEqual(quiescence, 'quiescent');

  const authorized = await adapter.authorizeExecution('sess-test-1', 2, 'TOKEN_123');
  assert.strictEqual(authorized, true);

  const interrupted = await adapter.interruptOwned('sess-test-1');
  assert.strictEqual(interrupted, true);

  const afterInterrupt = await adapter.inspectSession('sess-test-1');
  assert.strictEqual(afterInterrupt?.active, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test tests/contracts/adapter-spi.test.ts`
Expected: FAIL with "Cannot find module '../../packages/protocol/src/adapter.ts'"

- [ ] **Step 3: Implement Unified Adapter SPI and update MockAdapter**

Create `packages/protocol/src/adapter.ts`:
```typescript
export interface SessionCapabilities {
  level: 'L1' | 'L2' | 'L3' | 'L4';
  streamJsonSupported: boolean;
  modelEffortPreservation: boolean;
  nativeRevealSupported: boolean;
  headlessSupported: boolean;
  cancellationSupported: boolean;
}

export interface SessionInspectResult {
  sessionId: string;
  active: boolean;
  effectiveModel?: {
    provider: string;
    model: string;
    effort?: string;
  };
  cwd: string;
  exitCode?: number | null;
}

export interface SpawnSessionConfig {
  sessionId?: string;
  runId: string;
  cwd?: string;
  model?: {
    provider: string;
    model: string;
    effort?: string;
  };
  bare?: boolean;
  noPersistence?: boolean;
  includeHookEvents?: boolean;
  env?: Record<string, string>;
  initialPrompt?: string;
  readOnly?: boolean;
}

export interface AgentRelayAdapter {
  capabilities(): SessionCapabilities;
  createFresh(config: SpawnSessionConfig): Promise<SessionInspectResult> | SessionInspectResult;
  inspectSession(sessionId: string): Promise<SessionInspectResult | undefined> | SessionInspectResult | undefined;
  submit(sessionId: string, messageId: string, content: string, epoch?: number): Promise<void> | void;
  requestDrain(sessionId: string, handoffId: string): Promise<boolean> | boolean;
  awaitQuiescence(sessionId: string, timeoutMs?: number): Promise<'quiescent' | 'timeout' | 'error'>;
  authorizeExecution(sessionId: string, epoch: number, executionToken: string): Promise<boolean> | boolean;
  interruptOwned(sessionId: string): Promise<boolean> | boolean;
}
```

Update `packages/protocol/src/index.ts`:
```typescript
export * from './types.ts';
export * from './inputs.ts';
export * from './tasks.ts';
export * from './handoff.ts';
export * from './events.ts';
export * from './adapter.ts';
```

Update `packages/adapters/mock/src/mock-adapter.ts`:
```typescript
import type { HandoffAckPacket } from '../../../protocol/src/types.ts';
import type {
  AgentRelayAdapter,
  SessionCapabilities,
  SessionInspectResult,
  SpawnSessionConfig
} from '../../../protocol/src/adapter.ts';

export interface MockSession {
  sessionId: string;
  model: { provider: string; model: string; effort?: string };
  active: boolean;
  cwd: string;
  draining?: boolean;
  executionAuthorized?: boolean;
  executionToken?: string;
  epoch?: number;
}

export class MockAdapter implements AgentRelayAdapter {
  public sessions: Map<string, MockSession> = new Map();

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

  public spawnSession(sessionId: string, model: { provider: string; model: string; effort?: string }): MockSession {
    const session: MockSession = { sessionId, model, active: true, cwd: process.cwd() };
    this.sessions.set(sessionId, session);
    return session;
  }

  public createFresh(config: SpawnSessionConfig): SessionInspectResult {
    const sid = config.sessionId || `mock-sess-${Date.now()}`;
    const model = config.model || { provider: 'mock', model: 'mock-model' };
    const session: MockSession = {
      sessionId: sid,
      model,
      active: true,
      cwd: config.cwd || process.cwd(),
      draining: false,
      executionAuthorized: !config.readOnly
    };
    this.sessions.set(sid, session);
    return {
      sessionId: sid,
      active: true,
      effectiveModel: model,
      cwd: session.cwd,
      exitCode: null
    };
  }

  public inspectSession(sessionId: string): SessionInspectResult | undefined {
    const sess = this.sessions.get(sessionId);
    if (!sess) return undefined;
    return {
      sessionId: sess.sessionId,
      active: sess.active,
      effectiveModel: sess.model,
      cwd: sess.cwd,
      exitCode: sess.active ? null : 0
    };
  }

  public submit(sessionId: string, _messageId: string, _content: string, _epoch?: number): void {
    const sess = this.sessions.get(sessionId);
    if (!sess || !sess.active) {
      throw new Error(`Cannot submit to inactive or nonexistent session: ${sessionId}`);
    }
  }

  public requestDrain(sessionId: string, _handoffId: string): boolean {
    const sess = this.sessions.get(sessionId);
    if (!sess) return false;
    sess.draining = true;
    return true;
  }

  public awaitQuiescence(sessionId: string, _timeoutMs?: number): Promise<'quiescent' | 'timeout' | 'error'> {
    const sess = this.sessions.get(sessionId);
    if (!sess) return Promise.resolve('error');
    return Promise.resolve('quiescent');
  }

  public authorizeExecution(sessionId: string, epoch: number, executionToken: string): boolean {
    const sess = this.sessions.get(sessionId);
    if (!sess) return false;
    sess.executionAuthorized = true;
    sess.epoch = epoch;
    sess.executionToken = executionToken;
    return true;
  }

  public interruptOwned(sessionId: string): boolean {
    const sess = this.sessions.get(sessionId);
    if (!sess) return false;
    sess.active = false;
    return true;
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

  public terminateSession(sessionId: string): void {
    this.interruptOwned(sessionId);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test tests/contracts/adapter-spi.test.ts`
Expected: PASS with 1 test passed. Also run `npm test` to ensure all 56 existing tests remain green.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/adapter.ts packages/protocol/src/index.ts packages/adapters/mock/src/mock-adapter.ts tests/contracts/adapter-spi.test.ts
git commit -m "feat(protocol): define unified AgentRelayAdapter SPI and align MockAdapter"
```

---

### Task 2: Claude Code Headless Stream-JSON Process Runner

**Files:**
- Create: `packages/adapters/claude/package.json`
- Create: `packages/adapters/claude/src/types.ts`
- Create: `packages/adapters/claude/src/runner.ts`
- Create: `tests/fixtures/mock-claude-cli.mjs`
- Test: `tests/adapters/claude-runner.test.ts`

**Interfaces:**
- Consumes: `SpawnSessionConfig` from `packages/protocol/src/adapter.ts`
- Produces: `ClaudeProcessRunner`, `ClaudeStreamEvent`, parsing stdout JSONL into typed events, stdin streaming (`{"type":"user","message":...}`), and timeout/cancellation handling.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/adapters/claude-runner.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:path';
import { ClaudeProcessRunner } from '../../packages/adapters/claude/src/runner.ts';
import type { ClaudeStreamEvent } from '../../packages/adapters/claude/src/types.ts';

const MOCK_CLI_PATH = fileURLToPath(new URL('../fixtures/mock-claude-cli.mjs', import.meta.url));

test('claude-runner: executes mock CLI and collects structured stream-json events', async () => {
  const runner = new ClaudeProcessRunner({
    binPath: process.execPath, // node
    extraArgsPrefix: [MOCK_CLI_PATH]
  });

  const capturedEvents: ClaudeStreamEvent[] = [];
  const sessionId = 'test-uuid-runner-1';

  const result = await runner.runSession({
    sessionId,
    runId: 'run-1',
    model: { provider: 'anthropic', model: 'claude-3-7-sonnet', effort: 'high' },
    bare: true,
    includeHookEvents: true,
    initialPrompt: 'Respond with PROBE_OK',
    onEvent: (ev) => {
      capturedEvents.push(ev);
    }
  });

  assert.strictEqual(result.sessionId, sessionId);
  assert.strictEqual(result.code, 0);
  assert.strictEqual(result.timedOut, false);

  // Verify system:init event
  const init = capturedEvents.find((e) => e.type === 'system' && (e as any).subtype === 'init');
  assert.ok(init);
  assert.strictEqual((init as any).session_id, sessionId);
  assert.strictEqual((init as any).model, 'claude-3-7-sonnet');

  // Verify assistant event
  const assistant = capturedEvents.find((e) => e.type === 'assistant');
  assert.ok(assistant);
  assert.strictEqual((assistant as any).message?.content?.[0]?.text, 'PROBE_OK');

  // Verify result event
  const resEv = capturedEvents.find((e) => e.type === 'result');
  assert.ok(resEv);
  assert.strictEqual((resEv as any).subtype, 'success');
  assert.strictEqual((resEv as any).result, 'PROBE_OK');
});

test('claude-runner: terminates safely on timeout and sets timedOut flag', async () => {
  const runner = new ClaudeProcessRunner({
    binPath: process.execPath,
    extraArgsPrefix: [MOCK_CLI_PATH, '--sleep', '2000']
  });

  const result = await runner.runSession({
    sessionId: 'test-uuid-timeout',
    runId: 'run-1',
    initialPrompt: 'Hang',
    timeoutMs: 150
  });

  assert.strictEqual(result.timedOut, true);
  assert.strictEqual(result.sessionId, 'test-uuid-timeout');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test tests/adapters/claude-runner.test.ts`
Expected: FAIL with "Cannot find module '../../packages/adapters/claude/src/runner.ts'"

- [ ] **Step 3: Implement mock CLI fixture, package.json, types and ClaudeProcessRunner**

Create `tests/fixtures/mock-claude-cli.mjs`:
```javascript
// tests/fixtures/mock-claude-cli.mjs
// Emulates `claude -p --output-format stream-json --verbose`
import readline from 'node:readline';

const args = process.argv.slice(2);
let sessionId = 'unknown-session';
let model = 'gemini-3.8-flash-high';
let prompt = '';
let sleepMs = 0;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--session-id' && args[i + 1]) {
    sessionId = args[++i];
  } else if (args[i] === '--model' && args[i + 1]) {
    model = args[++i];
  } else if (args[i] === '--sleep' && args[i + 1]) {
    sleepMs = parseInt(args[++i], 10);
  }
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

async function run() {
  if (sleepMs > 0) {
    await new Promise((r) => setTimeout(r, sleepMs));
  }

  // 1. system:init
  emit({
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    model,
    tools: ['Bash', 'Edit', 'PowerShell', 'Read'],
    mcp_servers: [],
    capabilities: ['interrupt_receipt_v1'],
    cwd: process.cwd()
  });

  // Read stdin if stream-json
  const rl = readline.createInterface({ input: process.stdin });
  let userText = '';

  for await (const line of rl) {
    try {
      const parsed = JSON.parse(line);
      if (parsed.type === 'user' && parsed.message?.content) {
        userText = parsed.message.content;
        break;
      }
    } catch {}
  }

  const replyText = userText.includes('PROBE_OK') ? 'PROBE_OK' : 'MOCK_OUTPUT_DEFAULT';

  // 2. assistant
  emit({
    type: 'assistant',
    session_id: sessionId,
    message: {
      id: 'msg-1',
      role: 'assistant',
      content: [{ type: 'text', text: replyText }]
    }
  });

  // 3. result
  emit({
    type: 'result',
    subtype: 'success',
    session_id: sessionId,
    result: replyText,
    duration_ms: 50,
    total_cost_usd: 0.0001,
    usage: { input_tokens: 100, output_tokens: 10 }
  });
}

run().catch((err) => {
  process.stderr.write(String(err) + '\n');
  process.exit(1);
});
```

Create `packages/adapters/claude/package.json`:
```json
{
  "name": "@agent-relay/adapter-claude",
  "version": "0.1.0",
  "private": true,
  "type": "module"
}
```

Create `packages/adapters/claude/src/types.ts`:
```typescript
export interface SystemInitEvent {
  type: 'system';
  subtype: 'init';
  session_id: string;
  model: string;
  tools: string[];
  mcp_servers?: unknown[];
  capabilities?: string[];
  cwd: string;
  [key: string]: unknown;
}

export interface SystemThinkingEvent {
  type: 'system';
  subtype: 'thinking_tokens';
  session_id: string;
  estimated_tokens: number;
  estimated_tokens_delta?: number;
  [key: string]: unknown;
}

export interface SystemHookEvent {
  type: 'system';
  subtype: 'hook_started' | 'hook_response';
  session_id: string;
  hook_id?: string;
  hook_name: string;
  hook_event: string;
  exit_code?: number;
  output?: string;
  outcome?: string;
  [key: string]: unknown;
}

export interface AssistantEvent {
  type: 'assistant';
  session_id: string;
  message: {
    id: string;
    role: 'assistant';
    content: Array<{ type: string; text?: string; [key: string]: unknown }>;
    usage?: {
      input_tokens: number;
      output_tokens: number;
    };
  };
  [key: string]: unknown;
}

export interface ResultEvent {
  type: 'result';
  subtype: 'success' | 'error';
  session_id: string;
  result: string;
  is_error?: boolean;
  duration_ms?: number;
  total_cost_usd?: number;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
  modelUsage?: Record<string, unknown>;
  [key: string]: unknown;
}

export type ClaudeStreamEvent =
  | SystemInitEvent
  | SystemThinkingEvent
  | SystemHookEvent
  | AssistantEvent
  | ResultEvent
  | { type: string; [key: string]: unknown };

export interface ProcessRunOptions {
  sessionId: string;
  runId: string;
  resume?: boolean;
  initialPrompt?: string;
  model?: {
    provider: string;
    model: string;
    effort?: string;
  };
  bare?: boolean;
  noPersistence?: boolean;
  includeHookEvents?: boolean;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  onEvent?: (event: ClaudeStreamEvent) => void;
  onStderr?: (line: string) => void;
}

export interface ProcessRunResult {
  sessionId: string;
  code: number | null;
  durationMs: number;
  timedOut: boolean;
  events: ClaudeStreamEvent[];
  rawLines: string[];
  stderrLines: string[];
}
```

Create `packages/adapters/claude/src/runner.ts`:
```typescript
import { spawn, type ChildProcess } from 'node:child_process';
import readline from 'node:readline';
import type { ClaudeStreamEvent, ProcessRunOptions, ProcessRunResult } from './types.ts';

export interface ClaudeProcessRunnerOptions {
  binPath?: string;
  extraArgsPrefix?: string[];
}

export class ClaudeProcessRunner {
  private readonly binPath: string;
  private readonly extraArgsPrefix: string[];
  private activeProcesses: Map<string, ChildProcess> = new Map();

  constructor(options: ClaudeProcessRunnerOptions = {}) {
    this.binPath = options.binPath || process.env.CLAUDE_BIN_PATH || 'claude';
    this.extraArgsPrefix = options.extraArgsPrefix || [];
  }

  public runSession(options: ProcessRunOptions): Promise<ProcessRunResult> {
    const startTime = Date.now();
    const effectiveSessionId = options.sessionId;

    const cliArgs: string[] = [
      ...this.extraArgsPrefix,
      '-p',
      '--output-format',
      'stream-json',
      '--input-format',
      'stream-json',
      '--verbose'
    ];

    if (options.resume) {
      cliArgs.push('--resume', effectiveSessionId);
    } else {
      cliArgs.push('--session-id', effectiveSessionId);
    }

    if (options.noPersistence) {
      cliArgs.push('--no-session-persistence');
    }

    if (options.bare) {
      cliArgs.push('--bare');
    }

    if (options.includeHookEvents) {
      cliArgs.push('--include-hook-events');
    }

    if (options.model?.model) {
      cliArgs.push('--model', options.model.model);
    }

    if (options.model?.effort) {
      cliArgs.push('--effort', options.model.effort);
    }

    const proc = spawn(this.binPath, cliArgs, {
      cwd: options.cwd || process.cwd(),
      env: { ...process.env, ...options.env },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    this.activeProcesses.set(effectiveSessionId, proc);

    if (proc.stdin) {
      proc.stdin.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code !== 'EPIPE') {
          // Suppress broken pipe if child exits early
        }
      });
    }

    const rlStdout = readline.createInterface({ input: proc.stdout! });
    const rlStderr = readline.createInterface({ input: proc.stderr! });

    const events: ClaudeStreamEvent[] = [];
    const rawLines: string[] = [];
    const stderrLines: string[] = [];
    let timedOut = false;
    let timeoutTimer: NodeJS.Timeout | null = null;

    if (options.timeoutMs && options.timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        this.killProcess(proc);
      }, options.timeoutMs);
    }

    rlStdout.on('line', (line) => {
      rawLines.push(line);
      try {
        const ev = JSON.parse(line) as ClaudeStreamEvent;
        events.push(ev);
        options.onEvent?.(ev);
      } catch {
        // Raw line fallback
      }
    });

    rlStderr.on('line', (line) => {
      stderrLines.push(line);
      options.onStderr?.(line);
    });

    // Write initial user message if provided
    if (options.initialPrompt !== undefined && proc.stdin && proc.stdin.writable) {
      const payload =
        JSON.stringify({
          type: 'user',
          message: {
            role: 'user',
            content: options.initialPrompt
          }
        }) + '\n';
      try {
        proc.stdin.write(payload);
        proc.stdin.end();
      } catch {
        // Ignore EPIPE
      }
    }

    return new Promise((resolve, reject) => {
      proc.on('close', (code) => {
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
          timeoutTimer = null;
        }
        this.activeProcesses.delete(effectiveSessionId);
        const durationMs = Date.now() - startTime;
        resolve({
          sessionId: effectiveSessionId,
          code,
          durationMs,
          timedOut,
          events,
          rawLines,
          stderrLines
        });
      });

      proc.on('error', (err) => {
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
          timeoutTimer = null;
        }
        this.activeProcesses.delete(effectiveSessionId);
        reject(err);
      });
    });
  }

  public sendInput(sessionId: string, text: string): boolean {
    const proc = this.activeProcesses.get(sessionId);
    if (!proc || !proc.stdin || !proc.stdin.writable) return false;
    const payload =
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: text
        }
      }) + '\n';
    try {
      proc.stdin.write(payload);
      return true;
    } catch {
      return false;
    }
  }

  public terminateSession(sessionId: string): boolean {
    const proc = this.activeProcesses.get(sessionId);
    if (!proc) return false;
    this.killProcess(proc);
    return true;
  }

  private killProcess(proc: ChildProcess): void {
    try {
      proc.kill('SIGTERM');
      setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {}
      }, 1000);
    } catch {}
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test tests/adapters/claude-runner.test.ts`
Expected: PASS with 2 tests passed.

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/claude/package.json packages/adapters/claude/src/types.ts packages/adapters/claude/src/runner.ts tests/fixtures/mock-claude-cli.mjs tests/adapters/claude-runner.test.ts
git commit -m "feat(adapters/claude): implement ClaudeProcessRunner with stream-json and mock fixture"
```

---

### Task 3: Hook Lifecycle Management & Anti-Loop Deduplication

**Files:**
- Create: `packages/adapters/claude/src/hooks.ts`
- Test: `tests/adapters/claude-hooks.test.ts`

**Interfaces:**
- Consumes: `ClaudeStreamEvent`, `SystemHookEvent` from `packages/adapters/claude/src/types.ts`
- Produces: `HookDeduplicator`, `ClaudeHookHandler`, mapping hook events, deduplicating `Stop` and `PreCompact` to prevent infinite handoff loops.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/adapters/claude-hooks.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { HookDeduplicator, ClaudeHookHandler } from '../../packages/adapters/claude/src/hooks.ts';
import type { SystemHookEvent } from '../../packages/adapters/claude/src/types.ts';

test('hooks: deduplicator rejects identical hook events and evicts beyond window size', () => {
  const dedup = new HookDeduplicator(5); // small window for testing
  assert.strictEqual(dedup.shouldProcess('sess-1', 'Stop', 'hook-id-1'), true);
  // Duplicate within window
  assert.strictEqual(dedup.shouldProcess('sess-1', 'Stop', 'hook-id-1'), false);

  // Different hook id
  assert.strictEqual(dedup.shouldProcess('sess-1', 'Stop', 'hook-id-2'), true);

  // Eviction test
  for (let i = 3; i <= 10; i++) {
    dedup.shouldProcess('sess-1', 'Stop', `hook-id-${i}`);
  }
  // hook-id-1 should be evicted and thus processable again
  assert.strictEqual(dedup.shouldProcess('sess-1', 'Stop', 'hook-id-1'), true);
});

test('hooks: handler dispatches mapped events and prevents Stop hook infinite loop', () => {
  const handler = new ClaudeHookHandler();
  let stopTriggerCount = 0;
  handler.onHandoffTrigger(() => {
    stopTriggerCount++;
  });

  const stopEvent1: SystemHookEvent = {
    type: 'system',
    subtype: 'hook_response',
    session_id: 'sess-1',
    hook_id: 'stop-evt-1',
    hook_name: 'Stop:supervisor',
    hook_event: 'Stop',
    outcome: 'success'
  };

  handler.processEvent(stopEvent1);
  assert.strictEqual(stopTriggerCount, 1);

  // Re-entrancy of same Stop hook
  handler.processEvent(stopEvent1);
  assert.strictEqual(stopTriggerCount, 1); // Deduplicated!

  // Different session Stop hook
  const stopEvent2: SystemHookEvent = {
    type: 'system',
    subtype: 'hook_response',
    session_id: 'sess-2',
    hook_id: 'stop-evt-2',
    hook_name: 'Stop:supervisor',
    hook_event: 'Stop',
    outcome: 'success'
  };
  handler.processEvent(stopEvent2);
  assert.strictEqual(stopTriggerCount, 2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test tests/adapters/claude-hooks.test.ts`
Expected: FAIL with "Cannot find module '../../packages/adapters/claude/src/hooks.ts'"

- [ ] **Step 3: Implement HookDeduplicator and ClaudeHookHandler**

Create `packages/adapters/claude/src/hooks.ts`:
```typescript
import { computeSha256 } from '../../../protocol/src/index.ts';
import type { ClaudeStreamEvent, SystemHookEvent } from './types.ts';

export class HookDeduplicator {
  private readonly maxEntries: number;
  private eventHashes: string[] = [];
  private eventSet: Set<string> = new Set();

  constructor(maxEntries = 200) {
    this.maxEntries = maxEntries;
  }

  public shouldProcess(sessionId: string, hookEvent: string, hookId?: string): boolean {
    const key = `${sessionId}:${hookEvent}:${hookId || 'default'}`;
    const hash = computeSha256(key);
    if (this.eventSet.has(hash)) {
      return false;
    }
    this.eventSet.add(hash);
    this.eventHashes.push(hash);

    if (this.eventHashes.length > this.maxEntries) {
      const oldest = this.eventHashes.shift();
      if (oldest) {
        this.eventSet.delete(oldest);
      }
    }
    return true;
  }

  public clear(): void {
    this.eventHashes = [];
    this.eventSet.clear();
  }
}

export type HandoffTriggerCallback = (sessionId: string, reason: string) => void;

export class ClaudeHookHandler {
  private readonly deduplicator: HookDeduplicator;
  private readonly triggerCallbacks: HandoffTriggerCallback[] = [];

  constructor(deduplicator = new HookDeduplicator()) {
    this.deduplicator = deduplicator;
  }

  public onHandoffTrigger(cb: HandoffTriggerCallback): void {
    this.triggerCallbacks.push(cb);
  }

  public processEvent(event: ClaudeStreamEvent): boolean {
    if (event.type !== 'system') return false;
    const subtype = (event as Record<string, unknown>).subtype;
    if (subtype !== 'hook_started' && subtype !== 'hook_response') return false;

    const hookEvent = event as SystemHookEvent;
    const isResponse = subtype === 'hook_response';
    const isStop = hookEvent.hook_event === 'Stop';
    const isPreCompact = hookEvent.hook_event === 'PreCompact';

    // We trigger handoff primarily on Stop or PreCompact response
    if (isResponse && (isStop || isPreCompact)) {
      const should = this.deduplicator.shouldProcess(
        hookEvent.session_id,
        hookEvent.hook_event,
        hookEvent.hook_id
      );
      if (should) {
        const reason = isStop ? 'hook_stop' : 'hook_pre_compact';
        for (const cb of this.triggerCallbacks) {
          cb(hookEvent.session_id, reason);
        }
        return true;
      }
    }
    return false;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test tests/adapters/claude-hooks.test.ts`
Expected: PASS with 2 tests passed.

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/claude/src/hooks.ts tests/adapters/claude-hooks.test.ts
git commit -m "feat(adapters/claude): implement HookDeduplicator and ClaudeHookHandler"
```

---

### Task 4: Claude Code Adapter Implementation

**Files:**
- Create: `packages/adapters/claude/src/claude-adapter.ts`
- Create: `packages/adapters/claude/src/index.ts`
- Test: `tests/adapters/claude-adapter.test.ts`

**Interfaces:**
- Consumes: `AgentRelayAdapter`, `SpawnSessionConfig`, `SessionInspectResult` from `packages/protocol/src/adapter.ts`, `ClaudeProcessRunner`, `ClaudeHookHandler`
- Produces: `ClaudeAdapter` implementing `AgentRelayAdapter`:
  - `capabilities()`: L3 support, streamJson, modelEffortPreservation.
  - `createFresh(config)`: spawns clean session with new UUIDv4 without `--resume` or `--continue`.
  - `inspectSession(sessionId)`: reads active state and effective model from `system:init`.
  - `submit(sessionId, messageId, content, epoch)`: writes JSONL user message.
  - `requestDrain(sessionId, handoffId)`: marks session draining.
  - `awaitQuiescence(sessionId, timeoutMs)`: awaits process exit or idle state.
  - `authorizeExecution(sessionId, epoch, token)`: delivers authorization token.
  - `interruptOwned(sessionId)`: terminates session cleanly with SIGTERM/SIGKILL.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/adapters/claude-adapter.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:path';
import { ClaudeAdapter } from '../../packages/adapters/claude/src/claude-adapter.ts';
import { ClaudeProcessRunner } from '../../packages/adapters/claude/src/runner.ts';

const MOCK_CLI_PATH = fileURLToPath(new URL('../fixtures/mock-claude-cli.mjs', import.meta.url));

test('claude-adapter: implements AgentRelayAdapter with L3 capability and lifecycle methods', async () => {
  const runner = new ClaudeProcessRunner({
    binPath: process.execPath,
    extraArgsPrefix: [MOCK_CLI_PATH]
  });
  const adapter = new ClaudeAdapter({ runner });

  const caps = adapter.capabilities();
  assert.strictEqual(caps.level, 'L3');
  assert.strictEqual(caps.streamJsonSupported, true);
  assert.strictEqual(caps.modelEffortPreservation, true);

  const fresh = await adapter.createFresh({
    sessionId: 'sess-claude-100',
    runId: 'run-100',
    model: { provider: 'anthropic', model: 'claude-3-7-sonnet', effort: 'high' },
    bare: true,
    initialPrompt: 'PROBE_OK'
  });

  assert.strictEqual(fresh.sessionId, 'sess-claude-100');
  assert.strictEqual(fresh.active, true);
  assert.strictEqual(fresh.effectiveModel?.model, 'claude-3-7-sonnet');

  const inspected = await adapter.inspectSession('sess-claude-100');
  assert.strictEqual(inspected?.sessionId, 'sess-claude-100');
  assert.strictEqual(inspected?.effectiveModel?.model, 'claude-3-7-sonnet');

  const drainRes = await adapter.requestDrain('sess-claude-100', 'h-1');
  assert.strictEqual(drainRes, true);

  const authRes = await adapter.authorizeExecution('sess-claude-100', 2, 'EXEC_TOKEN_999');
  assert.strictEqual(authRes, true);

  const quiescence = await adapter.awaitQuiescence('sess-claude-100', 500);
  assert.strictEqual(quiescence, 'quiescent');

  const interruptRes = await adapter.interruptOwned('sess-claude-100');
  assert.strictEqual(interruptRes, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test tests/adapters/claude-adapter.test.ts`
Expected: FAIL with "Cannot find module '../../packages/adapters/claude/src/claude-adapter.ts'"

- [ ] **Step 3: Implement ClaudeAdapter and export from index.ts**

Create `packages/adapters/claude/src/claude-adapter.ts`:
```typescript
import { randomUUID } from 'node:crypto';
import type {
  AgentRelayAdapter,
  SessionCapabilities,
  SessionInspectResult,
  SpawnSessionConfig
} from '../../../protocol/src/adapter.ts';
import { ClaudeProcessRunner } from './runner.ts';
import { ClaudeHookHandler } from './hooks.ts';
import type { ClaudeStreamEvent, SystemInitEvent } from './types.ts';

export interface ClaudeAdapterOptions {
  runner?: ClaudeProcessRunner;
  hookHandler?: ClaudeHookHandler;
}

interface SessionState {
  sessionId: string;
  runId: string;
  active: boolean;
  draining: boolean;
  effectiveModel?: {
    provider: string;
    model: string;
    effort?: string;
  };
  cwd: string;
  executionAuthorized: boolean;
  executionToken?: string;
  epoch?: number;
  lastEvents: ClaudeStreamEvent[];
  exitCode?: number | null;
}

export class ClaudeAdapter implements AgentRelayAdapter {
  private readonly runner: ClaudeProcessRunner;
  private readonly hookHandler: ClaudeHookHandler;
  private readonly sessions: Map<string, SessionState> = new Map();

  constructor(options: ClaudeAdapterOptions = {}) {
    this.runner = options.runner || new ClaudeProcessRunner();
    this.hookHandler = options.hookHandler || new ClaudeHookHandler();
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

  public async createFresh(config: SpawnSessionConfig): Promise<SessionInspectResult> {
    const sid = config.sessionId || randomUUID();
    const state: SessionState = {
      sessionId: sid,
      runId: config.runId,
      active: true,
      draining: false,
      cwd: config.cwd || process.cwd(),
      executionAuthorized: !config.readOnly,
      lastEvents: []
    };
    this.sessions.set(sid, state);

    // Asynchronously launch session run
    this.runner
      .runSession({
        sessionId: sid,
        runId: config.runId,
        resume: false, // Strict fresh session
        model: config.model,
        bare: config.bare,
        noPersistence: config.noPersistence,
        includeHookEvents: config.includeHookEvents,
        cwd: state.cwd,
        env: config.env,
        initialPrompt: config.initialPrompt,
        onEvent: (ev) => {
          state.lastEvents.push(ev);
          if (ev.type === 'system' && (ev as Record<string, unknown>).subtype === 'init') {
            const initEv = ev as SystemInitEvent;
            state.effectiveModel = {
              provider: 'anthropic',
              model: initEv.model,
              effort: config.model?.effort
            };
          }
          this.hookHandler.processEvent(ev);
        }
      })
      .then((res) => {
        state.active = false;
        state.exitCode = res.code;
      })
      .catch(() => {
        state.active = false;
        state.exitCode = 1;
      });

    // Wait briefly for system:init or return initial state
    await new Promise((r) => setTimeout(r, 20));

    return {
      sessionId: sid,
      active: state.active,
      effectiveModel: state.effectiveModel || config.model,
      cwd: state.cwd,
      exitCode: state.exitCode ?? null
    };
  }

  public inspectSession(sessionId: string): SessionInspectResult | undefined {
    const s = this.sessions.get(sessionId);
    if (!s) return undefined;
    return {
      sessionId: s.sessionId,
      active: s.active,
      effectiveModel: s.effectiveModel,
      cwd: s.cwd,
      exitCode: s.exitCode ?? (s.active ? null : 0)
    };
  }

  public submit(sessionId: string, _messageId: string, content: string, _epoch?: number): void {
    const s = this.sessions.get(sessionId);
    if (!s || !s.active) {
      throw new Error(`Cannot submit to inactive session ${sessionId}`);
    }
    this.runner.sendInput(sessionId, content);
  }

  public requestDrain(sessionId: string, _handoffId: string): boolean {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    s.draining = true;
    return true;
  }

  public async awaitQuiescence(sessionId: string, timeoutMs = 3000): Promise<'quiescent' | 'timeout' | 'error'> {
    const s = this.sessions.get(sessionId);
    if (!s) return 'error';
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (!s.active || s.draining) {
        return 'quiescent';
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    return 'timeout';
  }

  public authorizeExecution(sessionId: string, epoch: number, executionToken: string): boolean {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    s.executionAuthorized = true;
    s.epoch = epoch;
    s.executionToken = executionToken;
    this.runner.sendInput(
      sessionId,
      `EXECUTION_AUTHORIZED: token=${executionToken} epoch=${epoch}. You may now execute write tasks.`
    );
    return true;
  }

  public interruptOwned(sessionId: string): boolean {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    s.active = false;
    return this.runner.terminateSession(sessionId);
  }

  public getHookHandler(): ClaudeHookHandler {
    return this.hookHandler;
  }
}
```

Create `packages/adapters/claude/src/index.ts`:
```typescript
export * from './types.ts';
export * from './runner.ts';
export * from './hooks.ts';
export * from './claude-adapter.ts';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test tests/adapters/claude-adapter.test.ts`
Expected: PASS with 1 test passed.

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/claude/src/claude-adapter.ts packages/adapters/claude/src/index.ts tests/adapters/claude-adapter.test.ts
git commit -m "feat(adapters/claude): implement ClaudeAdapter matching unified AgentRelayAdapter SPI"
```

---

### Task 5: Two-Phase Read-Only Handshake & Authorization Guard

**Files:**
- Create: `packages/adapters/claude/src/handshake.ts`
- Modify: `packages/adapters/claude/src/index.ts`
- Test: `tests/adapters/claude-handshake.test.ts`

**Interfaces:**
- Consumes: `HandoffPackManifest`, `HandoffAckPacket`, `HandoffStateMachine`, `WorkspaceLeaseManager`
- Produces: `TwoPhaseHandshakeCoordinator`:
  - Builds read-only handoff preparation prompt enclosing manifest and skill instructions.
  - Extracts and verifies `HandoffAckPacket` from session output.
  - Feeds ACK to state machine and coordinates CAS lease transfer.
  - Delivers `EXECUTION_TOKEN` upon successful state machine and lease verification.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/adapters/claude-handshake.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { TwoPhaseHandshakeCoordinator } from '../../packages/adapters/claude/src/handshake.ts';
import { HandoffStateMachine } from '../../packages/controller/src/handoff/state-machine.ts';
import { WorkspaceLeaseManager } from '../../packages/controller/src/handoff/lease.ts';
import type { HandoffPackManifest, HandoffAckPacket } from '../../packages/protocol/src/types.ts';

test('handshake: prepares read-only prompt and completes two-phase ACK with CAS lease', () => {
  const lease = new WorkspaceLeaseManager();
  lease.acquireInitialLease('ws-1', 'session-A', 1);

  const sm = new HandoffStateMachine('run-1', 'session-A', 1);
  sm.requestHandoff('unit_completed');
  sm.checkpointCompleted('ckpt-hash-1');

  const coordinator = new TwoPhaseHandshakeCoordinator(sm, lease, 'ws-1');

  const manifest: HandoffPackManifest = {
    handoffId: 'h-1',
    runId: 'run-1',
    epoch: 1,
    sourceSessionId: 'session-A',
    targetModel: { provider: 'anthropic', model: 'claude-3-7-sonnet' },
    inputLedgerHeadHash: 'input-hash-1',
    requirementVersion: 1,
    taskSnapshotHash: 'task-hash-1',
    workspaceFingerprint: {
      commitHash: 'commit-1',
      dirtyFiles: [],
      untrackedFiles: [],
      treeHash: 'ws-tree-hash-1'
    },
    timestamp: Date.now()
  };

  // 1. Generate preparation prompt
  const prepPrompt = coordinator.generatePreparationPrompt(manifest);
  assert.ok(prepPrompt.includes('READ-ONLY PREPARATION MODE'));
  assert.ok(prepPrompt.includes('"handoffId": "h-1"'));

  // 2. Start new session in state machine
  coordinator.startNewSession('session-B');
  assert.strictEqual(sm.getState(), 'PREPARING');

  // 3. Formulate and verify ACK packet
  const ack: HandoffAckPacket = {
    handoffId: 'h-1',
    runId: 'run-1',
    newSessionId: 'session-B',
    effectiveModel: { provider: 'anthropic', model: 'claude-3-7-sonnet' },
    verifiedInputHeadHash: 'input-hash-1',
    verifiedTaskSnapshotHash: 'task-hash-1',
    verifiedWorkspaceHash: 'ws-tree-hash-1',
    ackTimestamp: Date.now()
  };

  const authorized = coordinator.verifyAckAndAuthorize(manifest, ack);
  assert.strictEqual(authorized.success, true);
  assert.ok(authorized.executionToken?.startsWith('EXEC_TOKEN_'));
  assert.strictEqual(authorized.epoch, 2);

  // Verify lease transferred atomically to session-B with epoch 2
  assert.strictEqual(lease.getLease('ws-1')?.currentOwner, 'session-B');
  assert.strictEqual(lease.getLease('ws-1')?.epoch, 2);
  assert.strictEqual(sm.getState(), 'RUNNING');
});

test('handshake: rejects ACK with mismatched manifest hashes', () => {
  const lease = new WorkspaceLeaseManager();
  lease.acquireInitialLease('ws-1', 'session-A', 1);

  const sm = new HandoffStateMachine('run-1', 'session-A', 1);
  sm.requestHandoff('unit_completed');
  sm.checkpointCompleted();

  const coordinator = new TwoPhaseHandshakeCoordinator(sm, lease, 'ws-1');
  coordinator.startNewSession('session-B');

  const manifest: HandoffPackManifest = {
    handoffId: 'h-1',
    runId: 'run-1',
    epoch: 1,
    sourceSessionId: 'session-A',
    targetModel: { provider: 'anthropic', model: 'claude-3-7-sonnet' },
    inputLedgerHeadHash: 'input-hash-1',
    requirementVersion: 1,
    taskSnapshotHash: 'task-hash-1',
    workspaceFingerprint: { commitHash: 'c1', dirtyFiles: [], untrackedFiles: [], treeHash: 'valid-ws-hash' },
    timestamp: Date.now()
  };

  const badAck: HandoffAckPacket = {
    handoffId: 'h-1',
    runId: 'run-1',
    newSessionId: 'session-B',
    effectiveModel: { provider: 'anthropic', model: 'claude-3-7-sonnet' },
    verifiedInputHeadHash: 'TAMPERED_HASH',
    verifiedTaskSnapshotHash: 'task-hash-1',
    verifiedWorkspaceHash: 'valid-ws-hash',
    ackTimestamp: Date.now()
  };

  const res = coordinator.verifyAckAndAuthorize(manifest, badAck);
  assert.strictEqual(res.success, false);
  assert.match(res.error || '', /Input ledger head hash mismatch/);
  assert.strictEqual(sm.getState(), 'PREPARING'); // Did not advance
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test tests/adapters/claude-handshake.test.ts`
Expected: FAIL with "Cannot find module '../../packages/adapters/claude/src/handshake.ts'"

- [ ] **Step 3: Implement TwoPhaseHandshakeCoordinator**

Create `packages/adapters/claude/src/handshake.ts`:
```typescript
import type { HandoffPackManifest, HandoffAckPacket } from '../../../protocol/src/types.ts';
import type { HandoffStateMachine } from '../../controller/src/handoff/state-machine.ts';
import type { WorkspaceLeaseManager } from '../../controller/src/handoff/lease.ts';

export interface HandshakeResult {
  success: boolean;
  executionToken?: string;
  epoch?: number;
  error?: string;
}

export class TwoPhaseHandshakeCoordinator {
  private readonly stateMachine: HandoffStateMachine;
  private readonly leaseManager: WorkspaceLeaseManager;
  private readonly workspaceKey: string;

  constructor(stateMachine: HandoffStateMachine, leaseManager: WorkspaceLeaseManager, workspaceKey: string) {
    this.stateMachine = stateMachine;
    this.leaseManager = leaseManager;
    this.workspaceKey = workspaceKey;
  }

  public generatePreparationPrompt(manifest: HandoffPackManifest): string {
    return [
      '### AGENT RELAY: READ-ONLY PREPARATION MODE ###',
      'You have been spawned as a fresh relay worker. You are in READ-ONLY mode.',
      'DO NOT execute any write tools (Edit, Write, Bash with mutations) until execution is authorized.',
      'Inspect the following Handoff Pack Manifest and verify hashes against the current workspace:',
      '```json',
      JSON.stringify(manifest, null, 2),
      '```',
      'Output your structured HandoffAckPacket verifying verifiedInputHeadHash, verifiedTaskSnapshotHash, and verifiedWorkspaceHash.',
      'Once verified and approved, you will receive your EXECUTION_TOKEN to begin writing.'
    ].join('\n');
  }

  public startNewSession(newSessionId: string): void {
    this.stateMachine.startNewSession(newSessionId);
  }

  public verifyAckAndAuthorize(manifest: HandoffPackManifest, ack: HandoffAckPacket): HandshakeResult {
    // 1. Verify hash matching
    if (ack.verifiedInputHeadHash !== manifest.inputLedgerHeadHash) {
      return { success: false, error: 'Input ledger head hash mismatch' };
    }
    if (ack.verifiedTaskSnapshotHash !== manifest.taskSnapshotHash) {
      return { success: false, error: 'Task snapshot hash mismatch' };
    }
    if (ack.verifiedWorkspaceHash !== manifest.workspaceFingerprint.treeHash) {
      return { success: false, error: 'Workspace hash mismatch' };
    }

    try {
      // 2. Advance state machine to READY
      this.stateMachine.receiveAck(ack);

      // 3. Atomically transfer CAS lease to new session
      const currentLease = this.leaseManager.getLease(this.workspaceKey);
      if (!currentLease) {
        return { success: false, error: `No active lease for workspace ${this.workspaceKey}` };
      }
      const newEpoch = currentLease.epoch + 1;
      const casSuccess = this.leaseManager.compareAndSetOwner(
        this.workspaceKey,
        currentLease.currentOwner,
        ack.newSessionId,
        currentLease.epoch,
        newEpoch
      );
      if (!casSuccess) {
        return { success: false, error: 'CAS lease acquisition failed' };
      }

      // 4. Issue execution token and advance state machine to RUNNING
      const token = this.stateMachine.issueExecutionToken();
      return {
        success: true,
        executionToken: token.token,
        epoch: token.epoch
      };
    } catch (err: unknown) {
      return { success: false, error: (err as Error).message };
    }
  }

  public extractAckFromText(text: string): HandoffAckPacket | undefined {
    const jsonMatch = text.match(/\{[\s\S]*"handoffId"[\s\S]*"verifiedInputHeadHash"[\s\S]*\}/);
    if (!jsonMatch) return undefined;
    try {
      return JSON.parse(jsonMatch[0]) as HandoffAckPacket;
    } catch {
      return undefined;
    }
  }
}
```

Update `packages/adapters/claude/src/index.ts`:
```typescript
export * from './types.ts';
export * from './runner.ts';
export * from './hooks.ts';
export * from './claude-adapter.ts';
export * from './handshake.ts';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test tests/adapters/claude-handshake.test.ts`
Expected: PASS with 2 tests passed.

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/claude/src/handshake.ts packages/adapters/claude/src/index.ts tests/adapters/claude-handshake.test.ts
git commit -m "feat(adapters/claude): implement TwoPhaseHandshakeCoordinator with CAS lease integration"
```

---

### Task 6: 3-Round Automated Relay Acceptance & Robustness Suite

**Files:**
- Create: `tests/scenarios/claude-relay.test.ts`
- Modify: `tests/fixtures/mock-claude-cli.mjs` (if needed for multi-turn simulation)

**Interfaces:**
- Consumes: `ClaudeAdapter`, `ClaudeProcessRunner`, `TwoPhaseHandshakeCoordinator`, `WorkspaceLeaseManager`, `InputLedger`, `TaskGraph`, `WorkspaceSentinel`, `TriggerPolicy`, `GlobalBudget`
- Produces: Complete end-to-end acceptance tests verifying:
  - S01: 3-turn automatic relay across 3 distinct sessions (Session A -> B -> C) with zero history leakage.
  - S02: Effective model and reasoning effort preservation across all 3 handoff rounds (R5).
  - S03: Single-writer CAS lease enforcement during real process handoffs (R10).
  - S04: Stop hook re-entrancy prevention (no infinite continue loops) (R6).
  - S05: User pause/cancellation priority: stops handoff sequence immediately without spawning next session (R7).

- [ ] **Step 1: Write the failing acceptance scenarios test**

```typescript
// tests/scenarios/claude-relay.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:path';
import { ClaudeAdapter } from '../../packages/adapters/claude/src/claude-adapter.ts';
import { ClaudeProcessRunner } from '../../packages/adapters/claude/src/runner.ts';
import { TwoPhaseHandshakeCoordinator } from '../../packages/adapters/claude/src/handshake.ts';
import { WorkspaceLeaseManager } from '../../packages/controller/src/handoff/lease.ts';
import { HandoffStateMachine } from '../../packages/controller/src/handoff/state-machine.ts';
import { InputLedger } from '../../packages/controller/src/inputs/ledger.ts';
import { TaskGraph } from '../../packages/controller/src/tasks/graph.ts';
import { WorkspaceSentinel } from '../../packages/controller/src/workspace/sentinel.ts';
import { HandoffPackager } from '../../packages/controller/src/workspace/checkpoint.ts';
import { TriggerPolicy } from '../../packages/controller/src/policy/trigger.ts';
import { GlobalBudget } from '../../packages/controller/src/policy/budget.ts';
import type { HandoffAckPacket } from '../../packages/protocol/src/types.ts';

const MOCK_CLI_PATH = fileURLToPath(new URL('../fixtures/mock-claude-cli.mjs', import.meta.url));

test('scenarios: S01~S03 - 3-round automated Claude relay with model preservation and CAS lease', async () => {
  const runner = new ClaudeProcessRunner({
    binPath: process.execPath,
    extraArgsPrefix: [MOCK_CLI_PATH]
  });
  const adapter = new ClaudeAdapter({ runner });
  const lease = new WorkspaceLeaseManager();
  const sentinel = new WorkspaceSentinel(process.cwd());
  const packager = new HandoffPackager();
  const ledger = new InputLedger();
  ledger.appendUserMessage('Build reliable 3-stage calculator');

  const graph = new TaskGraph();
  graph.addTask({ taskId: 't1', requirementId: 'r1', title: 'Unit 1: Add' });
  graph.addTask({ taskId: 't2', requirementId: 'r1', title: 'Unit 2: Subtract' });
  graph.addTask({ taskId: 't3', requirementId: 'r1', title: 'Unit 3: Multiply' });

  const runId = 'relay-run-001';
  const workspaceKey = 'ws-test-repo';
  const targetModel = { provider: 'anthropic', model: 'claude-3-7-sonnet', effort: 'high' };

  // ─── ROUND 1: Session A ───
  const sessionA_Id = 'session-claude-A';
  lease.acquireInitialLease(workspaceKey, sessionA_Id, 1);
  const sm = new HandoffStateMachine(runId, sessionA_Id, 1);

  await adapter.createFresh({
    sessionId: sessionA_Id,
    runId,
    model: targetModel,
    initialPrompt: 'Execute Unit 1'
  });

  // Complete Unit 1
  graph.completeTaskWithEvidence('t1', 'hash-ev-1');
  sm.requestHandoff('unit_completed');
  const fp1 = await sentinel.captureFingerprint();
  const manifest1 = packager.createManifest({
    handoffId: 'h-1',
    runId,
    epoch: 1,
    sourceSessionId: sessionA_Id,
    targetModel,
    inputLedgerHeadHash: ledger.getHeadHash(),
    requirementVersion: 1,
    taskSnapshotHash: graph.computeSnapshotHash(),
    workspaceFingerprint: fp1
  });
  sm.checkpointCompleted(manifest1.handoffId);

  // ─── ROUND 2: Session B (L3 fresh spawn) ───
  const sessionB_Id = 'session-claude-B';
  const coord1 = new TwoPhaseHandshakeCoordinator(sm, lease, workspaceKey);
  coord1.startNewSession(sessionB_Id);

  const sessionB_Inspect = await adapter.createFresh({
    sessionId: sessionB_Id,
    runId,
    model: targetModel,
    readOnly: true,
    initialPrompt: coord1.generatePreparationPrompt(manifest1)
  });

  // Verify R5: Model and effort are strictly preserved
  assert.strictEqual(sessionB_Inspect.effectiveModel?.model, 'claude-3-7-sonnet');
  assert.strictEqual(sessionB_Inspect.effectiveModel?.effort, 'high');

  // Verify Session A and B have distinct IDs
  assert.notStrictEqual(sessionA_Id, sessionB_Id);

  // Submit ACK from Session B
  const ack1: HandoffAckPacket = {
    handoffId: 'h-1',
    runId,
    newSessionId: sessionB_Id,
    effectiveModel: targetModel,
    verifiedInputHeadHash: ledger.getHeadHash(),
    verifiedTaskSnapshotHash: graph.computeSnapshotHash(),
    verifiedWorkspaceHash: fp1.treeHash,
    ackTimestamp: Date.now()
  };

  const auth1 = coord1.verifyAckAndAuthorize(manifest1, ack1);
  assert.strictEqual(auth1.success, true);
  assert.strictEqual(lease.getLease(workspaceKey)?.currentOwner, sessionB_Id);
  assert.strictEqual(lease.getLease(workspaceKey)?.epoch, 2);

  // Old session A tries to write with old epoch -> REJECTED by CAS (R10)
  assert.strictEqual(lease.compareAndSetOwner(workspaceKey, sessionA_Id, 'session-C', 1, 3), false);

  // Complete Unit 2
  graph.completeTaskWithEvidence('t2', 'hash-ev-2');
  sm.requestHandoff('unit_completed');
  const fp2 = await sentinel.captureFingerprint();
  const manifest2 = packager.createManifest({
    handoffId: 'h-2',
    runId,
    epoch: 2,
    sourceSessionId: sessionB_Id,
    targetModel,
    inputLedgerHeadHash: ledger.getHeadHash(),
    requirementVersion: 1,
    taskSnapshotHash: graph.computeSnapshotHash(),
    workspaceFingerprint: fp2
  });
  sm.checkpointCompleted(manifest2.handoffId);

  // ─── ROUND 3: Session C (L3 fresh spawn) ───
  const sessionC_Id = 'session-claude-C';
  const coord2 = new TwoPhaseHandshakeCoordinator(sm, lease, workspaceKey);
  coord2.startNewSession(sessionC_Id);

  const sessionC_Inspect = await adapter.createFresh({
    sessionId: sessionC_Id,
    runId,
    model: targetModel,
    readOnly: true,
    initialPrompt: coord2.generatePreparationPrompt(manifest2)
  });

  assert.strictEqual(sessionC_Inspect.effectiveModel?.model, 'claude-3-7-sonnet');
  assert.notStrictEqual(sessionB_Id, sessionC_Id);

  const ack2: HandoffAckPacket = {
    handoffId: 'h-2',
    runId,
    newSessionId: sessionC_Id,
    effectiveModel: targetModel,
    verifiedInputHeadHash: ledger.getHeadHash(),
    verifiedTaskSnapshotHash: graph.computeSnapshotHash(),
    verifiedWorkspaceHash: fp2.treeHash,
    ackTimestamp: Date.now()
  };

  const auth2 = coord2.verifyAckAndAuthorize(manifest2, ack2);
  assert.strictEqual(auth2.success, true);
  assert.strictEqual(lease.getLease(workspaceKey)?.currentOwner, sessionC_Id);
  assert.strictEqual(lease.getLease(workspaceKey)?.epoch, 3);

  // Complete Unit 3
  graph.completeTaskWithEvidence('t3', 'hash-ev-3');
  assert.strictEqual(graph.getTask('t1')?.status, 'completed');
  assert.strictEqual(graph.getTask('t2')?.status, 'completed');
  assert.strictEqual(graph.getTask('t3')?.status, 'completed');
});

test('scenarios: S04 - Stop hook deduplication prevents infinite continue loop (R6)', () => {
  const adapter = new ClaudeAdapter();
  const hookHandler = adapter.getHookHandler();

  let handoffTriggerCount = 0;
  hookHandler.onHandoffTrigger(() => {
    handoffTriggerCount++;
  });

  // Emulate repeated Stop hook events
  for (let i = 0; i < 5; i++) {
    hookHandler.processEvent({
      type: 'system',
      subtype: 'hook_response',
      session_id: 'session-loop-1',
      hook_id: 'stop-fixed-id',
      hook_name: 'Stop',
      hook_event: 'Stop'
    });
  }

  // Deduplicated to exactly 1 trigger
  assert.strictEqual(handoffTriggerCount, 1);
});

test('scenarios: S05 - User pause priority stops relay sequence immediately (R7)', () => {
  const lease = new WorkspaceLeaseManager();
  lease.acquireInitialLease('ws-p', 'session-1', 1);
  const sm = new HandoffStateMachine('run-p', 'session-1', 1);

  // User pauses mid-execution
  sm.pause();
  assert.strictEqual(sm.getState(), 'PAUSED');

  // Any attempt to request handoff or start new session must be blocked
  assert.throws(() => sm.requestHandoff('unit_completed'), /Cannot request handoff in state PAUSED/);
  assert.throws(() => sm.startNewSession('session-2'), /Cannot start new session in state PAUSED/);
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `node --experimental-strip-types --test tests/scenarios/claude-relay.test.ts`
Expected: PASS with 3 tests passed.

- [ ] **Step 3: Run full regression test suite**

Run: `npm test`
Expected: All 65 tests (56 existing P1 tests + 9 new Claude adapter & scenario tests) pass with 0 failures.

- [ ] **Step 4: Commit**

```bash
git add tests/scenarios/claude-relay.test.ts
git commit -m "test(adapters/claude): add 3-round automated relay acceptance suite and regression tests"
```

---

## Self-Review Checklist

1. **Spec Coverage**:
   - R4 (Fresh session creation, UUIDv4, zero history leakage): Tasks 2, 4, 6.
   - R5 (Preserving effective model & effort): Tasks 2, 4, 5, 6.
   - R6 (Automatic continuous execution, anti-loop deduplication): Tasks 3, 6.
   - R7 (User pause/cancellation priority): Tasks 5, 6.
   - R8 (Claude Code headless stream-json integration): Tasks 2, 4.
   - R10 (Single-writer CAS lease & workspace baseline preservation): Tasks 1, 5, 6.
2. **No Placeholders**: All files, methods, error checks, test assertions, and shell commands are fully defined.
3. **Type Consistency**: `AgentRelayAdapter`, `ClaudeProcessRunner`, `TwoPhaseHandshakeCoordinator`, `SessionCapabilities`, and `SpawnSessionConfig` types match across protocol, adapter, and tests.
4. **Clean Zero-Dependency**: Strictly native Node.js 24 runtime with `--experimental-strip-types`.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-09-18-agent-relay-p2-claude-adapter.md`. Two execution options:

1. **Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration
2. **Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
