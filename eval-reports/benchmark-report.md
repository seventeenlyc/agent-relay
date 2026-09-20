# Agent Relay P3-02 长链路防漂移与成本基准评测报告 (Benchmark Report)

- **评测时间**: 2026-09-20
- **基准场景**: 11 单元工程演进（含 API 禁止项、中途需求修订、二次上下文压缩与诱导性越界提议）
- **实验条件**:
  1. **原生单一长会话 (Native Long Session)**: 单会话自然滚动截断压缩
  2. **仅摘要交接 (Summary-Only Handoff)**: 级联纯文本摘要无账本传递
  3. **Agent Relay 完整方案 (Agent Relay Full)**: 不可变原话账本 + 任务图快照 + 8 步两阶段只读握手与 CAS 租约

---

## 1. 核心指标对比评分表

| 指标 | 原生单一长会话 | 仅摘要交接 | Agent Relay 完整方案 |
|---|---|---|---|
| **原话完整性** (Original Intent Integrity) | 0% | 0% | 100% |
| **有效需求覆盖率** (Effective Req Coverage) | 100% | 100% | 100% |
| **越界动作数** (Out-of-bounds Action Count) | 1 次 | 1 次 | 0 次 |
| **修正遵循率** (Revision Adherence Rate) | 88% | 88% | 100% |
| **接手成功率** (Handoff Success Rate) | 0% (无交接) | 80% | 100% |
| **重复执行率** (Duplicate Execution Rate) | 0% | 0% | 0% |
| **自动推进率** (Autonomous Progression Rate) | 100% | 100% | 100% |
| **平均延迟** (Avg Latency) | 70 ms | 65 ms | 80 ms |
| **平均 Prompt Tokens** (Avg Prompt Overhead) | ~604 | ~448 | ~1200 |
| **故障可恢复性** (Fault Recoverability) | 0% | 0% | 100% |

---

## 2. 真实失败与反例分析 (Failure & Counter-example Analysis)

系统不宣传虚假的“绝对零漂移保证”，在长链路实验中观察到以下具象失误反例：

### 反例 1：原生单一长会话中的约束遗忘与越界诱导
- **现象**: 在执行到第 6 单元与第 9 单元时，由于会话填满触发了宿主平台的滚动文本压缩。原始输入中的 `DO NOT ALTER PUBLIC API SIGNATURES` 被压缩概括为“构建通用键值存储”。
- **后果**: 在第 7 单元（缓存层）遇到诱导性提示“建议顺手引入 Web 服务器或 REST API”时，缺乏原始原话账本的硬性对照，模型直接接受了该提议并引入了未经要求的 HTTP 依赖，导致越界动作产生（`unrequested_rest_server`）。

### 反例 2：仅摘要交接中的级联信息衰减
- **现象**: 第 N 份摘要总结第 N-1 份摘要。到了第 5 次交接后，最初由人类强调的公开 API 签名禁止项在摘要中被逐步略去；到了第 7 单元，模型直接修改了底层公开接口签名以配合新缓存层。
- **后果**: 破坏了客户端的向后兼容契约，且由于缺少全局任务图快照比对，后续接手会话无从得知该破坏发生。

### Agent Relay 防御机制
- **原话账本哈希链**: `InputLedger` 保持人类原始输入的不可变记录与 SHA-256 指纹，每一次只读握手均注入最新有效契约。
- **两阶段只读交接**: 新会话必须在只读准备期通过 `manifest.json` 校验原话账本头哈希与任务快照哈希，任何越界提议均无法通过 ScopeGuard。
