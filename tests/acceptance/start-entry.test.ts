import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCli } from '../../packages/cli/src/cli.ts';
import { TwoPhaseHandshakeCoordinator } from '../../packages/adapters/claude/src/handshake.ts';
import { ScriptedAdapter } from '../helpers/scripted-adapter.ts';

test('acceptance: start entry completes and cleans up for all three targets', async () => {
  for (const target of ['codex', 'claude', 'dsh'] as const) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `agent-relay-start-${target}-`));
    const workspace = path.join(root, 'workspace');
    const dataDir = path.join(root, 'data');
    fs.mkdirSync(workspace);
    const output: string[] = [];
    const adapter = new ScriptedAdapter();
    let shutdown = false;

    try {
      const code = await runCli(
        [
          'start',
          `--target=${target}`,
          `--workspace=${workspace}`,
          `--goal=${target} acceptance`,
          '--prompt=run the acceptance task',
          '--run=start-entry-acceptance',
          `--data-dir=${dataDir}`
        ],
        {
          io: { out: (line) => output.push(line), err: (line) => output.push(`ERR ${line}`) },
          startRuntimeFactory: async () => ({
            adapter,
            adapterName: target,
            createCoordinator: (deps) => new TwoPhaseHandshakeCoordinator(deps.stateMachine, deps.leaseManager, deps.workspaceKey),
            shutdown: async () => {
              shutdown = true;
            }
          })
        }
      );

      assert.equal(code, 0, `${target}: ${output.join('\n')}`);
      assert.match(output.join('\n'), /run started: start-entry-acceptance/);
      assert.match(output.join('\n'), /finished: COMPLETED/);
      assert.equal(shutdown, true, `${target} runtime was not shut down`);
      assert.ok(fs.existsSync(path.join(dataDir, 'relay.db')));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});
