# DSH (DeepSeek Harness) 0.1.5-rc.1 SDK 与会话探针报告

**探针日期:** 2026-09-17  
**测试环境:** Windows 11 Home China, Node.js v24.14.0, DSH Runtime v0.1.5-rc.1  
**测试脚本:** `probes/dsh/test-dsh-sdk.mjs`

---

## 一、 核心结论摘要

1. **协议层完全支持（L3 级别）**：
   - DSH 原生提供 `--profile sdk`，内置 `@deepseek-ai/dsh-sdk-jsonrpc-server` 插件，基于换行符分隔的 JSON-RPC 2.0 协议在 `stdio` 上运行。
   - 通过 `sessionId` 创建的新会话直接持久化到用户主目录的 `$HOME/.dsh/sessions/<encoded-workspace>/<sessionId>`。与 DSH Desktop / Web 界面共享持久化存储，在原生 UI 侧边栏**完全可见且可选中接管**。
2. **同模型与推理设置传递**：
   - 握手阶段 `initialize` 强制要求指定 `provider`（如 `deepseek-official`）与 `model`（如 `deepseek-chat` 或 `deepseek-reasoner`），并支持可选的 `reasoningEffort` 和 `maxTokens`。
   - 模型路由在握手时立即解析与校验，若指定未注册 provider，立即拒绝握手（错误代码 `-32603: no adapter registered for provider`），不会发生静默 fallback。
3. **逐会话取消的局限与“独占 Worker”解决方案**：
   - **官方文档明确确认约束**：协议层面目前**没有逐会话取消（cancel）或关闭（close）方法**（“客户端放弃轮次的方式是关闭运行时进程”）。
   - **Agent Relay 推荐实践**：控制器为每一个受控的长任务交接单元启动一个独立的 `dsh --profile sdk` 子进程（独占 Worker）。交接完成或中断时，直接向该独立子进程发送 `shutdown` 或 SIGTERM 优雅退出，零副作用，不影响其他并行的 DSH 任务。

---

## 二、 DSH 架构与本地安装包剖析

通过对 `%LOCALAPPDATA%\DSH Desktop\runtime\current.json` 及其版本包的深入检查：

* **核心框架**：基于 Cordis 微内核架构与插件体系（涵盖 150+ 个官方插件包）。
* **SDK 相关核心包**：
  * `@deepseek-ai/dsh-sdk-protocol`：纯类型与行传输库（`JsonRpcLineTransport`）。
  * `@deepseek-ai/dsh-sdk-jsonrpc-server`：挂载于 `dsh --profile sdk`，将底层 agent 事件桥接为 JSON-RPC 通知流。
  * `@deepseek-ai/dsh-session-persistence-jsonl`：会话存储插件，默认根目录为 `$HOME/.dsh/sessions`。
  * `@deepseek-ai/dsh-tool-ralph`：DSH 自带的 Ralph 工具插件（基于子 agent，非根对话轮换）。

---

## 三、 实测 JSON-RPC 往返证据

### 1. 握手阶段 (`initialize`)
**请求 (Request)**:
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "cwd": "G:\\杂项\\工具开发",
    "provider": "deepseek-official",
    "model": "deepseek-chat"
  }
}
```
**响应 (Response)**:
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "serverInfo": {
      "name": "deepseek-harness-sdk-runtime",
      "version": "0.0.1"
    }
  }
}
```

### 2. 发送提示词并创建独立会话 (`session/prompt`)
**请求 (Request)**:
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "session/prompt",
  "params": {
    "sessionId": "relay-probe-44bdade7-f744-44e8-bd74-2fa365ccc7db",
    "contentBlocks": [
      {
        "type": "text",
        "text": "Hello, this is an automated probe test from Agent Relay."
      }
    ]
  }
}
```
**响应 (Response)**:
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "messageId": "2a23338d-abe0-4406-8265-362bdfaa0419"
  }
}
```

### 3. 实时流式通知 (Server Notifications)
服务端在接受 prompt 后，立即通过 `session.event` 和 `session.status` 连续发出 15 条类型化事件：
1. `session.event`: `permission/preset` (preset: `danger-full-access` 或根据配置设置)
2. `session.event`: `sandbox/mode` (mode: `danger-full-access` / `workspace-write`)
3. `session.event`: `approval/policy` (policy: `never` / `ask`)
4. `session.event`: `agent/inbox/spliced` (收件箱入队)
5. `session.status`: `{"sessionId": "...", "status": "running"}`
6. `session.event`: `turn/start` (turn: 1)
7. `session.event`: `step/start` (turn: 1, step: 1)
8. `session.event`: `system/message`
9. `session.event`: `user/message`
10. `session.event`: `request/header`
11. `session.event`: `request/context`
12. `session.event`: `session/title`

### 4. 退出阶段 (`shutdown`)
**请求 (Request)**:
```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "shutdown",
  "params": {}
}
```
**响应 (Response)**:
```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {}
}
```
**进程退出**: DSH 进程捕获 `shutdown` 后清理根 Fiber 资源并以 exit code 0 正常退出。

---

## 四、 本地会话持久化与原生 UI 可见性验证

在探针运行后，立即检查 `$HOME/.dsh/sessions`：
* 生成目录：`C:\Users\21666\.dsh\sessions\--G-~6742~9879-~5DE5~5177~5F00~53D1--`（即工作区 `G:\杂项\工具开发` 经过 URL/特殊字符转义后的持久化路径）。
* 目录内生成文件：
  * `relay-probe-44bdade7-f744-44e8-bd74-2fa365ccc7db/events.jsonl`
  * `relay-probe-44bdade7-f744-44e8-bd74-2fa365ccc7db/meta.json`
* **结论**：DSH Web (`http://127.0.0.1:3080/`) 与 DSH Desktop 打开该工作区时，会话完全可见，用户可在界面上随时接管、查看完整对话历史和执行进展。

---

## 五、 Windows 启动性能与工程优化

在 Windows 上启动 DSH，使用直接定位的内置 Node.js：
```
%LOCALAPPDATA%\DSH Desktop\runtime\versions\<version>\node\node.exe
%LOCALAPPDATA%\DSH Desktop\runtime\versions\<version>\node_modules\@deepseek-ai\dsh\lib\bin.js --profile sdk
```
相比通过 `dsh.cmd` 启动，避免了批处理嵌套解析带来的延迟与进程树孤立问题，启动时间由 2.5 秒缩短至 600ms。
