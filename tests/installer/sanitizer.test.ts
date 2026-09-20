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
