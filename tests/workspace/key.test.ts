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

function createJunctionOrSkip(linkParent: string, link: string, target: string): void {
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
}

test('key: relative and absolute forms of the same directory resolve identically', () => {
  const dir = makeTempDir('agent-relay-key-');
  const originalCwd = process.cwd();
  try {
    // cwd 必须在 G: 盘之外也成立：只有真的把相对路径交给 normalizeWorkspaceKey，
    // 这条断言才在验证 path.resolve
    process.chdir(path.dirname(dir));
    const relativeInput = path.basename(dir);
    assert.ok(!path.isAbsolute(relativeInput), 'the test must exercise a relative path, not an absolute one');
    const absolute = normalizeWorkspaceKey(dir);
    const relative = normalizeWorkspaceKey(relativeInput);
    assert.strictEqual(relative, absolute);
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('key: a junction and its target resolve to the same workspace key (V34)', () => {
  const target = makeTempDir('agent-relay-target-');
  const linkParent = makeTempDir('agent-relay-link-');
  const link = path.join(linkParent, 'linked-workspace');

  createJunctionOrSkip(linkParent, link, target);

  assert.strictEqual(
    normalizeWorkspaceKey(link),
    normalizeWorkspaceKey(target),
    'a junction and its target must share one workspace key'
  );

  fs.rmSync(linkParent, { recursive: true, force: true });
  fs.rmSync(target, { recursive: true, force: true });
});

test('key: a junction prefix resolves to the target even when the leaf does not exist yet (V34)', () => {
  const target = makeTempDir('agent-relay-target-');
  const linkParent = makeTempDir('agent-relay-link-');
  const link = path.join(linkParent, 'linked-workspace');

  createJunctionOrSkip(linkParent, link, target);

  assert.strictEqual(
    normalizeWorkspaceKey(path.join(link, 'not-yet-created')),
    normalizeWorkspaceKey(path.join(target, 'not-yet-created')),
    'the longest existing ancestor must be resolved, with the unresolved tail re-appended'
  );

  fs.rmSync(linkParent, { recursive: true, force: true });
  fs.rmSync(target, { recursive: true, force: true });
});

test('key: a junction prefix resolves through a two-segment unresolved tail (V34)', () => {
  const target = makeTempDir('agent-relay-target-');
  const linkParent = makeTempDir('agent-relay-link-');
  const link = path.join(linkParent, 'linked-workspace');

  createJunctionOrSkip(linkParent, link, target);

  const viaLink = path.join(link, 'nested', 'deeper');
  const viaTarget = path.join(target, 'nested', 'deeper');
  assert.strictEqual(normalizeWorkspaceKey(viaLink), normalizeWorkspaceKey(viaTarget));

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

test('key: case-variant non-existent paths resolve identically on Windows (V34)', () => {
  if (process.platform !== 'win32') {
    // 同上：大小写不敏感语义仅在 Windows 上成立。
    return;
  }
  // 尾部尚未创建，realpath 只规范化已存在的祖先，尾段的大小写只能靠大小写折叠拉平
  const ghost = path.join(os.tmpdir(), 'agent-relay-ghost-case-xyz', 'nested');
  const upper = ghost.toUpperCase();
  const lower = ghost.toLowerCase();
  assert.notStrictEqual(upper, lower, 'the test path must actually differ in case');
  assert.strictEqual(normalizeWorkspaceKey(upper), normalizeWorkspaceKey(lower));
});

test('key: two independent directories get different keys', () => {
  const a = makeTempDir('agent-relay-wt-a-');
  const b = makeTempDir('agent-relay-wt-b-');
  assert.notStrictEqual(normalizeWorkspaceKey(a), normalizeWorkspaceKey(b));
  fs.rmSync(a, { recursive: true, force: true });
  fs.rmSync(b, { recursive: true, force: true });
});

test('key: a non-existent path normalizes deterministically to a non-empty key without throwing', () => {
  const ghost = path.join(os.tmpdir(), 'agent-relay-nonexistent-xyz', 'nested');
  const first = normalizeWorkspaceKey(ghost);
  const second = normalizeWorkspaceKey(ghost);
  assert.strictEqual(first, second);
  assert.ok(first.length > 0);
});
