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

test('targets: DSH target installs plugin entry into .dsh/config.json', async () => {
  const dir = tempDir();
  try {
    const installer = new Installer();
    const results = await installer.install({
      target: 'dsh',
      workspacePath: dir,
      cliScriptPath: path.join(dir, 'cli.js')
    });

    const dshResult = results.find((r) => r.target === 'dsh' && r.scope === 'workspace');
    assert.ok(dshResult);

    const dshConfig = path.join(dir, '.dsh', 'config.json');
    assert.strictEqual(fs.existsSync(dshConfig), true);

    const config = JSON.parse(fs.readFileSync(dshConfig, 'utf8'));
    assert.ok(Array.isArray(config.plugins));
    assert.strictEqual(config.plugins.length, 1);
    assert.strictEqual(config.plugins[0].id, 'agent-relay');
    assert.strictEqual(config.plugins[0].managedBy, 'agent-relay');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('targets: Installer with target=all installs all three targets', async () => {
  const dir = tempDir();
  try {
    const installer = new Installer();
    const results = await installer.install({
      target: 'all',
      workspacePath: dir,
      cliScriptPath: path.join(dir, 'cli.js')
    });

    assert.strictEqual(results.length, 3);
    const targets = results.map((r) => r.target);
    assert.ok(targets.includes('claude'));
    assert.ok(targets.includes('codex'));
    assert.ok(targets.includes('dsh'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('targets: Installer throws on unknown target', async () => {
  const installer = new Installer();
  await assert.rejects(
    () => installer.install({ target: 'unknown' as any, workspacePath: '/tmp/nope' }),
    { message: /Unknown install target/ }
  );
});

test('targets: Claude hooks contain correct event names', async () => {
  const dir = tempDir();
  try {
    const installer = new Installer();
    await installer.install({
      target: 'claude',
      workspacePath: dir,
      cliScriptPath: path.join(dir, 'cli.js')
    });

    const settingsPath = path.join(dir, '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const events = settings.hooks.map((h: any) => h.event);
    assert.deepStrictEqual(events, ['SessionStart', 'PreCompact', 'Stop']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('targets: Claude idempotent install does not duplicate hooks', async () => {
  const dir = tempDir();
  try {
    const installer = new Installer();
    const opts = { target: 'claude' as const, workspacePath: dir, cliScriptPath: path.join(dir, 'cli.js') };

    await installer.install(opts);
    await installer.install(opts);

    const settingsPath = path.join(dir, '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.strictEqual(settings.hooks.length, 3, 'hooks should not be duplicated on second install');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('targets: Codex idempotent install does not duplicate anchor block', async () => {
  const dir = tempDir();
  try {
    const installer = new Installer();
    const opts = { target: 'codex' as const, workspacePath: dir, cliScriptPath: path.join(dir, 'cli.js') };

    await installer.install(opts);
    await installer.install(opts);

    const agentsMd = path.join(dir, 'AGENTS.md');
    const content = fs.readFileSync(agentsMd, 'utf8');
    const startCount = (content.match(/<!-- AGENT_RELAY_START -->/g) || []).length;
    assert.strictEqual(startCount, 1, 'anchor block should not be duplicated');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('targets: DSH idempotent install does not duplicate plugin entry', async () => {
  const dir = tempDir();
  try {
    const installer = new Installer();
    const opts = { target: 'dsh' as const, workspacePath: dir, cliScriptPath: path.join(dir, 'cli.js') };

    await installer.install(opts);
    await installer.install(opts);

    const dshConfig = path.join(dir, '.dsh', 'config.json');
    const config = JSON.parse(fs.readFileSync(dshConfig, 'utf8'));
    assert.strictEqual(config.plugins.length, 1, 'plugin entry should not be duplicated');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
