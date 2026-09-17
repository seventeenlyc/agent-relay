# Claude Code Headless/Session 协议探针与运行机制分析报告

> **测试时间**: 2026-09-17  
> **Claude Code 版本**: `2.1.274 (Claude Code)`  
> **环境**: Windows 11 Home (Node.js v24.14.0, PowerShell 5.1)  
> **CLI 绝对路径**: `C:\Users\21666\.local\bin\claude.exe`  
> **探针脚本**: `probes/claude/test-claude-session.mjs`  
> **协议传输**: Headless CLI (`-p` / Stdio Line-Delimited JSON Streaming)  

---

## 1. 核心结论摘要

1. **会话 ID 强可控性与强隔离性**:
   - 支持通过 `--session-id <uuid>` 注入自定义 UUIDv4。
   - 所有下行流式事件（`system:init`、`system:thinking_tokens`、`assistant`、`result`、`system:hook_*`）均携带该注入的 `session_id`。
   - 实测证明：不同 `session_id` 的连续调用之间具有**完全隔离的上下文历史（Zero Conversation Leakage）**。
   - 支持通过 `--resume <uuid>` 精确恢复历史会话状态，且会触发 `SessionStart:resume` 生命周期钩子。

2. **流式输出模式的关键约束（Critical Flag Dependency）**:
   - 当使用 `-p`（`--print`）与 `--output-format stream-json` 时，**必须显式添加 `--verbose`**。
   - 若未添加 `--verbose`，CLI 会直接终止并报错：
     `Error: When using --print, --output-format=stream-json requires --verbose`（Exit Code 1）。

3. **双向流式通信支持（Bidirectional Stream-JSON）**:
   - 支持 `--input-format stream-json` + `--output-format stream-json`。
   - 客户端可通过 `stdin` 实时推入 JSONL 格式的用户消息：
     `{"type": "user", "message": {"role": "user", "content": "..."}}\n`
   - 支持避免非交互式命令行传参时的字符转义问题，并消除无 stdin 输入时的 3 秒检测等待延迟。

4. **超轻量 Headless 优化模式（`--bare`）**:
   - 提供极速模式 `--bare`，自动跳过 Hooks、LSP、MCP、Plugins、自动上下文检索（CLAUDE.md）、Keychain 与 Project Auto-Memory。
   - 默认模式的系统上下文开销约为 **14,300 tokens**，而在 `--bare` 模式下仅为 **1,394 tokens**（下降 90.2%）。
   - 内置工具集缩减至 4 个基础原语：`["Bash", "Edit", "PowerShell", "Read"]`，极适合轻量级、确定性接力任务。

5. **项目级持久化记忆与会话隔离边界（Important Finding）**:
   - Claude Code 拥有独立于单个 Session Transcript 的 Project Auto-Memory 机制（存储于 `~/.claude/projects/<project-hash>/memory/`）。
   - 若会话 prompt 显式触发记忆写入（如 "store in memory"），模型会调用 memory 工具写入项目级持久化文件。同工作目录下的后续其他 session 读取项目记忆时会读到该信息。
   - **Agent Relay 架构规避方案**: 在需要完全沙箱/无副作用的会话接力中，应采用 `--bare`、指定独立工作目录（`--worktree` 或 `--add-dir`）、或通过 `--no-session-persistence` 与提示词约束保证纯净隔离。

---

## 2. CLI 启动参数矩阵 (CLI Invocation Flags Matrix)

| 参数 | 类型 | 适用场景 / 说明 | Agent Relay 适配建议 |
| :--- | :--- | :--- | :--- |
| `-p, --print` | Flag | 非交互式批处理/管道模式，运行单次指令后退出 | **必须**。接力 Worker 核心模式 |
| `--output-format stream-json` | String | 输出格式选择：`text`, `json`, `stream-json` | **必须**为 `stream-json`，实现细粒度事件驱动 |
| `--verbose` | Flag | 启用详细输出。当 `-p` 与 `stream-json` 组合时为系统硬性要求 | **必须**包含 |
| `--session-id <uuid>` | UUIDv4 | 指定本次执行绑定的全局唯一会话 ID | **必须**由 Relay Dispatcher 统一分发注入 |
| `--resume <uuid>` | UUIDv4 | 恢复指定会话的历史上下文，继续执行新轮次 | 用于同一任务的多轮接力或重试 |
| `--no-session-persistence` | Flag | 禁用会话落盘，不写 transcript 到本地磁盘 | 推荐用于只读探针、单次测试与临时子任务 |
| `--input-format stream-json` | String | 从 stdin 读取实时流式输入，避免命令行转义限制 | 推荐用于长文本提示词与结构化输入 |
| `--include-hook-events` | Flag | 在流式输出中包含所有 Hook 的生命周期启动与结束事件 | 推荐用于审计 Hook 耗时与外部干涉拦截 |
| `--model <name>` | String | 指定基座模型（如 `gemini-3.8-flash-high`, `sonnet`, `opus`） | 可由接力层按任务难度动态路由 |
| `--effort <level>` | String | 推理力度（`low`, `medium`, `high`, `xhigh`, `max`） | 影响 `thinking_tokens` 产生量与深度思考耗时 |
| `--bare` | Flag | 极简模式：跳过 hooks/plugins/auto-memory，大幅减少 token 消耗 | 推荐作为高并发、轻量型任务的 Worker 预设 |
| `--permission-mode` | String | 权限模式（`bypassPermissions`, `auto`, `dontAsk`, `manual`） | 根据调度执行环境安全策略配置 |

---

## 3. Stream-JSON 事件契约与数据流

在 `--output-format stream-json --verbose` 模式下，Claude Code 通过 `stdout` 按行（JSONL）实时推送结构化事件。

### 3.1 `system:init` 初始化事件
会话启动的首个核心系统事件，宣告当前会话的元数据、可用工具、MCP 服务与扩展能力：
```json
{
  "type": "system",
  "subtype": "init",
  "cwd": "G:\\杂项\\工具开发",
  "session_id": "040914a4-8d67-4ded-8c41-8cffbc442424",
  "tools": [
    "Task", "Bash", "Edit", "Glob", "Grep", "PowerShell", "Read", "Write", "ToolSearch"
  ],
  "mcp_servers": [
    { "name": "dsh", "status": "connected", "source": "user" }
  ],
  "model": "gemini-3.8-flash-high",
  "permissionMode": "bypassPermissions",
  "claude_code_version": "2.1.274",
  "output_style": "default",
  "agents": ["claude", "Explore", "general-purpose", "Plan", "statusline-setup"],
  "capabilities": [
    "interrupt_receipt_v1",
    "interrupt_cancel_queued_v1",
    "msg_lifecycle_v1"
  ],
  "uuid": "45a714cd-7505-4e2e-a551-3af796055c78",
  "fast_mode_state": "off",
  "powershell_path": "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
}
```

### 3.2 `system:thinking_tokens` 思考进度事件
模型开始与进行深度思考时触发，可用于心跳与思考预算统计：
```json
{
  "type": "system",
  "subtype": "thinking_tokens",
  "estimated_tokens": 58,
  "estimated_tokens_delta": 58,
  "session_id": "040914a4-8d67-4ded-8c41-8cffbc442424",
  "uuid": "9fc24fb2-9407-4a64-9443-592e8c61d764"
}
```

### 3.3 `assistant` 模型输出事件
携带 assistant 生成的内容片段（包括 `thinking`、`text`、`tool_use`）：
```json
{
  "type": "assistant",
  "message": {
    "id": "7tWratX3BaC-1e8Py5KUwQE",
    "type": "message",
    "role": "assistant",
    "content": [
      {
        "type": "text",
        "text": "PROBE_BASIC_OK"
      }
    ],
    "model": "gemini-3.8-flash",
    "stop_reason": null,
    "stop_sequence": null,
    "usage": {
      "input_tokens": 14300,
      "output_tokens": 6,
      "cache_read_input_tokens": 0,
      "cache_creation_input_tokens": 0
    }
  },
  "parent_tool_use_id": null,
  "session_id": "040914a4-8d67-4ded-8c41-8cffbc442424",
  "uuid": "359fdcc6-10ad-45e4-a5e9-bd3eb855f5ff",
  "timestamp": "2026-09-17T11:58:40.782Z"
}
```

### 3.4 `result` 轮次终态摘要事件
表示本次 CLI 执行彻底完成，汇总性能、计费、Token 消耗及错误状态：
```json
{
  "type": "result",
  "subtype": "success",
  "result": "PROBE_BASIC_OK",
  "is_error": false,
  "num_turns": 1,
  "session_id": "040914a4-8d67-4ded-8c41-8cffbc442424",
  "duration_ms": 3306,
  "duration_api_ms": 3116,
  "ttft_ms": 3202,
  "total_cost_usd": 0.07165,
  "usage": {
    "input_tokens": 14300,
    "output_tokens": 6,
    "cache_read_input_tokens": 0,
    "cache_creation_input_tokens": 0,
    "server_tool_use": { "web_search_requests": 0, "web_fetch_requests": 0 }
  },
  "modelUsage": {
    "gemini-3.8-flash-high": {
      "inputTokens": 14300,
      "outputTokens": 6,
      "costUSD": 0.07165,
      "contextWindow": 200000,
      "thinkingTokens": 0
    }
  },
  "subagent_stats": {
    "spawned": 0,
    "completed": 0,
    "failed": 0
  },
  "terminal_reason": "completed",
  "uuid": "89d4d330-2f53-42b8-aae2-47b671e1e96a"
}
```

### 3.5 Hook 生命周期事件 (`--include-hook-events`)
```json
{
  "type": "system",
  "subtype": "hook_started",
  "hook_id": "aa650df5-d684-435c-ac2a-fbd87536d12d",
  "hook_name": "SessionStart:startup",
  "hook_event": "SessionStart",
  "session_id": "040914a4-8d67-4ded-8c41-8cffbc442424"
}
```
```json
{
  "type": "system",
  "subtype": "hook_response",
  "hook_id": "aa650df5-d684-435c-ac2a-fbd87536d12d",
  "hook_name": "SessionStart:startup",
  "hook_event": "SessionStart",
  "output": "",
  "exit_code": 0,
  "outcome": "success",
  "session_id": "040914a4-8d67-4ded-8c41-8cffbc442424"
}
```

---

## 4. 会话隔离性实测验证数据 (Session Isolation Verification)

探针脚本测试了三组连续执行：
1. **会话 A (Writer)**: UUID `99fd8ed6-8d17-4fc7-8fe5-4fb398e713f4`
   - 提示词: 注入随机暗号 `SECRET_TOKEN_338640` 并确认存储在会话上下文。
   - 结果: 回复 `"STORED"`，执行耗时 7,318ms。
2. **会话 B (Fresh Reader)**: UUID `b29cdb86-62e4-4964-888e-4e6682ae206b`
   - 提示词: 询问会话历史中是否有暗号，若没有则回复 `NO_SECRET_FOUND`。
   - 结果: 回复 `"NO_SECRET_FOUND"`，未发现任何暗号字符。
   - **证明**: 会话 A 与会话 B 的上下文完全独立，无任何历史渗漏（Zero Leakage）。
3. **会话 A 恢复 (Resume)**: `--resume 99fd8ed6-8d17-4fc7-8fe5-4fb398e713f4`
   - 提示词: 查询该会话早前记录的暗号。
   - 触发 Hook: `SessionStart:resume`。
   - 结果: 精确返回 `"SECRET_TOKEN_338640"`，执行耗时 5,523ms。
   - **证明**: 持久化状态与历史轮次完整保留，会话恢复机制可靠。

---

## 5. 标准模式 vs 极简模式（`--bare`）实测对比

| 指标维度 | 标准模式 (Standard Mode) | 极简模式 (`--bare`) | 差异幅度 |
| :--- | :--- | :--- | :--- |
| **系统输入 Tokens** | 14,309 tokens | 1,409 tokens | **-90.1%** (大幅节约成本) |
| **启动工具集 (Tools)** | 29 个全量工具 + MCP | 4 个原语工具 (`Bash, Edit, PowerShell, Read`) | 极简可预测 |
| **MCP Servers** | 自动挂载本地已配置服务 (如 `dsh`) | 强制空数组 (`[]`) | 无外部 MCP 依赖干扰 |
| **Hook 触发** | 触发全部外部 Hook（如 `Clawd on Desk`） | 0 次 Hook 触发 | 规避外部 Hook 故障风险 |
| **端到端冷启动延迟** | 6 ~ 8 秒 | 1.8 ~ 3.2 秒 | 提速超过 50% |

---

## 6. Agent Relay 架构接入实施建议

1. **命令行构造模板**:
   ```typescript
   const claudeArgs = [
     '-p',
     '--output-format', 'stream-json',
     '--input-format', 'stream-json',
     '--verbose',
     '--session-id', taskSessionUuid,
     // 若为轻量任务使用 --bare
     ...(taskConfig.isolated ? ['--bare'] : []),
     // 若继续执行已有任务
     ...(isResume ? ['--resume', taskSessionUuid] : [])
   ];
   ```

2. **输入与输出管道管理**:
   - 必须通过 `stdin` 向进程输入 JSONL 格式的用户消息：
     ```json
     {"type":"user","message":{"role":"user","content":"..."}}
     ```
   - 写入完成后立即 `stdin.end()` 或在持续对话中保持管道打开。
   - 监听 `stdout` 并按换行符拆分解析 JSON。根据 `ev.type` 分发到 Agent Relay 事件总线：
     - `system:init`: 注册 Worker 身份与能力清单；
     - `assistant`: 转发流式生成文本与工具调用到前端展示；
     - `result`: 判定轮次终态，提取 Token 消耗与计费数据进入审计账单。

3. **中断与静止控制 (Cancellation)**:
   - 初始化事件中宣告的 `interrupt_receipt_v1` 与 `interrupt_cancel_queued_v1` 证实 Claude Code 具备会话内打断处理能力。
   - 在 Headless 模式下，若需强行停止会话，向子进程发送 `SIGTERM` / `taskkill`，随后可通过读取已落盘 transcript 或下发 `--resume` 重新介入。
