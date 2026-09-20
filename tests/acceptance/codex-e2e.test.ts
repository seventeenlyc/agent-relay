import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RelayDatabase } from '../../packages/controller/src/run/db.ts';
import { RunStore } from '../../packages/controller/src/run/store.ts';
import { RunController, type StartRunConfig } from '../../packages/controller/src/run/engine.ts';
import { RecordingNotifier } from '../../packages/controller/src/run/notifier.ts';
import { TwoPhaseHandshakeCoordinator } from '../../packages/adapters/claude/src/handshake.ts';
import { ScriptedAdapter } from '../helpers/scripted-adapter.ts';

const FOUR_UNITS = [
  { taskId: 'u1', requirementId: 'req-root', title: 'Data Schema Setup', dependencies: [] as string[] },
  { taskId: 'u2', requirementId: 'req-root', title: 'Vector Index Builder', dependencies: ['u1'] },
  { taskId: 'u3', requirementId: 'req-root', title: 'Query Engine Benchmark', dependencies: ['u2'] },
  { taskId: 'u4', requirementId: 'req-root', title: 'Codex AGENTS Protocol Wrap', dependencies: ['u3'] }
];

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('acceptance: Codex CLI - four units complete through three automatic handoffs (V32, R4, R5, R6, R8)', async () => {
  const dataDir = tempDir('codex-e2e-');
  const db = new RelayDatabase({ dbPath: path.join(dataDir, 'relay.db') });
  const store = new RunStore(db);
  const adapter = new ScriptedAdapter();
  const notifier = new RecordingNotifier();

  try {
    const controller = new RunController({
      store,
      dataDir,
      adapter,
      adapterName: 'codex',
      notifier,
      createCoordinator: (deps) =>
        new TwoPhaseHandshakeCoordinator(
          deps.stateMachine as any,
          deps.leaseManager as any,
          deps.workspaceKey
        )
    });

    const config: StartRunConfig = {
      runId: 'codex-e2e-demo',
      goal: 'Deliver search engine across 4 units in Codex CLI',
      workspacePath: dataDir,
      tasks: FOUR_UNITS,
      model: { provider: 'openai', model: 'o3-mini', effort: 'medium' },
      initialUserMessage: 'Build search engine. Strictly maintain zero schema drift.'
    };

    controller.startRun(config);
    const outcomes = await controller.executeUntilSettled(100);

    assert.strictEqual(outcomes.filter((o) => o.kind === 'unit_executed').length, 4);
    assert.strictEqual(outcomes.filter((o) => o.kind === 'handoff_performed').length, 3);
    assert.strictEqual(outcomes[outcomes.length - 1].kind, 'completed');

    const run = store.getRun('codex-e2e-demo')!;
    assert.strictEqual(run.state, 'COMPLETED');
    assert.strictEqual(run.handoffCount, 3);

    const chain = store.listChain('codex-e2e-demo');
    assert.strictEqual(chain.length, 4);
    assert.strictEqual(new Set(chain.map((l) => l.nextSessionId)).size, 4);
    assert.strictEqual(chain.every((l) => l.adapter === 'codex'), true);
    assert.strictEqual(chain.every((l) => l.model === 'o3-mini'), true);
    assert.strictEqual(chain.every((l) => l.effort === 'medium'), true);
  } finally {
    db.close();
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // Windows cleanup
    }
  }
});
