# agent-relay-dsh

> **Agent Relay DSH Host Plugin** — Multi-session physical isolation, automated cross-window handoffs, and state machine persistence for DeepSeek Harness (DSH) Desktop.

---

## 🌟 核心特性 (Features)

1. **真实多会话跨窗口接力 (Real Multi-Session Dispatch)**
   - 告别单窗口 Token 膨胀崩溃与破坏性截断。
   - 宏观阶段通过 DSH 原生 RPC（`session/create` + `session/rename`）在左侧边栏物化独立会话卡片。
   - 桌面自动弹出打开新会话专属窗口（`http://127.0.0.1:19387/#/<sessionId>`）。
   - 通过 `session/prompt` (`mode: 'queue'`) 派发任务，由独立 Agent 自主调用工具完成工作。

2. **加密级 3D 状态机与防作弊机制 (3D State Machine & CAS Lease)**
   - **单调 CAS 租约锁**：全系统保证任意时刻仅有一个会话持有工作区写权限，杜绝脏写。
   - **不可变人类提示词账本**：SHA-256 哈希存证，杜绝多轮对话后的需求衰减与降级。
   - **3D 指纹防作弊**：前驱会话移交前校验代码树哈希与任务 DAG，验签一致才放行写操作。

3. **双重自动触发钩子 (DshHandoffHook)**
   - **PreCompact 自动避灾钩子**：当会话接近上下文上限（触发 `compaction/start`）前，自动捕获状态并物化新会话弹窗续接，实现超长链路零信息丢失。
   - **交接标记钩子 (Marker Trigger Hook)**：监听回复流，当检测到 `HANDOFF_ACK_START` 等交接信号时，自动触发后继会话生成与窗口弹出。

4. **内嵌 Skill 知识与任务分层铁律**
   - 内置 `agent-relay` 技能，大模型自动识别“多阶段交接”并加载。
   - 明确任务分层：宏观阶段才列为 Relay 任务（建会话+弹窗）；微观打杂由 Subagent 在当前会话内部并发消化，绝不产生会话爆炸。

5. **6 大原生控制工具**
   - `relay_status`：查询状态与进度
   - `relay_pause`：注入安全断点
   - `relay_resume`：恢复执行
   - `relay_stop`：立即停止并撤销租约
   - `relay_chain`：查询跨会话父子链
   - `relay_materialize`：物化会话卡片至 DSH 侧边栏

---

## 🚀 安装指南 (Installation)

### 方式 1：通过 NPM 安装到 DSH Desktop Profile

在 DSH Desktop 扩展环境中直接安装：

```bash
cd ~/.dsh/profiles/desktop
npm install agent-relay-dsh
```

### 方式 2：本地离线包安装 (Tarball)

在任意机器打包：
```bash
npm pack
# 生成 agent-relay-dsh-0.1.0.tgz
```
安装到目标 DSH 环境：
```bash
cd ~/.dsh/profiles/desktop
npm install /path/to/agent-relay-dsh-0.1.0.tgz
```

---

## 🛠️ 快速测试 (Quick Test)

安装后，您可以在终端中直接运行极简两阶段跨会话接力测试：

```bash
node skills/agent-relay/scripts/dispatch.mjs '[
  {
    "title": "🧪 [Relay测试] Epoch 1: 基础运算",
    "prompt": "请回答：123 + 456 等于几？直接给出数字答案。"
  },
  {
    "title": "🧪 [Relay测试] Epoch 2: 结果检验",
    "prompt": "承接上一步运算结果 579，请说明它是奇数还是偶数并解释原因。"
  }
]'
```

---

## 📄 开源许可证 (License)

MIT License.
