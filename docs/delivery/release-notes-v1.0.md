# Agent Relay v1.0.0 正式发布说明 (Release Notes)

> **版本**: v1.0.0  
> **发布日期**: 2026-09-20  
> **状态**: 生产就绪 (Production Ready)  
> **依赖环境**: Node.js >= 24.0.0 (原生 ESM + 原生 SQLite，零外部 npm 运行时依赖)

---

## 🚀 项目简介

**Agent Relay** 是专为 AI Agent（Claude Code、Codex CLI、DeepSeek Harness）设计的**跨长周期、多物理会话工程任务连续接力系统**。

在传统的单长会话模式中，随着任务深入，上下文窗口膨胀迫使平台进行自然压缩，导致关键约束被遗忘、需求理解漂移、产生未授权的越界修改甚至进入死循环。Agent Relay 通过**不可变原话账本、确定性任务图快照、两阶段只读交接与单写入者 CAS 租约**，在每个工程单元完成后自动启动同模型的全新物理会话并无缝交接，彻底实现“长链条防漂移、故障能自愈、跨端可迁移”。

---

## 🌟 核心特性

### 1. 不可变原话账本与契约演进 (R1, R3)
- **人类输入绝对不可变**：人类原始指令按追加日志（`InputLedger`）落盘并生成 SHA-256 哈希链，跨会话传递永不丢失；
- **需求中途修订（`supersedes`）**：支持用户中途变更需求，自动替换对应子项，同时旧原话完整留存，保持决策可溯源；
- **ScopeGuard 越界防御**：严格比对任务图允许路径与证据，拦截模型自主发起的无依据重构或增加未要求的功能。

### 2. 确定性两阶段交接与原子租约 (R2, R4, R5)
- **物理新会话隔离**：每次交接创建全新的物理进程会话，绝对不复用旧会话的上下文历史；
- **两阶段只读准备（Preparation -> Commit）**：新会话必须先以只读权限启动，校验 Manifest 账本哈希与快照一致后返回 ACK，方能通过原子 CAS 租约获得独占写权；
- **同模型与 Effort 配置继承**：严格继承并校验 `provider`、`model`、`effort` 配置，模型发生意外篡改时立即阻断并报警。

### 3. 控制平面与平稳运行引擎 (R6, R7, R9)
- **0 交互确认推进**：无需用户频繁输入“继续”，全流程自动连续推进；
- **可恢复的控制意图**：提供 `pause`（下一节点暂停）、`resume`（继续）、`stop`（立即停止）、`disable`（禁用交接）；意图先持久化落库再通知引擎，不怕断电；
- **实时状态卡投影**：自动输出结构化 `state_projection.json` 与 CLI `watch` 视图，关闭终端或窗口后可随时重新连接。

### 4. 生产级故障自愈与对账系统 (R10)
- **事务 Outbox 与对账器（RunReconciler）**：覆盖 11 处崩溃边界，针对快照损坏、孤立文件、会话创建回包丢失等异常实现 100% 自动对账自愈；
- **工作区指纹防御**：检测中途换分支、改代码或移动目录，指纹失配时先对账再决定，绝不盲目覆盖用户资产。

### 5. 三端适配器与通用安装套件 (R8)
- **Claude Code 适配器**：L3 原生自动化级，全面支持 `SessionStart`、`PreCompact`、`Stop` Hooks；
- **Codex CLI 适配器**：L3 协议托管级，自动维护 `AGENTS.md` 协议锚点块；
- **DSH 适配器**：L2/L3 混合调度级，基于 DSH SDK ProcessRunner 保证环境与进程隔离；
- **通用安装器（`agent-relay install`）**：修改前自动生成 `<file>.bak.<timestamp>` 时间戳备份，JSON/Markdown 幂等防重合并，卸载时严格保留用户代码与数据库，深度兼容 Windows 中文与空格路径。

---

## 📦 快速开始 (Quickstart)

### 1. 一键安装并配置客户端
```bash
# 为当前工作区安装 Claude Code 支持（同时在工作区注入 hooks）
agent-relay install --target=claude --workspace=.

# 或一次性为三端全部安装
agent-relay install --target=all --workspace=.
```

### 2. 检查运行状态
```bash
# 查看当前工作区活动任务状态卡
agent-relay status

# 轮询监听任务进度
agent-relay watch --interval 2000
```

### 3. 控制任务生命周期
```bash
# 在当前工作单元完成后暂停，安全释放写权
agent-relay pause

# 从暂停中恢复继续推进
agent-relay resume

# 卸载 Relay 配置（默认严格保留源码与 relay.db）
agent-relay uninstall --target=claude --workspace=.
```

---

## 🧪 验证与回归

全系统通过 365+ 个自动化测试用例，覆盖 V01～V35 全部验收场景：

```bash
# 运行三端端到端验收演示 (秒级运行)
npm run demo

# 运行 11 单元 10 次交接防漂移长链路基准评测
npm run eval

# 运行全系统完整回归测试套件
npm run verify:all
```
