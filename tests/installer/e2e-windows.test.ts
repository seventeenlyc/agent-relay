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
