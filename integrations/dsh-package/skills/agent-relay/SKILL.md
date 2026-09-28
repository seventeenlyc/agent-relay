---
name: agent-relay
description: "当用户需要长上下文长链路任务分段、多阶段任务自动交接（Handoff）、或者需要跨会话隔离并在 DSH 桌面端自动创建与打开侧边独立会话时使用。核心规划约束：严格区分宏观 Relay 阶段与微观子代理！只有需要重置上下文、移交写租约的宏观阶段才列为 Relay 任务；子代理负责当前阶段内部并发打杂，绝不上报为全局阶段任务，杜绝会话爆炸与乱弹窗。"
---

# Agent Relay: DSH 多会话物理隔离与自动化跨窗口接力技能

## 概述与核心守则

Agent Relay 是专为长上下文、长链路工程任务设计的**多会话物理隔离与状态机安全接力框架**。
在 DeepSeek Harness (DSH) 环境中运行时，必须恪守以下核心守则：

1. **绝对禁止单窗口包揽全局**：
   - 严禁在当前主对话窗口中一次性完成整个工程的所有阶段。
   - 当前窗口只负责**调度（Dispatching）与监控（Monitoring）**，所有宏观阶段性工作必须派发到新建的独立会话中执行。
2. **侧边栏静默物化（严禁弹出外置浏览器网页）**：
   - 每个 Epoch（阶段）必须通过 DSH 原生 `session/create` 在左侧边栏创建独立会话条目，并使用 `session/rename` 规范命名（如 `🚀 [Relay] Epoch 1: ...`）。
   - **默认隐藏外置浏览器弹窗**：新会话直接在 DSH Desktop 左侧边栏挂载并在后台独立执行，**严禁默认调用 `start "http://..."` 弹出系统浏览器网页**，用户在 DSH 左侧边栏点击即可无缝切换查看。
3. **真实自主推理**：
   - 必须通过 `session/prompt` (`mode: 'queue'`) 将任务投递至该新会话中，由该会话内专属的 Agent 独立调用工具执行，绝不伪造会话文件。

---

## ⚡ 核心铁律：任务分层规划法则（宏观 Relay vs 微观 Subagent）

由于插件内置了**监听任务完成与交接标记的自动触发钩子（Auto-Trigger Hook）**，**严禁混淆宏观阶段与微观子任务**。必须严格遵循以下分层规划原则：

### 1. 宏观接力任务（Relay Epochs）——【必须列入规划】
- **定义**：具有独立里程碑价值、必须彻底清空重置上下文空间、必须独占写租约（CAS Lease）的大阶段。
- **规划粒度**：全流程通常只规划 **2 ~ 4 个 Epoch**（例如：`Epoch 1: 扫描与依赖分析` -> `Epoch 2: 核心重构与压测` -> `Epoch 3: 全局报告收敛`）。
- **执行效果**：每个 Epoch 会由调度器或钩子在 DSH 侧边栏新建独立会话并静默派发执行（不弹出外置浏览器网页）。

### 2. 微观子代理工作（Micro Subagents）——【绝对不要列为全局任务】
- **定义**：某个 Epoch 内部的临时辅助动作，如并行抓取多个文件、执行局部语法检查、临时测试脚本、多角度数据调研等。
- **规划铁律**：**严禁将子代理工作列为全局阶段任务！严禁为每个子代理触发 Relay 换棒！**
- **执行方式**：在当前 Epoch 会话内部，直接使用 `subagent`、`workflow` 或本地工具并发完成，**结果在当前窗口内部消化汇总**。
- **杜绝两类反模式（Anti-Patterns）**：
  - ❌ **会话爆炸（Session Explosion）**：把“查文件A”、“查文件B”列为任务，导致钩子在侧边栏刷屏创建 10 个会话；
  - ❌ **单窗臃肿（Single Window Bloat）**：把耗费数万 Token 的大阶段全堆在一个窗口硬抗，导致上下文截断。

### 3. 一秒定性速查表

| 工作特征 | 处理方式 | 是否新建侧边栏独立会话？ |
| :--- | :--- | :--- |
| **需要彻底重置 Token 上下文的大里程碑** | **列为 Relay 阶段任务（Epoch）** | ✅ **是**（侧边栏静默新建，不弹浏览器） |
| **需要移交单写者 CAS 租约的核心代码修改** | **列为 Relay 阶段任务（Epoch）** | ✅ **是**（侧边栏静默新建，不弹浏览器） |
| **阶段内部的多目录并行搜索/调研** | **使用 Subagent / Workflow** | ❌ **否**（在当前会话内部消化） |
| **临时运行一个测试用例或检查类型** | **直接调用工具或轻量 Subagent** | ❌ **否**（在当前会话内部消化） |
| **汇总多角度数据供当前阶段决策** | **使用 Subagent 并行收集** | ❌ **否**（在当前会话内部消化） |

---

## 快速使用指南

### 方式一：调用内嵌调度器执行多阶段接力（最简单、全自动）

在 Node.js 或终端中直接调用内嵌的 `dispatch.mjs`：

```bash
node "C:\Users\21666\.agents\skills\agent-relay\scripts\dispatch.mjs" '[
  {
    "title": "🚀 [Relay] Epoch 1: 架构与拓扑扫描",
    "prompt": "作为 Epoch 1 独立工作者，扫描当前工作区插件并输出结果。如需并发调研多个子目录，请在会话内使用子代理消化。"
  },
  {
    "title": "🚀 [Relay] Epoch 2: 压测与指标采集",
    "prompt": "承接 Epoch 1 结果，执行工具调用延迟与压缩比测试。"
  }
]'
```

调度器会自动：
1. 分别在 DSH 桌面端创建 `Epoch 1` 和 `Epoch 2` 独立会话；
2. 自动在桌面弹出打开两扇会话窗口；
3. 将任务投递至各自会话中等待自主推理完成；
4. 将父子链与交接证据记录到 `relay.db`。

---

### 方式二：在 Agent 思考与执行时使用 JavaScript 调度模块

当作为主 Agent 接到用户多阶段任务需求时，直接引用 `RelayDispatcher` 模块：

```javascript
import { RelayDispatcher } from 'G:/杂项/工具开发/skills/agent-relay/scripts/dispatch.mjs';

const dispatcher = new RelayDispatcher(process.cwd());

await dispatcher.runPipeline([
  {
    title: '🚀 [Relay] Epoch 1: 扫描分析',
    prompt: '【任务】扫描 docs 目录并输出统计（内部并发由本会话自主调度子代理完成）'
  },
  {
    title: '🚀 [Relay] Epoch 2: 报告汇总',
    prompt: '【任务】汇总上一阶段发现并输出报告'
  }
]);
```

---

## 原生控制工具一览（由 agent-relay-dsh 插件自动注入）

DSH 环境已内嵌以下 6 个原生控制工具，Agent 可随时调用：

| 工具名称 | 作用说明 | 参数说明 |
| :--- | :--- | :--- |
| `relay_status` | 查询当前 Relay 运行状态、阶段代数、会话 ID 与单元进度 | `{ run_id?: string }` |
| `relay_pause` | 在下一个安全边界注入暂停意图（安全断点） | `{ run_id?: string }` |
| `relay_resume` | 从 PAUSED 状态恢复执行 | `{ run_id?: string }` |
| `relay_stop` | 立即停止 Relay 运行并撤销租约 | `{ run_id?: string }` |
| `relay_chain` | 查询全链路跨会话父子链（谁交接给谁、模型、交接原因） | `{ run_id?: string }` |
| `relay_materialize` | 将指定运行或交接链物化挂载至 DSH 侧边栏会话卡片 | `{ run_id?: string, workspace_path?: string }` |

---

## 自动触发钩子机制（Auto-Trigger Hooks）

`agent-relay-dsh` 插件在 DSH 宿主内部挂载了自动监听钩子，无需人工干预即可在特定时机自动切分会话：

1. **PreCompact 自动交接钩子**：
   - 监听 DSH 会话的 `compaction/start` / `contextPressure` 事件；
   - 当上下文长度逼近模型极限即将触发破坏性总结时，钩子自动将当前会话状态打包，创建下一个 Epoch 会话并无缝续接，实现长上下文零截断。
2. **交接标记自动触发钩子（Marker Trigger Hook）**：
   - 当任意会话中 Agent 的回复末尾包含 `HANDOFF_ACK_START ... HANDOFF_ACK_END` 或 `【触发下一阶段交接】` 标记时，钩子自动识别 ACK 内容，提取目标后继任务，并在 1 秒内自动创建并弹窗打开后继 Epoch 会话。
   - **注意**：子代理内部的轻量回复绝不输出交接标记，只有当前 Epoch 整体宣告完成时才输出交接标记！
