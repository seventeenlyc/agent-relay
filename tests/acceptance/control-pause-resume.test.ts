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
import { ControlIntentLog } from '../../packages/controller/src/run/intent.ts';
import { ScriptedAdapter } from '../helpers/scripted-adapter.ts';

const FOUR_UNITS = [
  { taskId: 'u1', requirementId: 'req-root', title: 'Unit 1: Data Ingestion', dependencies: [] as string[] },
  { taskId: 'u2', requirementId: 'req-root', title: 'Unit 2: Transform', dependencies: ['u1'] },
  { taskId: 'u3', requirementId: 'req-root', title: 'Unit 3: Validate', dependencies: ['u2'] },
  { taskId: 'u4', requirementId: 'req-root', title: 'Unit 4: Package', dependencies: ['u3'] }
];

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('acceptance: Control Plane - pause next node at handoff boundary and resume safely (V20, V21, R7)', async () => {
  const dataDir = tempDir('control-pause-');
  const db = new RelayDatabase({ dbPath: path.join(dataDir, 'relay.db') });
  const store = new RunStore(db);
  const adapter = new ScriptedAdapter();
  const notifier = new RecordingNotifier();
  const intentLog = new ControlIntentLog(store);

  try {
    const controller = new RunController({
      store,
      dataDir,
      adapter,
      adapterName: 'claude',
      notifier,
      createCoordinator: (deps) =>
        new TwoPhaseHandshakeCoordinator(
          deps.stateMachine as any,
          deps.leaseManager as any,
          deps.workspaceKey
        )
    });

    const runId = 'control-pause-demo';
    const config: StartRunConfig = {
      runId,
      goal: 'Demonstrate pause and resume across units',
      workspacePath: dataDir,
      tasks: FOUR_UNITS,
      model: { provider: 'anthropic', model: 'claude-3-7-sonnet', effort: 'high' },
      initialUserMessage: 'Execute with controllable pause.'
    };

    controller.startRun(config);

    // 1. Tick 1: u1 executes in session 1
    const o1 = await controller.tick();
    assert.strictEqual(o1.kind, 'unit_executed');
    assert.strictEqual((o1 as any).taskId, 'u1');

    // 2. User writes "pause_next_node" intent BEFORE handoff
    const pauseIntent = intentLog.append(runId, 'pause_next_node');
    assert.ok(pauseIntent.intentId);
    assert.strictEqual(intentLog.resolve(runId)?.kind, 'pause_next_node');

    // 3. Tick 2: controller encounters pause intent at handoff boundary -> PAUSED state
    const o2 = await controller.tick();
    assert.strictEqual(o2.kind, 'paused');

    let run = store.getRun(runId)!;
    assert.strictEqual(run.state, 'PAUSED');
    assert.strictEqual(run.handoffCount, 0); // Did NOT create session 2 prematurely (V20)

    // 4. User issues "resume" intent
    intentLog.append(runId, 'resume');

    // 5. Resume and execute remaining ticks until completion
    const remainingOutcomes = await controller.executeUntilSettled(100);
    assert.ok(remainingOutcomes.some((o) => o.kind === 'completed'));

    run = store.getRun(runId)!;
    assert.strictEqual(run.state, 'COMPLETED');
    assert.strictEqual(run.handoffCount, 3);
    assert.strictEqual(store.listChain(runId).length, 4);
  } finally {
    db.close();
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // Windows cleanup
    }
  }
});
