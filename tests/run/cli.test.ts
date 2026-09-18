// tests/run/cli.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { RelayDatabase } from '../../packages/controller/src/run/db.ts';
import { RunStore } from '../../packages/controller/src/run/store.ts';
import { SessionChainLedger } from '../../packages/controller/src/run/chain.ts';
import { runCli, type CliIo } from '../../packages/cli/src/cli.ts';

const BIN_PATH = fileURLToPath(new URL('../../bin/agent-relay.mjs', import.meta.url));

function capture(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      out: (line: string) => out.push(line),
      err: (line: string) => err.push(line)
    },
    out,
    err
  };
}

function seed(dataDir: string, runId = 'run-cli-1', state: 'RUNNING' | 'PAUSED' = 'RUNNING') {
  const db = new RelayDatabase({ dbPath: path.join(dataDir, 'relay.db') });
  const store = new RunStore(db);
  store.insertRun({
    runId,
    workspaceKey: 'ws-cli',
    workspacePath: 'C:/tmp/ws-cli',
    goal: 'Ship the CLI entrance',
    model: { provider: 'anthropic', model: 'claude-3-7-sonnet', effort: 'high' },
    state,
    unitCount: 2
  });
  store.appendTaskSnapshot(
    runId,
    1,
    JSON.stringify([
      {
        taskId: 'u1',
        requirementId: 'req-root',
        title: 'Unit One',
        description: '',
        dependencies: [],
        status: 'completed',
        allowedPaths: [],
        expectedArtifacts: [],
        testEvidenceHash: 'ev-u1',
        completedAt: 1
      },
      {
        taskId: 'u2',
        requirementId: 'req-root',
        title: 'Unit Two',
        description: '',
        dependencies: ['u1'],
        status: 'pending',
        allowedPaths: [],
        expectedArtifacts: []
      }
    ]),
    'snap-1'
  );
  const chain = new SessionChainLedger(store);
  chain.append({
    runId,
    nextSessionId: 'worker-A',
    adapter: 'claude',
    provider: 'anthropic',
    model: 'claude-3-7-sonnet',
    effort: 'high',
    epoch: 1,
    reason: 'run_started'
  });
  return { db, store };
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-relay-cli-'));
}

test('cli: status prints the status card with exit code 0', async () => {
  const dataDir = tempDir();
  const { db } = seed(dataDir);
  db.close();

  const { io, out } = capture();
  const code = await runCli(['status', '--data-dir', dataDir], { io });

  assert.strictEqual(code, 0);
  const text = out.join('\n');
  assert.match(text, /^目标: Ship the CLI entrance/m);
  assert.match(text, /^进度: 1\/2 单元完成/m);
  assert.match(text, /^压缩: 未知/m);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('cli: status --json emits parseable structured output', async () => {
  const dataDir = tempDir();
  const { db } = seed(dataDir);
  db.close();

  const { io, out } = capture();
  const code = await runCli(['status', '--data-dir', dataDir, '--json'], { io });

  assert.strictEqual(code, 0);
  const parsed = JSON.parse(out.join('\n')) as Record<string, unknown>;
  assert.strictEqual(parsed.runId, 'run-cli-1');
  assert.strictEqual(parsed.state, 'RUNNING');
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('cli: chain lists session links in order', async () => {
  const dataDir = tempDir();
  const { db, store } = seed(dataDir);
  new SessionChainLedger(store).append({
    runId: 'run-cli-1',
    prevSessionId: 'worker-A',
    nextSessionId: 'worker-B',
    adapter: 'claude',
    provider: 'anthropic',
    model: 'claude-3-7-sonnet',
    epoch: 2,
    handoffId: 'h-1',
    reason: 'unit_completed'
  });
  db.close();

  const { io, out } = capture();
  const code = await runCli(['chain', '--data-dir', dataDir], { io });

  assert.strictEqual(code, 0);
  const text = out.join('\n');
  assert.match(text, /worker-A/);
  assert.match(text, /worker-B/);
  assert.match(text, /unit_completed/);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('cli: control actions persist the intent before printing confirmation', async () => {
  const dataDir = tempDir();
  const { db, store } = seed(dataDir);
  db.close();

  const paused = capture();
  assert.strictEqual(await runCli(['pause', '--data-dir', dataDir], { io: paused.io }), 0);
  assert.match(paused.out.join('\n'), /watermark 1/);

  const inspection = new RelayDatabase({ dbPath: path.join(dataDir, 'relay.db') });
  const inspectionStore = new RunStore(inspection);
  const pending = inspectionStore.listPendingIntents('run-cli-1');
  assert.strictEqual(pending.length, 1, 'the intent must already be durable when confirmation is printed');
  assert.strictEqual(pending[0].kind, 'pause_next_node');
  assert.strictEqual(pending[0].watermark, 1);

  const stopped = capture();
  assert.strictEqual(await runCli(['stop', '--data-dir', dataDir], { io: stopped.io }), 0);
  assert.strictEqual(inspectionStore.listPendingIntents('run-cli-1').length, 2);
  assert.strictEqual(inspectionStore.getLatestIntentWatermark('run-cli-1'), 2);

  inspection.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('cli: run selection fails with exit code 2 when no run or several runs exist', async () => {
  const empty = tempDir();
  const missing = capture();
  assert.strictEqual(await runCli(['status', '--data-dir', empty], { io: missing.io }), 2);
  assert.match(missing.err.join('\n'), /no run/i);
  fs.rmSync(empty, { recursive: true, force: true });

  const ambiguous = tempDir();
  const { db } = seed(ambiguous, 'run-cli-1');
  const store = new RunStore(db);
  store.insertRun({
    runId: 'run-cli-2',
    workspaceKey: 'ws-cli-2',
    workspacePath: 'C:/tmp/ws-cli-2',
    goal: 'Second run',
    model: { provider: 'anthropic', model: 'claude-3-7-sonnet' },
    state: 'RUNNING',
    unitCount: 1
  });
  db.close();

  const several = capture();
  assert.strictEqual(await runCli(['status', '--data-dir', ambiguous], { io: several.io }), 2);
  assert.match(several.err.join('\n'), /--run/);

  // --run disambiguates
  const explicit = capture();
  assert.strictEqual(
    await runCli(['status', '--data-dir', ambiguous, '--run', 'run-cli-2'], { io: explicit.io }),
    0
  );
  assert.match(explicit.out.join('\n'), /Second run/);
  fs.rmSync(ambiguous, { recursive: true, force: true });
});

test('cli: unknown commands and bad usage exit with code 1', async () => {
  const dataDir = tempDir();
  const { db } = seed(dataDir);
  db.close();

  const noCommand = capture();
  assert.strictEqual(await runCli([], { io: noCommand.io }), 1);
  assert.match(noCommand.err.join('\n'), /usage/i);

  const unknown = capture();
  assert.strictEqual(await runCli(['frobnicate', '--data-dir', dataDir], { io: unknown.io }), 1);
  assert.match(unknown.err.join('\n'), /unknown command/i);

  const missingValue = capture();
  assert.strictEqual(await runCli(['status', '--data-dir', dataDir, '--run'], { io: missingValue.io }), 1);
  assert.match(missingValue.err.join('\n'), /--run requires a value/);

  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('cli: actions that the current state forbids exit with code 3', async () => {
  const dataDir = tempDir();
  const { db } = seed(dataDir, 'run-cli-1', 'RUNNING');
  db.close();

  const resumeRunning = capture();
  assert.strictEqual(await runCli(['resume', '--data-dir', dataDir], { io: resumeRunning.io }), 3);
  assert.match(resumeRunning.err.join('\n'), /resume/i);

  const inspection = new RelayDatabase({ dbPath: path.join(dataDir, 'relay.db') });
  new RunStore(inspection).updateRunState('run-cli-1', 'PAUSED', { pauseReason: 'test' });
  inspection.close();

  const resumePaused = capture();
  assert.strictEqual(await runCli(['resume', '--data-dir', dataDir], { io: resumePaused.io }), 0);
  assert.match(resumePaused.out.join('\n'), /resumed|resume/i);

  const completed = new RelayDatabase({ dbPath: path.join(dataDir, 'relay.db') });
  new RunStore(completed).updateRunState('run-cli-1', 'COMPLETED');
  completed.close();

  const pauseCompleted = capture();
  assert.strictEqual(await runCli(['pause', '--data-dir', dataDir], { io: pauseCompleted.io }), 3);
  assert.match(pauseCompleted.err.join('\n'), /COMPLETED/);

  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('cli: watch refreshes a bounded number of times and can be interrupted', async () => {
  const dataDir = tempDir();
  const { db } = seed(dataDir);
  db.close();

  const { io, out } = capture();
  const code = await runCli(['watch', '--data-dir', dataDir, '--interval', '1', '--iterations', '2'], { io });

  assert.strictEqual(code, 0);
  const refreshes = out.filter((line) => line.startsWith('目标:')).length;
  assert.strictEqual(refreshes, 2, 'watch must refresh exactly the requested number of times');
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('cli: the real bin shim writes a durable intent visible to the supervisor process (V22)', () => {
  const dataDir = tempDir();
  const { db, store } = seed(dataDir);
  db.close();

  // A separate OS process performs the control action
  const result = spawnSync(process.execPath, [BIN_PATH, 'stop', '--data-dir', dataDir, '--run', 'run-cli-1'], {
    encoding: 'utf8',
    env: { ...process.env }
  });
  assert.strictEqual(result.status, 0, `bin shim failed: ${result.stderr}`);
  assert.match(result.stdout, /watermark 1/);

  // The supervisor-side connection observes it without sharing memory
  const supervisorDb = new RelayDatabase({ dbPath: path.join(dataDir, 'relay.db') });
  const supervisorStore = new RunStore(supervisorDb);
  const pending = supervisorStore.listPendingIntents('run-cli-1');
  assert.strictEqual(pending.length, 1);
  assert.strictEqual(pending[0].kind, 'stop_now');
  assert.strictEqual(pending[0].watermark, 1);
  assert.strictEqual(supervisorStore.getRun('run-cli-1')?.state, 'RUNNING', 'the shim must not drive the run itself');

  supervisorDb.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
