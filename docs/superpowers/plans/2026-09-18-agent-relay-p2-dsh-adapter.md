# DSH Adapter (P2-03) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the production-grade DSH Adapter (`packages/adapters/dsh`) adhering to the Unified Adapter SPI (`AgentRelayAdapter`), communicating over Stdio JSON-RPC 2.0 with DSH SDK runtime (`dsh --profile sdk` or direct Node execution via `%LOCALAPPDATA%\DSH Desktop\runtime\current.json`), using a Dedicated Worker Architecture for clean process-level cancellation and isolation, event-driven quiescence tracking (`session.status`, `session.event`), DeepSeek model and provider preservation (`deepseek-official`, `deepseek-chat` / `deepseek-reasoner`), two-phase read-only handshake with atomic CAS workspace lease, and 3-round automated relay without history leakage or double-writing.

**Architecture:** Implement JSON-RPC 2.0 transport over child process Stdio in `DshProcessRunner` (`packages/adapters/dsh/src/runner.ts`) with direct Windows Node resolution fallback to `dsh --profile sdk`. Because DSH runtime protocol lacks a per-session cancel method (`session/cancel`), implement a Dedicated Worker Architecture where each session/handoff unit is managed by a dedicated `DshProcessRunner` process; `interruptOwned` triggers clean `shutdown` / SIGTERM on that dedicated worker without affecting other sessions. Implement `DshAdapter` (`packages/adapters/dsh/src/dsh-adapter.ts`) implementing `AgentRelayAdapter`. Implement `DshHandshakeCoordinator` in `packages/adapters/dsh/src/handshake.ts` to coordinate read-only preparation prompt injection, 3D cryptographic hash verification, and atomic CAS lease progression. Verify the entire system with comprehensive unit, contract, and 3-round end-to-end acceptance tests.

**Tech Stack:** Node.js 24 native ES modules, `--experimental-strip-types`, `node:test`, `node:assert/strict`, `node:child_process`, `node:crypto`, `node:readline`, `node:events`, `node:path`, `node:fs`. Zero external runtime npm dependencies.

**Spec:** `docs/probes/dsh.md`, `packages/protocol/src/adapter.ts`, `agent-relay-design/03-技术设计.md`, `agent-relay-design/04-开发任务清单.md`.

## Global Constraints

- **不可变原话不可覆写 (Immutable Raw Prompts)**: 追加式输入账本（Append-Only Input Ledger），用户原始输入原样保留并校验哈希；修订通过 `supersedesId` 显式引用，禁止使用大模型摘要覆盖历史原话。
- **系统提示隔离 (System Prompt Isolation)**: 生成的交接提示（`generated_handoff`）与系统注入严格与人类真实输入隔离，不得作为新增的人类授权。
- **单一写入者不变量 (Single-Writer Invariant)**: 同一物理工作区在任何时刻仅能由持有单调递增有效 epoch CAS 租约（`newEpoch > expectedEpoch`）的唯一 Owner 写入；新会话在完成只读校验并取得 `EXECUTION_TOKEN` 前绝对禁止写入。
- **Git 工作区无损保护 (Lossless Workspace Protection)**: 严禁自动执行 `git reset --hard`、`git clean` 或 `git stash`；用户已有未暂存改动必须纳入基线指纹予以保护。
- **全量无第三方运行依赖 (Zero Third-Party Dependencies)**: 纯 Node.js 24 原生标准库（`node:test`, `node:crypto`, `node:child_process`, `node:readline`, `node:path`, `node:fs`），零外部 runtime npm 依赖。
- **DSH 独占 Worker 进程约束 (DSH Dedicated Worker Architecture)**: DSH 官方协议缺少逐会话取消方法（`session/cancel`）；适配器为每个交接单元启动独立 `dsh --profile sdk` 子进程，以进程级 `shutdown` / SIGTERM 实现零副作用安全静止与并发任务隔离。
- **严格 Provider 与 Model 校验**: `initialize` 阶段必须指定并校验 Provider（`deepseek-official`）与 Model（`deepseek-chat` 或 `deepseek-reasoner`），无效 Provider 必须触发 `-32603` 错误拒绝握手，严禁静默 fallback。

---

### Task 1: DSH SDK Protocol Types & Mock SDK Server Fixture

**Files:**
- Create: `packages/adapters/dsh/package.json`
- Create: `packages/adapters/dsh/src/types.ts`
- Create: `tests/fixtures/mock-dsh-sdk-server.mjs`
- Test: `tests/adapters/dsh-fixture.test.ts`

**Interfaces:**
- Consumes: JSON-RPC 2.0 specification, `docs/probes/dsh.md`
- Produces: `DshJsonRpcRequest`, `DshJsonRpcResponse`, `DshJsonRpcNotification`, `DshInitializeParams`, `DshInitializeResult`, `DshSessionPromptParams`, `DshSessionPromptResult`, `DshSessionStatusParams`, `DshSessionEventParams`, and mock executable `mock-dsh-sdk-server.mjs`.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/adapters/dsh-fixture.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const MOCK_SERVER_PATH = fileURLToPath(new URL('../fixtures/mock-dsh-sdk-server.mjs', import.meta.url));

test('dsh-fixture: mock sdk server starts and handles initialize, session/prompt, and shutdown via JSON-RPC 2.0', async () => {
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

  // 1. Send initialize with deepseek-official and deepseek-chat
  proc.stdin!.write(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { cwd: process.cwd(), provider: 'deepseek-official', model: 'deepseek-chat' }
    }) + '\n'
  );

  // 2. Send session/prompt
  proc.stdin!.write(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/prompt',
      params: {
        sessionId: 'dsh-session-001',
        contentBlocks: [{ type: 'text', text: 'echo: hello dsh' }]
      }
    }) + '\n'
  );

  // Wait for processing
  await new Promise((r) => setTimeout(r, 100));

  const initRes = responses.find((r) => r.id === 1);
  assert.ok(initRes);
  assert.strictEqual(initRes.result.serverInfo.name, 'deepseek-harness-sdk-runtime');
  assert.strictEqual(initRes.result.serverInfo.version, '0.0.1');

  const promptRes = responses.find((r) => r.id === 2);
  assert.ok(promptRes);
  assert.ok(promptRes.result.messageId);

  // Check notifications received
  const runningStatus = notifications.find(
    (n) => n.method === 'session.status' && n.params?.status === 'running'
  );
  assert.ok(runningStatus);

  const idleStatus = notifications.find(
    (n) => n.method === 'session.status' && n.params?.status === 'idle'
  );
  assert.ok(idleStatus);

  // 3. Send shutdown
  proc.stdin!.write(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 3,
      method: 'shutdown',
      params: {}
    }) + '\n'
  );

  const exitCode = await new Promise((resolve) => {
    proc.on('close', (code) => resolve(code));
  });
  assert.strictEqual(exitCode, 0);
});

test('dsh-fixture: rejects invalid provider on initialize with -32603', async () => {
  const proc = spawn(process.execPath, [MOCK_SERVER_PATH], {
    stdio: ['pipe', 'pipe', 'pipe']
  });

  const rl = readline.createInterface({ input: proc.stdout! });
  const responses: any[] = [];

  rl.on('line', (line) => {
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined) responses.push(msg);
    } catch {}
  });

  proc.stdin!.write(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { cwd: process.cwd(), provider: 'unsupported-provider', model: 'deepseek-chat' }
    }) + '\n'
  );

  await new Promise((r) => setTimeout(r, 60));

  const initRes = responses.find((r) => r.id === 1);
  assert.ok(initRes);
  assert.ok(initRes.error);
  assert.strictEqual(initRes.error.code, -32603);
  assert.ok(initRes.error.message.includes('no adapter registered for provider'));

  proc.kill('SIGTERM');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/adapters/dsh-fixture.test.ts`
Expected: FAIL with "Cannot find module ... mock-dsh-sdk-server.mjs"

- [ ] **Step 3: Write minimal implementation**

Create `packages/adapters/dsh/package.json`:
```json
{
  "name": "@agent-relay/adapter-dsh",
  "version": "0.1.0",
  "private": true,
  "type": "module"
}
```

Create `packages/adapters/dsh/src/types.ts`:
```typescript
export interface DshJsonRpcRequest<T = any> {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: T;
}

export interface DshJsonRpcResponse<T = any> {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: T;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

export interface DshJsonRpcNotification<T = any> {
  jsonrpc: '2.0';
  method: string;
  params?: T;
}

export interface DshInitializeParams {
  cwd: string;
  provider: string;
  model: string;
  reasoningEffort?: string;
  maxTokens?: number;
}

export interface DshInitializeResult {
  serverInfo: {
    name: string;
    version: string;
  };
}

export interface DshSessionPromptContentBlock {
  type: 'text';
  text: string;
}

export interface DshSessionPromptParams {
  sessionId: string;
  contentBlocks: DshSessionPromptContentBlock[];
}

export interface DshSessionPromptResult {
  messageId: string;
}

export interface DshSessionStatusParams {
  sessionId: string;
  status: 'running' | 'idle';
}

export interface DshSessionEventParams {
  sessionId: string;
  event: string;
  data?: any;
  text?: string;
}
```

Create `tests/fixtures/mock-dsh-sdk-server.mjs`:
```javascript
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

let initialized = false;
let configuredProvider = null;
let configuredModel = null;
let configuredEffort = null;
const sessions = new Map();

function sendResponse(id, result, error = null) {
  const resp = { jsonrpc: '2.0', id };
  if (error) {
    resp.error = error;
  } else {
    resp.result = result;
  }
  process.stdout.write(JSON.stringify(resp) + '\n');
}

function sendNotification(method, params) {
  const notif = { jsonrpc: '2.0', method, params };
  process.stdout.write(JSON.stringify(notif) + '\n');
}

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch (err) {
    sendResponse(null, undefined, { code: -32700, message: 'Parse error' });
    return;
  }

  const { id, method, params } = msg;

  if (method === 'initialize') {
    const provider = params?.provider;
    const model = params?.model;
    if (provider !== 'deepseek-official') {
      sendResponse(id, undefined, {
        code: -32603,
        message: `no adapter registered for provider: ${provider}`
      });
      return;
    }
    initialized = true;
    configuredProvider = provider;
    configuredModel = model || 'deepseek-chat';
    configuredEffort = params?.reasoningEffort;

    sendResponse(id, {
      serverInfo: {
        name: 'deepseek-harness-sdk-runtime',
        version: '0.0.1'
      }
    });
    return;
  }

  if (method === 'test/hang') {
    // Deliberately do not respond to test timeout handling
    return;
  }

  if (method === 'shutdown') {
    sendResponse(id, {});
    process.exit(0);
  }

  if (method === 'session/prompt') {
    const sessionId = params?.sessionId || randomUUID();
    const contentBlocks = params?.contentBlocks || [];
    const text = contentBlocks.map((b) => b.text).join('\n');
    const messageId = randomUUID();

    let session = sessions.get(sessionId);
    if (!session) {
      session = { sessionId, messages: [] };
      sessions.set(sessionId, session);
    }
    session.messages.push(text);

    sendResponse(id, { messageId });

    // Emit initial status running
    sendNotification('session.status', { sessionId, status: 'running' });
    sendNotification('session.event', { sessionId, event: 'turn/start', data: { turn: 1 } });
    sendNotification('session.event', { sessionId, event: 'step/start', data: { turn: 1, step: 1 } });

    // Check if preparation prompt requesting ACK
    if (text.includes('PREPARATION_MODE: READ_ONLY')) {
      const handoffIdMatch = text.match(/HANDOFF_ID:\s*([^\s\n]+)/);
      const inputHashMatch = text.match(/INPUT_HEAD_HASH:\s*([^\s\n]+)/);
      const snapshotHashMatch = text.match(/TASK_SNAPSHOT_HASH:\s*([^\s\n]+)/);
      const workspaceHashMatch = text.match(/WORKSPACE_TREE_HASH:\s*([^\s\n]+)/);

      const ackPacket = {
        handoffId: handoffIdMatch ? handoffIdMatch[1] : 'unknown',
        newSessionId: sessionId,
        verifiedInputHeadHash: inputHashMatch ? inputHashMatch[1] : '',
        verifiedTaskSnapshotHash: snapshotHashMatch ? snapshotHashMatch[1] : '',
        verifiedWorkspaceHash: workspaceHashMatch ? workspaceHashMatch[1] : '',
        effectiveModel: {
          provider: configuredProvider || 'deepseek-official',
          model: configuredModel || 'deepseek-chat',
          effort: configuredEffort
        },
        status: 'READY'
      };

      const ackText = `HANDOFF_ACK_START\n${JSON.stringify(ackPacket)}\nHANDOFF_ACK_END`;
      sendNotification('session.event', {
        sessionId,
        event: 'assistant/message',
        text: ackText
      });
    } else if (text.includes('EXECUTION_TOKEN:')) {
      sendNotification('session.event', {
        sessionId,
        event: 'assistant/message',
        text: `EXECUTION_AUTHORIZED: ${text.slice(0, 50)}`
      });
    } else if (text.startsWith('echo:')) {
      sendNotification('session.event', {
        sessionId,
        event: 'assistant/message',
        text: text.slice(5).trim()
      });
    } else {
      sendNotification('session.event', {
        sessionId,
        event: 'assistant/message',
        text: `Processed: ${text.slice(0, 100)}`
      });
    }

    // Emit idle status
    setTimeout(() => {
      sendNotification('session.status', { sessionId, status: 'idle' });
    }, 20);
    return;
  }

  sendResponse(id, undefined, {
    code: -32601,
    message: `Method not found: ${method}`
  });
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/adapters/dsh-fixture.test.ts`
Expected: PASS (2 tests pass)

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/dsh/package.json packages/adapters/dsh/src/types.ts tests/fixtures/mock-dsh-sdk-server.mjs tests/adapters/dsh-fixture.test.ts
git commit -m "feat(adapters/dsh): add DSH SDK protocol types and mock JSON-RPC 2.0 server fixture"
```

---

### Task 2: DSH Process Runner & Dedicated Worker Manager

**Files:**
- Create: `packages/adapters/dsh/src/runner.ts`
- Test: `tests/adapters/dsh-runner.test.ts`

**Interfaces:**
- Consumes: `packages/adapters/dsh/src/types.ts`, `tests/fixtures/mock-dsh-sdk-server.mjs`
- Produces: `DshProcessRunner`, `DshProcessRunnerOptions`, `DshLaunchConfig`, `resolveDshLaunchConfig`.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/adapters/dsh-runner.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { DshProcessRunner, resolveDshLaunchConfig } from '../../packages/adapters/dsh/src/runner.ts';

const MOCK_SERVER_PATH = fileURLToPath(new URL('../fixtures/mock-dsh-sdk-server.mjs', import.meta.url));

test('dsh-runner: resolveDshLaunchConfig returns default config or localAppData config', () => {
  const config = resolveDshLaunchConfig();
  assert.ok(config.command);
  assert.ok(Array.isArray(config.args));
  assert.ok(config.args.includes('--profile') || config.args.includes('sdk'));
});

test('dsh-runner: launches mock server, sends initialize, session/prompt, and receives notifications', async () => {
  const runner = new DshProcessRunner({
    binPath: process.execPath,
    extraArgsPrefix: [MOCK_SERVER_PATH]
  });

  const notifications: any[] = [];
  runner.onNotification((notif) => {
    notifications.push(notif);
  });

  await runner.start();
  assert.strictEqual(runner.isRunning(), true);

  const initRes = await runner.sendRequest('initialize', {
    cwd: process.cwd(),
    provider: 'deepseek-official',
    model: 'deepseek-chat'
  });
  assert.strictEqual(initRes.serverInfo.name, 'deepseek-harness-sdk-runtime');

  const promptRes = await runner.sendRequest('session/prompt', {
    sessionId: 'session-runner-1',
    contentBlocks: [{ type: 'text', text: 'echo: hello from runner' }]
  });
  assert.ok(promptRes.messageId);

  // Wait for idle notification
  await new Promise((r) => setTimeout(r, 60));

  const hasRunning = notifications.some(
    (n) => n.method === 'session.status' && n.params?.status === 'running'
  );
  assert.strictEqual(hasRunning, true);

  const hasIdle = notifications.some(
    (n) => n.method === 'session.status' && n.params?.status === 'idle'
  );
  assert.strictEqual(hasIdle, true);

  await runner.shutdown();
  assert.strictEqual(runner.isRunning(), false);
});

test('dsh-runner: rejects request when server responds with JSON-RPC error', async () => {
  const runner = new DshProcessRunner({
    binPath: process.execPath,
    extraArgsPrefix: [MOCK_SERVER_PATH]
  });

  await runner.start();
  await assert.rejects(
    async () => {
      await runner.sendRequest('initialize', {
        cwd: process.cwd(),
        provider: 'invalid-provider',
        model: 'deepseek-chat'
      });
    },
    {
      message: /no adapter registered for provider/
    }
  );

  await runner.terminate();
});

test('dsh-runner: handles deterministic request timeout cleanly', async () => {
  const runner = new DshProcessRunner({
    binPath: process.execPath,
    extraArgsPrefix: [MOCK_SERVER_PATH]
  });

  await runner.start();
  try {
    await assert.rejects(
      async () => {
        await runner.sendRequest('test/hang', {}, 50);
      },
      {
        message: /timed out after 50ms/
      }
    );
  } finally {
    await runner.terminate();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/adapters/dsh-runner.test.ts`
Expected: FAIL with "Cannot find module ... runner.ts"

- [ ] **Step 3: Write minimal implementation**

Create `packages/adapters/dsh/src/runner.ts`:
```typescript
import { spawn, type ChildProcess } from 'node:child_process';
import readline from 'node:readline';
import path from 'node:path';
import fs from 'node:fs';
import type {
  DshJsonRpcRequest,
  DshJsonRpcResponse,
  DshJsonRpcNotification
} from './types.ts';

export interface DshLaunchConfig {
  command: string;
  args: string[];
  directNode: boolean;
  runtimeDir?: string;
}

export function resolveDshLaunchConfig(): DshLaunchConfig {
  const localAppData = process.env.LOCALAPPDATA || '';
  const currentJsonPath = path.join(localAppData, 'DSH Desktop', 'runtime', 'current.json');

  if (fs.existsSync(currentJsonPath)) {
    try {
      const state = JSON.parse(fs.readFileSync(currentJsonPath, 'utf8'));
      const runtimeDir = path.join(localAppData, 'DSH Desktop', 'runtime', state.relativeDir);
      const nodeExe = path.join(runtimeDir, 'node', 'node.exe');
      const binJs = path.join(runtimeDir, state.entryRelativePath);
      if (fs.existsSync(nodeExe) && fs.existsSync(binJs)) {
        return {
          command: nodeExe,
          args: [binJs, '--profile', 'sdk'],
          directNode: true,
          runtimeDir
        };
      }
    } catch {
      // Fallback
    }
  }

  return {
    command: process.platform === 'win32' ? 'dsh.cmd' : 'dsh',
    args: ['--profile', 'sdk'],
    directNode: false
  };
}

export interface DshProcessRunnerOptions {
  binPath?: string;
  extraArgsPrefix?: string[];
  cwd?: string;
  env?: Record<string, string>;
  startupGracePeriodMs?: number;
}

export class DshProcessRunner {
  private readonly options: DshProcessRunnerOptions;
  private proc: ChildProcess | null = null;
  private stdoutRl: readline.Interface | null = null;
  private stderrRl: readline.Interface | null = null;
  private nextId = 1;
  private readonly pendingRequests = new Map<
    number | string,
    {
      resolve: (value: any) => void;
      reject: (reason: any) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private readonly notificationListeners = new Set<(notification: DshJsonRpcNotification) => void>();
  private readonly stdoutBuffer: string[] = [];
  private readonly stderrBuffer: string[] = [];
  private readonly notificationBuffer: DshJsonRpcNotification[] = [];
  private readonly MAX_BUFFER_LINES = 500;
  private running = false;
  private exitCode: number | null = null;

  constructor(options: DshProcessRunnerOptions = {}) {
    this.options = options;
  }

  public isRunning(): boolean {
    return this.running && this.proc !== null && !this.proc.killed;
  }

  public getExitCode(): number | null {
    return this.exitCode;
  }

  public async start(): Promise<void> {
    if (this.isRunning()) return;

    let command: string;
    let args: string[];
    let useShell = false;

    if (this.options.binPath) {
      command = this.options.binPath;
      args = [...(this.options.extraArgsPrefix || [])];
    } else {
      const launchConfig = resolveDshLaunchConfig();
      command = launchConfig.command;
      args = [...(this.options.extraArgsPrefix || []), ...launchConfig.args];
      useShell = !launchConfig.directNode && process.platform === 'win32';
    }

    const proc = spawn(command, args, {
      cwd: this.options.cwd || process.cwd(),
      env: {
        ...process.env,
        ...(this.options.env || {})
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: useShell
    });

    this.proc = proc;
    this.running = true;
    this.exitCode = null;

    if (proc.stdout) {
      this.stdoutRl = readline.createInterface({ input: proc.stdout, terminal: false });
      this.stdoutRl.on('line', (line) => this.handleStdoutLine(line));
    }

    if (proc.stderr) {
      this.stderrRl = readline.createInterface({ input: proc.stderr, terminal: false });
      this.stderrRl.on('line', (line) => this.handleStderrLine(line));
    }

    let startupError: Error | null = null;
    const earlyExitListener = (code: number | null) => {
      this.running = false;
      this.exitCode = code;
      startupError = new Error(`DSH process exited early with code ${code}`);
    };
    proc.once('exit', earlyExitListener);

    const earlyErrorListener = (err: Error) => {
      startupError = err;
    };
    proc.once('error', earlyErrorListener);

    const graceMs = this.options.startupGracePeriodMs ?? 250;
    await new Promise((resolve) => setTimeout(resolve, graceMs));

    proc.removeListener('exit', earlyExitListener);
    proc.removeListener('error', earlyErrorListener);

    if (startupError) {
      this.cleanup();
      throw startupError;
    }

    proc.on('exit', (code) => {
      this.running = false;
      this.exitCode = code;
      this.rejectAllPending(new Error(`DSH process exited with code ${code}`));
      this.cleanup();
    });

    proc.on('error', (err) => {
      this.running = false;
      this.rejectAllPending(err);
      this.cleanup();
    });
  }

  private handleStdoutLine(line: string): void {
    if (!line.trim()) return;
    this.stdoutBuffer.push(line);
    if (this.stdoutBuffer.length > this.MAX_BUFFER_LINES) {
      this.stdoutBuffer.shift();
    }

    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && this.pendingRequests.has(msg.id)) {
        const pending = this.pendingRequests.get(msg.id)!;
        clearTimeout(pending.timer);
        this.pendingRequests.delete(msg.id);
        if (msg.error) {
          pending.reject(new Error(msg.error.message || `JSON-RPC error ${msg.error.code}`));
        } else {
          pending.resolve(msg.result);
        }
      } else if (msg.method) {
        const notif = msg as DshJsonRpcNotification;
        this.notificationBuffer.push(notif);
        if (this.notificationBuffer.length > this.MAX_BUFFER_LINES) {
          this.notificationBuffer.shift();
        }
        for (const listener of this.notificationListeners) {
          try {
            listener(notif);
          } catch {}
        }
      }
    } catch {}
  }

  private handleStderrLine(line: string): void {
    if (!line.trim()) return;
    this.stderrBuffer.push(line);
    if (this.stderrBuffer.length > this.MAX_BUFFER_LINES) {
      this.stderrBuffer.shift();
    }
  }

  public sendRequest<T = any>(method: string, params: any = {}, timeoutMs = 30000): Promise<T> {
    if (!this.isRunning() || !this.proc?.stdin) {
      return Promise.reject(new Error('Cannot send request: DSH process is not running'));
    }

    const id = this.nextId++;
    const req: DshJsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params
    };

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`DSH request '${method}' (id: ${id}) timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      this.pendingRequests.set(id, { resolve, reject, timer });

      const payload = JSON.stringify(req) + '\n';
      try {
        this.proc!.stdin!.write(payload, (err) => {
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

  public onNotification(listener: (notif: DshJsonRpcNotification) => void): () => void {
    this.notificationListeners.add(listener);
    return () => {
      this.notificationListeners.delete(listener);
    };
  }

  public getStdoutBuffer(): string[] {
    return [...this.stdoutBuffer];
  }

  public getStderrBuffer(): string[] {
    return [...this.stderrBuffer];
  }

  public getNotificationBuffer(): DshJsonRpcNotification[] {
    return [...this.notificationBuffer];
  }

  public async shutdown(timeoutMs = 5000): Promise<void> {
    if (!this.isRunning()) return;

    try {
      await this.sendRequest('shutdown', {}, timeoutMs);
    } catch {}

    await this.terminate();
  }

  public async terminate(): Promise<void> {
    if (!this.proc) return;

    const proc = this.proc;
    if (!proc.killed) {
      proc.kill('SIGTERM');
    }

    const exitPromise = new Promise<void>((resolve) => {
      if (proc.exitCode !== null) return resolve();
      proc.once('exit', () => resolve());
    });

    const fallbackTimer = setTimeout(() => {
      try {
        if (!proc.killed) proc.kill('SIGKILL');
      } catch {}
    }, 500);
    fallbackTimer.unref();

    await exitPromise;
    clearTimeout(fallbackTimer);
    this.cleanup();
  }

  private rejectAllPending(err: Error): void {
    for (const [, req] of this.pendingRequests) {
      clearTimeout(req.timer);
      req.reject(err);
    }
    this.pendingRequests.clear();
  }

  private cleanup(): void {
    this.running = false;
    if (this.stdoutRl) {
      this.stdoutRl.close();
      this.stdoutRl = null;
    }
    if (this.stderrRl) {
      this.stderrRl.close();
      this.stderrRl = null;
    }
    this.proc = null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/adapters/dsh-runner.test.ts`
Expected: PASS (4 tests pass)

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/dsh/src/runner.ts tests/adapters/dsh-runner.test.ts
git commit -m "feat(adapters/dsh): implement DshProcessRunner with JSON-RPC 2.0 lifecycle and launch resolution"
```

---

### Task 3: Production DSH Adapter Implementation & SPI Alignment

**Files:**
- Create: `packages/adapters/dsh/src/dsh-adapter.ts`
- Create: `packages/adapters/dsh/src/index.ts`
- Modify: `tests/contracts/adapter-spi.test.ts`
- Test: `tests/adapters/dsh-adapter.test.ts`

**Interfaces:**
- Consumes: `AgentRelayAdapter` from `packages/protocol/src/adapter.ts`, `DshProcessRunner`, `types.ts`
- Produces: `DshAdapter`, `DshAdapterOptions`, satisfying full `AgentRelayAdapter` contract.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/adapters/dsh-adapter.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { DshAdapter } from '../../packages/adapters/dsh/src/dsh-adapter.ts';

const MOCK_SERVER_PATH = fileURLToPath(new URL('../fixtures/mock-dsh-sdk-server.mjs', import.meta.url));

test('dsh-adapter: implements AgentRelayAdapter with L3 capability and dedicated worker lifecycle', async () => {
  const adapter = new DshAdapter({
    runnerOptions: {
      binPath: process.execPath,
      extraArgsPrefix: [MOCK_SERVER_PATH]
    }
  });

  const caps = adapter.capabilities();
  assert.strictEqual(caps.level, 'L3');
  assert.strictEqual(caps.streamJsonSupported, true);
  assert.strictEqual(caps.modelEffortPreservation, true);
  assert.strictEqual(caps.headlessSupported, true);
  assert.strictEqual(caps.cancellationSupported, true);
  assert.strictEqual(caps.nativeRevealSupported, false);

  const fresh = await adapter.createFresh({
    sessionId: 'session-dsh-100',
    runId: 'run-dsh-100',
    model: { provider: 'deepseek-official', model: 'deepseek-chat', effort: 'high' },
    initialPrompt: 'echo: PROBE_SUCCESS_DSH'
  });

  assert.strictEqual(fresh.sessionId, 'session-dsh-100');
  assert.strictEqual(fresh.active, true);
  assert.strictEqual(fresh.effectiveModel?.model, 'deepseek-chat');
  assert.strictEqual(fresh.effectiveModel?.provider, 'deepseek-official');
  assert.strictEqual(fresh.effectiveModel?.effort, 'high');

  const inspected = await adapter.inspectSession('session-dsh-100');
  assert.strictEqual(inspected?.sessionId, 'session-dsh-100');
  assert.strictEqual(inspected?.effectiveModel?.model, 'deepseek-chat');
  assert.strictEqual(inspected?.active, true);

  const quiescence = await adapter.awaitQuiescence('session-dsh-100', 1000);
  assert.strictEqual(quiescence, 'quiescent');

  const output = adapter.getSessionOutput('session-dsh-100');
  assert.ok(output.includes('PROBE_SUCCESS_DSH'));

  const events = adapter.getSessionEvents('session-dsh-100');
  assert.ok(events.length > 0);

  // Submit next turn
  await adapter.submit('session-dsh-100', 'm-2', 'echo: next dsh turn');
  await adapter.awaitQuiescence('session-dsh-100', 1000);
  assert.ok(adapter.getSessionOutput('session-dsh-100').includes('next dsh turn'));

  // Drain and authorize
  const drainRes = await adapter.requestDrain('session-dsh-100', 'h-1');
  assert.strictEqual(drainRes, true);

  const authRes = await adapter.authorizeExecution('session-dsh-100', 2, 'EXEC_TOKEN_DSH_999');
  assert.strictEqual(authRes, true);
  await adapter.awaitQuiescence('session-dsh-100', 1000);

  // Interrupt dedicated worker
  const interruptRes = await adapter.interruptOwned('session-dsh-100');
  assert.strictEqual(interruptRes, true);

  const afterInterrupt = await adapter.inspectSession('session-dsh-100');
  assert.strictEqual(afterInterrupt?.active, false);

  await adapter.shutdown();
});

test('dsh-adapter: handles nonexistent session edge cases gracefully', async () => {
  const adapter = new DshAdapter();

  assert.strictEqual(await adapter.inspectSession('nonexistent-session'), undefined);
  assert.strictEqual(await adapter.requestDrain('nonexistent-session', 'h-0'), false);
  assert.strictEqual(await adapter.awaitQuiescence('nonexistent-session', 100), 'error');
  assert.strictEqual(await adapter.authorizeExecution('nonexistent-session', 1, 'tok'), false);
  assert.strictEqual(await adapter.interruptOwned('nonexistent-session'), false);
  assert.strictEqual(adapter.getSessionOutput('nonexistent-session'), '');
  assert.deepStrictEqual(adapter.getSessionEvents('nonexistent-session'), []);

  await assert.rejects(
    async () => {
      await adapter.submit('nonexistent-session', 'm-1', 'hello');
    },
    {
      message: /Cannot submit to nonexistent session nonexistent-session/
    }
  );

  await adapter.shutdown();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/adapters/dsh-adapter.test.ts`
Expected: FAIL with "Cannot find module ... dsh-adapter.ts"

- [ ] **Step 3: Write minimal implementation**

Create `packages/adapters/dsh/src/dsh-adapter.ts`:
```typescript
import { randomUUID } from 'node:crypto';
import type {
  AgentRelayAdapter,
  SessionCapabilities,
  SessionInspectResult,
  SpawnSessionConfig
} from '../../../protocol/src/adapter.ts';
import { DshProcessRunner, type DshProcessRunnerOptions } from './runner.ts';
import type {
  DshInitializeResult,
  DshSessionPromptResult,
  DshJsonRpcNotification,
  DshSessionStatusParams,
  DshSessionEventParams
} from './types.ts';

export interface DshAdapterOptions {
  runnerOptions?: DshProcessRunnerOptions;
  runnerFactory?: (sessionId: string, config: SpawnSessionConfig) => DshProcessRunner;
}

interface DshSessionState {
  sessionId: string;
  runId: string;
  runner: DshProcessRunner;
  active: boolean;
  draining: boolean;
  isIdle: boolean;
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
  events: DshJsonRpcNotification[];
  exitCode?: number | null;
  quiescenceWaiters: Array<() => void>;
  unsubscribeNotifications: (() => void) | null;
}

export class DshAdapter implements AgentRelayAdapter {
  private readonly options: DshAdapterOptions;
  private readonly sessions: Map<string, DshSessionState> = new Map();

  constructor(options: DshAdapterOptions = {}) {
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

  public async createFresh(config: SpawnSessionConfig): Promise<SessionInspectResult> {
    const sessionId = config.sessionId || `dsh-${randomUUID()}`;
    const targetModel = config.model?.model || 'deepseek-chat';
    const targetProvider = config.model?.provider || 'deepseek-official';
    const targetEffort = config.model?.effort;
    const cwd = config.cwd || process.cwd();

    // Spawn dedicated worker for this session
    const runner = this.options.runnerFactory
      ? this.options.runnerFactory(sessionId, config)
      : new DshProcessRunner({
          ...(this.options.runnerOptions || {}),
          cwd,
          env: config.env
        });

    await runner.start();

    // Initialize dedicated worker with target provider & model
    const initRes = await runner.sendRequest<DshInitializeResult>('initialize', {
      cwd,
      provider: targetProvider,
      model: targetModel,
      reasoningEffort: targetEffort
    });

    const state: DshSessionState = {
      sessionId,
      runId: config.runId,
      runner,
      active: true,
      draining: false,
      isIdle: true,
      effectiveModel: {
        provider: targetProvider,
        model: targetModel,
        effort: targetEffort
      },
      cwd,
      executionAuthorized: !config.readOnly,
      outputChunks: [],
      events: [],
      quiescenceWaiters: [],
      unsubscribeNotifications: null
    };

    state.unsubscribeNotifications = runner.onNotification((notif) => {
      this.handleNotification(state, notif);
    });

    this.sessions.set(sessionId, state);

    if (config.initialPrompt) {
      state.isIdle = false;
      try {
        await runner.sendRequest<DshSessionPromptResult>('session/prompt', {
          sessionId,
          contentBlocks: [{ type: 'text', text: config.initialPrompt }]
        });
      } catch (err) {
        state.isIdle = true;
        throw err;
      }
    }

    return {
      sessionId,
      active: state.active,
      effectiveModel: state.effectiveModel,
      cwd: state.cwd,
      exitCode: state.exitCode
    };
  }

  public async inspectSession(sessionId: string): Promise<SessionInspectResult | undefined> {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;

    return {
      sessionId: session.sessionId,
      active: session.active && session.runner.isRunning(),
      effectiveModel: session.effectiveModel,
      cwd: session.cwd,
      exitCode: session.exitCode ?? session.runner.getExitCode()
    };
  }

  public async submit(sessionId: string, messageId: string, content: string, epoch?: number): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Cannot submit to nonexistent session ${sessionId}`);
    }

    if (!session.active || !session.runner.isRunning()) {
      throw new Error(`Cannot submit to inactive session ${sessionId}`);
    }

    if (epoch !== undefined) {
      session.epoch = epoch;
    }

    session.isIdle = false;
    try {
      await session.runner.sendRequest<DshSessionPromptResult>('session/prompt', {
        sessionId,
        contentBlocks: [{ type: 'text', text: content }]
      });
    } catch (err) {
      session.isIdle = true;
      throw err;
    }
  }

  public async requestDrain(sessionId: string, handoffId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session || !session.active) return false;

    session.draining = true;
    return true;
  }

  public async awaitQuiescence(sessionId: string, timeoutMs = 30000): Promise<'quiescent' | 'timeout' | 'error'> {
    const session = this.sessions.get(sessionId);
    if (!session) return 'error';

    if (session.isIdle) return 'quiescent';

    return new Promise<'quiescent' | 'timeout' | 'error'>((resolve) => {
      let resolved = false;

      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          resolve('timeout');
        }
      }, timeoutMs);

      session.quiescenceWaiters.push(() => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          resolve('quiescent');
        }
      });
    });
  }

  public async authorizeExecution(sessionId: string, epoch: number, executionToken: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session || !session.active) return false;

    session.epoch = epoch;
    session.executionToken = executionToken;
    session.executionAuthorized = true;

    try {
      await this.submit(sessionId, `auth-${randomUUID()}`, `EXECUTION_TOKEN: ${executionToken}`, epoch);
      return true;
    } catch {
      return false;
    }
  }

  public async interruptOwned(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    session.active = false;
    session.isIdle = true;
    this.notifyQuiescence(session);

    try {
      await session.runner.shutdown();
      session.exitCode = session.runner.getExitCode() ?? 0;
      return true;
    } catch {
      await session.runner.terminate();
      session.exitCode = session.runner.getExitCode() ?? 0;
      return true;
    }
  }

  public getSessionOutput(sessionId: string): string {
    const session = this.sessions.get(sessionId);
    return session ? session.outputChunks.join('') : '';
  }

  public getSessionEvents(sessionId: string): DshJsonRpcNotification[] {
    const session = this.sessions.get(sessionId);
    return session ? [...session.events] : [];
  }

  public async shutdown(): Promise<void> {
    for (const [, session] of this.sessions) {
      if (session.unsubscribeNotifications) {
        session.unsubscribeNotifications();
        session.unsubscribeNotifications = null;
      }
      if (session.active) {
        session.active = false;
        await session.runner.shutdown().catch(() => session.runner.terminate());
      }
    }
    this.sessions.clear();
  }

  private handleNotification(session: DshSessionState, notif: DshJsonRpcNotification): void {
    session.events.push(notif);

    if (notif.method === 'session.status') {
      const params = notif.params as DshSessionStatusParams | undefined;
      if (params?.status === 'idle') {
        session.isIdle = true;
        this.notifyQuiescence(session);
      } else if (params?.status === 'running') {
        session.isIdle = false;
      }
    } else if (notif.method === 'session.event') {
      const params = notif.params as DshSessionEventParams | undefined;
      if (params?.text) {
        session.outputChunks.push(params.text);
      }
    }
  }

  private notifyQuiescence(session: DshSessionState): void {
    const waiters = [...session.quiescenceWaiters];
    session.quiescenceWaiters.length = 0;
    for (const waiter of waiters) {
      try {
        waiter();
      } catch {}
    }
  }
}
```

Create `packages/adapters/dsh/src/index.ts`:
```typescript
export * from './types.ts';
export * from './runner.ts';
export * from './dsh-adapter.ts';
export * from './handshake.ts';
```

Modify `tests/contracts/adapter-spi.test.ts` to add `dsh-adapter`:
```typescript
test('adapter-spi: DshAdapter implements AgentRelayAdapter interface', async () => {
  const mockServerPath = fileURLToPath(new URL('../fixtures/mock-dsh-sdk-server.mjs', import.meta.url));
  const adapter: AgentRelayAdapter = new DshAdapter({
    runnerOptions: {
      binPath: process.execPath,
      extraArgsPrefix: [mockServerPath]
    }
  });

  const caps = adapter.capabilities();
  assert.strictEqual(caps.level, 'L3');
  assert.strictEqual(caps.streamJsonSupported, true);
  assert.strictEqual(caps.modelEffortPreservation, true);
  assert.strictEqual(caps.headlessSupported, true);
  assert.strictEqual(caps.cancellationSupported, true);

  const config: SpawnSessionConfig = {
    sessionId: 'sess-spi-dsh',
    runId: 'run-spi-dsh-1',
    model: { provider: 'deepseek-official', model: 'deepseek-chat', effort: 'high' },
    initialPrompt: 'echo: dsh-spi'
  };

  const inspect = await adapter.createFresh(config);
  assert.strictEqual(inspect.sessionId, 'sess-spi-dsh');
  assert.strictEqual(inspect.active, true);
  assert.strictEqual(inspect.effectiveModel?.model, 'deepseek-chat');
  assert.strictEqual(inspect.effectiveModel?.provider, 'deepseek-official');

  const inspected = await adapter.inspectSession('sess-spi-dsh');
  assert.strictEqual(inspected?.sessionId, 'sess-spi-dsh');

  const drainSuccess = await adapter.requestDrain('sess-spi-dsh', 'handoff-dsh');
  assert.strictEqual(drainSuccess, true);

  const quiescence = await adapter.awaitQuiescence('sess-spi-dsh', 1000);
  assert.strictEqual(quiescence, 'quiescent');

  const authSuccess = await adapter.authorizeExecution('sess-spi-dsh', 2, 'TOKEN_DSH_SPI');
  assert.strictEqual(authSuccess, true);

  const interrupted = await adapter.interruptOwned('sess-spi-dsh');
  assert.strictEqual(interrupted, true);

  const afterInterrupt = await adapter.inspectSession('sess-spi-dsh');
  assert.strictEqual(afterInterrupt?.active, false);

  await (adapter as DshAdapter).shutdown();
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/adapters/dsh-adapter.test.ts tests/contracts/adapter-spi.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/dsh/src/dsh-adapter.ts packages/adapters/dsh/src/index.ts tests/adapters/dsh-adapter.test.ts tests/contracts/adapter-spi.test.ts
git commit -m "feat(adapters/dsh): implement DshAdapter matching unified AgentRelayAdapter SPI"
```

---

### Task 4: Two-Phase Read-Only Handshake Coordinator for DSH

**Files:**
- Create: `packages/adapters/dsh/src/handshake.ts`
- Test: `tests/adapters/dsh-handshake.test.ts`

**Interfaces:**
- Consumes: `packages/protocol/src/handoff.ts`, `packages/controller/src/handoff/lease.ts`, `packages/controller/src/handoff/state-machine.ts`, `DshAdapter`
- Produces: `DshHandshakeCoordinator`, `HandshakeResult`.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/adapters/dsh-handshake.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { DshAdapter } from '../../packages/adapters/dsh/src/dsh-adapter.ts';
import { DshHandshakeCoordinator } from '../../packages/adapters/dsh/src/handshake.ts';
import { WorkspaceLeaseManager } from '../../packages/controller/src/handoff/lease.ts';
import { HandoffStateMachine } from '../../packages/controller/src/handoff/state-machine.ts';
import type { HandoffPackManifest, HandoffAckPacket } from '../../packages/protocol/src/handoff.ts';

const MOCK_SERVER_PATH = fileURLToPath(new URL('../fixtures/mock-dsh-sdk-server.mjs', import.meta.url));

test('dsh-handshake: prepares read-only prompt, verifies 3D hashes, and increments CAS lease epoch', async () => {
  const adapter = new DshAdapter({
    runnerOptions: {
      binPath: process.execPath,
      extraArgsPrefix: [MOCK_SERVER_PATH]
    }
  });

  const leaseManager = new WorkspaceLeaseManager();
  const workspaceKey = 'ws-dsh-test';
  leaseManager.acquireLease(workspaceKey, 'source-dsh-session', 1);

  const stateMachine = new HandoffStateMachine({
    handoffId: 'h-dsh-1',
    taskUnitId: 'unit-dsh-1',
    sourceSessionId: 'source-dsh-session',
    targetAdapterType: 'dsh',
    workspacePath: process.cwd()
  });
  stateMachine.prepare();

  const coordinator = new DshHandshakeCoordinator({
    adapter,
    leaseManager,
    stateMachine,
    workspaceKey
  });

  const manifest: HandoffPackManifest = {
    handoffId: 'h-dsh-1',
    taskUnitId: 'unit-dsh-1',
    sourceSessionId: 'source-dsh-session',
    targetSessionId: 'target-dsh-session',
    epoch: 1,
    targetModel: { provider: 'deepseek-official', model: 'deepseek-chat', effort: 'high' },
    inputLedgerHeadHash: 'hash-input-999',
    taskSnapshotHash: 'hash-task-888',
    workspaceFingerprint: {
      treeHash: 'hash-tree-777',
      uncommittedDiffHash: 'hash-diff-000',
      trackedFilesCount: 10
    },
    contextSummary: 'Preparation step for DSH'
  };

  const prepPrompt = coordinator.buildPreparationPrompt(manifest);
  assert.ok(prepPrompt.includes('PREPARATION_MODE: READ_ONLY'));
  assert.ok(prepPrompt.includes('HANDOFF_ID: h-dsh-1'));
  assert.ok(prepPrompt.includes('INPUT_HEAD_HASH: hash-input-999'));

  // Spawn fresh target session with preparation prompt
  await adapter.createFresh({
    sessionId: 'target-dsh-session',
    runId: 'run-dsh-test',
    readOnly: true,
    model: manifest.targetModel,
    initialPrompt: prepPrompt
  });

  await adapter.awaitQuiescence('target-dsh-session', 1000);

  const output = adapter.getSessionOutput('target-dsh-session');
  assert.ok(output.includes('HANDOFF_ACK_START'));

  const ack = coordinator.parseAckFromOutput(output);
  assert.ok(ack);
  assert.strictEqual(ack?.handoffId, 'h-dsh-1');
  assert.strictEqual(ack?.verifiedInputHeadHash, 'hash-input-999');

  const authResult = coordinator.verifyAckAndAuthorize(manifest, ack!);
  assert.strictEqual(authResult.success, true);
  assert.strictEqual(authResult.epoch, 2);
  assert.ok(authResult.executionToken);

  const updatedLease = leaseManager.getLease(workspaceKey);
  assert.strictEqual(updatedLease?.currentOwner, 'target-dsh-session');
  assert.strictEqual(updatedLease?.epoch, 2);

  await adapter.shutdown();
});

test('dsh-handshake: rejects ACK on hash mismatch or model mismatch without mutating lease', () => {
  const adapter = new DshAdapter();
  const leaseManager = new WorkspaceLeaseManager();
  const workspaceKey = 'ws-dsh-test';
  leaseManager.acquireLease(workspaceKey, 'source-dsh', 1);

  const stateMachine = new HandoffStateMachine({
    handoffId: 'h-1',
    taskUnitId: 'u-1',
    sourceSessionId: 'source-dsh',
    targetAdapterType: 'dsh',
    workspacePath: process.cwd()
  });
  stateMachine.prepare();

  const coordinator = new DshHandshakeCoordinator({
    adapter,
    leaseManager,
    stateMachine,
    workspaceKey
  });

  const manifest: HandoffPackManifest = {
    handoffId: 'h-1',
    taskUnitId: 'u-1',
    sourceSessionId: 'source-dsh',
    targetSessionId: 'target-dsh',
    epoch: 1,
    targetModel: { provider: 'deepseek-official', model: 'deepseek-chat' },
    inputLedgerHeadHash: 'correct-input-hash',
    taskSnapshotHash: 'correct-task-hash',
    workspaceFingerprint: { treeHash: 'correct-tree-hash', uncommittedDiffHash: '', trackedFilesCount: 1 },
    contextSummary: 'test'
  };

  const badAck: HandoffAckPacket = {
    handoffId: 'h-1',
    newSessionId: 'target-dsh',
    verifiedInputHeadHash: 'wrong-input-hash',
    verifiedTaskSnapshotHash: 'correct-task-hash',
    verifiedWorkspaceHash: 'correct-tree-hash',
    effectiveModel: { provider: 'deepseek-official', model: 'deepseek-chat' },
    status: 'READY'
  };

  const res = coordinator.verifyAckAndAuthorize(manifest, badAck);
  assert.strictEqual(res.success, false);
  assert.ok(res.error?.includes('Input ledger head hash mismatch'));

  const lease = leaseManager.getLease(workspaceKey);
  assert.strictEqual(lease?.currentOwner, 'source-dsh');
  assert.strictEqual(lease?.epoch, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/adapters/dsh-handshake.test.ts`
Expected: FAIL with "Cannot find module ... handshake.ts"

- [ ] **Step 3: Write minimal implementation**

Create `packages/adapters/dsh/src/handshake.ts`:
```typescript
import type { DshAdapter } from './dsh-adapter.ts';
import type { WorkspaceLeaseManager } from '../../../controller/src/handoff/lease.ts';
import type { HandoffStateMachine } from '../../../controller/src/handoff/state-machine.ts';
import type { HandoffPackManifest, HandoffAckPacket } from '../../../protocol/src/handoff.ts';

export interface DshHandshakeCoordinatorOptions {
  adapter: DshAdapter;
  leaseManager: WorkspaceLeaseManager;
  stateMachine: HandoffStateMachine;
  workspaceKey: string;
}

export interface HandshakeResult {
  success: boolean;
  executionToken?: string;
  epoch?: number;
  error?: string;
}

export class DshHandshakeCoordinator {
  private readonly adapter: DshAdapter;
  private readonly leaseManager: WorkspaceLeaseManager;
  private readonly stateMachine: HandoffStateMachine;
  private readonly workspaceKey: string;

  constructor(options: DshHandshakeCoordinatorOptions) {
    this.adapter = options.adapter;
    this.leaseManager = options.leaseManager;
    this.stateMachine = options.stateMachine;
    this.workspaceKey = options.workspaceKey;
  }

  public buildPreparationPrompt(manifest: HandoffPackManifest): string {
    return [
      '<<<AGENT_RELAY_HANDOFF_PREPARATION>>>',
      'PREPARATION_MODE: READ_ONLY',
      `HANDOFF_ID: ${manifest.handoffId}`,
      `TASK_UNIT_ID: ${manifest.taskUnitId}`,
      `SOURCE_SESSION_ID: ${manifest.sourceSessionId}`,
      `TARGET_SESSION_ID: ${manifest.targetSessionId}`,
      `EPOCH: ${manifest.epoch}`,
      `INPUT_HEAD_HASH: ${manifest.inputLedgerHeadHash}`,
      `TASK_SNAPSHOT_HASH: ${manifest.taskSnapshotHash}`,
      `WORKSPACE_TREE_HASH: ${manifest.workspaceFingerprint.treeHash}`,
      `UNCOMMITTED_DIFF_HASH: ${manifest.workspaceFingerprint.uncommittedDiffHash}`,
      `CONTEXT_SUMMARY: ${manifest.contextSummary}`,
      'INSTRUCTION: Verify workspace hashes and reply strictly with HANDOFF_ACK_START and HANDOFF_ACK_END block.',
      '<<<END_AGENT_RELAY_HANDOFF_PREPARATION>>>'
    ].join('\n');
  }

  public parseAckFromOutput(output: string): HandoffAckPacket | null {
    const startIndex = output.indexOf('HANDOFF_ACK_START');
    const endIndex = output.indexOf('HANDOFF_ACK_END');
    if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
      return null;
    }

    const jsonStr = output.slice(startIndex + 'HANDOFF_ACK_START'.length, endIndex).trim();
    try {
      return JSON.parse(jsonStr) as HandoffAckPacket;
    } catch {
      return null;
    }
  }

  public verifyAckAndAuthorize(manifest: HandoffPackManifest, ack: HandoffAckPacket): HandshakeResult {
    if (ack.handoffId !== manifest.handoffId) {
      return { success: false, error: `Handoff ID mismatch: expected ${manifest.handoffId}, got ${ack.handoffId}` };
    }

    if (ack.verifiedInputHeadHash !== manifest.inputLedgerHeadHash) {
      return { success: false, error: `Input ledger head hash mismatch: expected ${manifest.inputLedgerHeadHash}, got ${ack.verifiedInputHeadHash}` };
    }

    if (ack.verifiedTaskSnapshotHash !== manifest.taskSnapshotHash) {
      return { success: false, error: `Task snapshot hash mismatch: expected ${manifest.taskSnapshotHash}, got ${ack.verifiedTaskSnapshotHash}` };
    }

    if (ack.verifiedWorkspaceHash !== manifest.workspaceFingerprint.treeHash) {
      return { success: false, error: `Workspace hash mismatch: expected ${manifest.workspaceFingerprint.treeHash}, got ${ack.verifiedWorkspaceHash}` };
    }

    if (ack.effectiveModel?.model !== manifest.targetModel.model) {
      return { success: false, error: `Model mismatch: expected ${manifest.targetModel.model}, got ${ack.effectiveModel?.model}` };
    }

    if (this.stateMachine.getState() !== 'PREPARING') {
      return { success: false, error: `Cannot receive ACK in state ${this.stateMachine.getState()}` };
    }

    const currentLease = this.leaseManager.getLease(this.workspaceKey);
    if (!currentLease) {
      return { success: false, error: `No active lease for workspace ${this.workspaceKey}` };
    }

    if (currentLease.currentOwner !== manifest.sourceSessionId) {
      return { success: false, error: `Lease owner mismatch: expected ${manifest.sourceSessionId}, got ${currentLease.currentOwner}` };
    }

    if (currentLease.epoch !== manifest.epoch) {
      return { success: false, error: `Lease epoch mismatch: expected ${manifest.epoch}, got ${currentLease.epoch}` };
    }

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

    try {
      this.stateMachine.receiveAck(ack);
      const token = this.stateMachine.issueExecutionToken();
      return {
        success: true,
        executionToken: token.token,
        epoch: token.epoch
      };
    } catch (err: unknown) {
      // Monotonic rollback
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
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/adapters/dsh-handshake.test.ts`
Expected: PASS (2 tests pass)

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/dsh/src/handshake.ts tests/adapters/dsh-handshake.test.ts
git commit -m "feat(adapters/dsh): implement DshHandshakeCoordinator with CAS lease integration"
```

---

### Task 5: 3-Round Automated Relay Acceptance & Robustness Suite (S01~S05)

**Files:**
- Test: `tests/scenarios/dsh-relay.test.ts`

**Interfaces:**
- Consumes: `DshAdapter`, `DshHandshakeCoordinator`, `InputLedger`, `TaskGraph`, `WorkspaceLeaseManager`
- Produces: S01~S05 automated acceptance test suite for DSH.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/scenarios/dsh-relay.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { DshAdapter } from '../../packages/adapters/dsh/src/dsh-adapter.ts';
import { DshHandshakeCoordinator } from '../../packages/adapters/dsh/src/handshake.ts';
import { InputLedger } from '../../packages/controller/src/inputs/ledger.ts';
import { TaskGraph } from '../../packages/controller/src/tasks/graph.ts';
import { WorkspaceLeaseManager } from '../../packages/controller/src/handoff/lease.ts';
import { HandoffStateMachine } from '../../packages/controller/src/handoff/state-machine.ts';
import type { HandoffPackManifest } from '../../packages/protocol/src/handoff.ts';

const MOCK_SERVER_PATH = fileURLToPath(new URL('../fixtures/mock-dsh-sdk-server.mjs', import.meta.url));

test('scenarios: S01~S03 - 3-round automated DSH relay with model preservation and CAS lease', async () => {
  const adapter = new DshAdapter({
    runnerOptions: {
      binPath: process.execPath,
      extraArgsPrefix: [MOCK_SERVER_PATH]
    }
  });

  const ledger = new InputLedger();
  ledger.append('User original task instruction for DSH multi-round relay');
  const inputHash = ledger.getHeadHash();

  const graph = new TaskGraph();
  graph.addTask({ id: 'd-t1', title: 'Task Unit 1' });
  graph.addTask({ id: 'd-t2', title: 'Task Unit 2' });
  graph.addTask({ id: 'd-t3', title: 'Task Unit 3' });
  const snapshotHash = graph.getSnapshotHash();
  const workspaceTreeHash = 'hash-ws-dsh-round';

  const lease = new WorkspaceLeaseManager();
  const workspaceKey = 'ws-dsh-scenario';

  // --- ROUND 1: Worker A ---
  const workerA_Id = 'worker-dsh-A';
  lease.acquireLease(workspaceKey, workerA_Id, 1);

  await adapter.createFresh({
    sessionId: workerA_Id,
    runId: 'run-dsh-1',
    model: { provider: 'deepseek-official', model: 'deepseek-chat', effort: 'high' },
    initialPrompt: 'echo: Worker A starting unit 1'
  });
  await adapter.awaitQuiescence(workerA_Id, 1000);
  assert.ok(adapter.getSessionOutput(workerA_Id).includes('Worker A starting unit 1'));
  graph.updateStatus('d-t1', 'completed');

  // Handoff to Worker B
  const sm1 = new HandoffStateMachine({
    handoffId: 'h-dsh-r1-r2',
    taskUnitId: 'd-t2',
    sourceSessionId: workerA_Id,
    targetAdapterType: 'dsh',
    workspacePath: process.cwd()
  });
  sm1.prepare();

  const coord1 = new DshHandshakeCoordinator({
    adapter,
    leaseManager: lease,
    stateMachine: sm1,
    workspaceKey
  });

  const workerB_Id = 'worker-dsh-B';
  const manifest1: HandoffPackManifest = {
    handoffId: 'h-dsh-r1-r2',
    taskUnitId: 'd-t2',
    sourceSessionId: workerA_Id,
    targetSessionId: workerB_Id,
    epoch: 1,
    targetModel: { provider: 'deepseek-official', model: 'deepseek-chat', effort: 'high' },
    inputLedgerHeadHash: inputHash,
    taskSnapshotHash: snapshotHash,
    workspaceFingerprint: { treeHash: workspaceTreeHash, uncommittedDiffHash: '', trackedFilesCount: 5 },
    contextSummary: 'Worker A handed off to Worker B'
  };

  const prepPrompt1 = coord1.buildPreparationPrompt(manifest1);
  await adapter.createFresh({
    sessionId: workerB_Id,
    runId: 'run-dsh-2',
    readOnly: true,
    model: manifest1.targetModel,
    initialPrompt: prepPrompt1
  });
  await adapter.awaitQuiescence(workerB_Id, 1000);

  const ack1 = coord1.parseAckFromOutput(adapter.getSessionOutput(workerB_Id));
  assert.ok(ack1);
  assert.strictEqual(ack1?.effectiveModel?.model, 'deepseek-chat');
  assert.strictEqual(ack1?.effectiveModel?.provider, 'deepseek-official');

  const auth1 = coord1.verifyAckAndAuthorize(manifest1, ack1!);
  assert.strictEqual(auth1.success, true);
  assert.strictEqual(auth1.epoch, 2);

  // Verify Worker A is blocked from further CAS write attempts with old epoch 1
  assert.strictEqual(lease.compareAndSetOwner(workspaceKey, workerA_Id, 'worker-dsh-X', 1, 3), false);

  await adapter.authorizeExecution(workerB_Id, auth1.epoch!, auth1.executionToken!);
  await adapter.awaitQuiescence(workerB_Id, 1000);
  assert.ok(adapter.getSessionOutput(workerB_Id).includes('EXECUTION_AUTHORIZED'));
  graph.updateStatus('d-t2', 'completed');

  // --- ROUND 2 to ROUND 3: Worker B -> Worker C ---
  const workerC_Id = 'worker-dsh-C';
  const sm2 = new HandoffStateMachine({
    handoffId: 'h-dsh-r2-r3',
    taskUnitId: 'd-t3',
    sourceSessionId: workerB_Id,
    targetAdapterType: 'dsh',
    workspacePath: process.cwd()
  });
  sm2.prepare();

  const coord2 = new DshHandshakeCoordinator({
    adapter,
    leaseManager: lease,
    stateMachine: sm2,
    workspaceKey
  });

  const manifest2: HandoffPackManifest = {
    handoffId: 'h-dsh-r2-r3',
    taskUnitId: 'd-t3',
    sourceSessionId: workerB_Id,
    targetSessionId: workerC_Id,
    epoch: 2,
    targetModel: { provider: 'deepseek-official', model: 'deepseek-reasoner', effort: 'high' },
    inputLedgerHeadHash: inputHash,
    taskSnapshotHash: snapshotHash,
    workspaceFingerprint: { treeHash: workspaceTreeHash, uncommittedDiffHash: '', trackedFilesCount: 5 },
    contextSummary: 'Worker B handed off to Worker C with deepseek-reasoner'
  };

  const prepPrompt2 = coord2.buildPreparationPrompt(manifest2);
  await adapter.createFresh({
    sessionId: workerC_Id,
    runId: 'run-dsh-3',
    readOnly: true,
    model: manifest2.targetModel,
    initialPrompt: prepPrompt2
  });
  await adapter.awaitQuiescence(workerC_Id, 1000);

  const ack2 = coord2.parseAckFromOutput(adapter.getSessionOutput(workerC_Id));
  assert.ok(ack2);
  assert.strictEqual(ack2?.effectiveModel?.model, 'deepseek-reasoner');

  const auth2 = coord2.verifyAckAndAuthorize(manifest2, ack2!);
  assert.strictEqual(auth2.success, true);
  assert.strictEqual(auth2.epoch, 3);

  await adapter.authorizeExecution(workerC_Id, auth2.epoch!, auth2.executionToken!);
  await adapter.awaitQuiescence(workerC_Id, 1000);
  graph.updateStatus('d-t3', 'completed');

  // Verify all tasks completed across all 3 workers
  assert.strictEqual(graph.getTask('d-t1')?.status, 'completed');
  assert.strictEqual(graph.getTask('d-t2')?.status, 'completed');
  assert.strictEqual(graph.getTask('d-t3')?.status, 'completed');

  // Verify final lease owner is Worker C at epoch 3
  const finalLease = lease.getLease(workspaceKey);
  assert.strictEqual(finalLease?.currentOwner, workerC_Id);
  assert.strictEqual(finalLease?.epoch, 3);

  await adapter.shutdown();
});

test('scenarios: S04~S05 - dedicated worker shutdown and cancellation priority', async () => {
  const adapter = new DshAdapter({
    runnerOptions: {
      binPath: process.execPath,
      extraArgsPrefix: [MOCK_SERVER_PATH]
    }
  });

  const workerId = 'worker-dsh-interrupt';
  await adapter.createFresh({
    sessionId: workerId,
    runId: 'run-dsh-interrupt',
    model: { provider: 'deepseek-official', model: 'deepseek-chat' }
  });

  const inspectBefore = await adapter.inspectSession(workerId);
  assert.strictEqual(inspectBefore?.active, true);

  // User cancel / interrupt priority
  const interruptSuccess = await adapter.interruptOwned(workerId);
  assert.strictEqual(interruptSuccess, true);

  const inspectAfter = await adapter.inspectSession(workerId);
  assert.strictEqual(inspectAfter?.active, false);

  // Submitting to interrupted session fails immediately
  await assert.rejects(
    async () => {
      await adapter.submit(workerId, 'msg-after', 'Should fail');
    },
    {
      message: /Cannot submit to inactive session/
    }
  );

  await adapter.shutdown();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/scenarios/dsh-relay.test.ts`
Expected: FAIL if fixtures or options differ

- [ ] **Step 3: Run test and verify full test suite**

Run: `npm test`
Expected: PASS (118 existing tests + new DSH tests all passing)

- [ ] **Step 4: Run full regression and test coverage**

Run: `npm test`
Expected: All tests passing cleanly (zero failures, clean exit code 0)

- [ ] **Step 5: Commit**

```bash
git add tests/scenarios/dsh-relay.test.ts
git commit -m "test(scenarios): add 3-round automated DSH relay acceptance and robustness suite (S01~S05)"
```
