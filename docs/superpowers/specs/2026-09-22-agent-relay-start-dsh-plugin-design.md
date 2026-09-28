# Agent Relay 启动入口与 DSH 插件设计

## 目标

增加可执行的 `agent-relay start` 入口，复用现有 `RunController` 完成长任务运行；Codex 和 Claude 使用内置适配器，DSH 通过可动态加载的插件接入，同时提供 DSH 宿主可加载的事件桥。

## 范围

- `start` 支持 `codex`、`claude`、`dsh` 三个目标，每次只启动一个目标。
- 支持单个默认任务和 JSON 任务文件两种任务图输入。
- 启动进程前台运行至终态，持久化 `relay.db` 和状态投影，并在退出时关闭适配器和数据库。
- DSH 插件实现 `apply(ctx)`，订阅已验证的 `session/event`，将事件转发到 Relay 事件日志；插件同时导出 `createRuntime()`，供 CLI 动态加载而不是静态耦合 DSH。
- 安装器为 DSH 注册插件入口，保留已有插件配置并支持幂等卸载。

## 非目标

- 不把 `--target=all` 作为 `start` 目标；同一工作区同时跑三个 agent 会违反单写入者约束。
- 不假设 Codex App 桌面端可被外部创建或切换会话。
- 不伪造 DSH 未验证的逐会话取消接口；DSH 仍使用独占 worker 的 shutdown/SIGTERM 语义。
- 不把 DSH 插件事件桥宣称为完整原生端到端验收；真实 DSH profile 加载仍需独立环境验证。

## CLI 契约

```text
agent-relay start
  --target=codex|claude|dsh
  --workspace=<path>
  --goal=<text>
  --prompt=<text>
  [--run=<id>]
  [--data-dir=<path>]
  [--tasks-file=<json-path>]
  [--provider=<provider>]
  [--model=<model>]
  [--effort=<effort>]
  [--max-ticks=<n>]
```

`--goal` 和 `--prompt` 是必需的。未提供 `--tasks-file` 时创建一个 `main` 任务；任务文件必须是任务数组，字段与 `StartRunConfig.tasks` 一致。`--target=dsh` 动态加载插件清单中的入口，入口不存在或导出不满足协议时立即失败，不静默降级为内置 DSH。

## 插件契约

插件入口导出：

```ts
export const pluginManifest: {
  id: 'agent-relay-dsh';
  version: string;
  protocolVersion: 1;
  target: 'dsh';
};

export function createRuntime(options: {
  cwd: string;
  dataDir: string;
}): Promise<{
  adapter: AgentRelayAdapter;
  adapterName: 'dsh';
  createCoordinator: RunControllerOptions['createCoordinator'];
  shutdown(): Promise<void>;
}>;

export function apply(ctx: {
  on(event: 'session/event', listener: (session: unknown, event: unknown) => void): void;
}): void;
```

`apply(ctx)` 只做事件桥，不启动第二个控制器；CLI 的 `createRuntime()` 负责实际 Supervisor 生命周期。事件桥默认无副作用，只有设置 `AGENT_RELAY_EVENT_LOG` 时才追加 JSONL 诊断事件。

## 生命周期与错误处理

1. CLI 解析并校验参数、工作区和任务文件。
2. 创建目标 runtime、打开数据库、创建 `RunController`。
3. `startRun()` 持久化原始 prompt 和任务图，随后 `executeUntilSettled()` 自动推进。
4. 终态为 `COMPLETED` 时退出码 0；`PAUSED`、`CANCELLED`、`DISABLED`、`BLOCKED`、`RECOVERY_REQUIRED` 有明确状态输出和非零退出码。
5. `finally` 中先关闭适配器，再关闭数据库；启动或运行异常不遗留活动子进程。

## 验证

- CLI 参数、任务文件、目标插件加载和终态退出码的单元测试。
- Codex/Claude 使用现有 mock runner 验证 `start` 真的创建 controller 并执行。
- DSH 插件工厂使用现有 mock DSH server 验证动态加载、三端统一 runtime 契约和事件桥。
- 安装器验证 DSH 配置写入插件入口且幂等，卸载只移除 Agent Relay 自有项。
- 先运行新增测试，再运行完整 `npm test`；记录既有 Claude 时序 flaky，不将单次基线失败归因于本改动。
