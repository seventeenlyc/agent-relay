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

test('merger: backupFile returns null for non-existent file', () => {
  const merger = new ConfigMerger();
  const result = merger.backupFile(path.join(os.tmpdir(), 'nonexistent-file-12345.json'));
  assert.strictEqual(result, null);
});

test('merger: mergeJsonFile creates new file when target does not exist', () => {
  const dir = tempDir();
  try {
    const jsonPath = path.join(dir, 'subdir', 'new-settings.json');

    const merger = new ConfigMerger();
    const res = merger.mergeJsonFile(jsonPath, (existing) => {
      existing.newKey = 'newValue';
      return existing;
    });

    assert.strictEqual(res.backupPath, null);
    assert.strictEqual(fs.existsSync(jsonPath), true);

    const content = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    assert.strictEqual(content.newKey, 'newValue');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('merger: removeJsonManagedEntries filters matching hooks', () => {
  const dir = tempDir();
  try {
    const jsonPath = path.join(dir, 'settings.json');
    fs.writeFileSync(jsonPath, JSON.stringify({
      hooks: [
        { event: 'SessionStart', command: 'relay-cmd', managedBy: 'agent-relay' },
        { event: 'SessionEnd', command: 'user-cmd' }
      ]
    }), 'utf8');

    const merger = new ConfigMerger();
    const changed = merger.removeJsonManagedEntries(jsonPath, (item) => item.managedBy === 'agent-relay');
    assert.strictEqual(changed, true);

    const content = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    assert.strictEqual(content.hooks.length, 1);
    assert.strictEqual(content.hooks[0].command, 'user-cmd');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('merger: removeJsonManagedEntries returns false for non-existent file', () => {
  const merger = new ConfigMerger();
  const result = merger.removeJsonManagedEntries(
    path.join(os.tmpdir(), 'nonexistent-file-67890.json'),
    () => true
  );
  assert.strictEqual(result, false);
});

test('merger: removeMarkdownBlock returns false for non-existent file', () => {
  const merger = new ConfigMerger();
  const result = merger.removeMarkdownBlock(path.join(os.tmpdir(), 'nonexistent-file-67890.md'));
  assert.strictEqual(result, false);
});

test('merger: mergeMarkdownBlock is idempotent (replaces existing block)', () => {
  const dir = tempDir();
  try {
    const mdPath = path.join(dir, 'CLAUDE.md');
    fs.writeFileSync(mdPath, '# Config\n\nUser stuff.\n', 'utf8');

    const merger = new ConfigMerger();
    merger.mergeMarkdownBlock(mdPath, 'Version 1 content.');
    merger.mergeMarkdownBlock(mdPath, 'Version 2 content.');

    const content = fs.readFileSync(mdPath, 'utf8');
    assert.ok(!content.includes('Version 1 content.'));
    assert.ok(content.includes('Version 2 content.'));
    // Only one start tag
    const startCount = content.split('<!-- AGENT_RELAY_START -->').length - 1;
    assert.strictEqual(startCount, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('merger: mergeMarkdownBlock with custom blockTag', () => {
  const dir = tempDir();
  try {
    const mdPath = path.join(dir, 'CUSTOM.md');
    fs.writeFileSync(mdPath, 'Existing.\n', 'utf8');

    const merger = new ConfigMerger();
    merger.mergeMarkdownBlock(mdPath, 'Custom block.', 'MY_CUSTOM_TAG');

    const content = fs.readFileSync(mdPath, 'utf8');
    assert.ok(content.includes('<!-- MY_CUSTOM_TAG_START -->'));
    assert.ok(content.includes('<!-- MY_CUSTOM_TAG_END -->'));
    assert.ok(content.includes('Custom block.'));

    const removed = merger.removeMarkdownBlock(mdPath, 'MY_CUSTOM_TAG');
    assert.strictEqual(removed, true);

    const afterRemove = fs.readFileSync(mdPath, 'utf8');
    assert.ok(!afterRemove.includes('MY_CUSTOM_TAG'));
    assert.ok(afterRemove.includes('Existing.'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
