// tests/scenarios/relay-run.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RelayDatabase } from '../../packages/controller/src/run/db.ts';
import { RunStore } from '../../packages/controller/src/run/store.ts';
import { RunController, type StartRunConfig } from '../../packages/controller/src/run/engine.ts';
import { ControlIntentLog } from '../../packages/controller/src/run/intent.ts';
import { RecordingNotifier } from '../../packages/controller/src/run/notifier.ts';
import { buildRunStatus, renderStatusCard, writeStateProjection } from '../../packages/controller/src/run/status.ts';
import { WorkspaceLeaseManager } from '../../packages/controller/src/handoff/lease.ts';
import { HandoffStateMachine } from '../../packages/controller/src/handoff/state-machine.ts';
import { DurableLeaseManager } from '../../packages/controller/src/handoff/durable-lease.ts';
import { normalizeWorkspaceKey } from '../../packages/controller/src/workspace/key.ts';
import { TwoPhaseHandshakeCoordinator } from '../../packages/adapters/claude/src/handshake.ts';
import { DshAdapter } from '../../packages/adapters/dsh/src/dsh-adapter.ts';
import { DshHandshakeCoordinator } from '../../packages/adapters/dsh/src/handshake.ts';
import { runCli, type CliIo } from '../../packages/cli/src/cli.ts';
import { ScriptedAdapter } from '../helpers/scripted-adapter.ts';

const MOCK_DSH_SERVER = fileURLToPath(new URL('../fixtures/mock-dsh-sdk-server.mjs', import.meta.url));

const FOUR_UNITS = [
  { taskId: 'u1', requirementId: 'req-root', title: 'Data Ingestion', dependencies: [] as string[] },
  { taskId: 'u2', requirementId: 'req-root', title: 'Transformer Encoder', dependencies: ['u1'] },
  { taskId: 'u3', requirementId: 'req-root', title: 'Autoregressive Decoder', dependencies: ['u2'] },
  { taskId: 'u4', requirementId: 'req-root', title: 'Loss and Optimizer', dependencies: ['u3'] }
];

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function capture(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l) => out.push(l), err: (l) => err.push(l) }, out, err };
}

function claudeCoordinator() {
  return (deps: {
    stateMachine: unknown;
    leaseManager: unknown;
    workspaceKey: string;
  }) =>
    new TwoPhaseHandshakeCoordinator(
      deps.stateMachine as HandoffStateMachine,
      deps.leaseManager as WorkspaceLeaseManager,
      deps.workspaceKey
    );
}

test('scenarios: S01 - four units complete through three automatic handoffs driven by RunController', async () => {
  const dataDir = tempDir('agent-relay-s01-');
  const db = new RelayDatabase({ dbPath: path.join(dataDir, 'relay.db') });
  const store = new RunStore(db);
  const adapter = new ScriptedAdapter();
  const notifier = new RecordingNotifier();

  const controller = new RunController({
    store,
    dataDir,
    adapter,
    adapterName: 'claude',
    notifier,
    createCoordinator: claudeCoordinator()
  });

  const config: StartRunConfig = {
    runId: 'relay-run-001',
    goal: 'Build the deep learning pipeline across four units',
    workspacePath: dataDir,
    tasks: FOUR_UNITS,
    model: { provider: 'anthropic', model: 'claude-3-7-sonnet', effort: 'high' },
    initialUserMessage: 'Build the pipeline. Do not change the public API.'
  };

  controller.startRun(config);
  const outcomes = await controller.executeUntilSettled();

  assert.strictEqual(outcomes.filter((o) => o.kind === 'unit_executed').length, 4);
  assert.strictEqual(outcomes.filter((o) => o.kind === 'handoff_performed').length, 3);
  assert.strictEqual(outcomes[outcomes.length - 1].kind, 'completed');

  const run = store.getRun('relay-run-001')!;
  assert.strictEqual(run.state, 'COMPLETED');
  assert.strictEqual(run.handoffCount, 3);
  assert.strictEqual(store.listChain('relay-run-001').length, 4);

  // R4/R5: four distinct sessions, no history reuse, model preserved on every link
  const chain = store.listChain('relay-run-001');
  assert.strictEqual(new Set(chain.map((l) => l.nextSessionId)).size, 4);
  assert.strictEqual(chain.every((l) => l.model === 'claude-3-7-sonnet'), true);
  assert.strictEqual(chain.every((l) => l.effort === 'high'), true);

  // R1: the original wording is intact and never overwritten
  const inputs = store.listInputs('relay-run-001');
  assert.strictEqual(inputs.length, 1);
  assert.strictEqual(inputs[0].record.rawContent, config.initialUserMessage);

  // R6: three consecutive handoffs with zero confirmation prompts
  assert.deepStrictEqual(notifier.notifications.map((n) => n.type), ['run_completed']);

  // R9: the entrance shows the finished run
  const view = buildRunStatus(store, 'relay-run-001');
  assert.strictEqual(view.progress.completed, 4);
  assert.strictEqual(view.progress.total, 4);
  assert.match(renderStatusCard(view), /^进度: 4\/4 单元完成/m);

  const status = capture();
  assert.strictEqual(await runCli(['status', '--data-dir', dataDir], { io: status.io }), 0);
  assert.match(status.out.join('\n'), /4\/4 单元完成/);

  const chainOutput = capture();
  assert.strictEqual(await runCli(['chain', '--data-dir', dataDir, '--json'], { io: chainOutput.io }), 0);
  assert.strictEqual((JSON.parse(chainOutput.out.join('\n')) as unknown[]).length, 4);

  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('scenarios: V22 - closing the viewer and reopening it recovers the current progress', async () => {
  const dataDir = tempDir('agent-relay-v22-');
  const db = new RelayDatabase({ dbPath: path.join(dataDir, 'relay.db') });
  const store = new RunStore(db);
  const controller = new RunController({
    store,
    dataDir,
    adapter: new ScriptedAdapter(),
    adapterName: 'claude',
    notifier: new RecordingNotifier(),
    createCoordinator: claudeCoordinator()
  });

  controller.startRun({
    runId: 'relay-run-v22',
    goal: 'Pause and resume across viewer restarts',
    workspacePath: dataDir,
    tasks: FOUR_UNITS,
    model: { provider: 'anthropic', model: 'claude-3-7-sonnet' },
    initialUserMessage: 'Ship it.'
  });

  await controller.tick(); // unit 1
  await controller.tick(); // handoff to session 2

  // First viewer opens and closes (nothing is held between invocations)
  const first = capture();
  assert.strictEqual(await runCli(['status', '--data-dir', dataDir], { io: first.io }), 0);

  // The run advanced further while no viewer existed
  await controller.tick(); // unit 2 in session 2

  // Reopening the viewer recovers the newer progress from the authoritative store
  const second = capture();
  assert.strictEqual(await runCli(['status', '--data-dir', dataDir], { io: second.io }), 0);
  assert.match(second.out.join('\n'), /^进度: 2\/4 单元完成/m);
  assert.notStrictEqual(second.out.join('\n'), first.out.join('\n'));

  // The projection file on disk is a rebuildable projection, not a second source of truth
  const projectionPath = path.join(dataDir, 'relay-run-v22', 'state.md');
  assert.strictEqual(fs.existsSync(projectionPath), true);
  const projectionBefore = fs.readFileSync(projectionPath, 'utf8');
  fs.rmSync(projectionPath);
  writeStateProjection(dataDir, buildRunStatus(store, 'relay-run-v22'));
  assert.strictEqual(fs.readFileSync(projectionPath, 'utf8'), projectionBefore);

  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('scenarios: V21 - a CLI stop is honoured and never treated as an abnormal restart', async () => {
  const dataDir = tempDir('agent-relay-v21-');
  const dbPath = path.join(dataDir, 'relay.db');
  const db = new RelayDatabase({ dbPath });
  const store = new RunStore(db);
  const adapter = new ScriptedAdapter();
  const controller = new RunController({
    store,
    dataDir,
    adapter,
    adapterName: 'claude',
    notifier: new RecordingNotifier(),
    createCoordinator: claudeCoordinator()
  });

  controller.startRun({
    runId: 'relay-run-v21',
    goal: 'Cancel mid-run',
    workspacePath: dataDir,
    tasks: FOUR_UNITS,
    model: { provider: 'anthropic', model: 'claude-3-7-sonnet' },
    initialUserMessage: 'Go.'
  });
  await controller.tick();

  // The user cancels through the entrance, not through the controller API
  const stop = capture();
  assert.strictEqual(await runCli(['stop', '--data-dir', dataDir], { io: stop.io }), 0);
  assert.strictEqual((await controller.tick()).kind, 'stopped');
  assert.strictEqual(store.getRun('relay-run-v21')?.state, 'CANCELLED');

  const sessionCount = adapter.created.length;
  const submitCount = adapter.submitted.length;
  db.close();

  // A restart must read the persisted cancel intent and stay put
  const restartedDb = new RelayDatabase({ dbPath });
  const restartedStore = new RunStore(restartedDb);
  const restartedAdapter = new ScriptedAdapter();
  const restarted = new RunController({
    store: restartedStore,
    dataDir,
    adapter: restartedAdapter,
    adapterName: 'claude',
    notifier: new RecordingNotifier(),
    createCoordinator: claudeCoordinator()
  });
  restarted.rehydrate('relay-run-v21');

  const resumeAttempt = capture();
  const exitCode = await runCli(['resume', '--data-dir', dataDir], { io: resumeAttempt.io });
  assert.strictEqual(exitCode, 3, 'a cancelled run must reject resume after restart');

  const outcome = await restarted.tick();
  assert.strictEqual(outcome.kind, 'stopped');
  assert.strictEqual(restartedAdapter.created.length, 0);
  assert.strictEqual(restartedAdapter.submitted.length, 0);

  // No new intent may be introduced by the restart itself
  assert.strictEqual(restartedStore.listPendingIntents('relay-run-v21').length, 0);
  assert.strictEqual(adapter.created.length, sessionCount);
  assert.strictEqual(adapter.submitted.length, submitCount);

  restartedDb.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('scenarios: V13 - duplicate handoffs are deduplicated by handoffId', async () => {
  const dataDir = tempDir('agent-relay-v13-');
  const db = new RelayDatabase({ dbPath: path.join(dataDir, 'relay.db') });
  const store = new RunStore(db);
  const controller = new RunController({
    store,
    dataDir,
    adapter: new ScriptedAdapter(),
    adapterName: 'claude',
    notifier: new RecordingNotifier(),
    createCoordinator: claudeCoordinator()
  });

  controller.startRun({
    runId: 'relay-run-v13',
    goal: 'Deduplicate handoffs',
    workspacePath: dataDir,
    tasks: FOUR_UNITS,
    model: { provider: 'anthropic', model: 'claude-3-7-sonnet' },
    initialUserMessage: 'Go.'
  });
  await controller.tick();

  // Replaying the same handoff id must be refused at the storage layer
  const insert = () =>
    store.insertHandoff({
      handoffId: 'h-relay-run-v13-1',
      runId: 'relay-run-v13',
      epoch: 1,
      sourceSessionId: 'relay-run-v13-s1',
      state: 'REQUESTED'
    });
  assert.strictEqual(insert(), true);
  assert.strictEqual(insert(), false, 'a replayed handoff must not create a second record');

  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('scenarios: V34 - case and link variants of one directory share a single run', async () => {
  const dataDir = tempDir('agent-relay-v34-');
  const workspaceDir = path.join(dataDir, 'workspace');
  fs.mkdirSync(workspaceDir);
  const linkParent = path.join(dataDir, 'links');
  fs.mkdirSync(linkParent);
  const linked = path.join(linkParent, 'linked-workspace');

  try {
    fs.symlinkSync(workspaceDir, linked, 'junction');
  } catch {
    fs.symlinkSync(workspaceDir, linked, 'dir');
  }

  const db = new RelayDatabase({ dbPath: path.join(dataDir, 'relay.db') });
  const store = new RunStore(db);
  const controller = new RunController({
    store,
    dataDir,
    adapter: new ScriptedAdapter(),
    adapterName: 'claude',
    notifier: new RecordingNotifier(),
    createCoordinator: claudeCoordinator()
  });

  assert.strictEqual(normalizeWorkspaceKey(workspaceDir), normalizeWorkspaceKey(linked));

  const base: StartRunConfig = {
    runId: 'relay-run-v34-a',
    goal: 'Single owner per physical workspace',
    workspacePath: workspaceDir,
    tasks: FOUR_UNITS,
    model: { provider: 'anthropic', model: 'claude-3-7-sonnet' },
    initialUserMessage: 'Go.'
  };
  const first = controller.startRun(base);
  const second = controller.startRun({ ...base, runId: 'relay-run-v34-b', workspacePath: linked });

  assert.strictEqual(second.runId, first.runId, 'both paths must resolve to the same controlled run');
  assert.strictEqual(store.listRuns().length, 1);

  // An independent worktree never collides
  const sibling = path.join(dataDir, 'sibling-worktree');
  fs.mkdirSync(sibling);
  assert.notStrictEqual(normalizeWorkspaceKey(sibling), normalizeWorkspaceKey(workspaceDir));
  const third = controller.startRun({ ...base, runId: 'relay-run-v34-c', workspacePath: sibling });
  assert.strictEqual(third.runId, 'relay-run-v34-c');
  assert.strictEqual(store.listRuns().length, 2);

  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('scenarios: V31 - two independent workspaces relay in isolation', async () => {
  const dataDir = tempDir('agent-relay-v31-');
  const workspaceA = path.join(dataDir, 'ws-a');
  const workspaceB = path.join(dataDir, 'ws-b');
  fs.mkdirSync(workspaceA);
  fs.mkdirSync(workspaceB);

  const db = new RelayDatabase({ dbPath: path.join(dataDir, 'relay.db') });
  const store = new RunStore(db);
  const adapters = { a: new ScriptedAdapter(), b: new ScriptedAdapter() };
  const makeController = (adapter: ScriptedAdapter) =>
    new RunController({
      store,
      dataDir,
      adapter,
      adapterName: 'claude',
      notifier: new RecordingNotifier(),
      createCoordinator: claudeCoordinator()
    });

  for (const [key, workspacePath, runId] of [
    ['a', workspaceA, 'relay-run-a'],
    ['b', workspaceB, 'relay-run-b']
  ] as const) {
    makeController(adapters[key]).startRun({
      runId,
      goal: `Run ${runId}`,
      workspacePath,
      tasks: FOUR_UNITS,
      model: { provider: 'anthropic', model: 'claude-3-7-sonnet' },
      initialUserMessage: 'Go.'
    });
  }

  // Interleave the two runs; neither may disturb the other
  const controllerA = makeController(adapters.a);
  const controllerB = makeController(adapters.b);
  controllerA.rehydrate('relay-run-a');
  controllerB.rehydrate('relay-run-b');

  await controllerA.tick();
  await controllerB.tick();
  await controllerA.tick();
  await controllerB.tick();

  assert.strictEqual(store.getRun('relay-run-a')?.handoffCount, 1);
  assert.strictEqual(store.getRun('relay-run-b')?.handoffCount, 1);
  assert.strictEqual(store.getLeaseRow(normalizeWorkspaceKey(workspaceA))?.currentOwner, 'relay-run-a-s2');
  assert.strictEqual(store.getLeaseRow(normalizeWorkspaceKey(workspaceB))?.currentOwner, 'relay-run-b-s2');
  assert.strictEqual(store.listChain('relay-run-a').length, 2);
  assert.strictEqual(store.listChain('relay-run-b').length, 2);

  const outcomes = await controllerA.executeUntilSettled();
  assert.strictEqual(outcomes[outcomes.length - 1].kind, 'completed');
  assert.strictEqual(store.getRun('relay-run-b')?.state, 'RUNNING', 'run B must be untouched by run A finishing');

  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('scenarios: real DSH adapter - one handoff across two dedicated worker processes', async () => {
  const dataDir = tempDir('agent-relay-dsh-');
  const workspaceDir = path.join(dataDir, 'workspace');
  fs.mkdirSync(workspaceDir);

  const db = new RelayDatabase({ dbPath: path.join(dataDir, 'relay.db') });
  const store = new RunStore(db);
  const adapter = new DshAdapter({
    runnerOptions: {
      binPath: process.execPath,
      extraArgsPrefix: [MOCK_DSH_SERVER],
      startupGracePeriodMs: 50
    }
  });
  const notifier = new RecordingNotifier();

  const controller = new RunController({
    store,
    dataDir,
    adapter,
    adapterName: 'dsh',
    notifier,
    createCoordinator: (deps) =>
      new DshHandshakeCoordinator({
        adapter: adapter,
        leaseManager: deps.leaseManager as unknown as WorkspaceLeaseManager,
        stateMachine: deps.stateMachine,
        workspaceKey: deps.workspaceKey
      })
  });

  try {
    controller.startRun({
      runId: 'relay-run-dsh',
      goal: 'Two units over real DSH worker processes',
      workspacePath: workspaceDir,
      tasks: FOUR_UNITS.slice(0, 2),
      model: { provider: 'deepseek-official', model: 'deepseek-chat', effort: 'high' },
      initialUserMessage: 'Run two units. Do not change the public API.'
    });

    const outcomes = await controller.executeUntilSettled();
    assert.deepStrictEqual(
      outcomes.map((o) => o.kind),
      ['unit_executed', 'handoff_performed', 'unit_executed', 'completed']
    );

    const chain = store.listChain('relay-run-dsh');
    assert.strictEqual(chain.length, 2);
    assert.strictEqual(chain[0].adapter, 'dsh');
    assert.strictEqual(chain[1].model, 'deepseek-chat');
    assert.strictEqual(chain[1].effort, 'high');

    // The first worker process is gone; the second one is the only live owner
    assert.strictEqual(adapter.inspectSession('relay-run-dsh-s1')?.active, false);
    assert.strictEqual(adapter.inspectSession('relay-run-dsh-s2')?.active, true);

    const run = store.getRun('relay-run-dsh')!;
    assert.strictEqual(store.getLeaseRow(run.workspaceKey), undefined, 'the finished run releases the lease');
    assert.deepStrictEqual(
      (JSON.parse(store.getLatestTaskSnapshot('relay-run-dsh')!.snapshotJson) as Array<{ status: string }>).map(
        (t) => t.status
      ),
      ['completed', 'completed']
    );
    assert.deepStrictEqual(notifier.notifications.map((n) => n.type), ['run_completed']);
  } finally {
    await adapter.shutdown();
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
