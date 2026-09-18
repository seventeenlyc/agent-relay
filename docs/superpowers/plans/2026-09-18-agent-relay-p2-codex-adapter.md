# Codex Adapter (P2-01) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the production-grade Codex Adapter (`packages/adapters/codex`) adhering to the Unified Adapter SPI (`AgentRelayAdapter`), communicating over Stdio JSON-RPC 2.0 with `codex app-server --stdio`, supporting independent UUIDv7 thread isolation, event-driven quiescence tracking (`thread/status/changed`, `turn/completed`), `turn/interrupt` cancellation, model & reasoning effort preservation (`gpt-5.6-luna`, `xhigh`), two-phase read-only handshake with atomic CAS workspace lease, and 3-round automated relay without history leakage or double-writing.

**Architecture:** Implement JSON-RPC 2.0 transport over child process Stdio in `CodexProcessRunner` (`packages/adapters/codex/src/runner.ts`). Wrap RPC methods (`initialize`, `thread/start`, `turn/start`, `turn/interrupt`, `thread/read`) and notifications into `CodexAdapter` (`packages/adapters/codex/src/codex-adapter.ts`) implementing `AgentRelayAdapter`. Implement `CodexHandshakeCoordinator` in `packages/adapters/codex/src/handshake.ts` to coordinate read-only preparation prompt injection, verification of 3D cryptographic hashes, and atomic CAS lease progression. Verify the entire system with comprehensive unit, contract, and 3-round end-to-end acceptance tests.

**Tech Stack:** Node.js 24 native ES modules, `--experimental-strip-types`, `node:test`, `node:assert/strict`, `node:child_process`, `node:crypto`, `node:readline`, `node:events`, `node:path`. Zero external runtime npm dependencies.

**Spec:** `docs/probes/codex.md`, `packages/protocol/src/adapter.ts`, `agent-relay-design/03-技术设计.md`, `agent-relay-design/04-开发任务清单.md`.

## Global Constraints

- **不可变原话不可覆写 (Immutable Raw Prompts)**: 追加式输入账本（Append-Only Input Ledger），用户原始输入原样保留并校验哈希；修订通过 `supersedesId` 显式引用，禁止使用大模型摘要覆盖历史原话。
- **系统提示隔离 (System Prompt Isolation)**: 生成的交接提示（`generated_handoff`）与系统注入严格与人类真实输入隔离，不得作为新增的人类授权。
- **单一写入者不变量 (Single-Writer Invariant)**: 同一物理工作区在任何时刻仅能由持有单调递增有效 epoch CAS 租约（`newEpoch > expectedEpoch`）的唯一 Owner 写入；新会话在完成只读校验并取得 `EXECUTION_TOKEN` 前绝对禁止写入。
- **Git 工作区无损保护 (Lossless Workspace Protection)**: 严禁自动执行 `git reset --hard`、`git clean` 或 `git stash`；用户已有未暂存改动必须纳入基线指纹予以保护。
- **全量无第三方运行依赖 (Zero Third-Party Dependencies)**: 纯 Node.js 24 原生标准库（`node:test`, `node:crypto`, `node:child_process`, `node:readline`, `node:path`），零外部 runtime npm 依赖。
- **未物化线程读保护 (Unmaterialized Thread Read Guard)**: 在首个用户消息提交前禁止发起 `thread/read(includeTurns: true)`，避免触发 Codex 服务端 -32600 协议错误。

---

### Task 1: Codex JSON-RPC 2.0 Protocol Types & Mock App-Server Fixture

**Files:**
- Create: `packages/adapters/codex/package.json`
- Create: `packages/adapters/codex/src/types.ts`
- Create: `tests/fixtures/mock-codex-app-server.mjs`
- Test: `tests/adapters/codex-fixture.test.ts`

**Interfaces:**
- Consumes: JSON-RPC 2.0 specification, `docs/probes/codex.md`
- Produces: `JsonRpcRequest`, `JsonRpcResponse`, `JsonRpcNotification`, `ThreadStartParams`, `ThreadStartResponse`, `TurnStartParams`, `TurnStartResponse`, `TurnInterruptParams`, `ServerNotification`, and mock executable `mock-codex-app-server.mjs`.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/adapters/codex-fixture.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const MOCK_SERVER_PATH = fileURLToPath(new URL('../fixtures/mock-codex-app-server.mjs', import.meta.url));

test('codex-fixture: mock app-server starts and handles initialize, thread/start, and turn/start via JSON-RPC 2.0', async () => {
  const proc = spawn(process.execPath, [MOCK_SERVER_PATH], {
    stdio: ['pipe', 'pipe', 'pipe']
  });

  const rl = readline.createInterface({ input: proc.stdout! });
  const responses: any[] = [];
  const notifications: any[] = [];

  rl.on('line', (line) => {
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined) {
        responses.push(msg);
      } else if (msg.method) {
        notifications.push(msg);
      }
    } catch {}
  });

  // 1. Send initialize
  proc.stdin!.write(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'test-runner', version: '0.1.0' } }
    }) + '\n'
  );

  // 2. Send thread/start
  proc.stdin!.write(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'thread/start',
      params: { cwd: process.cwd(), model: 'gpt-5.6-luna' }
    }) + '\n'
  );

  // Wait for responses
  await new Promise((r) => setTimeout(r, 80));

  const initRes = responses.find((r) => r.id === 1);
  assert.ok(initRes);
  assert.strictEqual(initRes.result.platformOs, 'windows');
  assert.ok(initRes.result.codexHome);

  const threadRes = responses.find((r) => r.id === 2);
  assert.ok(threadRes);
  assert.ok(threadRes.result.thread?.id?.startsWith('01a0af-'));
  assert.strictEqual(threadRes.result.model, 'gpt-5.6-luna');
  assert.strictEqual(threadRes.result.modelProvider, 'openai');
  assert.strictEqual(threadRes.result.reasoningEffort, 'xhigh');

  const threadStartedNotif = notifications.find((n) => n.method === 'thread/started');
  assert.ok(threadStartedNotif);

  // 3. Send turn/start
  const threadId = threadRes.result.thread.id;
  proc.stdin!.write(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 3,
      method: 'turn/start',
      params: {
        threadId,
        input: [{ type: 'text', text: 'Reply with PROBE_SUCCESS_P0' }]
      }
    }) + '\n'
  );

  // Wait for turn completion notifications
  await new Promise((r) => setTimeout(r, 120));

  const turnRes = responses.find((r) => r.id === 3);
  assert.ok(turnRes);
  assert.strictEqual(turnRes.result.turn?.status, 'inProgress');

  const deltaNotif = notifications.find((n) => n.method === 'item/agentMessage/delta');
  assert.ok(deltaNotif);
  assert.strictEqual(deltaNotif.params.delta, 'PROBE_SUCCESS_P0');

  const turnCompletedNotif = notifications.find((n) => n.method === 'turn/completed');
  assert.ok(turnCompletedNotif);
  assert.strictEqual(turnCompletedNotif.params.turn?.status, 'completed');

  proc.stdin!.end();
  proc.kill('SIGTERM');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test tests/adapters/codex-fixture.test.ts`
Expected: FAIL with "Cannot find module .../mock-codex-app-server.mjs"

- [ ] **Step 3: Implement package.json, types.ts and mock-codex-app-server.mjs**

Create `packages/adapters/codex/package.json`:
```json
{
  "name": "@agent-relay/adapter-codex",
  "version": "0.1.0",
  "private": true,
  "type": "module"
}
```

Create `packages/adapters/codex/src/types.ts`:
```typescript
export interface JsonRpcRequest<T = unknown> {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: T;
}

export interface JsonRpcResponse<T = unknown> {
  jsonrpc: '2.0';
  id: number | string;
  result?: T;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface JsonRpcNotification<T = unknown> {
  jsonrpc: '2.0';
  method: string;
  params?: T;
}

export interface InitializeParams {
  clientInfo?: {
    name: string;
    version: string;
    title?: string;
  };
  capabilities?: Record<string, unknown>;
}

export interface InitializeResponse {
  userAgent: string;
  codexHome: string;
  platformFamily: string;
  platformOs: string;
}

export interface ThreadStartParams {
  cwd?: string;
  model?: string;
  ephemeral?: boolean;
  approvalPolicy?: string;
  baseInstructions?: string;
  developerInstructions?: string;
}

export interface ThreadStartResponse {
  thread: {
    id: string;
    sessionId: string;
    source?: string;
    ephemeral?: boolean;
    cwd?: string;
    [key: string]: unknown;
  };
  model: string;
  modelProvider: string;
  reasoningEffort?: string;
  cwd: string;
  [key: string]: unknown;
}

export interface TurnStartParams {
  threadId: string;
  input: Array<{
    type: 'text';
    text: string;
    text_elements?: unknown[];
    [key: string]: unknown;
  }>;
}

export interface TurnStartResponse {
  turn: {
    id: string;
    items: unknown[];
    status: 'inProgress' | 'completed' | 'interrupted' | 'failed';
    error?: unknown;
    durationMs?: number | null;
  };
}

export interface TurnInterruptParams {
  threadId: string;
  turnId: string;
}

export interface ThreadReadParams {
  threadId: string;
  includeTurns?: boolean;
}

export interface ThreadStatusChangedParams {
  threadId: string;
  status: {
    type: 'active' | 'idle';
  };
}

export interface ItemDeltaParams {
  threadId: string;
  turnId: string;
  delta: string;
}

export interface TurnCompletedParams {
  threadId: string;
  turn: {
    id: string;
    status: 'completed' | 'interrupted' | 'failed';
    durationMs?: number;
    error?: unknown;
  };
}
```

Create `tests/fixtures/mock-codex-app-server.mjs`:
```javascript
// tests/fixtures/mock-codex-app-server.mjs
// Emulates `codex app-server --stdio` JSON-RPC 2.0 server
import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin });
const threads = new Map();
let threadCounter = 1;
let turnCounter = 1;

function sendResponse(id, result, error = null) {
  const payload = { jsonrpc: '2.0', id };
  if (error) {
    payload.error = error;
  } else {
    payload.result = result;
  }
  process.stdout.write(JSON.stringify(payload) + '\n');
}

function sendNotification(method, params) {
  const payload = { jsonrpc: '2.0', method, params };
  process.stdout.write(JSON.stringify(payload) + '\n');
}

rl.on('line', (line) => {
  line = line.trim();
  if (!line) return;
  try {
    const msg = JSON.parse(line);
    const { id, method, params } = msg;

    if (method === 'initialize') {
      sendResponse(id, {
        userAgent: 'mock-codex/0.144.4 (Windows 10.0.26200)',
        codexHome: 'C:\\Users\\mock\\.codex',
        platformFamily: 'windows',
        platformOs: 'windows'
      });
    } else if (method === 'thread/start') {
      const threadId = `01a0af-${String(threadCounter++).padStart(6, '0')}`;
      const model = params?.model || 'gpt-5.6-luna';
      const cwd = params?.cwd || process.cwd();
      const ephemeral = Boolean(params?.ephemeral);
      const threadObj = {
        id: threadId,
        sessionId: threadId,
        source: 'vscode',
        ephemeral,
        cwd
      };
      threads.set(threadId, {
        thread: threadObj,
        model,
        modelProvider: 'openai',
        reasoningEffort: 'xhigh',
        cwd,
        turns: [],
        activeTurnId: null,
        interruptedTurnId: null
      });

      sendResponse(id, {
        thread: threadObj,
        model,
        modelProvider: 'openai',
        reasoningEffort: 'xhigh',
        cwd
      });

      sendNotification('thread/started', { thread: threadObj });
    } else if (method === 'turn/start') {
      const thread = threads.get(params?.threadId);
      if (!thread) {
        sendResponse(id, null, { code: -32602, message: 'Thread not found' });
        return;
      }
      const turnId = `turn-${String(turnCounter++).padStart(6, '0')}`;
      thread.activeTurnId = turnId;

      sendResponse(id, {
        turn: {
          id: turnId,
          items: [],
          status: 'inProgress'
        }
      });

      // Emit lifecycle sequence
      sendNotification('thread/status/changed', {
        threadId: thread.thread.id,
        status: { type: 'active' }
      });
      sendNotification('turn/started', {
        threadId: thread.thread.id,
        turn: { id: turnId, status: 'inProgress' }
      });

      const inputText = params?.input?.[0]?.text || '';
      let replyDelta = 'PROBE_SUCCESS_P0';
      if (inputText.includes('READ-ONLY PREPARATION MODE')) {
        // Echo structured ACK
        try {
          const match = inputText.match(/\{[\s\S]*"handoffId"[\s\S]*\}/);
          if (match) {
            const manifest = JSON.parse(match[0]);
            const ack = {
              handoffId: manifest.handoffId,
              runId: manifest.runId,
              newSessionId: thread.thread.id,
              effectiveModel: { provider: 'openai', model: thread.model, effort: thread.reasoningEffort },
              verifiedInputHeadHash: manifest.inputLedgerHeadHash,
              verifiedTaskSnapshotHash: manifest.taskSnapshotHash,
              verifiedWorkspaceHash: manifest.workspaceFingerprint?.treeHash || 'hash-ws-default',
              ackTimestamp: Date.now()
            };
            replyDelta = '```json\n' + JSON.stringify(ack, null, 2) + '\n```';
          }
        } catch {
          replyDelta = 'ACK_GENERATION_FAILED';
        }
      } else if (inputText.includes('EXECUTION_AUTHORIZED')) {
        replyDelta = 'TASK_COMPLETED_SUCCESS';
      } else if (inputText.includes('echo:')) {
        replyDelta = inputText.replace('echo:', '').trim();
      }

      setTimeout(() => {
        if (thread.interruptedTurnId === turnId) {
          // Was interrupted
          return;
        }
        sendNotification('item/started', { threadId: thread.thread.id, turnId });
        sendNotification('item/agentMessage/delta', {
          threadId: thread.thread.id,
          turnId,
          delta: replyDelta
        });
        sendNotification('item/completed', {
          threadId: thread.thread.id,
          turnId,
          item: { type: 'agentMessage', text: replyDelta }
        });

        thread.turns.push({ id: turnId, status: 'completed', text: replyDelta });
        thread.activeTurnId = null;

        sendNotification('thread/status/changed', {
          threadId: thread.thread.id,
          status: { type: 'idle' }
        });
        sendNotification('turn/completed', {
          threadId: thread.thread.id,
          turn: { id: turnId, status: 'completed', durationMs: 40 }
        });
      }, 30);
    } else if (method === 'turn/interrupt') {
      const thread = threads.get(params?.threadId);
      if (thread && thread.activeTurnId) {
        const interruptedId = thread.activeTurnId;
        thread.interruptedTurnId = interruptedId;
        thread.activeTurnId = null;
        thread.turns.push({ id: interruptedId, status: 'interrupted' });

        sendResponse(id, {});
        sendNotification('thread/status/changed', {
          threadId: thread.thread.id,
          status: { type: 'idle' }
        });
        sendNotification('turn/completed', {
          threadId: thread.thread.id,
          turn: { id: interruptedId, status: 'interrupted', durationMs: 25 }
        });
      } else {
        sendResponse(id, {});
      }
    } else if (method === 'thread/read') {
      const thread = threads.get(params?.threadId);
      if (!thread) {
        sendResponse(id, null, { code: -32602, message: 'Thread not found' });
        return;
      }
      if (params?.includeTurns && thread.turns.length === 0) {
        sendResponse(id, null, {
          code: -32600,
          message: `thread ${params.threadId} is not materialized yet; includeTurns is unavailable before first user message`
        });
        return;
      }
      sendResponse(id, {
        thread: {
          ...thread.thread,
          turns: params?.includeTurns ? thread.turns : []
        }
      });
    } else {
      sendResponse(id, null, { code: -32601, message: `Method not found: ${method}` });
    }
  } catch (err) {
    process.stderr.write(`[MockServer Error]: ${String(err)}\n`);
  }
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test tests/adapters/codex-fixture.test.ts`
Expected: PASS with 1 test passed.

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/codex/package.json packages/adapters/codex/src/types.ts tests/fixtures/mock-codex-app-server.mjs tests/adapters/codex-fixture.test.ts
git commit -m "feat(adapters/codex): define JSON-RPC 2.0 types and mock codex app-server fixture"
```

---

### Task 2: Codex Process Runner & Stdio JSON-RPC 2.0 Client

**Files:**
- Create: `packages/adapters/codex/src/runner.ts`
- Test: `tests/adapters/codex-runner.test.ts`

**Interfaces:**
- Consumes: `JsonRpcRequest`, `JsonRpcResponse`, `JsonRpcNotification` from `packages/adapters/codex/src/types.ts`
- Produces: `CodexProcessRunner`:
  - Spawns `codex app-server --stdio` (or mock / custom path via options).
  - Bidirectional Stdio JSON-RPC 2.0 line-delimited protocol transport.
  - `sendRequest<TRes>(method, params, timeoutMs)`: generates monotonic message ID, tracks pending promises, handles timeout and error responses.
  - `onNotification(listener)`: dispatches notifications (`thread/status/changed`, `turn/started`, `turn/completed`, `item/agentMessage/delta`, etc.).
  - 500-line bounded memory buffer for raw lines and events.
  - Consumer callback exception isolation.
  - Graceful termination (`terminate()`) via SIGTERM + unref SIGKILL.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/adapters/codex-runner.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { CodexProcessRunner } from '../../packages/adapters/codex/src/runner.ts';
import type {
  InitializeResponse,
  ThreadStartResponse,
  TurnStartResponse,
  TurnCompletedParams
} from '../../packages/adapters/codex/src/types.ts';

const MOCK_SERVER_PATH = fileURLToPath(new URL('../fixtures/mock-codex-app-server.mjs', import.meta.url));

test('codex-runner: initializes connection and performs thread/turn RPCs with notifications', async () => {
  const runner = new CodexProcessRunner({
    binPath: process.execPath,
    extraArgsPrefix: [MOCK_SERVER_PATH]
  });

  await runner.start();
  assert.strictEqual(runner.isRunning(), true);

  // 1. initialize
  const initRes = await runner.sendRequest<InitializeResponse>('initialize', {
    clientInfo: { name: 'test-client', version: '1.0.0' }
  });
  assert.strictEqual(initRes.platformOs, 'windows');

  // 2. thread/start
  const threadRes = await runner.sendRequest<ThreadStartResponse>('thread/start', {
    model: 'gpt-5.6-luna'
  });
  assert.ok(threadRes.thread?.id);
  assert.strictEqual(threadRes.model, 'gpt-5.6-luna');
  assert.strictEqual(threadRes.modelProvider, 'openai');
  assert.strictEqual(threadRes.reasoningEffort, 'xhigh');

  const threadId = threadRes.thread.id;

  // 3. turn/start & wait for turn/completed
  const completedPromise = new Promise<TurnCompletedParams>((resolve) => {
    runner.onNotification((notif) => {
      if (notif.method === 'turn/completed' && (notif.params as any).threadId === threadId) {
        resolve(notif.params as TurnCompletedParams);
      }
    });
  });

  const turnRes = await runner.sendRequest<TurnStartResponse>('turn/start', {
    threadId,
    input: [{ type: 'text', text: 'echo: hello codex' }]
  });
  assert.strictEqual(turnRes.turn.status, 'inProgress');

  const completed = await completedPromise;
  assert.strictEqual(completed.turn.status, 'completed');

  await runner.terminate();
  assert.strictEqual(runner.isRunning(), false);
});

test('codex-runner: handles turn/interrupt RPC correctly', async () => {
  const runner = new CodexProcessRunner({
    binPath: process.execPath,
    extraArgsPrefix: [MOCK_SERVER_PATH]
  });

  await runner.start();
  const threadRes = await runner.sendRequest<ThreadStartResponse>('thread/start');
  const threadId = threadRes.thread.id;

  const turnRes = await runner.sendRequest<TurnStartResponse>('turn/start', {
    threadId,
    input: [{ type: 'text', text: 'long running' }]
  });
  const turnId = turnRes.turn.id;

  const interruptCompletedPromise = new Promise<TurnCompletedParams>((resolve) => {
    runner.onNotification((notif) => {
      if (notif.method === 'turn/completed' && (notif.params as any).threadId === threadId) {
        resolve(notif.params as TurnCompletedParams);
      }
    });
  });

  await runner.sendRequest('turn/interrupt', { threadId, turnId });
  const completed = await interruptCompletedPromise;
  assert.strictEqual(completed.turn.status, 'interrupted');

  await runner.terminate();
});

test('codex-runner: handles RPC error response and unmaterialized thread read error', async () => {
  const runner = new CodexProcessRunner({
    binPath: process.execPath,
    extraArgsPrefix: [MOCK_SERVER_PATH]
  });

  await runner.start();
  const threadRes = await runner.sendRequest<ThreadStartResponse>('thread/start');
  const threadId = threadRes.thread.id;

  // Unmaterialized thread with includeTurns: true returns code -32600
  await assert.rejects(
    async () => {
      await runner.sendRequest('thread/read', { threadId, includeTurns: true });
    },
    {
      message: /not materialized yet/
    }
  );

  await runner.terminate();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test tests/adapters/codex-runner.test.ts`
Expected: FAIL with "Cannot find module '../../packages/adapters/codex/src/runner.ts'"

- [ ] **Step 3: Implement CodexProcessRunner**

Create `packages/adapters/codex/src/runner.ts`:
```typescript
import { spawn, type ChildProcess } from 'node:child_process';
import readline from 'node:readline';
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcNotification
} from './types.ts';

export interface CodexProcessRunnerOptions {
  binPath?: string;
  extraArgsPrefix?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export type NotificationListener = (notification: JsonRpcNotification) => void;

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const MAX_BUFFER_LINES = 500;

export class CodexProcessRunner {
  private readonly binPath: string;
  private readonly extraArgsPrefix: string[];
  private readonly cwd: string;
  private readonly env: Record<string, string>;

  private process: ChildProcess | null = null;
  private reqIdCounter = 1;
  private pendingRequests: Map<number | string, PendingRequest> = new Map();
  private notificationListeners: Set<NotificationListener> = new Set();
  private rawLines: string[] = [];
  private stderrLines: string[] = [];

  constructor(options: CodexProcessRunnerOptions = {}) {
    this.binPath = options.binPath || process.env.CODEX_BIN_PATH || 'codex';
    this.extraArgsPrefix = options.extraArgsPrefix || ['app-server', '--stdio'];
    this.cwd = options.cwd || process.cwd();
    this.env = options.env || {};
  }

  public start(): Promise<void> {
    if (this.process) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      try {
        const proc = spawn(this.binPath, this.extraArgsPrefix, {
          cwd: this.cwd,
          env: { ...process.env, ...this.env },
          stdio: ['pipe', 'pipe', 'pipe']
        });

        this.process = proc;

        proc.stdin?.on('error', (err: NodeJS.ErrnoException) => {
          if (err.code !== 'EPIPE') {
            // Suppress unhandled EPIPE on child shutdown
          }
        });

        const rlStdout = readline.createInterface({ input: proc.stdout! });
        const rlStderr = readline.createInterface({ input: proc.stderr! });

        rlStdout.on('line', (line) => {
          this.rawLines.push(line);
          if (this.rawLines.length > MAX_BUFFER_LINES) {
            this.rawLines.shift();
          }
          this.handleStdoutLine(line);
        });

        rlStderr.on('line', (line) => {
          this.stderrLines.push(line);
          if (this.stderrLines.length > MAX_BUFFER_LINES) {
            this.stderrLines.shift();
          }
        });

        proc.on('error', (err) => {
          this.cleanupProcess();
          reject(err);
        });

        proc.on('close', () => {
          this.cleanupProcess();
        });

        // Give process a brief moment to initialize stdio
        setTimeout(() => resolve(), 20);
      } catch (err) {
        reject(err);
      }
    });
  }

  public isRunning(): boolean {
    return this.process !== null && !this.process.killed;
  }

  public onNotification(listener: NotificationListener): () => void {
    this.notificationListeners.add(listener);
    return () => {
      this.notificationListeners.delete(listener);
    };
  }

  public sendRequest<TRes = unknown>(
    method: string,
    params?: unknown,
    timeoutMs = 30000
  ): Promise<TRes> {
    if (!this.process || !this.process.stdin || !this.process.stdin.writable) {
      return Promise.reject(new Error('Codex process is not running or stdin is closed'));
    }

    const id = this.reqIdCounter++;
    const payload: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params
    };

    return new Promise<TRes>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`JSON-RPC request '${method}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingRequests.set(id, {
        resolve,
        reject,
        timer
      });

      try {
        this.process!.stdin!.write(JSON.stringify(payload) + '\n', 'utf8', (err) => {
          if (err) {
            clearTimeout(timer);
            this.pendingRequests.delete(id);
            reject(err);
          }
        });
      } catch (err) {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(err);
      }
    });
  }

  public terminate(): Promise<void> {
    if (!this.process) {
      return Promise.resolve();
    }

    const proc = this.process;
    return new Promise((resolve) => {
      let resolved = false;
      const finish = () => {
        if (!resolved) {
          resolved = true;
          this.cleanupProcess();
          resolve();
        }
      };

      proc.once('close', finish);
      try {
        proc.kill('SIGTERM');
      } catch {
        finish();
        return;
      }

      const forceTimer = setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {}
        finish();
      }, 500);
      if (typeof forceTimer.unref === 'function') {
        forceTimer.unref();
      }
    });
  }

  public getRawLines(): string[] {
    return [...this.rawLines];
  }

  public getStderrLines(): string[] {
    return [...this.stderrLines];
  }

  private handleStdoutLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const msg = JSON.parse(trimmed);
      if (msg.id !== undefined && this.pendingRequests.has(msg.id)) {
        const pending = this.pendingRequests.get(msg.id)!;
        this.pendingRequests.delete(msg.id);
        clearTimeout(pending.timer);

        if (msg.error) {
          const errMsg = msg.error.message || `JSON-RPC error code ${msg.error.code}`;
          pending.reject(new Error(errMsg));
        } else {
          pending.resolve(msg.result);
        }
      } else if (msg.method && !msg.id) {
        const notif: JsonRpcNotification = {
          jsonrpc: '2.0',
          method: msg.method,
          params: msg.params
        };
        for (const listener of this.notificationListeners) {
          try {
            listener(notif);
          } catch {
            // Isolate listener error
          }
        }
      }
    } catch {
      // Non-JSON line fallback
    }
  }

  private cleanupProcess(): void {
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Codex process terminated'));
    }
    this.pendingRequests.clear();
    this.process = null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test tests/adapters/codex-runner.test.ts`
Expected: PASS with 3 tests passed.

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/codex/src/runner.ts tests/adapters/codex-runner.test.ts
git commit -m "feat(adapters/codex): implement CodexProcessRunner with JSON-RPC 2.0 lifecycle"
```

---

### Task 3: Production Codex Adapter Implementation & SPI Alignment

**Files:**
- Create: `packages/adapters/codex/src/codex-adapter.ts`
- Create: `packages/adapters/codex/src/index.ts`
- Modify: `tests/contracts/adapter-spi.test.ts`
- Test: `tests/adapters/codex-adapter.test.ts`

**Interfaces:**
- Consumes: `AgentRelayAdapter`, `SpawnSessionConfig`, `SessionInspectResult`, `SessionCapabilities` from `packages/protocol/src/adapter.ts`, `CodexProcessRunner`
- Produces: `CodexAdapter` implementing `AgentRelayAdapter`:
  - `capabilities()`: L3, streamJsonSupported, modelEffortPreservation, headlessSupported, cancellationSupported.
  - `createFresh(config)`: starts app-server process if not running, issues `initialize`, spawns fresh thread via `thread/start`, maps `config.sessionId` <-> UUIDv7 `threadId`, preserves `gpt-5.6-luna` & `xhigh`, optionally sends `initialPrompt` as first turn.
  - `inspectSession(sessionId)`: returns active state, effectiveModel, cwd.
  - `submit(sessionId, messageId, content, epoch)`: calls `turn/start`.
  - `requestDrain(sessionId, handoffId)`: marks session draining.
  - `awaitQuiescence(sessionId, timeoutMs)`: event-driven wait on `thread/status/changed` (`idle`) and active turn completion.
  - `authorizeExecution(sessionId, epoch, token)`: delivers authorization message turn.
  - `interruptOwned(sessionId)`: issues `turn/interrupt` if turn active, sets session inactive.
  - `getSessionOutput(sessionId)`: gets accumulated model response text.
  - `getSessionEvents(sessionId)`: gets captured notification events.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/adapters/codex-adapter.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { CodexAdapter } from '../../packages/adapters/codex/src/codex-adapter.ts';
import { CodexProcessRunner } from '../../packages/adapters/codex/src/runner.ts';

const MOCK_SERVER_PATH = fileURLToPath(new URL('../fixtures/mock-codex-app-server.mjs', import.meta.url));

test('codex-adapter: implements AgentRelayAdapter with L3 capability and lifecycle methods', async () => {
  const runner = new CodexProcessRunner({
    binPath: process.execPath,
    extraArgsPrefix: [MOCK_SERVER_PATH]
  });
  const adapter = new CodexAdapter({ runner });

  const caps = adapter.capabilities();
  assert.strictEqual(caps.level, 'L3');
  assert.strictEqual(caps.streamJsonSupported, true);
  assert.strictEqual(caps.modelEffortPreservation, true);

  const fresh = await adapter.createFresh({
    sessionId: 'session-codex-100',
    runId: 'run-100',
    model: { provider: 'openai', model: 'gpt-5.6-luna', effort: 'xhigh' },
    initialPrompt: 'echo: PROBE_SUCCESS_P0'
  });

  assert.strictEqual(fresh.sessionId, 'session-codex-100');
  assert.strictEqual(fresh.active, true);
  assert.strictEqual(fresh.effectiveModel?.model, 'gpt-5.6-luna');
  assert.strictEqual(fresh.effectiveModel?.provider, 'openai');
  assert.strictEqual(fresh.effectiveModel?.effort, 'xhigh');

  const inspected = await adapter.inspectSession('session-codex-100');
  assert.strictEqual(inspected?.sessionId, 'session-codex-100');
  assert.strictEqual(inspected?.effectiveModel?.model, 'gpt-5.6-luna');

  // Await quiescence
  const quiescence = await adapter.awaitQuiescence('session-codex-100', 1000);
  assert.strictEqual(quiescence, 'quiescent');

  const output = adapter.getSessionOutput('session-codex-100');
  assert.ok(output.includes('PROBE_SUCCESS_P0'));

  // Submit another message
  await adapter.submit('session-codex-100', 'm-2', 'echo: next step');
  await adapter.awaitQuiescence('session-codex-100', 1000);
  assert.ok(adapter.getSessionOutput('session-codex-100').includes('next step'));

  // Drain and authorize
  const drainRes = await adapter.requestDrain('session-codex-100', 'h-1');
  assert.strictEqual(drainRes, true);

  const authRes = await adapter.authorizeExecution('session-codex-100', 2, 'EXEC_TOKEN_888');
  assert.strictEqual(authRes, true);

  // Interrupt
  const interruptRes = await adapter.interruptOwned('session-codex-100');
  assert.strictEqual(interruptRes, true);

  const afterInterrupt = await adapter.inspectSession('session-codex-100');
  assert.strictEqual(afterInterrupt?.active, false);

  await adapter.shutdown();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test tests/adapters/codex-adapter.test.ts`
Expected: FAIL with "Cannot find module '../../packages/adapters/codex/src/codex-adapter.ts'"

- [ ] **Step 3: Implement CodexAdapter, index.ts and update adapter-spi.test.ts**

Create `packages/adapters/codex/src/codex-adapter.ts`:
```typescript
import { randomUUID } from 'node:crypto';
import type {
  AgentRelayAdapter,
  SessionCapabilities,
  SessionInspectResult,
  SpawnSessionConfig
} from '../../../protocol/src/adapter.ts';
import { CodexProcessRunner } from './runner.ts';
import type {
  InitializeResponse,
  ThreadStartResponse,
  TurnStartResponse,
  JsonRpcNotification,
  TurnCompletedParams,
  ItemDeltaParams,
  ThreadStatusChangedParams
} from './types.ts';

export interface CodexAdapterOptions {
  runner?: CodexProcessRunner;
}

interface CodexSessionState {
  sessionId: string;
  threadId: string;
  runId: string;
  active: boolean;
  draining: boolean;
  isIdle: boolean;
  activeTurnId: string | null;
  effectiveModel?: {
    provider: string;
    model: string;
    effort?: string;
  };
  cwd: string;
  executionAuthorized: boolean;
  executionToken?: string;
  epoch?: number;
  outputChunks: string[];
  events: JsonRpcNotification[];
  exitCode?: number | null;
}

export class CodexAdapter implements AgentRelayAdapter {
  private readonly runner: CodexProcessRunner;
  private readonly sessions: Map<string, CodexSessionState> = new Map();
  private readonly threadToSession: Map<string, string> = new Map();
  private initialized = false;

  constructor(options: CodexAdapterOptions = {}) {
    this.runner = options.runner || new CodexProcessRunner();
    this.setupNotificationHandler();
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
    await this.ensureInitialized();

    const targetModel = config.model?.model || 'gpt-5.6-luna';
    const targetProvider = config.model?.provider || 'openai';
    const targetEffort = config.model?.effort || 'xhigh';
    const cwd = config.cwd || process.cwd();

    // Spawn thread via thread/start
    const threadRes = await this.runner.sendRequest<ThreadStartResponse>('thread/start', {
      cwd,
      model: targetModel,
      ephemeral: Boolean(config.noPersistence)
    });

    const threadId = threadRes.thread.id;
    const sessionId = config.sessionId || threadId;

    const state: CodexSessionState = {
      sessionId,
      threadId,
      runId: config.runId,
      active: true,
      draining: false,
      isIdle: true,
      activeTurnId: null,
      effectiveModel: {
        provider: threadRes.modelProvider || targetProvider,
        model: threadRes.model || targetModel,
        effort: threadRes.reasoningEffort || targetEffort
      },
      cwd: threadRes.cwd || cwd,
      executionAuthorized: !config.readOnly,
      outputChunks: [],
      events: []
    };

    this.sessions.set(sessionId, state);
    this.threadToSession.set(threadId, sessionId);

    // If initial prompt is provided, start turn
    if (config.initialPrompt) {
      state.isIdle = false;
      const turnRes = await this.runner.sendRequest<TurnStartResponse>('turn/start', {
        threadId,
        input: [
          {
            type: 'text',
            text: config.initialPrompt
          }
        ]
      });
      state.activeTurnId = turnRes.turn.id;
    }

    return {
      sessionId,
      active: state.active,
      effectiveModel: state.effectiveModel,
      cwd: state.cwd,
      exitCode: null
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
      exitCode: s.active ? null : (s.exitCode ?? 0)
    };
  }

  public async submit(sessionId: string, _messageId: string, content: string, _epoch?: number): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s || !s.active) {
      throw new Error(`Cannot submit to inactive session ${sessionId}`);
    }

    s.isIdle = false;
    const turnRes = await this.runner.sendRequest<TurnStartResponse>('turn/start', {
      threadId: s.threadId,
      input: [
        {
          type: 'text',
          text: content
        }
      ]
    });
    s.activeTurnId = turnRes.turn.id;
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
      if (!s.active || (s.isIdle && s.activeTurnId === null)) {
        return 'quiescent';
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    return 'timeout';
  }

  public async authorizeExecution(sessionId: string, epoch: number, executionToken: string): Promise<boolean> {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    s.executionAuthorized = true;
    s.epoch = epoch;
    s.executionToken = executionToken;
    await this.submit(
      sessionId,
      `auth-${Date.now()}`,
      `EXECUTION_AUTHORIZED: token=${executionToken} epoch=${epoch}. You may now execute write tasks.`
    );
    return true;
  }

  public async interruptOwned(sessionId: string): Promise<boolean> {
    const s = this.sessions.get(sessionId);
    if (!s) return false;

    if (s.activeTurnId) {
      try {
        await this.runner.sendRequest('turn/interrupt', {
          threadId: s.threadId,
          turnId: s.activeTurnId
        });
      } catch {
        // If turn/interrupt fails, continue with marking inactive
      }
    }
    s.active = false;
    s.isIdle = true;
    s.activeTurnId = null;
    return true;
  }

  public getSessionOutput(sessionId: string): string {
    const s = this.sessions.get(sessionId);
    if (!s) return '';
    return s.outputChunks.join('');
  }

  public getSessionEvents(sessionId: string): JsonRpcNotification[] {
    const s = this.sessions.get(sessionId);
    if (!s) return [];
    return [...s.events];
  }

  public async shutdown(): Promise<void> {
    for (const [, s] of this.sessions) {
      s.active = false;
    }
    await this.runner.terminate();
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      if (!this.runner.isRunning()) {
        await this.runner.start();
      }
      await this.runner.sendRequest<InitializeResponse>('initialize', {
        clientInfo: { name: 'agent-relay-codex', version: '0.1.0' }
      });
      this.initialized = true;
    }
  }

  private setupNotificationHandler(): void {
    this.runner.onNotification((notif) => {
      const threadId = (notif.params as any)?.threadId;
      if (!threadId) return;
      const sessionId = this.threadToSession.get(threadId);
      if (!sessionId) return;
      const s = this.sessions.get(sessionId);
      if (!s) return;

      s.events.push(notif);
      if (s.events.length > 200) {
        s.events.shift();
      }

      if (notif.method === 'thread/status/changed') {
        const params = notif.params as ThreadStatusChangedParams;
        s.isIdle = params.status.type === 'idle';
      } else if (notif.method === 'item/agentMessage/delta') {
        const params = notif.params as ItemDeltaParams;
        if (params.delta) {
          s.outputChunks.push(params.delta);
        }
      } else if (notif.method === 'turn/completed') {
        const params = notif.params as TurnCompletedParams;
        if (s.activeTurnId === params.turn.id) {
          s.activeTurnId = null;
        }
        s.isIdle = true;
      }
    });
  }
}
```

Create `packages/adapters/codex/src/index.ts`:
```typescript
export * from './types.ts';
export * from './runner.ts';
export * from './codex-adapter.ts';
```

Modify `tests/contracts/adapter-spi.test.ts`: add `CodexAdapter` verification test at bottom:
```typescript
import { CodexAdapter } from '../../packages/adapters/codex/src/codex-adapter.ts';
import { CodexProcessRunner } from '../../packages/adapters/codex/src/runner.ts';

test('adapter-spi: CodexAdapter implements AgentRelayAdapter interface', async () => {
  const mockServerPath = fileURLToPath(new URL('../fixtures/mock-codex-app-server.mjs', import.meta.url));
  const runner = new CodexProcessRunner({
    binPath: process.execPath,
    extraArgsPrefix: [mockServerPath]
  });
  const adapter: AgentRelayAdapter = new CodexAdapter({ runner });

  const caps = adapter.capabilities();
  assert.strictEqual(caps.level, 'L3');
  assert.strictEqual(caps.streamJsonSupported, true);
  assert.strictEqual(caps.modelEffortPreservation, true);

  const config: SpawnSessionConfig = {
    sessionId: 'sess-spi-codex',
    runId: 'run-spi-codex-1',
    model: { provider: 'openai', model: 'gpt-5.6-luna', effort: 'xhigh' },
    initialPrompt: 'echo: codex-spi'
  };

  const inspect = await adapter.createFresh(config);
  assert.strictEqual(inspect.sessionId, 'sess-spi-codex');
  assert.strictEqual(inspect.active, true);
  assert.strictEqual(inspect.effectiveModel?.model, 'gpt-5.6-luna');
  assert.strictEqual(inspect.effectiveModel?.effort, 'xhigh');

  const inspected = await adapter.inspectSession('sess-spi-codex');
  assert.strictEqual(inspected?.sessionId, 'sess-spi-codex');

  const drainSuccess = await adapter.requestDrain('sess-spi-codex', 'handoff-codex');
  assert.strictEqual(drainSuccess, true);

  const quiescence = await adapter.awaitQuiescence('sess-spi-codex', 1000);
  assert.strictEqual(quiescence, 'quiescent');

  const authSuccess = await adapter.authorizeExecution('sess-spi-codex', 2, 'TOKEN_CODEX_SPI');
  assert.strictEqual(authSuccess, true);

  const interrupted = await adapter.interruptOwned('sess-spi-codex');
  assert.strictEqual(interrupted, true);

  const afterInterrupt = await adapter.inspectSession('sess-spi-codex');
  assert.strictEqual(afterInterrupt?.active, false);
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test tests/adapters/codex-adapter.test.ts tests/contracts/adapter-spi.test.ts`
Expected: PASS with all tests passing.

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/codex/src/codex-adapter.ts packages/adapters/codex/src/index.ts tests/adapters/codex-adapter.test.ts tests/contracts/adapter-spi.test.ts
git commit -m "feat(adapters/codex): implement CodexAdapter matching unified AgentRelayAdapter SPI"
```

---

### Task 4: Two-Phase Read-Only Handshake Coordinator for Codex

**Files:**
- Create: `packages/adapters/codex/src/handshake.ts`
- Modify: `packages/adapters/codex/src/index.ts`
- Test: `tests/adapters/codex-handshake.test.ts`

**Interfaces:**
- Consumes: `HandoffPackManifest`, `HandoffAckPacket` from `packages/protocol/src/types.ts`, `HandoffStateMachine`, `WorkspaceLeaseManager`
- Produces: `CodexHandshakeCoordinator`:
  - `generatePreparationPrompt(manifest)`: generates isolated read-only preparation prompt requiring verification of input ledger hash, task snapshot hash, and workspace tree hash.
  - `startNewSession(newSessionId)`: advances state machine to `PREPARING`.
  - `verifyAckAndAuthorize(manifest, ack)`:
    1. Validates handoff ID, input ledger hash, task snapshot hash, workspace tree hash, and target model.
    2. Validates state machine is in `PREPARING` state BEFORE CAS lease attempt.
    3. Validates lease preconditions (owner matches `manifest.sourceSessionId`, epoch matches `manifest.epoch`).
    4. Executes atomic CAS lease transfer (`newEpoch = manifest.epoch + 1`).
    5. Advances state machine to `READY` via `receiveAck(ack)` and issues `EXECUTION_TOKEN` to `RUNNING`.
    6. Monotonic rollback (`newEpoch + 1`) if state machine throws.
  - `extractAckFromText(text)`: robust two-tier parser (code block regex + balanced bracket scanning).

- [ ] **Step 1: Write the failing test**

```typescript
// tests/adapters/codex-handshake.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexHandshakeCoordinator } from '../../packages/adapters/codex/src/handshake.ts';
import { HandoffStateMachine } from '../../packages/controller/src/handoff/state-machine.ts';
import { WorkspaceLeaseManager } from '../../packages/controller/src/handoff/lease.ts';
import type { HandoffPackManifest, HandoffAckPacket } from '../../packages/protocol/src/types.ts';

test('codex-handshake: prepares read-only prompt and completes two-phase ACK with CAS lease', () => {
  const lease = new WorkspaceLeaseManager();
  lease.acquireInitialLease('ws-codex-1', 'thread-A', 1);

  const sm = new HandoffStateMachine('run-codex-1', 'thread-A', 1);
  sm.requestHandoff('unit_completed');
  sm.checkpointCompleted('ckpt-hash-1');

  const coordinator = new CodexHandshakeCoordinator(sm, lease, 'ws-codex-1');

  const manifest: HandoffPackManifest = {
    handoffId: 'h-codex-1',
    runId: 'run-codex-1',
    epoch: 1,
    sourceSessionId: 'thread-A',
    targetModel: { provider: 'openai', model: 'gpt-5.6-luna' },
    inputLedgerHeadHash: 'input-hash-codex-1',
    requirementVersion: 1,
    taskSnapshotHash: 'task-hash-codex-1',
    workspaceFingerprint: {
      commitHash: 'commit-1',
      dirtyFiles: [],
      untrackedFiles: [],
      treeHash: 'ws-tree-hash-codex-1'
    },
    timestamp: Date.now()
  };

  // 1. Generate preparation prompt
  const prepPrompt = coordinator.generatePreparationPrompt(manifest);
  assert.ok(prepPrompt.includes('READ-ONLY PREPARATION MODE'));
  assert.ok(prepPrompt.includes('"handoffId": "h-codex-1"'));

  // 2. Start new session in state machine
  coordinator.startNewSession('thread-B');
  assert.strictEqual(sm.getState(), 'PREPARING');

  // 3. Verify ACK packet and authorize
  const ack: HandoffAckPacket = {
    handoffId: 'h-codex-1',
    runId: 'run-codex-1',
    newSessionId: 'thread-B',
    effectiveModel: { provider: 'openai', model: 'gpt-5.6-luna' },
    verifiedInputHeadHash: 'input-hash-codex-1',
    verifiedTaskSnapshotHash: 'task-hash-codex-1',
    verifiedWorkspaceHash: 'ws-tree-hash-codex-1',
    ackTimestamp: Date.now()
  };

  const authorized = coordinator.verifyAckAndAuthorize(manifest, ack);
  assert.strictEqual(authorized.success, true);
  assert.ok(authorized.executionToken?.startsWith('EXEC_TOKEN_'));
  assert.strictEqual(authorized.epoch, 2);

  // Verify lease transferred atomically to thread-B with epoch 2
  assert.strictEqual(lease.getLease('ws-codex-1')?.currentOwner, 'thread-B');
  assert.strictEqual(lease.getLease('ws-codex-1')?.epoch, 2);
  assert.strictEqual(sm.getState(), 'RUNNING');
});

test('codex-handshake: rejects ACK on hash mismatch, model mismatch, or lease precondition failure', () => {
  const lease = new WorkspaceLeaseManager();
  lease.acquireInitialLease('ws-codex-1', 'thread-A', 1);

  const sm = new HandoffStateMachine('run-codex-1', 'thread-A', 1);
  sm.requestHandoff('unit_completed');
  sm.checkpointCompleted();

  const coordinator = new CodexHandshakeCoordinator(sm, lease, 'ws-codex-1');
  coordinator.startNewSession('thread-B');

  const manifest: HandoffPackManifest = {
    handoffId: 'h-codex-1',
    runId: 'run-codex-1',
    epoch: 1,
    sourceSessionId: 'thread-A',
    targetModel: { provider: 'openai', model: 'gpt-5.6-luna' },
    inputLedgerHeadHash: 'input-hash-codex-1',
    requirementVersion: 1,
    taskSnapshotHash: 'task-hash-codex-1',
    workspaceFingerprint: { commitHash: 'c1', dirtyFiles: [], untrackedFiles: [], treeHash: 'tree-hash-valid' },
    timestamp: Date.now()
  };

  // Hash mismatch
  const badHashAck: HandoffAckPacket = {
    handoffId: 'h-codex-1',
    runId: 'run-codex-1',
    newSessionId: 'thread-B',
    effectiveModel: { provider: 'openai', model: 'gpt-5.6-luna' },
    verifiedInputHeadHash: 'TAMPERED_HASH',
    verifiedTaskSnapshotHash: 'task-hash-codex-1',
    verifiedWorkspaceHash: 'tree-hash-valid',
    ackTimestamp: Date.now()
  };
  const res1 = coordinator.verifyAckAndAuthorize(manifest, badHashAck);
  assert.strictEqual(res1.success, false);
  assert.match(res1.error || '', /Input ledger head hash mismatch/);

  // Model mismatch
  const badModelAck: HandoffAckPacket = {
    handoffId: 'h-codex-1',
    runId: 'run-codex-1',
    newSessionId: 'thread-B',
    effectiveModel: { provider: 'openai', model: 'gpt-4o' },
    verifiedInputHeadHash: 'input-hash-codex-1',
    verifiedTaskSnapshotHash: 'task-hash-codex-1',
    verifiedWorkspaceHash: 'tree-hash-valid',
    ackTimestamp: Date.now()
  };
  const res2 = coordinator.verifyAckAndAuthorize(manifest, badModelAck);
  assert.strictEqual(res2.success, false);
  assert.match(res2.error || '', /Model mismatch/);
});

test('codex-handshake: extracts ACK from markdown code blocks and bracket-balanced JSON', () => {
  const lease = new WorkspaceLeaseManager();
  const sm = new HandoffStateMachine('run-codex-1', 'thread-A', 1);
  const coordinator = new CodexHandshakeCoordinator(sm, lease, 'ws-codex-1');

  const expectedAck: HandoffAckPacket = {
    handoffId: 'h-codex-extract',
    runId: 'run-codex-1',
    newSessionId: 'thread-B',
    effectiveModel: { provider: 'openai', model: 'gpt-5.6-luna' },
    verifiedInputHeadHash: 'input-hash-xyz',
    verifiedTaskSnapshotHash: 'task-hash-xyz',
    verifiedWorkspaceHash: 'ws-hash-xyz',
    ackTimestamp: 1700000000000
  };

  const outputWithMarkdown = `
Verification complete.
\`\`\`json
${JSON.stringify(expectedAck, null, 2)}
\`\`\`
Standing by for execution token.
`;
  const extracted = coordinator.extractAckFromText(outputWithMarkdown);
  assert.deepStrictEqual(extracted, expectedAck);

  const rawJsonOutput = `ACK: ${JSON.stringify(expectedAck)} ready.`;
  const extractedRaw = coordinator.extractAckFromText(rawJsonOutput);
  assert.deepStrictEqual(extractedRaw, expectedAck);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test tests/adapters/codex-handshake.test.ts`
Expected: FAIL with "Cannot find module '../../packages/adapters/codex/src/handshake.ts'"

- [ ] **Step 3: Implement CodexHandshakeCoordinator**

Create `packages/adapters/codex/src/handshake.ts`:
```typescript
import type { HandoffPackManifest, HandoffAckPacket } from '../../../protocol/src/types.ts';
import type { HandoffStateMachine } from '../../../controller/src/handoff/state-machine.ts';
import type { WorkspaceLeaseManager } from '../../../controller/src/handoff/lease.ts';

export interface HandshakeResult {
  success: boolean;
  executionToken?: string;
  epoch?: number;
  error?: string;
}

export class CodexHandshakeCoordinator {
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
      'You have been spawned as a fresh Codex relay worker thread. You are in READ-ONLY mode.',
      'DO NOT execute any write commands or file mutations until execution is authorized.',
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
    // 1. Verify handoff ID match
    if (ack.handoffId !== manifest.handoffId) {
      return { success: false, error: 'Handoff ID mismatch' };
    }

    // 2. Verify hash matching
    if (ack.verifiedInputHeadHash !== manifest.inputLedgerHeadHash) {
      return { success: false, error: 'Input ledger head hash mismatch' };
    }
    if (ack.verifiedTaskSnapshotHash !== manifest.taskSnapshotHash) {
      return { success: false, error: 'Task snapshot hash mismatch' };
    }
    if (ack.verifiedWorkspaceHash !== manifest.workspaceFingerprint.treeHash) {
      return { success: false, error: 'Workspace hash mismatch' };
    }

    // 3. Verify target model match
    if (ack.effectiveModel?.model !== manifest.targetModel.model) {
      return {
        success: false,
        error: `Model mismatch: expected ${manifest.targetModel.model}, got ${ack.effectiveModel?.model}`
      };
    }

    // 4. Check state machine state BEFORE attempting CAS lease transfer
    if (this.stateMachine.getState() !== 'PREPARING') {
      return {
        success: false,
        error: `Cannot receive ACK in state ${this.stateMachine.getState()}`
      };
    }

    // 5. Check lease preconditions BEFORE modifying state machine
    const currentLease = this.leaseManager.getLease(this.workspaceKey);
    if (!currentLease) {
      return { success: false, error: `No active lease for workspace ${this.workspaceKey}` };
    }
    if (currentLease.currentOwner !== manifest.sourceSessionId) {
      return {
        success: false,
        error: `Lease owner mismatch: expected ${manifest.sourceSessionId}, got ${currentLease.currentOwner}`
      };
    }
    if (currentLease.epoch !== manifest.epoch) {
      return {
        success: false,
        error: `Lease epoch mismatch: expected ${manifest.epoch}, got ${currentLease.epoch}`
      };
    }

    // 6. Perform CAS lease transfer
    const newEpoch = manifest.epoch + 1;
    const casSuccess = this.leaseManager.compareAndSetOwner(
      this.workspaceKey,
      manifest.sourceSessionId,
      ack.newSessionId,
      manifest.epoch,
      newEpoch
    );
    if (!casSuccess) {
      return { success: false, error: 'CAS lease acquisition failed' };
    }

    // 7. Advance state machine
    try {
      this.stateMachine.receiveAck(ack);
      const token = this.stateMachine.issueExecutionToken();
      return {
        success: true,
        executionToken: token.token,
        epoch: token.epoch
      };
    } catch (err: unknown) {
      // Revert CAS lease on state machine failure with monotonically increasing epoch
      this.leaseManager.compareAndSetOwner(
        this.workspaceKey,
        ack.newSessionId,
        manifest.sourceSessionId,
        newEpoch,
        newEpoch + 1
      );
      return { success: false, error: (err as Error).message };
    }
  }

  public extractAckFromText(text: string): HandoffAckPacket | undefined {
    // 1. Check markdown code blocks first
    const codeBlockRegex = /```(?:json)?\s*([\s\S]*?)```/g;
    let match: RegExpExecArray | null;
    while ((match = codeBlockRegex.exec(text)) !== null) {
      const block = match[1].trim();
      if (block.includes('"handoffId"') && block.includes('"verifiedInputHeadHash"')) {
        try {
          const parsed = JSON.parse(block) as HandoffAckPacket;
          if (parsed && typeof parsed === 'object' && parsed.handoffId && parsed.verifiedInputHeadHash) {
            return parsed;
          }
        } catch {}
      }
    }

    // 2. Scan for discrete balanced JSON objects
    let depth = 0;
    let inString = false;
    let escape = false;
    let startIndex = -1;

    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (inString) {
        if (escape) {
          escape = false;
        } else if (char === '\\') {
          escape = true;
        } else if (char === '"') {
          inString = false;
        }
      } else {
        if (char === '"') {
          inString = true;
        } else if (char === '{') {
          if (depth === 0) {
            startIndex = i;
          }
          depth++;
        } else if (char === '}') {
          if (depth > 0) {
            depth--;
            if (depth === 0 && startIndex !== -1) {
              const candidate = text.slice(startIndex, i + 1);
              startIndex = -1;
              if (candidate.includes('"handoffId"') && candidate.includes('"verifiedInputHeadHash"')) {
                try {
                  const parsed = JSON.parse(candidate) as HandoffAckPacket;
                  if (parsed && typeof parsed === 'object' && parsed.handoffId && parsed.verifiedInputHeadHash) {
                    return parsed;
                  }
                } catch {}
              }
            }
          }
        }
      }
    }

    return undefined;
  }
}
```

Update `packages/adapters/codex/src/index.ts`:
```typescript
export * from './types.ts';
export * from './runner.ts';
export * from './codex-adapter.ts';
export * from './handshake.ts';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test tests/adapters/codex-handshake.test.ts`
Expected: PASS with 3 tests passed.

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/codex/src/handshake.ts packages/adapters/codex/src/index.ts tests/adapters/codex-handshake.test.ts
git commit -m "feat(adapters/codex): implement CodexHandshakeCoordinator with CAS lease integration"
```

---

### Task 5: 3-Round Automated Relay Acceptance & Robustness Suite (S01~S05)

**Files:**
- Create: `tests/scenarios/codex-relay.test.ts`

**Interfaces:**
- Consumes: `CodexAdapter`, `CodexProcessRunner`, `CodexHandshakeCoordinator`, `WorkspaceLeaseManager`, `InputLedger`, `TaskGraph`, `WorkspaceSentinel`, `HandoffPackager`
- Produces: Complete end-to-end acceptance tests verifying:
  - S01: 3-round automatic relay across 3 distinct Codex threads (Thread A -> B -> C) with zero history leakage.
  - S02: Effective model (`gpt-5.6-luna`) and reasoning effort (`xhigh`) preservation across all 3 handoff rounds (R5).
  - S03: Single-writer CAS lease enforcement during real process handoffs (R10).
  - S04: Quiescence detection and `turn/interrupt` cancellation handling (R6, R7).
  - S05: User pause/cancellation priority: stops handoff sequence immediately without spawning next session (R7).

- [ ] **Step 1: Write the failing acceptance scenarios test**

```typescript
// tests/scenarios/codex-relay.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { CodexAdapter } from '../../packages/adapters/codex/src/codex-adapter.ts';
import { CodexProcessRunner } from '../../packages/adapters/codex/src/runner.ts';
import { CodexHandshakeCoordinator } from '../../packages/adapters/codex/src/handshake.ts';
import { WorkspaceLeaseManager } from '../../packages/controller/src/handoff/lease.ts';
import { HandoffStateMachine } from '../../packages/controller/src/handoff/state-machine.ts';
import { InputLedger } from '../../packages/controller/src/inputs/ledger.ts';
import { TaskGraph } from '../../packages/controller/src/tasks/graph.ts';
import { WorkspaceSentinel } from '../../packages/controller/src/workspace/sentinel.ts';
import { HandoffPackager } from '../../packages/controller/src/workspace/checkpoint.ts';
import type { HandoffAckPacket } from '../../packages/protocol/src/types.ts';

const MOCK_SERVER_PATH = fileURLToPath(new URL('../fixtures/mock-codex-app-server.mjs', import.meta.url));

test('scenarios: S01~S03 - 3-round automated Codex relay with model preservation and CAS lease', async () => {
  const runner = new CodexProcessRunner({
    binPath: process.execPath,
    extraArgsPrefix: [MOCK_SERVER_PATH]
  });
  const adapter = new CodexAdapter({ runner });
  const lease = new WorkspaceLeaseManager();
  const sentinel = new WorkspaceSentinel(process.cwd());
  const packager = new HandoffPackager();
  const ledger = new InputLedger();
  ledger.appendUserMessage('Build high-throughput Codex pipeline');

  const graph = new TaskGraph();
  graph.addTask({ taskId: 'c-t1', requirementId: 'req-1', title: 'Unit 1: Ingest' });
  graph.addTask({ taskId: 'c-t2', requirementId: 'req-1', title: 'Unit 2: Process' });
  graph.addTask({ taskId: 'c-t3', requirementId: 'req-1', title: 'Unit 3: Emit' });

  const runId = 'codex-relay-run-001';
  const workspaceKey = 'ws-codex-repo';
  const targetModel = { provider: 'openai', model: 'gpt-5.6-luna', effort: 'xhigh' };

  // ─── ROUND 1: Thread A ───
  const threadA_Id = 'thread-codex-A';
  lease.acquireInitialLease(workspaceKey, threadA_Id, 1);
  const sm = new HandoffStateMachine(runId, threadA_Id, 1);

  await adapter.createFresh({
    sessionId: threadA_Id,
    runId,
    model: targetModel,
    initialPrompt: 'Execute Unit 1: Ingest'
  });

  await adapter.awaitQuiescence(threadA_Id, 1000);
  graph.completeTaskWithEvidence('c-t1', 'hash-evidence-c1');
  sm.requestHandoff('unit_completed');
  const fp1 = await sentinel.captureFingerprint();
  const manifest1 = packager.createManifest({
    handoffId: 'h-codex-1',
    runId,
    epoch: 1,
    sourceSessionId: threadA_Id,
    targetModel,
    inputLedgerHeadHash: ledger.getHeadHash(),
    requirementVersion: 1,
    taskSnapshotHash: graph.computeSnapshotHash(),
    workspaceFingerprint: fp1
  });
  sm.checkpointCompleted(manifest1.handoffId);

  // ─── ROUND 2: Thread B (Fresh spawn) ───
  const threadB_Id = 'thread-codex-B';
  const coord1 = new CodexHandshakeCoordinator(sm, lease, workspaceKey);
  coord1.startNewSession(threadB_Id);

  const threadB_Inspect = await adapter.createFresh({
    sessionId: threadB_Id,
    runId,
    model: targetModel,
    readOnly: true,
    initialPrompt: coord1.generatePreparationPrompt(manifest1)
  });

  // Verify R5: Model and reasoning effort are strictly preserved
  assert.strictEqual(threadB_Inspect.effectiveModel?.model, 'gpt-5.6-luna');
  assert.strictEqual(threadB_Inspect.effectiveModel?.provider, 'openai');
  assert.strictEqual(threadB_Inspect.effectiveModel?.effort, 'xhigh');

  // Verify distinct session IDs
  assert.notStrictEqual(threadA_Id, threadB_Id);

  await adapter.awaitQuiescence(threadB_Id, 1000);
  const threadB_Output = adapter.getSessionOutput(threadB_Id);
  const extractedAck1 = coord1.extractAckFromText(threadB_Output);
  assert.ok(extractedAck1);

  // Authorize execution
  const auth1 = coord1.verifyAckAndAuthorize(manifest1, extractedAck1);
  assert.strictEqual(auth1.success, true);
  assert.strictEqual(lease.getLease(workspaceKey)?.currentOwner, threadB_Id);
  assert.strictEqual(lease.getLease(workspaceKey)?.epoch, 2);

  // Stale Thread A tries to write with old epoch -> REJECTED by CAS (R10)
  assert.strictEqual(lease.compareAndSetOwner(workspaceKey, threadA_Id, 'thread-C', 1, 3), false);

  await adapter.authorizeExecution(threadB_Id, auth1.epoch!, auth1.executionToken!);
  await adapter.awaitQuiescence(threadB_Id, 1000);

  graph.completeTaskWithEvidence('c-t2', 'hash-evidence-c2');
  sm.requestHandoff('unit_completed');
  const fp2 = await sentinel.captureFingerprint();
  const manifest2 = packager.createManifest({
    handoffId: 'h-codex-2',
    runId,
    epoch: 2,
    sourceSessionId: threadB_Id,
    targetModel,
    inputLedgerHeadHash: ledger.getHeadHash(),
    requirementVersion: 1,
    taskSnapshotHash: graph.computeSnapshotHash(),
    workspaceFingerprint: fp2
  });
  sm.checkpointCompleted(manifest2.handoffId);

  // ─── ROUND 3: Thread C (Fresh spawn) ───
  const threadC_Id = 'thread-codex-C';
  const coord2 = new CodexHandshakeCoordinator(sm, lease, workspaceKey);
  coord2.startNewSession(threadC_Id);

  const threadC_Inspect = await adapter.createFresh({
    sessionId: threadC_Id,
    runId,
    model: targetModel,
    readOnly: true,
    initialPrompt: coord2.generatePreparationPrompt(manifest2)
  });

  assert.strictEqual(threadC_Inspect.effectiveModel?.model, 'gpt-5.6-luna');
  assert.notStrictEqual(threadB_Id, threadC_Id);

  await adapter.awaitQuiescence(threadC_Id, 1000);
  const threadC_Output = adapter.getSessionOutput(threadC_Id);
  const extractedAck2 = coord2.extractAckFromText(threadC_Output);
  assert.ok(extractedAck2);

  const auth2 = coord2.verifyAckAndAuthorize(manifest2, extractedAck2);
  assert.strictEqual(auth2.success, true);
  assert.strictEqual(lease.getLease(workspaceKey)?.currentOwner, threadC_Id);
  assert.strictEqual(lease.getLease(workspaceKey)?.epoch, 3);

  await adapter.authorizeExecution(threadC_Id, auth2.epoch!, auth2.executionToken!);
  await adapter.awaitQuiescence(threadC_Id, 1000);

  graph.completeTaskWithEvidence('c-t3', 'hash-evidence-c3');
  assert.strictEqual(graph.getTask('c-t1')?.status, 'completed');
  assert.strictEqual(graph.getTask('c-t2')?.status, 'completed');
  assert.strictEqual(graph.getTask('c-t3')?.status, 'completed');

  await adapter.shutdown();
});

test('scenarios: S04 - Quiescence detection and turn/interrupt cancellation handling (R6, R7)', async () => {
  const runner = new CodexProcessRunner({
    binPath: process.execPath,
    extraArgsPrefix: [MOCK_SERVER_PATH]
  });
  const adapter = new CodexAdapter({ runner });

  await adapter.createFresh({
    sessionId: 'thread-interrupt-test',
    runId: 'run-interrupt',
    model: { provider: 'openai', model: 'gpt-5.6-luna' }
  });

  // Start turn then immediately interrupt
  await adapter.submit('thread-interrupt-test', 'msg-int-1', 'long essay');
  const interrupted = await adapter.interruptOwned('thread-interrupt-test');
  assert.strictEqual(interrupted, true);

  const quiescence = await adapter.awaitQuiescence('thread-interrupt-test', 500);
  assert.strictEqual(quiescence, 'quiescent');

  const inspected = adapter.inspectSession('thread-interrupt-test');
  assert.strictEqual(inspected?.active, false);

  await adapter.shutdown();
});

test('scenarios: S05 - User pause priority stops relay sequence immediately (R7)', () => {
  const lease = new WorkspaceLeaseManager();
  lease.acquireInitialLease('ws-pause-codex', 'thread-1', 1);
  const sm = new HandoffStateMachine('run-p-codex', 'thread-1', 1);

  // User pauses mid-execution
  sm.pause();
  assert.strictEqual(sm.getState(), 'PAUSED');

  // Any attempt to request handoff or start new session must be blocked
  assert.throws(() => sm.requestHandoff('unit_completed'), /Cannot request handoff in state PAUSED/);
  assert.throws(() => sm.startNewSession('thread-2'), /Cannot start new session in state PAUSED/);
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `node --experimental-strip-types --test tests/scenarios/codex-relay.test.ts`
Expected: PASS with 3 tests passed.

- [ ] **Step 3: Run full regression test suite**

Run: `npm test`
Expected: All tests (existing 92 tests + all new Codex tests) pass with 0 failures.

- [ ] **Step 4: Commit**

```bash
git add tests/scenarios/codex-relay.test.ts
git commit -m "test(adapters/codex): add 3-round automated relay acceptance suite and robustness tests"
```

---

## Self-Review Checklist

1. **Spec Coverage**:
   - R4 (Fresh session creation, UUIDv7, zero history leakage): Tasks 1, 2, 3, 5.
   - R5 (Preserving effective model `gpt-5.6-luna` & effort `xhigh`): Tasks 1, 2, 3, 5.
   - R6 (Automatic continuous execution, event-driven quiescence): Tasks 2, 3, 5.
   - R7 (User pause/cancellation priority & `turn/interrupt`): Tasks 2, 3, 5.
   - R8 (Codex `app-server --stdio` JSON-RPC 2.0 integration): Tasks 1, 2, 3.
   - R10 (Single-writer CAS lease & unmaterialized thread read guard): Tasks 1, 2, 4, 5.
2. **No Placeholders**: All files, methods, error checks, test assertions, and shell commands are fully defined.
3. **Type Consistency**: `AgentRelayAdapter`, `CodexProcessRunner`, `CodexHandshakeCoordinator`, `SessionCapabilities`, and `SpawnSessionConfig` types match across protocol, adapter, and tests.
4. **Clean Zero-Dependency**: Strictly native Node.js 24 runtime with `--experimental-strip-types`.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-09-18-agent-relay-p2-codex-adapter.md`. Two execution options:

1. **Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration
2. **Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
