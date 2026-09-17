# Agent Relay P0: 适配器探针与基座复用决策 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成 Codex (App-Server 路线)、Claude Code (Headless/Session 路线)、DeepSeek Harness (原生 SDK 路线) 的底层能力探针，以及现有长任务工具 (Ralph/GSD) 的复用评估，输出确凿的代码实验证据与基座架构决策。

**Architecture:** 围绕“后台静默接力 + 零键盘弹窗 + 原生能力利用”的核心设计原则，通过编写独立的探针测试脚本，在真实 Windows 运行环境中直连 Codex `app-server`、Claude Code `--session-id/stream-json` 和 DSH SDK，测定新会话创建、同模型继承、只读门控与中断静止的实际边界。

**Tech Stack:** Node.js (v24.14.0, ES Modules/CommonJS), TypeScript/JSON Schema, Codex CLI (0.144.4), Claude Code (2.1.274), DeepSeek Harness (0.1.5-rc.1), PowerShell.

**Spec:** `G:\杂项\工具开发\agent-relay-design\00-阅读入口.md` ~ `05-验收与接手说明.md`。

## Global Constraints

- **不可盲目写全量控制器代码**：P0 阶段仅输出探针脚本、测试记录与架构决策文档，不直接修改客户端全局配置，不替用户开启长期自循环。
- **真实证据不虚构**：未知字段明确记录为 null 或 unverified；L2（子 agent/后台执行）与 L3（原生新根会话）严格区分验收。
- **环境一致性检查**：测试必须记录 requested 与 effective model / effort，记录新旧 session/thread ID，确保旧历史未被静默复制。
- **Windows 本机路径适配**：所有测试脚本必须兼容 Windows 绝对路径、反斜杠/正斜杠规范化与反引号/空格转义。

---

### Task 1: P0-01 Codex App-Server 协议探针与 TypeScript 绑定生成

**Files:**
- Create: `probes/codex/generate-schema.ps1`
- Create: `probes/codex/test-app-server.mjs`
- Test: `probes/codex/test-app-server.mjs`
- Deliverable: `docs/probes/codex.md`

**Interfaces:**
- Consumes: `codex app-server --listen stdio://`
- Produces: `docs/probes/codex.md` 记录 `thread/start`, `turn/start`, `turn/interrupt` 的真实 JSON-RPC 往返证据与模型保持能力。

- [ ] **Step 1: 编写生成 Codex App-Server TypeScript 绑定和 JSON Schema 的脚本**

创建 `probes/codex/generate-schema.ps1`：
```powershell
$ErrorActionPreference = "Stop"
$outDir = "$PSScriptRoot/schema"
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Force $outDir | Out-Null }
Write-Host "Generating Codex app-server TypeScript bindings..."
codex app-server generate-ts --out "$outDir/ts" --experimental
Write-Host "Generating Codex app-server JSON Schema..."
codex app-server generate-json-schema --out "$outDir/json" --experimental
Write-Host "Done. Generated files located at: $outDir"
```

- [ ] **Step 2: 执行生成脚本并验证输出结构**

运行: `powershell -ExecutionPolicy Bypass -File probes/codex/generate-schema.ps1`
预期: `probes/codex/schema/ts` 和 `probes/codex/schema/json` 成功生成协议定义文件（包含 `thread/start`, `turn/start` 等类型定义）。

- [ ] **Step 3: 编写 Node.js 探针脚本 `probes/codex/test-app-server.mjs`**

通过 child_process 启动 `codex app-server --stdio`，发送 JSON-RPC 2.0 请求测试：
1. `initialize` 握手。
2. `thread/start` 创建新 thread（验证是否分配独立 thread ID，验证是否能指定 cwd 和 model）。
3. `turn/start` 注入测试消息（如 "echo probe_success" 并观察流式输出）。
4. 验证旧历史是否隔绝。
5. 优雅关闭。

```javascript
import { spawn } from 'node:child_process';
import readline from 'node:readline';

async function runProbe() {
  console.log('[Probe] Starting codex app-server --stdio...');
  const proc = spawn('codex', ['app-server', '--stdio'], {
    shell: true,
    stdio: ['pipe', 'pipe', 'inherit']
  });

  const rl = readline.createInterface({ input: proc.stdout });
  let reqId = 1;
  const pending = new Map();

  rl.on('line', (line) => {
    try {
      const msg = JSON.parse(line);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id).resolve(msg);
        pending.delete(msg.id);
      } else {
        console.log('[Event/Notification]', JSON.stringify(msg).slice(0, 150));
      }
    } catch (e) {
      console.log('[Raw Line]', line);
    }
  });

  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = reqId++;
      pending.set(id, { resolve, reject });
      const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
      proc.stdin.write(payload);
    });
  }

  // 1. Initialize
  console.log('[Probe] Sending initialize...');
  const initRes = await send('initialize', {
    clientInfo: { name: 'agent-relay-probe', version: '0.1.0' },
    capabilities: {}
  });
  console.log('[Probe] Initialize response:', JSON.stringify(initRes));

  // 2. Thread/start
  console.log('[Probe] Sending thread/start...');
  const threadRes = await send('thread/start', {
    cwd: process.cwd(),
    model: 'claude-opus-5' // or test with current default
  });
  console.log('[Probe] Thread/start response:', JSON.stringify(threadRes));

  proc.stdin.end();
  proc.kill();
  return { initRes, threadRes };
}

runProbe().then((res) => {
  console.log('[Probe] Complete:', res);
  process.exit(0);
}).catch((err) => {
  console.error('[Probe] Failed:', err);
  process.exit(1);
});
```

- [ ] **Step 4: 执行探针脚本并记录往返日志**

运行: `node probes/codex/test-app-server.mjs`
预期: 成功完成握手与 thread/start 创建，打印完整的真实 response 格式和 threadId。

- [ ] **Step 5: 撰写 `docs/probes/codex.md`**

记录真实支持的 RPC 方法名、参数签名、threadId 结构、模型传递是否生效、以及桌面侧边栏的同步观察结果。

---

### Task 2: P0-02 Claude Code Headless/Session 探针

**Files:**
- Create: `probes/claude/test-claude-session.mjs`
- Deliverable: `docs/probes/claude.md`

**Interfaces:**
- Consumes: `claude -p --output-format stream-json --input-format stream-json --session-id <uuid>`
- Produces: `docs/probes/claude.md` 验证 Claude Code 2.1.274 的全新 session ID 隔离、模型/effort 传递与流式事件捕获。

- [ ] **Step 1: 编写 Claude Code 流式会话探针 `probes/claude/test-claude-session.mjs`**

使用 Node.js 生成标准 UUIDv4，调用 `claude` CLI，测试：
1. 指定 `--session-id <uuid>`。
2. 指定 `--model` 和 `--effort` 参数。
3. 使用 `--output-format stream-json` 捕获完整消息流，验证是否包含 `session_id`、`model`、初始化及完成事件。
4. 验证连续启动两个不同 session-id 时，历史是否完全隔离。

```javascript
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import readline from 'node:readline';

async function testClaudeSession() {
  const sessionId = randomUUID();
  console.log(`[Probe] Testing Claude Code with fresh session ID: ${sessionId}`);

  const args = [
    '-p',
    '--no-session-persistence',
    '--output-format', 'stream-json',
    '--session-id', sessionId,
    'Say hello and output your model identifier only.'
  ];

  const proc = spawn('claude', args, {
    shell: true,
    stdio: ['ignore', 'pipe', 'inherit']
  });

  const rl = readline.createInterface({ input: proc.stdout });
  const events = [];

  rl.on('line', (line) => {
    try {
      const ev = JSON.parse(line);
      events.push(ev);
      console.log(`[Claude Event] type=${ev.type || ev.event}`);
    } catch {
      console.log(`[Claude Raw] ${line}`);
    }
  });

  return new Promise((resolve, reject) => {
    proc.on('close', (code) => {
      console.log(`[Claude] Process exited with code ${code}`);
      resolve({ sessionId, code, events });
    });
    proc.on('error', reject);
  });
}

testClaudeSession().then((res) => {
  console.log('[Claude Probe] Success. Captured events count:', res.events.length);
  process.exit(0);
}).catch((err) => {
  console.error('[Claude Probe] Failed:', err);
  process.exit(1);
});
```

- [ ] **Step 2: 运行探针并验证输出**

运行: `node probes/claude/test-claude-session.mjs`
预期: 进程正常退出，成功捕获流式 JSON 事件，记录有效 model 与会话元数据。

- [ ] **Step 3: 撰写 `docs/probes/claude.md`**

汇总 Claude Code 2.1.274 的 CLI 启动参数矩阵、session 独立性证据、权限控制参数与 hook 拦截点。

---

### Task 3: P0-03 DSH 原生 SDK 与 Session 探针

**Files:**
- Create: `probes/dsh/test-dsh-sdk.mjs`
- Deliverable: `docs/probes/dsh.md`

**Interfaces:**
- Consumes: `@deepseek-ai/dsh` SDK 协议与 DSH runtime
- Produces: `docs/probes/dsh.md` 验证 DSH 0.1.5-rc.1 的 `session/prompt`、模型继承、事件监听及会话级停止/静止方案。

- [ ] **Step 1: 检查 DSH 本地安装包的协议定义与导出接口**

编写简单检查脚本读取 `LOCALAPPDATA/DSH Desktop/runtime` 中的包结构与协议类型文件。

- [ ] **Step 2: 编写 DSH SDK 探针 `probes/dsh/test-dsh-sdk.mjs`**

测试通过 SDK 协议连接本地 DSH 服务（或使用 DSH runtime 节点），创建新 session，传递配置，测试消息交互与关闭行为。

- [ ] **Step 3: 执行探针并记录会话可见性**

运行: `node probes/dsh/test-dsh-sdk.mjs`
记录 DSH 是否在 Web 界面 (`http://127.0.0.1:3080/`) 同步呈现新 session。

- [ ] **Step 4: 撰写 `docs/probes/dsh.md`**

明确记录 DSH 原生能力等级（L2 还是 L3）、是否支持逐会话 Cancel、以及独占 worker 进程方案的可行性。

---

### Task 4: P0-04 现有工具评估与差距分析

**Files:**
- Deliverable: `docs/decisions/reuse-evaluation.md`

**Interfaces:**
- Consumes: Ralph Orchestrator、GSD Pi、DSH Ralph 的源码与接口规范
- Produces: `docs/decisions/reuse-evaluation.md` 给出各工具在 4 个核心维度上的评测得分与取舍原因。

- [ ] **Step 1: 调研 Ralph Orchestrator 扩展点**
核查 Ralph Orchestrator 对 Windows 的适配性、后端插件扩展能力、任务 ID 映射机制与拦截钩子。

- [ ] **Step 2: 调研 GSD Pi 与 DSH 自带 Ralph 方案**
核对 GSD Pi 的独立入口限制与 DSH 自带 `dsh-tool-ralph` 的子 agent 局限性。

- [ ] **Step 3: 产出差距评估矩阵与决策建议**
对比“直接复用”、“基于 Ralph Orchestrator 开发适配插件”与“编写轻量自研控制器（Controller Core）”的成本与维护代价。

---

### Task 5: P0-05 基座决策与 P1 架构落定

**Files:**
- Deliverable: `docs/decisions/architecture.md`

**Interfaces:**
- Consumes: `docs/probes/*.md` 与 `docs/decisions/reuse-evaluation.md`
- Produces: `docs/decisions/architecture.md` 最终技术路线图与 P1 详细任务依赖。

- [ ] **Step 1: 汇总三端探针实测数据，锁定各端能力等级（L1/L2/L3）**
- [ ] **Step 2: 做出最终架构决断（确定控制器基座是扩展既有工具还是轻量自研核心）**
- [ ] **Step 3: 输出 `docs/decisions/architecture.md` 并更新总体开发进度**
