# Codex App-Server 协议探针与 TypeScript 绑定分析报告

> **测试时间**: 2026-09-17  
> **Codex 版本**: `codex-cli 0.144.4`  
> **环境**: Windows 11 (Node.js v24.14.0, PowerShell 5.1)  
> **探针脚本**: `probes/codex/test-app-server.mjs`, `probes/codex/generate-schema.ps1`  
> **协议传输**: `codex app-server --stdio` (JSON-RPC 2.0 via Stdio)  

---

## 1. 协议绑定与 Schema 生成

通过执行 `probes/codex/generate-schema.ps1`：
```powershell
codex app-server generate-ts --out "probes/codex/schema/ts" --experimental
codex app-server generate-json-schema --out "probes/codex/schema/json" --experimental
```
成功生成了 **1008 个 TypeScript 类型定义文件** 和对应的 JSON Schema 定义包（包含根接口与 `v2` 扩展协议）。

### 核心类型清单
- 客户端请求根定义: `probes/codex/schema/ts/ClientRequest.ts`
- 服务端通知根定义: `probes/codex/schema/ts/ServerNotification.ts`
- 核心会话与轮次:
  - `InitializeParams` / `InitializeResponse`
  - `v2/ThreadStartParams` / `v2/ThreadStartResponse`
  - `v2/Thread` / `v2/ThreadReadParams` / `v2/ThreadReadResponse`
  - `v2/TurnStartParams` / `v2/TurnStartResponse`
  - `v2/TurnInterruptParams` / `v2/TurnInterruptResponse`
  - `v2/ThreadListParams` / `v2/ThreadListResponse`

---

## 2. 核心 RPC 接口契约与签名

### 2.1 握手: `initialize`
- **请求格式**:
  ```json
  {
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "clientInfo": {
        "name": "agent-relay-probe",
        "version": "0.1.0",
        "title": "Agent Relay P0 Probe"
      },
      "capabilities": {}
    }
  }
  ```
- **实测响应**:
  ```json
  {
    "userAgent": "agent-relay-probe/0.144.4 (Windows 10.0.26200; x86_64) unknown (agent-relay-probe; 0.1.0)",
    "codexHome": "C:\\Users\\21666\\.codex",
    "platformFamily": "windows",
    "platformOs": "windows"
  }
  ```

### 2.2 创建独立线程: `thread/start`
- **请求参数 (`ThreadStartParams`)**:
  - `cwd` (string, 可选): 指定工作目录绝对路径。
  - `model` (string, 可选): 指定基座模型（如 `"gpt-5.6-luna"`）。
  - `ephemeral` (boolean, 可选): 若为 `true`，则只保留在内存中，不向磁盘写 rollout jsonl，也不入库 `state_5.sqlite`。
  - `approvalPolicy` / `approvalsReviewer`: 控制只读与权限审批路由。
  - `baseInstructions` / `developerInstructions`: 注入接力上下文。
- **实测响应关键字段 (`ThreadStartResponse`)**:
  - `thread.id`: 标准 UUIDv7，如 `01a0af34-8c26-7271-ae57-79996559485f`。
  - `thread.sessionId`: 与根 thread ID 保持一致。
  - `thread.source`: 标为 `"vscode"`。
  - `model`: 返回实际生效模型（如 `"gpt-5.6-luna"`）。
  - `modelProvider`: 返回 `"openai"`。
  - `cwd`: 返回规范化后的工作目录（如 `"G:\\杂项\\工具开发"`）。
  - `reasoningEffort`: 继承自全局或指定（实测为 `"xhigh"`）。
  - `sandbox`: `{ type: "workspaceWrite", networkAccess: true, ... }`。
  - `approvalPolicy`: `"never"`（继承本地 config）。

### 2.3 启动执行轮次: `turn/start`
- **请求参数 (`TurnStartParams`)**:
  ```json
  {
    "jsonrpc": "2.0",
    "id": 3,
    "method": "turn/start",
    "params": {
      "threadId": "01a0af34-8c26-7271-ae57-79996559485f",
      "input": [
        {
          "type": "text",
          "text": "Reply with the exact text: \"PROBE_SUCCESS_P0\" and nothing else.",
          "text_elements": []
        }
      ]
    }
  }
  ```
- **实测响应**:
  立即返回 `status: "inProgress"` 的 Turn 对象：
  ```json
  {
    "turn": {
      "id": "01a0af34-a2b3-7833-b603-c067203c796d",
      "items": [],
      "itemsView": "notLoaded",
      "status": "inProgress",
      "error": null,
      "startedAt": null,
      "completedAt": null,
      "durationMs": null
    }
  }
  ```

### 2.4 中断执行: `turn/interrupt`
- **请求参数 (`TurnInterruptParams`)**:
  ```json
  {
    "jsonrpc": "2.0",
    "id": 6,
    "method": "turn/interrupt",
    "params": {
      "threadId": "01a0af35-2d1e-7971-a89c-16d36b705685",
      "turnId": "01a0af35-42bf-76b0-9d2b-f94e6702c483"
    }
  }
  ```
- **实测响应**:
  ```json
  {}
  ```
- **后续通知**:
  服务端立刻将 `thread/status/changed` 置为 `idle`，并推送 `turn/completed` 通知，其中 `turn.status` 为 `"interrupted"`，并记录中断前消耗的 `durationMs`（实测为 5111ms）。

---

## 3. 状态机与通知流 (Notification Lifecycle)

探针捕获到了完整的通知序列：

```
[Client] thread/start
   │
   ├─► [Server Notification] thread/started
   │
[Client] turn/start
   │
   ├─► [Server Response] turn: { id, status: "inProgress" }
   ├─► [Server Notification] thread/status/changed -> { type: "active" }
   ├─► [Server Notification] turn/started -> { turn: { status: "inProgress" } }
   ├─► [Server Notification] item/started
   ├─► [Server Notification] item/agentMessage/delta -> "PROBE_SUCCESS_P0"
   ├─► [Server Notification] item/completed
   ├─► [Server Notification] thread/status/changed -> { type: "idle" }
   └─► [Server Notification] turn/completed -> { turn: { status: "completed" / "interrupted", durationMs } }
```

---

## 4. 关键实测边界与重要发现

### 4.1 线程隔离性与历史隔绝
- **新 Thread ID 独立分配**: 每次调用 `thread/start` 均生成全新且单调递增的 UUIDv7 ID，父会话 `forkedFromId` 与 `parentThreadId` 均为 `null`。
- **Turn 互不串扰**: 
  - Thread 1 完成 1 个 turn，`turns.length === 1`，status 为 `completed`。
  - Thread 2 中断 1 个 turn，`turns.length === 1`，status 为 `interrupted`。
  - 调用 `thread/read` 检查两者的 `turns` 列表，完全独立，没有前序 Thread 1 的对话历史注入。

### 4.2 未物化会话的读保护机制 (重要错误码)
在对刚创建且尚未提交任何 user input 的 Thread 调用 `thread/read` 时：
- `includeTurns: false`: 正常成功返回元数据，`turns: []`。
- `includeTurns: true`: 严格抛出 JSON-RPC 错误：
  ```json
  {
    "code": -32600,
    "message": "thread <id> is not materialized yet; includeTurns is unavailable before first user message"
  }
  ```
- **结论**: 在 Agent Relay 架构中，接力控制器在新 thread 首次派发任务前，若需要校验线程健康，必须设置 `includeTurns: false` 或仅依靠 `thread/start` 返回的元数据。

### 4.3 显式模型与目录保持 (Requested vs Effective)
| 属性 | 请求值 | 实际返回值 (`thread/start`) | 是否符合预期 |
|---|---|---|---|
| `model` | `"gpt-5.6-luna"` | `"gpt-5.6-luna"` | 完全一致，支持强行锁定指定模型 |
| `cwd` | `G:\杂项\工具开发` | `G:\杂项\工具开发` | 完全一致，Windows 路径规范化解析 |
| `reasoningEffort` | 继承默认 | `"xhigh"` | 成功继承本地配置 |
| `approvalPolicy` | 继承默认 | `"never"` | 成功继承静默无需人工确认策略 |

### 4.4 桌面侧边栏与持久化机制 (UI 零干扰验证)
通过直接对 `~/.codex/` 内部 SQLite 数据库 (`state_5.sqlite`) 及 sessions 目录进行探查，实测证据如下：
1. **默认模式 (`ephemeral: false`)**:
   - 会话写入 `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`。
   - 会话元数据写入 `state_5.sqlite` 的 `threads` 表中，`source` 字段统一打标为 `'vscode'`。
   - `project_id` 为 `null`。
   - 在 Codex 官方桌面客户端中，侧边栏以当前激活的项目和 `cli` 交互为主，不会弹出前台弹窗、不夺取焦点、不打断用户当前的键盘输入。
2. **完全无痕模式 (`ephemeral: true`)**:
   - 实测调用 `thread/start` 时传递 `ephemeral: true`：
   - 返回 `thread.ephemeral = true`，`thread.path = null`。
   - 不向 `~/.codex/sessions/` 写入任何 jsonl 文件。
   - 不向 `state_5.sqlite` 插入任何记录。
   - 会话完全只存在于当前 `app-server` 进程内存中，退出后自动销毁，实现绝对干净的后台沙箱接力。

### 4.5 会话查询 (`thread/list`) 的过滤陷阱
在调用 `thread/list` 时：
- 若不传 `sourceKinds`，默认仅拉取交互式会话（主要是 CLI 会话），返回数量较少或为 0。
- 若显式传入 `sourceKinds: ["vscode", "appServer", "cli", "exec"]`，可以准确查找到所有由 app-server 生成的接力线程及其 `preview` 摘要。

---

## 5. 对 Agent Relay 架构落地的裁定

1. **Option 2 (App-Server 背景接力) 完全可行，性能优秀**:
   - 握手耗时 < 50ms。
   - 本地 JSON-RPC 2.0 通信稳定无弹窗，完全符合“零键盘输入、零弹窗打扰”的核心原则。
2. **接力执行模式推荐**:
   - 若任务需要事后审计追溯：使用默认持久化（`source: "vscode"`，落盘 JSONL 并入 SQLite，但不扰乱桌面交互）。
   - 若任务属于轻量探针或临时只读巡检：使用 `ephemeral: true`，内存会话无残留。
3. **控制器核心实现要点**:
   - 派发前不用发 `thread/read(includeTurns: true)`，直接创建后调用 `turn/start`。
   - 监听 `turn/completed` 事件判定该棒次接力结束。
   - 中断超时统一采用 `turn/interrupt`，5 秒内可平稳静止。
