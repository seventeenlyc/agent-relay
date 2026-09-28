import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TwoPhaseHandshakeCoordinator } from '../../packages/adapters/claude/src/handshake.ts';
import { executeStart } from '../../packages/cli/src/start-run.ts';
import { runCli } from '../../packages/cli/src/cli.ts';
import { createBuiltInRuntime } from '../../packages/cli/src/runtime.ts';
import { CodexProcessRunner } from '../../packages/adapters/codex/src/runner.ts';
import type { RelayRuntime } from '../../packages/cli/src/runtime.ts';
import type { StartArgs } from '../../packages/cli/src/start.ts';
import { ScriptedAdapter } from '../helpers/scripted-adapter.ts';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-relay-start-'));
}

test('executeStart runs one foreground run and shuts down the runtime', async () => {
  const root = makeTempDir();
  const workspace = path.join(root, 'workspace');
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(workspace);
  const adapter = new ScriptedAdapter();
  let shutdown = false;
  const runtime: RelayRuntime = {
    adapter,
    adapterName: 'codex',
    createCoordinator: (deps) => new TwoPhaseHandshakeCoordinator(deps.stateMachine, deps.leaseManager, deps.workspaceKey),
    shutdown: async () => {
      shutdown = true;
    }
  };
  const output: string[] = [];
  const args: StartArgs = {
    target: 'codex',
    workspace,
    goal: 'finish the root task',
    prompt: 'please execute the goal',
    maxTicks: 10
  };

  const code = await executeStart(args, {
    dataDir,
    io: { out: (line) => output.push(line), err: (line) => output.push(`ERR ${line}`) },
    createRuntime: async () => runtime,
    runId: 'start-test-run'
  });

  assert.equal(code, 0);
  assert.equal(shutdown, true);
  assert.match(output.join('\n'), /run started: start-test-run \(codex\)/);
  assert.match(output.join('\n'), /run start-test-run finished: COMPLETED/);
  assert.ok(fs.existsSync(path.join(dataDir, 'relay.db')));
});

test('executeStart returns an error and still shuts down when runtime execution fails', async () => {
  const root = makeTempDir();
  const adapter = new ScriptedAdapter();
  adapter.createFresh = () => {
    throw new Error('adapter execution failed');
  };
  let shutdown = false;
  const runtime: RelayRuntime = {
    adapter,
    adapterName: 'codex',
    createCoordinator: (deps) => new TwoPhaseHandshakeCoordinator(deps.stateMachine, deps.leaseManager, deps.workspaceKey),
    shutdown: async () => {
      shutdown = true;
    }
  };
  const errors: string[] = [];
  const args: StartArgs = {
    target: 'codex',
    workspace: path.join(root, 'missing-workspace'),
    goal: 'fail safely',
    prompt: 'run',
    maxTicks: 1
  };

  const code = await executeStart(args, {
    dataDir: path.join(root, 'data'),
    io: { out: () => undefined, err: (line) => errors.push(line) },
    createRuntime: async () => runtime,
    runId: 'start-error-run'
  });

  assert.equal(code, 1);
  assert.equal(shutdown, true);
  assert.match(errors.join('\n'), /error:/);
});

test('runCli dispatches the start command to the foreground executor', async () => {
  const root = makeTempDir();
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  const adapter = new ScriptedAdapter();
  const output: string[] = [];
  const code = await runCli(
    [
      'start',
      '--target=codex',
      `--workspace=${workspace}`,
      '--goal=CLI start',
      '--prompt=execute',
      `--data-dir=${path.join(root, 'data')}`
    ],
    {
      io: { out: (line) => output.push(line), err: (line) => output.push(`ERR ${line}`) },
      startRuntimeFactory: async () => ({
        adapter,
        adapterName: 'codex',
        createCoordinator: (deps) => new TwoPhaseHandshakeCoordinator(deps.stateMachine, deps.leaseManager, deps.workspaceKey),
        shutdown: async () => undefined
      })
    }
  );

  assert.equal(code, 0);
  assert.match(output.join('\n'), /run started:/);
  assert.match(output.join('\n'), /finished: COMPLETED/);
});

test('executeStart drives a Codex runtime through the existing mock app server', async () => {
  const root = makeTempDir();
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  const output: string[] = [];
  const mockServer = fileURLToPath(new URL('../fixtures/mock-codex-app-server.mjs', import.meta.url));
  const code = await executeStart(
    {
      target: 'codex',
      workspace,
      goal: 'Codex mock start',
      prompt: 'execute through Codex',
      maxTicks: 10
    },
    {
      dataDir: path.join(root, 'data'),
      io: { out: (line) => output.push(line), err: (line) => output.push(`ERR ${line}`) },
      createRuntime: async (_target, options) =>
        createBuiltInRuntime('codex', {
          cwd: options.cwd,
          codexRunner: new CodexProcessRunner({ binPath: process.execPath, extraArgsPrefix: [mockServer], cwd: options.cwd })
        })
    }
  );

  assert.equal(code, 0, output.join('\n'));
  assert.match(output.join('\n'), /finished: COMPLETED/);
});
