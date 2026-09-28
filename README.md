# agent-relay-dsh

<p align="center">
  <strong>DSH 桌面端多会话物理隔离与自动化侧边栏静默接力插件</strong><br>
  <em>Multi-Session Physical Isolation, Silent Sidebar Handoffs & State Machine Persistence for DeepSeek Harness (DSH) Desktop</em>
</p>

<p align="center">
  <a href="https://github.com/seventeenlyc/agent-relay/tree/dsh-plugin"><img src="https://img.shields.io/badge/DSH-Plugin-blue.svg" alt="DSH Plugin"></a>
  <a href="https://github.com/seventeenlyc/agent-relay/releases/tag/v0.1.0"><img src="https://img.shields.io/badge/version-0.1.0-green.svg" alt="Version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-purple.svg" alt="License"></a>
</p>

---

## 📖 概述 (Overview)

`agent-relay-dsh` 是专为 **DeepSeek Harness (DSH) Desktop** 设计的生产级多智能体接力流水线插件。

它彻底解决了大模型在处理超长复杂工程时**“单窗口 Token 膨胀崩溃、越聊越卡、细节遗忘、系统压缩一刀切截断”**的行业痛点。通过将任务分段为独立的 Epoch（阶段），插件通过 DSH 原生 RPC **在左侧边栏静默物化挂载独立会话并后台派发执行（完全隐藏外部浏览器网页弹窗，零桌面干扰）**，并以加密级 3D 状态机和单调 CAS 租约锁为保障，实现多会话间**物理级上下文隔离与无损自主接力**。

---

## 🌟 核心特性 (Key Features)

```
                    ┌─────────────────────────────────────────┐
                    │        DSH Desktop 桌面端宿主           │
                    └────────────────────┬────────────────────┘
                                         │
        ┌────────────────────────────────┼────────────────────────────────┐
        ▼                                ▼                                ▼
【1. 物理会话隔离与静默挂载】     【2. 双阶段握手与单写者租约】      【3. 双重自动触发钩子】
 • session/create 原生创建会话    • 单调 CAS 租约锁 (单写者保证)    • PreCompact 钩子 (容量溢出预警)
 • session/rename 侧边栏注入标题  • 不可变用户提示词账本 (防篡改)    • Marker 钩子 (HANDOFF_ACK)
 • 左侧边栏静默挂载 (隐藏外置网页)• 工作区 3D 状态树哈希校对        • 毫秒级自动物化后继会话
 • session/prompt 独立派发推理    • 跨 Epoch 会话父子链持久化       • 规避破坏性总结截断
        │                                │                                │
        └────────────────────────────────┼────────────────────────────────┘
                                         ▼
                         【4. 内嵌 Skill 知识与分层治理】
                          • 宏观 Relay 阶段 vs 微观 Subagent 内部消化
                          • 杜绝会话爆炸（Session Explosion）
                          • 6 大原生控制工具 (relay_*)
```

### 1. 真实多会话侧边栏静默接力 (Silent Sidebar Multi-Session Dispatch)
- **原生侧边栏物化**：全流程走 DSH 官方 RPC 契约（`session/create` + `session/rename`），绝不绕过宿主写底层文件，彻底杜绝 `refusing to materialize` 文件锁冲突。
- **静默后台运行（零网页弹窗干扰）**：每个阶段开始时，新会话直接置顶挂载在 DSH Desktop 左侧边栏并在后台独立执行，**完全隐藏外置浏览器标签页弹窗**，用户在 DSH 左侧边栏点击即可随时切换查看进度。
- **独立自主推理**：通过 `session/prompt` (`mode: 'queue'`) 派发任务，当前主窗口只负责调度监控，**所有具体的工具调用、代码重构与推理完全由侧边独立会话完成**。

### 2. 加密级 3D 状态机与防作弊机制 (3D State Machine & CAS Lease)
- **单写者 CAS 租约锁（Single-Writer Lease）**：物理保证任意时刻全系统仅有持有当前代数（Epoch）的一个会话具备写权限，彻底杜绝多 Agent 协同中的代码脏写覆盖。
- **不可变用户提示词账本（Immutable Input Ledger）**：原始用户需求一旦输入即永久 SHA-256 存证，杜绝多轮交接后的需求衰减与偷工减料。
- **3D 指纹防作弊**：前驱会话移交前校验代码树哈希与任务 DAG，验签一致才下发执行令牌。

### 3. 双重生命周期自动触发钩子 (DshHandoffHook)
- **PreCompact 自动避灾钩子**：监听 DSH `compaction/start` 事件。在会话因超长上下文即将触发官方破坏性 Summarize 截断的前一秒，钩子**自动打包状态、在侧边栏静默物化新会话并无缝续接**，实现长任务物理级零信息衰减。
- **Marker 自动触发钩子**：监听回复流，当检测到 `HANDOFF_ACK_START ... HANDOFF_ACK_END` 或 `【触发下一阶段交接】` 标记时，毫秒级自动在侧边栏创建并启动下一个 Epoch 会话。

### 4. 任务分层治理铁律（Hierarchical Planning Rules）
- **宏观接力任务（Relay Epochs）**：仅用于需要彻底清空重置上下文空间、移交独占写租约的大里程碑阶段（全流程通常控制在 2 ~ 4 个 Epoch）。
- **微观子代理（Micro Subagents）**：阶段内部的多目录并发抓取、临时单测、语法校验等，**在当前会话内部使用 Subagent 静默并发消化，严禁列入全局任务板**，彻底杜绝会话爆炸。

---

## 📊 对比分析：Agent Relay vs 传统子代理 vs 社区交接插件

| 维度 | 市面常见子代理 (Subagent) | 现存社区交接插件 (如 dsh-session-handoff) | **Agent Relay DSH 插件** |
| :--- | :--- | :--- | :--- |
| **拓扑结构** | 中心化星型（父会话持续累加 Token） | 孤立静态文档（生成 Markdown 文件） | **线性/DAG 接力赛跑（前驱退场，新会话满血）** |
| **执行模式** | 单窗口折叠运行，容易黑盒 | 需要人手动复制文件粘贴到新会话 | **全自动：原生侧边栏静默新建 + 后台独立运行** |
| **并发写安全** | 无锁控制，极易发生代码踩踏 | 无写权限治理 | **单调 CAS 租约锁（单写者保障）** |
| **防需求漂移** | 经过层层转述容易遗忘或降级 | 依赖模型自主总结 | **不可变账本（SHA-256 验签后才发令牌）** |
| **上下文溢出** | 触发 Compaction 被破坏性裁剪 | 无法自动应对上下文溢出 | **PreCompact 钩子在截断前一秒自动物化续接** |
| **分层治理** | 宏微观混淆 | 无分层机制 | **宏观 Relay + 微观 Subagent 内部消化** |

---

## 🚀 安装与集成指南 (Installation)

### 方式 1：通过 DSH CLI 一键安装（推荐）

```bash
dsh plugin --profile desktop add https://github.com/seventeenlyc/agent-relay/releases/download/v0.1.0/agent-relay-dsh-0.1.0.tgz
```
或直接通过 Git 分支安装：
```bash
dsh plugin --profile desktop add github:seventeenlyc/agent-relay#dsh-plugin
```

### 方式 2：通过 NPM 安装到 DSH Desktop Profile

```bash
cd ~/.dsh/profiles/desktop
npm install github:seventeenlyc/agent-relay#dsh-plugin
```

---

## 🧪 极简验证：5 秒体验侧边栏多会话接力

安装完成后，在任意终端中直接运行随包内置的极简调度器：

```bash
node skills/agent-relay/scripts/dispatch.mjs '[
  {
    "title": "🧪 [Relay测试] Epoch 1: 基础运算",
    "prompt": "请回答：123 + 456 等于几？直接给出数字答案。"
  },
  {
    "title": "🧪 [Relay测试] Epoch 2: 逻辑检验",
    "prompt": "承接上一步运算结果 579，请说明它是奇数还是偶数并解释原因。"
  }
]'
```

#### 预期效果：
1. 终端打印启动调度（全程**不会弹出任何烦人的外部浏览器网页**）；
2. DSH Desktop 左侧边栏置顶自动出现 `🧪 [Relay测试] Epoch 1: 基础运算`，独立 Agent 在后台自动回答 `579`；
3. Epoch 1 完成后，左侧边栏继续自动出现 `🧪 [Relay测试] Epoch 2: 逻辑检验`，独立 Agent 自动接棒完成奇偶校验；
4. 点击左侧边栏任一卡片即可直接查阅完整推理与交接过程！

---

## 🛠️ 原生控制工具一览 (Built-in Tools)

插件自动向 DSH 宿主注册以下 6 大原生控制工具，Agent 与用户可在对话中直接调用：

| 工具名称 | 作用说明 | 参数说明 |
| :--- | :--- | :--- |
| `relay_status` | 查询当前 Relay 运行状态、阶段代数、会话 ID 与进度 | `{ run_id?: string }` |
| `relay_pause` | 在下一个安全边界注入暂停意图（安全断点） | `{ run_id?: string }` |
| `relay_resume` | 从 PAUSED 状态恢复安全断点续跑 | `{ run_id?: string }` |
| `relay_stop` | 立即停止 Relay 运行并撤销写租约 | `{ run_id?: string }` |
| `relay_chain` | 查询全链路跨会话父子链（流转次序、模型、交接原因） | `{ run_id?: string }` |
| `relay_materialize` | 将指定运行或交接链静默物化挂载至 DSH 侧边栏会话卡片 | `{ run_id?: string, workspace_path?: string }` |

---

## 📄 开源许可证 (License)

本项目采用 [MIT License](LICENSE) 开源协议。
