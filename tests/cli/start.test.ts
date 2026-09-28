import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildStartTasks, parseStartArgs } from '../../packages/cli/src/start.ts';

test('start parser: requires target, workspace, goal, and prompt', () => {
  assert.throws(
    () => parseStartArgs(['--workspace=G:/workspace', '--goal=Ship it', '--prompt=Go']),
    /--target is required/
  );
  assert.throws(
    () => parseStartArgs(['--target=codex', '--goal=Ship it', '--prompt=Go']),
    /--workspace is required/
  );
  assert.throws(
    () => parseStartArgs(['--target=codex', '--workspace=G:/workspace', '--prompt=Go']),
    /--goal is required/
  );
  assert.throws(
    () => parseStartArgs(['--target=codex', '--workspace=G:/workspace', '--goal=Ship it']),
    /--prompt is required/
  );
});

test('start parser: accepts the three targets and rejects all', () => {
  for (const target of ['codex', 'claude', 'dsh']) {
    const parsed = parseStartArgs([
      `--target=${target}`,
      '--workspace=G:/workspace',
      '--goal=Ship it',
      '--prompt=Go'
    ]);
    assert.strictEqual(parsed.target, target);
  }

  assert.throws(
    () => parseStartArgs(['--target=all', '--workspace=G:/workspace', '--goal=Ship it', '--prompt=Go']),
    /--target must be one of codex, claude, dsh/
  );
});

test('start parser: applies defaults and creates one main task', () => {
  const parsed = parseStartArgs([
    '--target=codex',
    '--workspace=G:/workspace',
    '--goal=Ship it',
    '--prompt=Go'
  ]);

  assert.strictEqual(parsed.runId, undefined);
  assert.strictEqual(parsed.maxTicks, 100);
  assert.deepStrictEqual(buildStartTasks(parsed), [
    {
      taskId: 'main',
      requirementId: 'req-root',
      title: 'Ship it',
      description: 'Ship it'
    }
  ]);
});

test('start parser: loads and validates a task file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-relay-start-'));
  const file = path.join(dir, 'tasks.json');
  fs.writeFileSync(
    file,
    JSON.stringify([
      { taskId: 'u1', requirementId: 'req-root', title: 'First' },
      { taskId: 'u2', requirementId: 'req-root', title: 'Second', dependencies: ['u1'] }
    ])
  );

  try {
    const parsed = parseStartArgs([
      '--target=dsh',
      '--workspace=G:/workspace',
      '--goal=Ship it',
      '--prompt=Go',
      `--tasks-file=${file}`
    ]);
    assert.deepStrictEqual(buildStartTasks(parsed), [
      { taskId: 'u1', requirementId: 'req-root', title: 'First' },
      { taskId: 'u2', requirementId: 'req-root', title: 'Second', dependencies: ['u1'] }
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
