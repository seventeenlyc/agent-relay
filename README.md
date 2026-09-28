# agent-relay-dsh

<p align="center">
  <strong>DSH 桌面端多会话物理隔离与自动化跨窗口接力插件</strong><br>
  <em>Multi-Session Physical Isolation, Automated Cross-Window Handoffs & State Machine Persistence for DeepSeek Harness (DSH) Desktop</em>
</p>

<p align="center">
  <a href="https://github.com/seventeenlyc/agent-relay/tree/dsh-plugin"><img src="https://img.shields.io/badge/DSH-Plugin-blue.svg" alt="DSH Plugin"></a>
  <a href="https://github.com/seventeenlyc/agent-relay/tree/dsh-plugin"><img src="https://img.shields.io/badge/version-0.1.0-green.svg" alt="Version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-purple.svg" alt="License"></a>
</p>

---

## 📖 概述 (Overview)

`agent-relay-dsh` 是专为 **DeepSeek Harness (DSH) Desktop** 设计的生产级多智能体接力流水线插件。

它彻底解决了大模型在处理超长复杂工程时**“单窗口 Token 膨胀崩溃、越聊越卡、细节遗忘、系统压缩一刀切截断”**的行业痛点。通过将任务分段为独立的 Epoch（阶段），插件通过 DSH 原生 RPC **在左侧边栏自动创建独立会话、在桌面自动弹窗打开新会话**，并以加密级 3D 状态机和单调 CAS 租约锁为保障，实现多会话间**物理级上下文隔离与无损自主接力**。

---

## 🌟 核心特性 (Key Features)

```
                    ┌─────────────────────────────────────────┐
                    │        DSH Desktop 桌面端宿主           │
                    └────────────────────┬────────────────────┘
                                         │
        ┌────────────────────────────────┼────────────────────────────────┐
        ▼                                ▼                                ▼
【1. 物理会话隔离与窗口唤起】     【2. 双阶段握手与单写者租约】      【3. 双重自动触发钩子】
 • session/create 原生创建会话    • 单调 CAS 租约锁 (单写者保证)    • PreCompact 钩子 (容量溢出预警)
 • session/rename 侧边栏注入标题  • 不可变用户提示词账本 (防篡改)    • Marker 钩子 (HANDOFF_ACK)
 • 桌面自动弹窗打开新会话         • 工作区 3D 状态树哈希校对        • 毫秒级自动物化后继会话
 • session/prompt 独立派发推理    • 跨 Epoch 会话父子链持久化       • 规避破坏性总结截断
        │                                │                                │
        └────────────────────────────────┼────────────────────────────────┘
                                         ▼
                         【4. 内嵌 Skill 知识与分层治理】
                          • 宏观 Relay 阶段 vs 微观 Subagent 内部消化
                          • 杜绝会话爆炸（Session Explosion）
                          • 6 大原生控制工具 (relay_*)
```

### 1. 真实多会话跨窗口接力 (Real Multi-Session Dispatch)
- **原生侧边栏物化**：全流程走 DSH 官方 RPC 契约（`session/create` + `session/rename`），绝不绕过宿主写底层文件，彻底杜绝 `refusing to materialize` 文件锁冲突。
- **桌面窗口实时弹出**：每个阶段开始时，调度器通过系统命令（`start "http://127.0.0.1:19387/#/<sessionId>"`）在用户桌面**自动弹出专属独立窗口**，直观见证会话接力。
- **独立自主推理**：通过 `session/prompt` (`mode: 'queue'`) 派发任务，当前主窗口只负责调度监控，**所有具体的工具调用、代码重构与推理完全由独立会话完成**。

### 2. 加密级 3D 状态机与防作弊机制 (3D State Machine & CAS Lease)
- **单写者 CAS 租约锁（Single-Writer Lease）**：物理保证任意时刻全系统仅有持有当前代数（Epoch）的一个会话具备写权限，彻底杜绝多 Agent 协同中的代码脏写覆盖。
- **不可变用户提示词账本（Immutable Input Ledger）**：原始用户需求一旦输入即永久 SHA-256 存证，杜绝多轮交接后的需求衰减与偷工减料。
- **3D 指纹防作弊**：前驱会话移交前校验代码树哈希与任务 DAG，验签一致才下发执行令牌。

### 3. 双重生命周期自动触发钩子 (DshHandoffHook)
- **PreCompact 自动避灾钩子**：监听 DSH `compaction/start` 事件。在会话因超长上下文即将触发官方破坏性 Summarize 截断的前一秒，钩子**自动打包状态、物化新会话并弹窗续接**，实现长任务物理级零信息衰减。
- **Marker 自动触发钩子**：监听回复流，当检测到 `HANDOFF_ACK_START ... HANDOFF_ACK_END` 或 `【触发下一阶段交接】` 标记时，毫秒级自动唤起下一个 Epoch 会话并弹窗。

### 4. 任务分层治理铁律（Hierarchical Planning Rules）
- **宏观接力任务（Relay Epochs）**：仅用于需要彻底清空重置上下文空间、移交独占写租约的大里程碑阶段（全流程通常控制在 2 ~ 4 个 Epoch）。
- **微观子代理（Micro Subagents）**：阶段内部的多目录并发抓取、临时单测、语法校验等，**在当前会话内部使用 Subagent 静默并发消化，严禁列入全局任务板**，彻底杜绝桌面狂弹十几扇窗口的会话爆炸。

---

## 📊 对比分析：Agent Relay vs 传统子代理 vs 社区交接插件

| 维度 | 市面常见子代理 (Subagent) | 现存社区交接插件 (如 dsh-session-handoff) | **Agent Relay DSH 插件** |
| :--- | :--- | :--- | :--- |
| **拓扑结构** | 中心化星型（父会话持续累加 Token） | 孤立静态文档（生成 Markdown 文件） | **线性/DAG 接力赛跑（前驱退场，新窗满血）** |
| **执行模式** | 单窗口折叠运行，容易黑盒 | 需要人手动复制文件粘贴到新会话 | **全自动：原生侧边栏新建 + 桌面弹窗打开** |
| **并发写安全** | 无锁控制，极易发生代码踩踏 | 无写权限治理 | **单调 CAS 租约锁（单写者保障）** |
| **防需求漂移** | 经过层层转述容易遗忘或降级 | 依赖模型自主总结 | **不可变账本（SHA-256 验签后才发令牌）** |
| **上下文溢出** | 触发 Compaction 被破坏性裁剪 | 无法自动应对上下文溢出 | **PreCompact 钩子在截断前一秒自动物化续接** |
| **分层治理** | 宏微观混淆 | 无分层机制 | **宏观 Relay + 微观 Subagent 内部消化** |

---

## 🚀 安装与集成指南 (Installation)

### 方式 1：通过 Git 安装到 DSH Desktop Profile（最推荐）

进入您的 DSH 桌面端扩展目录，直接安装本独立分支：

```bash
cd ~/.dsh/profiles/desktop
npm install github:seventeenlyc/agent-relay#dsh-plugin
```

在 `~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles` 中添加 `"agent-relay-dsh"`：

```json
{
  "dependencies": {
    "agent-relay-dsh": "github:seventeenlyc/agent-relay#dsh-plugin"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "agent-relay-dsh"
      ]
    }
  }
}
```
保存后重启 DSH Desktop，插件即刻生效！

### 方式 2：离线 Tarball 打包安装

在任意开发机上打包生成独立安装包：
```bash
npm pack
# 生成 agent-relay-dsh-0.1.0.tgz (仅约 15 KB，零外部 npm 依赖)
```
将 `.tgz` 拷贝到目标机器安装：
```bash
cd ~/.dsh/profiles/desktop
npm install /path/to/agent-relay-dsh-0.1.0.tgz
```

---

## 🧪 极简验证：5 秒体验跨窗口接力

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

#### 预期视觉效果：
1. 终端打印启动调度；
2. 桌面**立即自动弹出一个新会话窗口**（Epoch 1: 基础运算），独立 Agent 自动回答 `579`；
3. Epoch 1 完成后，桌面**再次自动弹出第二个新会话窗口**（Epoch 2: 逻辑检验），独立 Agent 接棒分析；
4. DSH Desktop 左侧边栏置顶出现两个独立的已完成会话，当前主窗口保持完全干净！

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
| `relay_materialize` | 将指定运行或交接链物化挂载至 DSH 侧边栏会话卡片 | `{ run_id?: string, workspace_path?: string }` |

---

## 💡 官方插件市场收录申请 (Market Submission)

本插件严格符合 DSH 社区市场（[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)）收录规范。

向官方市场提交收录申请只需 1 步：在 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 提一个 Pull Request，在 `plugins.json` 中追加如下记录：

```json
{
  "name": "agent-relay-dsh",
  "owner": "seventeenlyc",
  "url": "https://github.com/seventeenlyc/agent-relay/tree/dsh-plugin",
  "category": "workflow",
  "description": {
    "en": "Multi-session physical isolation and automated cross-window handoffs for DSH Desktop with monotonic CAS leases, 3D state machine, and dual auto-trigger hooks.",
    "zh": "DSH 桌面端多会话物理隔离与自动化跨窗口接力插件：基于单调 CAS 租约锁与 3D 状态机，提供 PreCompact 与 Marker 双重自动触发钩子与分层接力技能。"
  },
  "install": "dsh plugin --profile desktop add github:seventeenlyc/agent-relay#dsh-plugin"
}
```
PR 合并后，DSH Desktop 的 **Plugin Market (dshmarket)** 将在 24 小时内自动向全球用户展示并支持一键安装！

---

## 📄 开源许可证 (License)

本项目采用 [MIT License](LICENSE) 开源协议。
