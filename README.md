# Agent Relay

**把长任务拆成独立会话，携带目标、任务状态与交接记录继续执行。**

Agent Relay 为 Claude Code、Codex CLI 和 DeepSeek Harness（DSH）提供多会话接力能力。它通过原始输入账本、任务图快照、交接校验和 CAS 租约协调不同阶段，减少长会话反复压缩后产生的需求漂移，并保留可查询的执行链。

截至 **2026-10-27**，三个独立插件包均可从 npm 安装：`agent-relay-claude@0.1.0`、`@zwc_seventeen17/agent-relay-codex@0.1.1` 和 `agent-relay-dsh@0.1.1`。仓库根目录的源码 CLI 与这些宿主插件是不同入口；兼容范围见[适配版本](#适配版本)。

## 插件优势

| 能力 | 对长任务的帮助 | 使用边界 |
| --- | --- | --- |
| 独立会话 | 每个阶段从新的会话开始，减少旧对话对当前任务的干扰 | 会话仍可共享同一个代码目录；上下文隔离不等于文件系统隔离 |
| 输入账本与交接摘要 | 保留用户原始指令，并记录已完成工作、约束与后续任务 | 摘要需要核对；不能保证模型永不遗漏信息 |
| 任务图与 SQLite 状态 | 保存任务、依赖、阶段和会话链，便于检查进度与故障定位 | 控制器和插件需使用同一个数据目录 |
| CAS 单写者租约 | 在受 Relay 控制的运行中协调工作区写入者与阶段切换 | 无法阻止外部编辑器、其他进程或绕过 Relay 的会话直接改文件 |
| 后台派发 | 通过宿主接口或 CLI 启动后继会话；Windows 子进程使用隐藏窗口选项 | 依赖宿主登录、权限、模型配置及接口兼容性 |
| 暂停、停止和交接链查询 | 将控制意图和执行记录持久化，便于人工介入 | 提交控制请求不等于控制器已经处理完成 |

原始输入以追加记录保存；修订可通过 `supersedes` 关联被替代输入，推导新约束时保留历史。任务阶段（Epoch）用于分析、实现、验收等较大的里程碑。阶段内的文件读取、局部测试通常在当前阶段完成，无需每次操作都新建会话。

适合多阶段开发、重构、跨领域任务及需要检查交接证据的工程工作。新会话不能替代测试、代码评审或工作区隔离。

## 从 npm 安装插件

先安装并登录对应宿主，再按需安装插件包。以下命令使用 npm 官方仓库；三个包可分别安装，不需要安装名为 `agent-relay` 的其他项目。

| 宿主 | 安装命令 | 安装后的接入 |
| --- | --- | --- |
| Claude Code | `npm install -g agent-relay-claude@0.1.0` | 在 Claude Code 的 MCP 配置中使用 `agent-relay-claude-mcp --mcp-stdio`；见 [Claude 插件说明](https://www.npmjs.com/package/agent-relay-claude) |
| Codex CLI | `npm install -g @zwc_seventeen17/agent-relay-codex@0.1.1` | MCP 命令为 `agent-relay-codex-mcp --mcp-stdio`；完整插件还需加载包内钩子并在 Codex 中信任；见 [Codex 插件说明](https://www.npmjs.com/package/@zwc_seventeen17/agent-relay-codex) |
| DSH Desktop | `npm install agent-relay-dsh@0.1.1` | npm 只安装包文件，仍需由 DSH 宿主加载并启用插件；见[下方 DSH 安装说明](#dsh-desktop)和 [DSH npm 包](https://www.npmjs.com/package/agent-relay-dsh) |

Claude/Codex 的全局命令需在宿主进程的 `PATH` 中可见。仅安装 npm 包不会自动写入宿主的 MCP 配置；Codex 仅配置 MCP 也不会启用生命周期钩子。三个 npm 插件建议使用 **Node.js ≥22.13.0**：Claude 0.1.0 的包清单虽然声明 ≥20，但 MCP 入口依赖 `node:sqlite`，Node 20 无法运行该入口；Node 22.13 起该模块不再需要实验性启动参数。参见 [Node.js SQLite 文档](https://nodejs.org/download/release/latest-v22.x/docs/api/sqlite.html)。

## 快速开始：从源码运行

### 1. 准备环境

- 源码使用原生 TypeScript 执行与 `node:sqlite`，建议采用 **Node.js 24.x**；仓库协议探针记录的环境为 **24.14.0**。
- 安装并登录目标宿主（`claude`、`codex` 或 DSH），确认可独立运行，并配置有权限使用的模型。
- 以下 CLI 示例均在仓库根目录执行。命令写为单行，便于在 PowerShell 或常见 Unix shell 中使用。

```bash
git clone https://github.com/seventeenlyc/agent-relay.git
cd agent-relay
node --version
```

当前根包 `agent-relay-workspace` 是私有工作区包，没有注册 `agent-relay` 命令。请使用 `node bin/agent-relay.mjs`，无需 `npm link`。

**不要通过 `npm install -g agent-relay` 安装本项目：npm 上该名称对应另一个仓库。** 插件请使用[上方三个已发布的包名](#从-npm-安装插件)。

### 2. 启动第一个任务

先把示例中的 `YOUR_MODEL_ID` 替换为目标宿主中已经配置且可用的模型 ID。`--goal` 是运行目标，`--prompt` 是交给首个会话的原始指令，两项均为必填。

```bash
node bin/agent-relay.mjs start --target=claude --workspace=. --goal="检查搜索模块" --prompt="只读检查搜索模块，说明现状与待改进事项，不修改文件。" --model="YOUR_MODEL_ID" --data-dir=./relay-data
```

Codex 使用相同入口，切换目标和模型即可：

```bash
node bin/agent-relay.mjs start --target=codex --workspace=. --goal="检查搜索模块" --prompt="只读检查搜索模块，说明现状与待改进事项，不修改文件。" --model="YOUR_MODEL_ID" --data-dir=./relay-data
```

`start` 在前台驱动运行，并输出运行 ID、数据目录及结束状态。它会调用已登录的模型服务，耗时和费用取决于模型及任务。需要同时查看进度时，在另一个终端使用下文的查询命令。

当前 CLI 没有实现 `--version`、`--help` 或 `materialize` 子命令。版本以包清单和 Release 为准，命令说明可查阅[CLI 源码](packages/cli/src/cli.ts)。

## 使用方法

### 带依赖关系的任务列表

在仓库根目录保存 `tasks.json`。CLI 要求顶层为非空数组，每项包含 `taskId`、`requirementId`、`title`；任务说明使用 `description`，依赖使用 `dependencies`。

```json
[
  {
    "taskId": "inventory",
    "requirementId": "req-search-review",
    "title": "盘点搜索模块",
    "description": "只读定位搜索入口、数据流和相关测试，输出文件路径与结论。"
  },
  {
    "taskId": "review",
    "requirementId": "req-search-review",
    "title": "复核盘点结果",
    "description": "根据上一阶段结果复核关键路径，列出可验证的改进建议，不修改文件。",
    "dependencies": ["inventory"]
  }
]
```

```bash
node bin/agent-relay.mjs start --target=claude --workspace=. --goal="审查搜索模块" --prompt="按任务列表分阶段只读审查。交接时保留原始目标、文件路径、验证证据和未完成事项。" --model="YOUR_MODEL_ID" --tasks-file=tasks.json --data-dir=./relay-data
```

可选任务字段还包括 `allowedPaths`、`expectedArtifacts`（字符串数组）。它们供任务约束与结果校验使用，不是操作系统权限规则。该 JSON 是源码 CLI 的任务格式；插件调度脚本接受的阶段列表有自己的格式，不能混用。

### 查询状态与交接链

查询命令中的数据目录必须与启动时一致。多运行并存时，添加 `--run <运行ID>` 指定目标；不要输入尖括号本身。

```bash
node bin/agent-relay.mjs status --data-dir ./relay-data
node bin/agent-relay.mjs status --data-dir ./relay-data --json
node bin/agent-relay.mjs watch --data-dir ./relay-data --interval 2000
node bin/agent-relay.mjs chain --data-dir ./relay-data
```

`watch` 可加 `--iterations 5` 限制刷新次数；`chain --json` 可输出结构化会话链。会话 ID 和账本用于追溯，实际成功仍需结合宿主终态与任务产物判断。

### 暂停、恢复与停止

```bash
node bin/agent-relay.mjs pause --data-dir ./relay-data
node bin/agent-relay.mjs resume --data-dir ./relay-data
node bin/agent-relay.mjs stop --data-dir ./relay-data
node bin/agent-relay.mjs disable --data-dir ./relay-data
```

这些命令把控制意图写入数据库。`pause` 请求在安全边界暂停，`resume` 请求恢复，`stop` 请求中断，`disable` 请求禁用自动交接；使用 `status` 核对实际状态。

**控制意图需要存活的控制器继续处理。** 当前前台 `start` 可能在暂停或需要恢复时结束并关闭运行时；单独调用 `resume` 不会启动新的控制器进程。它不等同于持久后台服务，也不提供通用的进程退出后自动续跑命令。遇到 `RECOVERY_REQUIRED` 时，应先检查原因、会话状态与产物，再决定恢复方式。

## 插件集成

### Claude Code 与 Codex CLI

公开主线包含这两个平台的源码适配器，使用上文的 `node bin/agent-relay.mjs start --target=claude` 或 `--target=codex` 完整示例启动。Claude 适配器通过 headless `stream-json` 执行，Codex 适配器通过 `codex app-server --stdio` 创建独立线程。

独立的 Claude/Codex 插件已发布到 npm，使用[上方包名](#从-npm-安装插件)安装；公开主线的源码 CLI 仍使用 `node bin/agent-relay.mjs`。源码安装器写入集成配置也不等于宿主已经加载插件或生命周期钩子；以实际源码入口与宿主发现结果为准。CLI 线程持久化不保证桌面应用会自动打开或展示相应聊天。

Codex npm 插件包含 MCP 控制服务与成功压缩后交接钩子：成功压缩默认累计三次后请求新聊天，需 `PostCompact`、`SessionStart(compact)`、钩子信任和宿主原生聊天创建工具。该能力不属于 DSH v0.1.1 包，也不代表压缩前零损失交接；仅挂载 MCP 时不会安装生命周期钩子。

### DSH Desktop

已发布的 **Agent Relay DSH v0.1.1** 面向 **DSH ≥0.2.1-rc.2、Node.js ≥22.13.0**。可以从 [npm](https://www.npmjs.com/package/agent-relay-dsh) 安装包文件，或使用 [GitHub Release 预构建包](https://github.com/seventeenlyc/agent-relay/releases/tag/v0.1.1)（同页提供 `SHA256SUMS`）。对于由 Electron 应用管理的 Desktop profile，还需在 DSH Desktop 的插件管理器中加载并启用；当前 DSH CLI 会拒绝直接对该 profile 执行 `dsh plugin --profile desktop add`。

使用目标 Desktop profile，并先在 DSH 中注册目标项目。插件通过宿主会话接口创建和派发独立会话，可在宿主界面查看；它支持实际执行，不只是事件观察。v0.1.1 从宿主发现动态 HTTP 地址，也支持显式设置 `DSH_WEB_URL`。

npm 包和 Release 包均包含运行所需的生成文件。源码 `install --target=dsh` 写入的是另一套集成配置，不能代替 DSH 插件安装器。DSH v0.1.1 发布包不包含独立的 Codex 压缩交接改动。

安装并启用插件后，保持 DSH Desktop 运行，在已注册项目目录保存 `dsh-stages.json`：

```json
[
  {
    "title": "Epoch 1: 创建验证产物",
    "prompt": "在当前项目创建 relay-demo-stage1.txt，内容为 RELAY_STAGE_1_OK。不要修改其他文件。"
  },
  {
    "title": "Epoch 2: 读取前序产物",
    "prompt": "读取当前项目的 relay-demo-stage1.txt，确认内容为 RELAY_STAGE_1_OK，输出校验结果，不修改文件。"
  }
]
```

Windows desktop profile 默认安装位置的调用示例（PowerShell）：

```powershell
$relayPackage = Join-Path $env:USERPROFILE '.dsh/profiles/desktop/node_modules/agent-relay-dsh'
node (Join-Path $relayPackage 'skills/agent-relay/scripts/dispatch.mjs') ./dsh-stages.json
```

如使用其他 profile 或安装位置，请把 `$relayPackage` 改为完整插件包目录，保留包内文件结构。阶段会使用宿主的模型配置并产生模型调用。前序聊天内容不会自动复制给后继阶段；这个例子通过共享文件传递结果。完成后检查两条独立会话、第二阶段的校验结果和 Relay 会话链；示例会留下一个验证文本文件。

该便捷派发脚本顺序执行阶段并记录会话链，不包含完整控制器的 CAS 租约交接或控制意图处理流程。需要租约治理与暂停恢复时，应使用完整控制器路径并单独验证，不能仅凭脚本日志中的交接文字认定已经取得写租约。

### DSH 插件控制工具

DSH 插件提供以下六个工具。具体工具名可能带有宿主前缀；以宿主实际发现的工具列表为准。

| 工具 | 用途 |
| --- | --- |
| `relay_status` | 查询运行状态和当前会话 |
| `relay_pause` | 提交下一安全边界暂停请求 |
| `relay_resume` | 提交恢复请求 |
| `relay_stop` | 提交停止请求 |
| `relay_chain` | 查询跨会话交接链 |
| `relay_materialize` | 按指定运行链创建并派发宿主会话，可能触发模型调用 |

上述工具通常接受可选 `run_id`；物化工具还接受 `workspace_path`。数据目录应与运行控制器一致。`relay_materialize` 是插件工具，不是源码 CLI 子命令。

## 配置与数据目录

源码 CLI 当前使用命令行参数和环境变量；不读取 `~/.agent-relay/config.json` 或 `.agent-relay/config.json`。

| 配置 | 作用 |
| --- | --- |
| `--target=claude\|codex\|dsh` | 选择启动目标 |
| `--workspace=<路径>` | 任务工作区，启动时必填 |
| `--goal=<目标>` / `--prompt=<原始指令>` | 启动时均必填 |
| `--tasks-file=<路径>` | CLI JSON 任务文件；省略时创建一个主任务 |
| `--model=<模型ID>` / `--provider=<提供方>` / `--effort=<级别>` | 指定当前宿主支持的模型设置，推荐显式设置模型 |
| `--max-ticks=<正整数>` | 控制器推进上限，默认 `100`，不是秒数 |
| `AGENT_RELAY_DATA_DIR` | CLI 与基础控制服务的数据目录默认值 |
| `CLAUDE_BIN_PATH` | Claude 进程适配器使用的可执行文件路径 |
| `DSH_WEB_URL` | DSH v0.1.1 的显式宿主 HTTP 地址 |

`start` 支持 `--data-dir=<路径>`；查询与控制命令使用 `--data-dir <路径>`。显式参数优先于 `AGENT_RELAY_DATA_DIR`。未设置时，CLI 默认数据目录为：

- Windows：`%LOCALAPPDATA%/agent-relay`；缺少该变量时使用用户目录下的 `AppData/Local/agent-relay`。
- macOS / Linux：`$XDG_STATE_HOME/agent-relay`；未设置时为 `~/.local/state/agent-relay`。

数据目录保存 `relay.db` 等运行记录。示例 `./relay-data` 相对于执行命令的当前目录解析；跨终端或 MCP 使用时推荐绝对路径。

Codex npm 插件的压缩交接状态目录与阈值由插件环境变量配置；当前公开主线的源码 CLI 不提供对应入口。参见 [Codex 插件说明](https://www.npmjs.com/package/@zwc_seventeen17/agent-relay-codex)。

## 卸载与数据保留

通过 DSH 插件安装器安装的包，请在目标 profile 的插件管理器中卸载。卸载插件配置不等于删除 Relay 运行数据。

如果此前使用过**源码安装器**，可使用对应卸载命令清理它管理的条目：

```bash
node bin/agent-relay.mjs uninstall --target=claude --workspace=.
```

源码卸载器支持 `--purge-all`，其当前行为只删除 `--workspace` 目录下的 `relay.db`、`relay.db-wal`、`relay.db-shm`；不会按 `AGENT_RELAY_DATA_DIR` 搜索所有运行数据，也不会删除全部源码或 Codex 压缩状态目录。需要清理数据时，先确认实际目录并备份。`--purge` 不是有效清理选项。

## 适配版本

### 组件与宿主

| 组件 | 当前版本或历史验证环境 | 能力与兼容边界 |
| --- | --- | --- |
| 源码工作区 / CLI | 根 `package.json` 为 `0.1.0`；建议 Node.js 24.x | 原生 TypeScript 与 SQLite；不是已发布的全局 CLI |
| Claude 源码适配器 / npm 插件 | 协议探针记录 Claude Code `2.1.274`；源码建议 Node 24.x；`agent-relay-claude@0.1.0` 实际需 Node ≥22.13.0 | 使用 headless `stream-json`；包清单的 Node ≥20 声明低于 MCP 入口实际要求，未确定完整功能的最低宿主版本 |
| Codex 源码适配器 / npm 插件 | 基础协议探针记录 Codex CLI `0.144.4`；源码建议 Node 24.x；`@zwc_seventeen17/agent-relay-codex@0.1.1` 要求 Node ≥22.13.0 | 基础线程派发依赖 app-server；压缩交接需要插件钩子和宿主原生聊天创建工具，尚无统一最低宿主版本结论 |
| DSH 发布包 | `agent-relay-dsh` **v0.1.1**；Node ≥22.13.0、DSH ≥0.2.1-rc.2 | 通过 DSH 宿主接口执行真实会话；npm 安装后仍需宿主加载，以对应包清单与验证范围为准 |

探针中的宿主版本是历史测试点，不表示该版本以上的所有组合均已验收。源码、本地插件和 DSH Release 可能不包含同一组改动。`docs/delivery` 中早期的“v1.0”交付文档不能用作当前包版本依据。

仓库协议探针主要记录 Windows 11、Node 24.14.0。macOS / Linux 的完整宿主流程需在目标环境单独验证。Relay 核心使用 Node 内置模块；宿主、账户、模型服务及宿主插件依赖仍需分别准备。

### 自动交接的验证范围

- **任务阶段接力**：由控制器、调度器及宿主事件推进，检查运行终态、会话链和产物确认结果。
- **Codex 成功压缩后交接**：Codex npm 包包含所需钩子；需宿主加载、信任并提供原生聊天创建工具。它不属于 DSH 发布包的能力。
- **跨领域 / Marker 交接**：依赖平台事件、标记识别和策略，不能保证任意自然语言领域切换都触发。
- **DSH v0.1.1 发布验证**：发布说明记录 `392/392` 测试、脱离源码目录的包检查及此前的双会话产物接力；自动压缩与跨领域钩子未单独验收。

版本要求和 DSH 验证范围来源：[v0.1.1 Release](https://github.com/seventeenlyc/agent-relay/releases/tag/v0.1.1)。

## 测试与开发

以下命令在源码仓库根目录执行，覆盖范围与测试数量以当次输出为准：

```bash
npm test
npm run test:contracts
npm run test:recovery
npm run test:installer
npm run demo
npm run eval
npm run verify:all
```

`demo` 运行仓库验收测试，`eval` 运行长链路评估；它们通过不等于所有真实宿主、桌面界面或生产环境均已验证。进行原生验收时，应另外记录宿主版本、模型、运行 ID、会话链及实际产物。

提交 Issue 时请附上复现步骤、Node 与宿主版本、运行状态以及已脱敏的错误信息。代码贡献可使用 `feat:`、`fix:`、`docs:`、`test:` 等 Conventional Commits 前缀。

## 文档与许可证

- [Agent Relay 技能规范](skills/agent-relay/SKILL.md)
- [DSH npm 插件说明](https://www.npmjs.com/package/agent-relay-dsh)
- [Codex 协议探针](docs/probes/codex.md)
- [Claude Code 协议探针](docs/probes/claude.md)
- [DSH 早期协议探针](docs/probes/dsh.md)
- [早期交付说明（历史记录）](docs/delivery/release-notes-v1.0.md)
- [DSH v0.1.1 发布说明与下载](https://github.com/seventeenlyc/agent-relay/releases/tag/v0.1.1)

三个 npm 插件包的清单均声明 MIT；许可正文随包提供。

[GitHub](https://github.com/seventeenlyc/agent-relay) · [Issues](https://github.com/seventeenlyc/agent-relay/issues)
