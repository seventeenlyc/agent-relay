// tests/run/edge-boundaries.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RelayDatabase } from '../../packages/controller/src/run/db.ts';
import { RunStore } from '../../packages/controller/src/run/store.ts';
import { RunController, type StartRunConfig } from '../../packages/controller/src/run/engine.ts';
import { ControlIntentLog } from '../../packages/controller/src/run/intent.ts';
import { ScriptedAdapter } from '../helpers/scripted-adapter.ts';
import { TwoPhaseHandshakeCoordinator } from '../../packages/adapters/claude/src/handshake.ts';
import { HandoffStateMachine } from '../../packages/controller/src/handoff/state-machine.ts';
import { WorkspaceLeaseManager } from '../../packages/controller/src/handoff/lease.ts';
import { normalizeWorkspaceKey } from '../../packages/controller/src/workspace/key.ts';

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('boundaries: unit failure keeps task in_progress and captures failure signature (V07)', async () => {
  const dataDir = makeTempDir('agent-relay-v07-');
  const dbPath = path.join(dataDir, 'relay.db');
  const db = new RelayDatabase({ dbPath });
  const store = new RunStore(db);
  const adapter = new ScriptedAdapter({
    unitReplies: {
      u1: {
        status: 'failed',
        summary: 'Compilation error: cannot find module X'
      }
    }
  });

  const controller = new RunController({
    store,
    dataDir,
    adapter,
    adapterName: 'claude',
    createCoordinator: (deps) =>
      new TwoPhaseHandshakeCoordinator(
        deps.stateMachine as HandoffStateMachine,
        deps.leaseManager as unknown as WorkspaceLeaseManager,
        deps.workspaceKey
      )
  });

  const config: StartRunConfig = {
    runId: 'run-v07',
    goal: 'Test partial task failure retention',
    workspacePath: dataDir,
    tasks: [{ taskId: 'u1', requirementId: 'req-root', title: 'Compile Code', dependencies: [] }],
    model: { provider: 'anthropic', model: 'claude-3-7-sonnet' },
    initialUserMessage: 'Compile the module.'
  };

  controller.startRun(config);

  const outcome = await controller.tick();
  assert.strictEqual(outcome.kind, 'unit_executed');
  assert.strictEqual((outcome as any).status, 'failed');

  // Verify task status is strictly in_progress, NOT completed
  const run = store.getRun('run-v07')!;
  assert.strictEqual(run.state, 'RUNNING');
  const latestSnapshot = store.getLatestTaskSnapshot('run-v07');
  assert.ok(latestSnapshot);
  const tasks = JSON.parse(latestSnapshot!.snapshotJson);
  assert.strictEqual(tasks.length, 1);
  assert.strictEqual(tasks[0].taskId, 'u1');
  assert.strictEqual(tasks[0].status, 'in_progress', 'failed task must remain in_progress, never marked completed');

  // Verify unit_failed event recorded with signature
  const events = store.listEvents('run-v07');
  const failEvent = events.find((e) => e.type === 'unit_failed');
  assert.ok(failEvent, 'must record unit_failed event');
  assert.strictEqual((failEvent!.payload as any).status, 'failed');
  assert.match((failEvent!.payload as any).summary, /cannot find module X/);

  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('boundaries: late stop intent after owner CAS invalidates execution token and halts in CANCELLED (V33)', async () => {
  const dataDir = makeTempDir('agent-relay-v33-');
  const dbPath = path.join(dataDir, 'relay.db');
  const db = new RelayDatabase({ dbPath });
  const store = new RunStore(db);
  const adapter = new ScriptedAdapter();

  let stopInjected = false;
  const controller = new RunController({
    store,
    dataDir,
    adapter,
    adapterName: 'claude',
    createCoordinator: (deps) =>
      new TwoPhaseHandshakeCoordinator(
        deps.stateMachine as HandoffStateMachine,
        deps.leaseManager as unknown as WorkspaceLeaseManager,
        deps.workspaceKey
      ),
    faultHook: async (point, ctx) => {
      if (point === 'after_owner_cas') {
        // Inject stop_now right after CAS committed but before token dispatch
        new ControlIntentLog(store).append('run-v33', 'stop_now');
        stopInjected = true;
      }
    }
  });

  const config: StartRunConfig = {
    runId: 'run-v33',
    goal: 'Test late stop after owner CAS',
    workspacePath: dataDir,
    tasks: [
      { taskId: 'u1', requirementId: 'req-root', title: 'Task One', dependencies: [] },
      { taskId: 'u2', requirementId: 'req-root', title: 'Task Two', dependencies: ['u1'] }
    ],
    model: { provider: 'anthropic', model: 'claude-3-7-sonnet' },
    initialUserMessage: 'Execute pipeline.'
  };

  controller.startRun(config);

  // Tick 1: execute u1
  const t1 = await controller.tick();
  assert.strictEqual(t1.kind, 'unit_executed');

  // Tick 2: handoff with stop_now injected at after_owner_cas
  const t2 = await controller.tick();
  assert.strictEqual(stopInjected, true, 'faultHook should have injected stop_now');
  assert.strictEqual(t2.kind, 'stopped');

  const run = store.getRun('run-v33')!;
  assert.strictEqual(run.state, 'CANCELLED');

  // Verify new session was interrupted and not allowed to execute
  assert.ok(adapter.interrupted.includes('run-v33-s2'), 'new session must be interrupted when late stop arrived');

  // Core invariant check: lease epoch MUST be incremented to 3 to invalidate the token issued with epoch 2!
  const wsKey = normalizeWorkspaceKey(dataDir);
  const lease = store.getLeaseRow(wsKey);
  assert.ok(lease);
  assert.strictEqual(lease!.epoch, 3, 'lease epoch must be incremented to invalidate the execution token');

  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('boundaries: unknown outcome / timeout in external action halts at RECOVERY_REQUIRED without faking completion (V26)', async () => {
  const dataDir = makeTempDir('agent-relay-v26-');
  const dbPath = path.join(dataDir, 'relay.db');
  const db = new RelayDatabase({ dbPath });
  const store = new RunStore(db);
  const adapter = new ScriptedAdapter({
    unitReplies: {
      u1: {
        status: 'unknown_outcome' as any,
        summary: 'External deploy timed out, outcome unknown'
      }
    }
  });

  const controller = new RunController({
    store,
    dataDir,
    adapter,
    adapterName: 'claude',
    createCoordinator: (deps) =>
      new TwoPhaseHandshakeCoordinator(
        deps.stateMachine as HandoffStateMachine,
        deps.leaseManager as unknown as WorkspaceLeaseManager,
        deps.workspaceKey
      )
  });

  const config: StartRunConfig = {
    runId: 'run-v26',
    goal: 'Test unknown external action outcome',
    workspacePath: dataDir,
    tasks: [{ taskId: 'u1', requirementId: 'req-root', title: 'Deploy Service', dependencies: [] }],
    model: { provider: 'anthropic', model: 'claude-3-7-sonnet' },
    initialUserMessage: 'Deploy service to remote.'
  };

  controller.startRun(config);

  const outcome = await controller.tick();
  assert.strictEqual(outcome.kind, 'recovery_required');
  assert.strictEqual((outcome as any).reason, 'external_action_outcome_unknown');

  const run = store.getRun('run-v26')!;
  assert.strictEqual(run.state, 'RECOVERY_REQUIRED');
  assert.strictEqual(run.blockedReason, 'external_action_outcome_unknown');

  // Task MUST NOT be marked completed
  const snapshot = store.getLatestTaskSnapshot('run-v26');
  const tasks = JSON.parse(snapshot!.snapshotJson);
  assert.notStrictEqual(tasks[0].status, 'completed', 'task must never be marked completed when outcome is unknown');

  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
