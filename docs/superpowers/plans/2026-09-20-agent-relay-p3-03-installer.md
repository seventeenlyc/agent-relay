# P3-03 安装、升级、卸载与兼容测试实现计划 (Installation, Upgrade, Uninstallation & Compatibility)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建独立的多端安装、升级与卸载子系统（`packages/installer`），实现三端（Claude Code、Codex CLI、DSH）配置的无损合并与时间戳备份、防重注册、精准卸载与数据保护、SQLite Schema 顺向迁移与高版本只读防御，以及 Windows 中文与空格路径的深度兼容。

**Architecture:** 
1. 路径与执行层：`sanitizer.ts` 负责 Node 可执行文件路径解析、Windows 盘符标准化与中文/空格安全转义双引号包装。
2. 配置合并层：`merger.ts` 负责配置文件时间戳备份（`*.bak.<timestamp>`）、JSON `managedBy: "agent-relay"` 深度合并防重、Markdown 锚点块替换与原子写入。
3. 目标适配层：`targets/` 抽象并实现三端（`claude.ts`, `codex.ts`, `dsh.ts`）的全局与工作区配置注入。
4. 卸载与保留层：`uninstaller.ts` 精准剥离带有 Relay 标记的配置，默认严格保留用户代码与 `relay.db`。
5. 数据库迁移层：`migration.ts` 负责 `schema_meta` 版本检查、顺向迁移事务与高于当前版本的只读降级保护。
6. CLI 与验收层：`cli.ts` 接入 `install`、`upgrade`、`uninstall` 子命令，并在 `tests/installer/e2e-windows.test.ts` 中针对真实中文空格路径进行闭环验收。

**Tech Stack:** Node.js 24 原生 ESM, `node:test`, `node:assert/strict`, `node:fs`, `node:path`, `node:sqlite`, TypeScript (`--experimental-strip-types`), 零外部 npm 依赖。

**Spec:** `docs/superpowers/specs/2026-09-20-agent-relay-p3-03-installer-design.md`

## Global Constraints

- **配置无损与零覆写**：修改前必须生成 `<file>.bak.<timestamp>` 备份；严禁覆盖用户自建 Hook 或修改其他非 Relay 配置。
- **防重注册保证**：通过 `managedBy: "agent-relay"` 标识条目；多次运行 `install` 必须原地更新，绝不允许重复追加 Hook。
- **用户资产严格保留**：卸载时仅剔除 Relay 配置；默认保留用户代码、Git 仓库和 `relay.db` 历史记录，除非显式传 `--purge-all`。
- **Windows 路径安全**：所有生成的启动命令必须正确处理中文、空格路径，严格用转义双引号包装。
- **零外部 npm 运行时依赖**：全部基于 Node.js 24 原生内置模块开发。

---

### Task 1: Windows 路径与 Shell 引号转义安全工具 (`sanitizer.ts`)

**Files:**
- Create: `packages/installer/package.json`
- Create: `packages/installer/src/sanitizer.ts`
- Test: `tests/installer/sanitizer.test.ts`

**Interfaces:**
- Produces:
  - `quoteForWindows(pathOrArg: string): string`: 对包含空格、中文或特殊字符的路径包装转义双引号。
  - `buildNodeCommand(scriptPath: string, args: string[], options?: { nodeExec?: string }): string`: 生成跨平台安全的 Node CLI 启动命令。
  - `normalizePath(filePath: string): string`: 统一路径格式为系统规范绝对路径。

- [ ] **Step 1: 编写测试用例 `tests/installer/sanitizer.test.ts`**

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import { quoteForWindows, buildNodeCommand, normalizePath } from '../../packages/installer/src/sanitizer.ts';

test('sanitizer: quoteForWindows wraps paths containing spaces or Chinese characters', () => {
  assert.strictEqual(quoteForWindows('simple'), 'simple');
  assert.strictEqual(quoteForWindows('C:\\Program Files\\nodejs\\node.exe'), '"C:\\Program Files\\nodejs\\node.exe"');
  assert.strictEqual(quoteForWindows('G:\\杂项\\工具开发\\cli.js'), '"G:\\杂项\\工具开发\\cli.js"');
  assert.strictEqual(quoteForWindows('测试 路径 with spaces'), '"测试 路径 with spaces"');
});

test('sanitizer: buildNodeCommand builds executable command line with properly quoted args', () => {
  const cmd = buildNodeCommand(
    'G:\\杂项\\工具开发\\packages\\cli\\dist\\index.js',
    ['hook', 'session_start', '--workspace', 'C:\\My Workspace\\repo'],
    { nodeExec: 'C:\\Program Files\\nodejs\\node.exe' }
  );
  assert.ok(cmd.startsWith('"C:\\Program Files\\nodejs\\node.exe"'));
  assert.ok(cmd.includes('"G:\\杂项\\工具开发\\packages\\cli\\dist\\index.js"'));
  assert.ok(cmd.includes('hook session_start --workspace "C:\\My Workspace\\repo"'));
});

test('sanitizer: normalizePath resolves relative segments and preserves drive letter', () => {
  const normalized = normalizePath('.');
  assert.ok(normalized.length > 0);
  assert.strictEqual(normalized, normalizePath(normalized));
});
```

- [ ] **Step 2: 运行测试验证失败**

运行：`node --experimental-strip-types tests/installer/sanitizer.test.ts`
预期：FAIL，找不到模块

- [ ] **Step 3: 创建 `packages/installer/package.json` 与 `sanitizer.ts`**

在 `packages/installer/package.json`：
```json
{
  "name": "@agent-relay/installer",
  "version": "0.1.0",
  "type": "module",
  "main": "src/index.ts"
}
```

在 `packages/installer/src/sanitizer.ts`：
```typescript
import path from 'node:path';

export function quoteForWindows(arg: string): string {
  if (!arg) return '""';
  // 如果已经两端带双引号则直接返回
  if (arg.startsWith('"') && arg.endsWith('"')) {
    return arg;
  }
  // 包含空格、制表符、中文或特殊字符时，包裹双引号
  if (/[\s\u4e00-\u9fa5&|<>^%!]/.test(arg)) {
    return `"${arg}"`;
  }
  return arg;
}

export function normalizePath(filePath: string): string {
  return path.resolve(filePath);
}

export function buildNodeCommand(
  scriptPath: string,
  args: string[],
  options?: { nodeExec?: string }
): string {
  const nodeExec = options?.nodeExec ?? process.execPath;
  const quotedNode = quoteForWindows(normalizePath(nodeExec));
  const quotedScript = quoteForWindows(normalizePath(scriptPath));
  const quotedArgs = args.map((a) => quoteForWindows(a)).join(' ');
  return `${quotedNode} ${quotedScript} ${quotedArgs}`.trim();
}
```

- [ ] **Step 4: 运行测试验证通过**

运行：`node --experimental-strip-types tests/installer/sanitizer.test.ts`
预期：PASS

- [ ] **Step 5: 提交代码**

```bash
git add packages/installer/package.json packages/installer/src/sanitizer.ts tests/installer/sanitizer.test.ts
git commit -m "feat(installer): implement Windows path sanitizer and command quoter"
```

---

### Task 2: 无损配置合并与时间戳备份引擎 (`merger.ts`)

**Files:**
- Create: `packages/installer/src/types.ts`
- Create: `packages/installer/src/merger.ts`
- Test: `tests/installer/merger.test.ts`

**Interfaces:**
- Consumes: `sanitizer.ts`
- Produces:
  - `ConfigMerger`:
    - `backupFile(targetPath: string): string | null`
    - `mergeJsonFile<T>(targetPath: string, updater: (existing: any) => any): { backupPath: string | null; updated: any }`
    - `mergeMarkdownBlock(targetPath: string, blockContent: string, blockTag?: string): { backupPath: string | null }`
    - `removeJsonManagedEntries(targetPath: string, predicate: (item: any) => boolean): boolean`
    - `removeMarkdownBlock(targetPath: string, blockTag?: string): boolean`

- [ ] **Step 1: 编写测试用例 `tests/installer/merger.test.ts`**

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigMerger } from '../../packages/installer/src/merger.ts';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'merger-test-'));
}

test('merger: creates timestamped backup before modifying existing JSON file', () => {
  const dir = tempDir();
  try {
    const jsonPath = path.join(dir, 'settings.json');
    fs.writeFileSync(jsonPath, JSON.stringify({ customUserSetting: true }), 'utf8');

    const merger = new ConfigMerger();
    const res = merger.mergeJsonFile(jsonPath, (existing) => {
      existing.injected = true;
      return existing;
    });

    assert.ok(res.backupPath);
    assert.strictEqual(fs.existsSync(res.backupPath!), true);
    assert.match(res.backupPath!, /\.bak\.\d{8}-\d{6}/);

    const originalContent = JSON.parse(fs.readFileSync(res.backupPath!, 'utf8'));
    assert.strictEqual(originalContent.customUserSetting, true);
    assert.strictEqual(originalContent.injected, undefined);

    const updatedContent = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    assert.strictEqual(updatedContent.customUserSetting, true);
    assert.strictEqual(updatedContent.injected, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('merger: idempotently updates entries without duplicates', () => {
  const dir = tempDir();
  try {
    const jsonPath = path.join(dir, 'settings.json');
    fs.writeFileSync(jsonPath, JSON.stringify({
      hooks: [{ event: 'SessionStart', command: 'old-cmd', managedBy: 'agent-relay' }]
    }), 'utf8');

    const merger = new ConfigMerger();
    // Run merge twice with new command
    for (let i = 0; i < 2; i++) {
      merger.mergeJsonFile(jsonPath, (existing) => {
        const hooks = existing.hooks || [];
        const idx = hooks.findIndex((h: any) => h.event === 'SessionStart' && h.managedBy === 'agent-relay');
        if (idx >= 0) {
          hooks[idx].command = 'new-cmd';
        } else {
          hooks.push({ event: 'SessionStart', command: 'new-cmd', managedBy: 'agent-relay' });
        }
        existing.hooks = hooks;
        return existing;
      });
    }

    const finalJson = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    assert.strictEqual(finalJson.hooks.length, 1);
    assert.strictEqual(finalJson.hooks[0].command, 'new-cmd');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('merger: mergeMarkdownBlock and removeMarkdownBlock manages anchor block cleanly', () => {
  const dir = tempDir();
  try {
    const mdPath = path.join(dir, 'AGENTS.md');
    fs.writeFileSync(mdPath, '# User Instructions\n\nExisting user content.\n', 'utf8');

    const merger = new ConfigMerger();
    merger.mergeMarkdownBlock(mdPath, 'Agent Relay protocol instructions here.');

    let content = fs.readFileSync(mdPath, 'utf8');
    assert.ok(content.includes('<!-- AGENT_RELAY_START -->'));
    assert.ok(content.includes('Agent Relay protocol instructions here.'));
    assert.ok(content.includes('Existing user content.'));

    // Remove block
    merger.removeMarkdownBlock(mdPath);
    content = fs.readFileSync(mdPath, 'utf8');
    assert.ok(!content.includes('AGENT_RELAY_START'));
    assert.ok(content.includes('Existing user content.'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 运行测试验证失败**

运行：`node --experimental-strip-types tests/installer/merger.test.ts`
预期：FAIL，模块未找到

- [ ] **Step 3: 实现 `types.ts` 与 `merger.ts`**

在 `packages/installer/src/types.ts`：
```typescript
export interface InstallOptions {
  target?: 'claude' | 'codex' | 'dsh' | 'all';
  global?: boolean;
  workspacePath?: string;
  cliScriptPath?: string;
}

export interface UninstallOptions {
  target?: 'claude' | 'codex' | 'dsh' | 'all';
  global?: boolean;
  workspacePath?: string;
  purgeAll?: boolean;
}

export interface InstallResult {
  target: string;
  scope: 'global' | 'workspace';
  filePath: string;
  backupPath: string | null;
  status: 'installed' | 'updated' | 'skipped';
}
```

在 `packages/installer/src/merger.ts`：
```typescript
import fs from 'node:fs';
import path from 'node:path';

function getTimestampString(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${yyyy}${mm}${dd}-${hh}${min}${ss}`;
}

export class ConfigMerger {
  public backupFile(targetPath: string): string | null {
    if (!fs.existsSync(targetPath)) return null;
    const dir = path.dirname(targetPath);
    const ext = path.extname(targetPath);
    const base = path.basename(targetPath, ext);
    const backupPath = path.join(dir, `${base}${ext}.bak.${getTimestampString()}`);
    fs.copyFileSync(targetPath, backupPath);
    return backupPath;
  }

  public mergeJsonFile<T = any>(
    targetPath: string,
    updater: (existing: any) => any
  ): { backupPath: string | null; updated: T } {
    let existing: any = {};
    let backupPath: string | null = null;

    if (fs.existsSync(targetPath)) {
      backupPath = this.backupFile(targetPath);
      try {
        const raw = fs.readFileSync(targetPath, 'utf8');
        existing = raw.trim() ? JSON.parse(raw) : {};
      } catch {
        existing = {};
      }
    } else {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    }

    const updated = updater(existing);
    const jsonStr = JSON.stringify(updated, null, 2);
    const tmpPath = `${targetPath}.tmp`;
    fs.writeFileSync(tmpPath, jsonStr, 'utf8');
    fs.renameSync(tmpPath, targetPath);

    return { backupPath, updated };
  }

  public mergeMarkdownBlock(
    targetPath: string,
    blockContent: string,
    blockTag = 'AGENT_RELAY'
  ): { backupPath: string | null } {
    const startTag = `<!-- ${blockTag}_START -->`;
    const endTag = `<!-- ${blockTag}_END -->`;
    const wrappedBlock = `\n${startTag}\n${blockContent}\n${endTag}\n`;

    let backupPath: string | null = null;
    let original = '';

    if (fs.existsSync(targetPath)) {
      backupPath = this.backupFile(targetPath);
      original = fs.readFileSync(targetPath, 'utf8');
    } else {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    }

    const regex = new RegExp(`${startTag}[\\s\\S]*?${endTag}`, 'm');
    let finalContent = '';
    if (regex.test(original)) {
      finalContent = original.replace(regex, `${startTag}\n${blockContent}\n${endTag}`);
    } else {
      finalContent = original ? `${original.trimEnd()}\n${wrappedBlock}` : wrappedBlock.trimStart();
    }

    const tmpPath = `${targetPath}.tmp`;
    fs.writeFileSync(tmpPath, finalContent, 'utf8');
    fs.renameSync(tmpPath, targetPath);

    return { backupPath };
  }

  public removeJsonManagedEntries(
    targetPath: string,
    predicate: (item: any) => boolean
  ): boolean {
    if (!fs.existsSync(targetPath)) return false;
    try {
      const raw = fs.readFileSync(targetPath, 'utf8');
      const json = JSON.parse(raw);
      let changed = false;

      if (Array.isArray(json.hooks)) {
        const origLen = json.hooks.length;
        json.hooks = json.hooks.filter((h: any) => !predicate(h));
        if (json.hooks.length !== origLen) changed = true;
      }

      if (changed) {
        this.backupFile(targetPath);
        fs.writeFileSync(targetPath, JSON.stringify(json, null, 2), 'utf8');
      }
      return changed;
    } catch {
      return false;
    }
  }

  public removeMarkdownBlock(targetPath: string, blockTag = 'AGENT_RELAY'): boolean {
    if (!fs.existsSync(targetPath)) return false;
    const startTag = `<!-- ${blockTag}_START -->`;
    const endTag = `<!-- ${blockTag}_END -->`;
    const regex = new RegExp(`\\n?${startTag}[\\s\\S]*?${endTag}\\n?`, 'm');

    const original = fs.readFileSync(targetPath, 'utf8');
    if (regex.test(original)) {
      this.backupFile(targetPath);
      const replaced = original.replace(regex, '\n').trim() + '\n';
      fs.writeFileSync(targetPath, replaced, 'utf8');
      return true;
    }
    return false;
  }
}
```

- [ ] **Step 4: 运行测试验证通过**

运行：`node --experimental-strip-types tests/installer/merger.test.ts`
预期：PASS

- [ ] **Step 5: 提交代码**

```bash
git add packages/installer/src/types.ts packages/installer/src/merger.ts tests/installer/merger.test.ts
git commit -m "feat(installer): implement lossless config merger and timestamped backup"
```

---

### Task 3: 三端安装目标适配器 (`targets/`) 与安装器核心 (`installer.ts`)

**Files:**
- Create: `packages/installer/src/targets/base.ts`
- Create: `packages/installer/src/targets/claude.ts`
- Create: `packages/installer/src/targets/codex.ts`
- Create: `packages/installer/src/targets/dsh.ts`
- Create: `packages/installer/src/installer.ts`
- Test: `tests/installer/targets.test.ts`

**Interfaces:**
- Produces:
  - `Installer`:
    - `install(options: InstallOptions): Promise<InstallResult[]>`

- [ ] **Step 1: 编写测试用例 `tests/installer/targets.test.ts`**

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Installer } from '../../packages/installer/src/installer.ts';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'targets-test-'));
}

test('targets: Claude target installs SessionStart, PreCompact and Stop hooks into .claude/settings.json', async () => {
  const dir = tempDir();
  try {
    const installer = new Installer();
    const results = await installer.install({
      target: 'claude',
      workspacePath: dir,
      cliScriptPath: path.join(dir, 'cli.js')
    });

    assert.ok(results.length > 0);
    const claudeLocal = results.find((r) => r.target === 'claude' && r.scope === 'workspace');
    assert.ok(claudeLocal);

    const settingsPath = path.join(dir, '.claude', 'settings.json');
    assert.strictEqual(fs.existsSync(settingsPath), true);

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.ok(Array.isArray(settings.hooks));
    assert.strictEqual(settings.hooks.length, 3);
    assert.ok(settings.hooks.every((h: any) => h.managedBy === 'agent-relay'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('targets: Codex target injects anchor block into AGENTS.md', async () => {
  const dir = tempDir();
  try {
    const installer = new Installer();
    const results = await installer.install({
      target: 'codex',
      workspacePath: dir,
      cliScriptPath: path.join(dir, 'cli.js')
    });

    const codexResult = results.find((r) => r.target === 'codex' && r.scope === 'workspace');
    assert.ok(codexResult);

    const agentsMd = path.join(dir, 'AGENTS.md');
    assert.strictEqual(fs.existsSync(agentsMd), true);
    const content = fs.readFileSync(agentsMd, 'utf8');
    assert.ok(content.includes('<!-- AGENT_RELAY_START -->'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 运行测试验证失败**

运行：`node --experimental-strip-types tests/installer/targets.test.ts`
预期：FAIL，Installer 模块未定义

- [ ] **Step 3: 实现 `targets/` 与 `installer.ts`**

1. `targets/base.ts`: 定义抽象基类 `BaseTarget`。
2. `targets/claude.ts`: 实现 Claude Code 的 `settings.json` 注入。
3. `targets/codex.ts`: 实现 Codex CLI 的 `AGENTS.md` 注入。
4. `targets/dsh.ts`: 实现 DSH 的 `.dsh/config.json` 插件注入。
5. `installer.ts`: 编排多端安装，支持 `target: 'all' | 'claude' | 'codex' | 'dsh'`。

- [ ] **Step 4: 运行测试验证通过**

运行：`node --experimental-strip-types tests/installer/targets.test.ts`
预期：PASS

- [ ] **Step 5: 提交代码**

```bash
git add packages/installer/src/targets/ packages/installer/src/installer.ts tests/installer/targets.test.ts
git commit -m "feat(installer): implement target adapters for Claude Code, Codex, and DSH"
```

---

### Task 4: 精准回滚与用户资产保护卸载器 (`uninstaller.ts`)

**Files:**
- Create: `packages/installer/src/uninstaller.ts`
- Test: `tests/installer/uninstaller.test.ts`

**Interfaces:**
- Consumes: `ConfigMerger`, `types.ts`
- Produces:
  - `Uninstaller`:
    - `uninstall(options: UninstallOptions): Promise<Array<{ target: string; cleanedFiles: string[] }>>`

- [ ] **Step 1: 编写测试用例 `tests/installer/uninstaller.test.ts`**

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Installer } from '../../packages/installer/src/installer.ts';
import { Uninstaller } from '../../packages/installer/src/uninstaller.ts';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'uninstaller-test-'));
}

test('uninstaller: removes Relay hooks while strictly preserving user-defined hooks and source files', async () => {
  const dir = tempDir();
  try {
    const settingsPath = path.join(dir, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({
      customUserOption: 'preserve-me',
      hooks: [{ event: 'Stop', command: 'user-clean-up.sh', managedBy: 'user' }]
    }, null, 2), 'utf8');

    // 1. Install Relay
    const installer = new Installer();
    await installer.install({ target: 'claude', workspacePath: dir, cliScriptPath: path.join(dir, 'cli.js') });

    const installedSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.strictEqual(installedSettings.hooks.length, 4); // 1 user + 3 relay

    // 2. Uninstall Relay (default preserves data)
    const uninstaller = new Uninstaller();
    await uninstaller.uninstall({ target: 'claude', workspacePath: dir });

    const uninstalledSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.strictEqual(uninstalledSettings.customUserOption, 'preserve-me');
    assert.strictEqual(uninstalledSettings.hooks.length, 1);
    assert.strictEqual(uninstalledSettings.hooks[0].command, 'user-clean-up.sh');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 运行测试验证失败**

运行：`node --experimental-strip-types tests/installer/uninstaller.test.ts`
预期：FAIL，Uninstaller 模块未定义

- [ ] **Step 3: 实现 `uninstaller.ts`**

在 `packages/installer/src/uninstaller.ts`：
- 使用 `ConfigMerger.removeJsonManagedEntries` 过滤 `managedBy === 'agent-relay'` 的项。
- 使用 `ConfigMerger.removeMarkdownBlock` 剔除 Codex 的 `AGENT_RELAY` 锚点块。
- 检查 `options.purgeAll`：若为 true 且存在 `relay.db` 则予以清理；缺省时严禁触碰 `relay.db` 与工作区源码。

- [ ] **Step 4: 运行测试验证通过**

运行：`node --experimental-strip-types tests/installer/uninstaller.test.ts`
预期：PASS

- [ ] **Step 5: 提交代码**

```bash
git add packages/installer/src/uninstaller.ts tests/installer/uninstaller.test.ts
git commit -m "feat(installer): implement uninstaller with precise rollback and user data protection"
```

---

### Task 5: SQLite Schema 顺向迁移与高版本只读防御 (`migration.ts`)

**Files:**
- Create: `packages/installer/src/migration.ts`
- Test: `tests/installer/migration.test.ts`

**Interfaces:**
- Consumes: `RelayDatabase`
- Produces:
  - `MigrationEngine`:
    - `getCurrentVersion(db: RelayDatabase): string`
    - `migrate(db: RelayDatabase, targetVersion?: string): { from: string; to: string }`
    - `checkCompatibility(db: RelayDatabase): { compatible: boolean; readOnlyRequired: boolean; reason?: string }`

- [ ] **Step 1: 编写测试用例 `tests/installer/migration.test.ts`**

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import { RelayDatabase } from '../../packages/controller/src/run/db.ts';
import { MigrationEngine } from '../../packages/installer/src/migration.ts';

test('migration: reports current schema version v1', () => {
  const db = new RelayDatabase({ dbPath: ':memory:' });
  try {
    const engine = new MigrationEngine();
    assert.strictEqual(engine.getCurrentVersion(db), '1');
    const comp = engine.checkCompatibility(db);
    assert.strictEqual(comp.compatible, true);
    assert.strictEqual(comp.readOnlyRequired, false);
  } finally {
    db.close();
  }
});

test('migration: flags readOnlyRequired when encountering unknown future schema version', () => {
  const db = new RelayDatabase({ dbPath: ':memory:' });
  try {
    // Simulate future schema version 99
    db.exec("UPDATE schema_meta SET value = '99' WHERE key = 'schema_version'");
    const engine = new MigrationEngine();
    const comp = engine.checkCompatibility(db);
    assert.strictEqual(comp.compatible, false);
    assert.strictEqual(comp.readOnlyRequired, true);
    assert.match(comp.reason!, /higher than supported/i);
  } finally {
    db.close();
  }
});
```

- [ ] **Step 2: 运行测试验证失败**

运行：`node --experimental-strip-types tests/installer/migration.test.ts`
预期：FAIL，MigrationEngine 未定义

- [ ] **Step 3: 实现 `migration.ts`**

在 `packages/installer/src/migration.ts`：
- `MAX_SUPPORTED_SCHEMA = 1`
- 读取 `schema_meta` 中的 `schema_version`。
- 如果大于 `MAX_SUPPORTED_SCHEMA`，返回 `readOnlyRequired: true`。
- 提供迁移执行器与版本检查器。

- [ ] **Step 4: 运行测试验证通过**

运行：`node --experimental-strip-types tests/installer/migration.test.ts`
预期：PASS

- [ ] **Step 5: 提交代码**

```bash
git add packages/installer/src/migration.ts tests/installer/migration.test.ts
git commit -m "feat(installer): implement schema migration engine with read-only defense"
```

---

### Task 6: CLI 命令注册与 Windows 中文/空格路径端到端闭环验收 (`cli.ts`, `e2e-windows.test.ts`)

**Files:**
- Modify: `packages/cli/src/cli.ts`
- Create: `packages/installer/src/index.ts`
- Test: `tests/installer/e2e-windows.test.ts`

**Interfaces:**
- Consumes: `Installer`, `Uninstaller`, `MigrationEngine`
- Produces:
  - `agent-relay install`
  - `agent-relay upgrade`
  - `agent-relay uninstall`
  - 端到端验收覆盖 V05, V06, V07, V25。

- [ ] **Step 1: 编写端到端验收测试 `tests/installer/e2e-windows.test.ts`**

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCli, type CliIo } from '../../packages/cli/src/cli.ts';

function capture(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l) => out.push(l), err: (l) => err.push(l) }, out, err };
}

test('e2e installer: full install -> upgrade -> uninstall lifecycle in path with Chinese and spaces', async () => {
  // Construct a directory with Chinese characters and spaces:
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-relay-'));
  const specialDir = path.join(baseDir, '测试 目录 with spaces');
  fs.mkdirSync(specialDir, { recursive: true });

  try {
    // 1. Install
    const cap1 = capture();
    const code1 = await runCli(['install', '--target=claude', `--workspace=${specialDir}`], cap1.io);
    assert.strictEqual(code1, 0);
    assert.strictEqual(fs.existsSync(path.join(specialDir, '.claude', 'settings.json')), true);

    // 2. Idempotent install (V06)
    const cap2 = capture();
    const code2 = await runCli(['install', '--target=claude', `--workspace=${specialDir}`], cap2.io);
    assert.strictEqual(code2, 0);
    const settings = JSON.parse(fs.readFileSync(path.join(specialDir, '.claude', 'settings.json'), 'utf8'));
    assert.strictEqual(settings.hooks.length, 3); // Still exactly 3 hooks, no duplicates

    // 3. Upgrade (V05)
    const cap3 = capture();
    const code3 = await runCli(['upgrade', `--workspace=${specialDir}`], cap3.io);
    assert.strictEqual(code3, 0);

    // 4. Uninstall (V07)
    const cap4 = capture();
    const code4 = await runCli(['uninstall', '--target=claude', `--workspace=${specialDir}`], cap4.io);
    assert.strictEqual(code4, 0);
    const uninstalledSettings = JSON.parse(fs.readFileSync(path.join(specialDir, '.claude', 'settings.json'), 'utf8'));
    assert.strictEqual(uninstalledSettings.hooks.length, 0);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 运行测试验证失败**

运行：`node --experimental-strip-types tests/installer/e2e-windows.test.ts`
预期：FAIL，CLI 尚未识别 `install`/`upgrade`/`uninstall` 子命令

- [ ] **Step 3: 扩展 `cli.ts` 并创建 `index.ts`**

1. 在 `packages/installer/src/index.ts` 导出所有公共 API。
2. 在 `packages/cli/src/cli.ts` 注册子命令：
   - `install`: 调用 `new Installer().install(...)` 并输出执行清单；
   - `upgrade`: 调用 `new MigrationEngine().migrate(...)`；
   - `uninstall`: 调用 `new Uninstaller().uninstall(...)`。

- [ ] **Step 4: 运行测试验证通过**

运行：`node --experimental-strip-types tests/installer/e2e-windows.test.ts`
预期：PASS

- [ ] **Step 5: 运行全量测试套件并提交代码**

运行：`npm test`
预期：325+ 个测试全部绿灯通过，0 失败。

```bash
git add packages/cli/src/cli.ts packages/installer/src/index.ts tests/installer/e2e-windows.test.ts
git commit -m "feat(installer): integrate install, upgrade, uninstall CLI commands and complete e2e acceptance"
```
