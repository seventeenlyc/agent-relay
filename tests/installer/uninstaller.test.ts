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

test('uninstaller: removes Codex anchor block while preserving user notes in AGENTS.md', async () => {
  const dir = tempDir();
  try {
    const agentsPath = path.join(dir, 'AGENTS.md');
    fs.writeFileSync(agentsPath, '# My Project\n\nUser instructions here.\n', 'utf8');

    const installer = new Installer();
    await installer.install({ target: 'codex', workspacePath: dir, cliScriptPath: path.join(dir, 'cli.js') });

    let content = fs.readFileSync(agentsPath, 'utf8');
    assert.ok(content.includes('<!-- AGENT_RELAY_START -->'));

    const uninstaller = new Uninstaller();
    await uninstaller.uninstall({ target: 'codex', workspacePath: dir });

    content = fs.readFileSync(agentsPath, 'utf8');
    assert.ok(!content.includes('AGENT_RELAY_START'));
    assert.ok(content.includes('User instructions here.'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('uninstaller: strictly preserves relay.db by default and only removes on purgeAll', async () => {
  const dir = tempDir();
  try {
    const dbPath = path.join(dir, 'relay.db');
    fs.writeFileSync(dbPath, 'SQLITE DATA MOCK', 'utf8');

    const uninstaller = new Uninstaller();
    // Default uninstall: preserves relay.db
    await uninstaller.uninstall({ target: 'all', workspacePath: dir, purgeAll: false });
    assert.strictEqual(fs.existsSync(dbPath), true);

    // Uninstall with purgeAll: removes relay.db
    await uninstaller.uninstall({ target: 'all', workspacePath: dir, purgeAll: true });
    assert.strictEqual(fs.existsSync(dbPath), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('uninstaller: removes DSH plugin entries from .dsh/config.json while preserving other plugins', async () => {
  const dir = tempDir();
  try {
    const dshConfigPath = path.join(dir, '.dsh', 'config.json');
    fs.mkdirSync(path.dirname(dshConfigPath), { recursive: true });
    fs.writeFileSync(dshConfigPath, JSON.stringify({
      customSetting: 'keep-me',
      plugins: [{ id: 'user-plugin', enabled: true }]
    }, null, 2), 'utf8');

    const installer = new Installer();
    await installer.install({ target: 'dsh', workspacePath: dir, cliScriptPath: path.join(dir, 'cli.js') });

    let config = JSON.parse(fs.readFileSync(dshConfigPath, 'utf8'));
    assert.strictEqual(config.plugins.length, 2); // 1 user + 1 relay

    const uninstaller = new Uninstaller();
    await uninstaller.uninstall({ target: 'dsh', workspacePath: dir });

    config = JSON.parse(fs.readFileSync(dshConfigPath, 'utf8'));
    assert.strictEqual(config.customSetting, 'keep-me');
    assert.strictEqual(config.plugins.length, 1);
    assert.strictEqual(config.plugins[0].id, 'user-plugin');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('uninstaller: purgeAll removes relay.db-wal and relay.db-shm alongside relay.db', async () => {
  const dir = tempDir();
  try {
    fs.writeFileSync(path.join(dir, 'relay.db'), 'db', 'utf8');
    fs.writeFileSync(path.join(dir, 'relay.db-wal'), 'wal', 'utf8');
    fs.writeFileSync(path.join(dir, 'relay.db-shm'), 'shm', 'utf8');

    const uninstaller = new Uninstaller();
    await uninstaller.uninstall({ target: 'all', workspacePath: dir, purgeAll: true });

    assert.strictEqual(fs.existsSync(path.join(dir, 'relay.db')), false);
    assert.strictEqual(fs.existsSync(path.join(dir, 'relay.db-wal')), false);
    assert.strictEqual(fs.existsSync(path.join(dir, 'relay.db-shm')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('uninstaller: target=all uninstalls all three targets', async () => {
  const dir = tempDir();
  try {
    // Set up files for all targets
    const settingsPath = path.join(dir, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, '{}', 'utf8');

    const agentsPath = path.join(dir, 'AGENTS.md');
    fs.writeFileSync(agentsPath, '# Project\n', 'utf8');

    const dshPath = path.join(dir, '.dsh', 'config.json');
    fs.mkdirSync(path.dirname(dshPath), { recursive: true });
    fs.writeFileSync(dshPath, '{}', 'utf8');

    const installer = new Installer();
    await installer.install({ target: 'all', workspacePath: dir, cliScriptPath: path.join(dir, 'cli.js') });

    // Verify all installed
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.ok(settings.hooks?.length > 0);
    assert.ok(fs.readFileSync(agentsPath, 'utf8').includes('AGENT_RELAY_START'));
    const dshConfig = JSON.parse(fs.readFileSync(dshPath, 'utf8'));
    assert.ok(dshConfig.plugins?.some((p: any) => p.id === 'agent-relay'));

    // Uninstall all
    const uninstaller = new Uninstaller();
    const results = await uninstaller.uninstall({ target: 'all', workspacePath: dir });

    // Verify all cleaned
    assert.ok(results.length >= 3);

    const settingsAfter = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.strictEqual(settingsAfter.hooks?.length ?? 0, 0);

    assert.ok(!fs.readFileSync(agentsPath, 'utf8').includes('AGENT_RELAY_START'));

    const dshAfter = JSON.parse(fs.readFileSync(dshPath, 'utf8'));
    assert.ok(!dshAfter.plugins?.some((p: any) => p.id === 'agent-relay'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('uninstaller: returns correct result structure with target and cleanedFiles', async () => {
  const dir = tempDir();
  try {
    const settingsPath = path.join(dir, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({
      hooks: [{ event: 'Stop', command: 'relay', managedBy: 'agent-relay' }]
    }, null, 2), 'utf8');

    const uninstaller = new Uninstaller();
    const results = await uninstaller.uninstall({ target: 'claude', workspacePath: dir });

    assert.ok(results.length >= 1);
    const claudeResult = results.find(r => r.target === 'claude');
    assert.ok(claudeResult);
    assert.ok(Array.isArray(claudeResult!.cleanedFiles));
    assert.ok(claudeResult!.cleanedFiles.length > 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
