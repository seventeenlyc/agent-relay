// tests/workspace/key.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeWorkspaceKey } from '../../packages/controller/src/workspace/key.ts';

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('key: relative and absolute forms of the same directory resolve identically', () => {
  const dir = makeTempDir('agent-relay-key-');
  const absolute = normalizeWorkspaceKey(dir);
  const relative = normalizeWorkspaceKey(path.relative(process.cwd(), dir));
  assert.strictEqual(relative, absolute);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('key: a junction and its target resolve to the same workspace key (V34)', () => {
  const target = makeTempDir('agent-relay-target-');
  const linkParent = makeTempDir('agent-relay-link-');
  const link = path.join(linkParent, 'linked-workspace');

  try {
    fs.symlinkSync(target, link, 'junction');
  } catch (err) {
    // Junction creation requires no privileges on Windows; on other platforms
    // fall back to a directory symlink and skip if the platform refuses both.
    try {
      fs.symlinkSync(target, link, 'dir');
    } catch {
      fs.rmSync(target, { recursive: true, force: true });
      fs.rmSync(linkParent, { recursive: true, force: true });
      throw new Error(`cannot create link for V34 test: ${(err as Error).message}`);
    }
  }

  assert.strictEqual(
    normalizeWorkspaceKey(link),
    normalizeWorkspaceKey(target),
    'a junction and its target must share one workspace key'
  );

  fs.rmSync(linkParent, { recursive: true, force: true });
  fs.rmSync(target, { recursive: true, force: true });
});

test('key: case-variant paths resolve identically on Windows (V34)', () => {
  if (process.platform !== 'win32') {
    // Windows 是本项目第一验证环境；大小写不敏感语义仅在 Windows 上成立。
    return;
  }
  const dir = makeTempDir('agent-relay-case-');
  const upper = dir.toUpperCase();
  const lower = dir.toLowerCase();
  assert.notStrictEqual(upper, lower, 'the test path must actually differ in case');
  assert.strictEqual(normalizeWorkspaceKey(upper), normalizeWorkspaceKey(lower));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('key: independent directories never collide, including sibling worktrees', () => {
  const a = makeTempDir('agent-relay-wt-a-');
  const b = makeTempDir('agent-relay-wt-b-');
  assert.notStrictEqual(normalizeWorkspaceKey(a), normalizeWorkspaceKey(b));
  fs.rmSync(a, { recursive: true, force: true });
  fs.rmSync(b, { recursive: true, force: true });
});

test('key: a non-existent path still normalizes deterministically and does not throw', () => {
  const ghost = path.join(os.tmpdir(), 'agent-relay-nonexistent-xyz', 'nested');
  const first = normalizeWorkspaceKey(ghost);
  const second = normalizeWorkspaceKey(ghost);
  assert.strictEqual(first, second);
  assert.ok(first.length > 0);
});
