// tests/run/engine.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RelayDatabase } from '../../packages/controller/src/run/db.ts';
import { RunStore } from '../../packages/controller/src/run/store.ts';
import { RunController, type StartRunConfig } from '../../packages/controller/src/run/engine.ts';
import { RecordingNotifier } from '../../packages/controller/src/run/notifier.ts';
import { ControlIntentLog } from '../../packages/controller/src/run/intent.ts';
import { normalizeWorkspaceKey } from '../../packages/controller/src/workspace/key.ts';
import { WorkspaceLeaseManager } from '../../packages/controller/src/handoff/lease.ts';
import { HandoffStateMachine } from '../../packages/controller/src/handoff/state-machine.ts';
import { TwoPhaseHandshakeCoordinator } from '../../packages/adapters/claude/src/handshake.ts';
import { ScriptedAdapter } from '../helpers/scripted-adapter.ts';

const TASKS = [
  { taskId: 'u1', requirementId: 'req-root', title: 'Data Ingestion', dependencies: [] as string[] },
  { taskId: 'u2', requirementId: 'req-root', title: 'Transformer Encoder', dependencies: ['u1'] },
  { taskId: 'u3', requirementId: 'req-root', title: 'Autoregressive Decoder', dependencies: ['u2'] },
  { taskId: 'u4', requirementId: 'req-root', title: 'Loss and Optimizer', dependencies: ['u3'] }
];

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function setup(options: {
  adapter?: ScriptedAdapter;
  dataDir?: string;
  dbPath?: string;
  notifier?: RecordingNotifier;
} = {}) {
  const dataDir = options.dataDir ?? makeTempDir('agent-relay-engine-');
  const dbPath = options.dbPath ?? path.join(dataDir, 'relay.db');
  const db = new RelayDatabase({ dbPath });
  const store = new RunStore(db);
  const adapter = options.adapter ?? new ScriptedAdapter();
  const notifier = options.notifier ?? new RecordingNotifier();

  const controller = new RunController({
    store,
    dataDir,
    adapter,
    adapterName: 'claude',
    notifier,
    createCoordinator: (deps) =>
      new TwoPhaseHandshakeCoordinator(
        deps.stateMachine as HandoffStateMachine,
        deps.leaseManager as unknown as WorkspaceLeaseManager,
        deps.workspaceKey
      )
  });

  const config: StartRunConfig = {
    runId: 'run-engine-1',
    goal: 'Ship the ingestion pipeline',
    workspacePath: dataDir,
    tasks: TASKS,
    model: { provider: 'anthropic', model: 'claude-3-7-sonnet', effort: 'high' },
    initialUserMessage: 'Build the ingestion pipeline. Do not change the public API.'
  };

  return { db, store, adapter, notifier, controller, config, dataDir, dbPath };
}

test('engine: startRun persists the run, the immutable human input and the initial snapshot', () => {
  const { db, store, controller, config, dataDir } = setup();
  const run = controller.startRun(config);

  assert.strictEqual(run.runId, 'run-engine-1');
  assert.strictEqual(run.state, 'INITIALIZING');
  assert.strictEqual(run.unitCount, 4);
  assert.strictEqual(run.workspaceKey, normalizeWorkspaceKey(dataDir));
  assert.deepStrictEqual(run.model, { provider: 'anthropic', model: 'claude-3-7-sonnet', effort: 'high' });

  const inputs = store.listInputs('run-engine-1');
  assert.strictEqual(inputs.length, 1);
  assert.strictEqual(inputs[0].record.source, 'human');
  assert.strictEqual(inputs[0].record.rawContent, config.initialUserMessage);
  assert.ok(inputs[0].record.sha256Hash);

  const snapshot = store.getLatestTaskSnapshot('run-engine-1');
  assert.ok(snapshot);
  assert.strictEqual((JSON.parse(snapshot!.snapshotJson) as unknown[]).length, 4);
  db.close();
});

test('engine: startRun returns the existing run when the workspace is already active (V34)', () => {
  const { db, controller, config, dataDir } = setup();
  const first = controller.startRun(config);

  const second = controller.startRun({ ...config, runId: 'run-engine-2', goal: 'Different goal' });
  assert.strictEqual(second.runId, first.runId, 'a duplicate activation must not open a second run');
  assert.strictEqual(second.goal, 'Ship the ingestion pipeline');

  const runCount = db.prepare('SELECT COUNT(*) AS c FROM runs').get() as { c: number };
  assert.strictEqual(runCount.c, 1, 'a duplicate activation must not insert a second run row');
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('engine: executeUntilSettled drives four units through three handoffs with silent rotation', async () => {
  const { db, store, adapter, notifier, controller, config, dataDir } = setup();
  controller.startRun(config);

  const outcomes = await controller.executeUntilSettled();
  assert.deepStrictEqual(
    outcomes.map((o) => o.kind),
    [
      'unit_executed',
      'handoff_performed',
      'unit_executed',
      'handoff_performed',
      'unit_executed',
      'handoff_performed',
      'unit_executed',
      'completed'
    ]
  );
  assert.deepStrictEqual(
    outcomes.filter((o) => o.kind === 'unit_executed').map((o) => (o as { taskId: string }).taskId),
    ['u1', 'u2', 'u3', 'u4']
  );

  // Four sessions, three handoffs
  const chain = store.listChain('run-engine-1');
  assert.strictEqual(chain.length, 4);
  assert.deepStrictEqual(chain.map((l) => l.sequence), [1, 2, 3, 4]);
  assert.deepStrictEqual(chain.map((l) => l.epoch), [1, 2, 3, 4]);
  assert.strictEqual(chain[0].prevSessionId, undefined);
  assert.strictEqual(chain[0].reason, 'run_started');
  assert.deepStrictEqual(
    chain.slice(1).map((l) => l.handoffId),
    ['h-run-engine-1-1', 'h-run-engine-1-2', 'h-run-engine-1-3']
  );
  assert.deepStrictEqual(
    chain.slice(1).map((l) => l.prevSessionId),
    [chain[0].nextSessionId, chain[1].nextSessionId, chain[2].nextSessionId]
  );

  // Every session preserved, all but the last superseded
  assert.strictEqual(chain.filter((l) => l.supersededAt !== undefined).length, 3);
  assert.strictEqual(chain[3].supersededAt, undefined);

  // Each session ran exactly one unit and only after authorization
  for (const link of chain) {
    assert.strictEqual(adapter.wasAuthorized(link.nextSessionId), true);
  }
  assert.strictEqual(adapter.interrupted.length, 3, 'each superseded worker is reaped');

  // Single writer: ownership advanced monotonically through the chain, then the
  // finished run releases the workspace lease so the workspace can be reused.
  const run = store.getRun('run-engine-1');
  assert.strictEqual(run?.state, 'COMPLETED');
  assert.strictEqual(run?.handoffCount, 3);
  assert.strictEqual(run?.currentSessionId, chain[3].nextSessionId);
  assert.strictEqual(run?.currentEpoch, 4);
  assert.strictEqual(store.getLeaseRow(run!.workspaceKey), undefined, 'a finished run releases its lease');
  assert.deepStrictEqual(
    [1, 2, 3].map((n) => store.getHandoff(`h-run-engine-1-${n}`)?.state),
    ['COMPLETED', 'COMPLETED', 'COMPLETED']
  );
  assert.deepStrictEqual(
    [1, 2, 3].map((n) => store.getHandoff(`h-run-engine-1-${n}`)?.targetSessionId),
    chain.slice(1).map((l) => l.nextSessionId)
  );

  // The last handoff snapshot is on disk and referenced by the database (V16)
  const manifestPath = store.getHandoff('h-run-engine-1-3')!.manifestPath!;
  assert.strictEqual(fs.existsSync(manifestPath), true);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { handoffId: string; runId: string };
  assert.strictEqual(manifest.handoffId, 'h-run-engine-1-3');
  assert.strictEqual(manifest.runId, 'run-engine-1');

  // All four units completed with evidence
  const tasks = JSON.parse(store.getLatestTaskSnapshot('run-engine-1')!.snapshotJson) as Array<{
    taskId: string;
    status: string;
    testEvidenceHash?: string;
  }>;
  assert.deepStrictEqual(tasks.map((t) => t.status), ['completed', 'completed', 'completed', 'completed']);
  assert.deepStrictEqual(tasks.map((t) => t.testEvidenceHash), ['evidence-u1', 'evidence-u2', 'evidence-u3', 'evidence-u4']);

  // Three consecutive handoffs must not ask the user for anything
  assert.deepStrictEqual(
    notifier.notifications.map((n) => n.type),
    ['run_completed'],
    'handoff rotation must stay silent; only completion notifies'
  );
  assert.strictEqual(notifier.ofType('run_completed').length, 1);
  assert.strictEqual(notifier.notifications.every((n) => n.severity === 'notify'), true);

  // state.md exists and reflects the finished run
  const statePath = path.join(dataDir, 'run-engine-1', 'state.md');
  assert.strictEqual(fs.existsSync(statePath), true);
  assert.match(fs.readFileSync(statePath, 'utf8'), /^进度: 4\/4 单元完成/m);

  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('engine: generated prompts never enter the human input ledger (V28)', async () => {
  const { db, store, controller, config, dataDir } = setup();
  controller.startRun(config);
  await controller.executeUntilSettled();

  const inputs = store.listInputs('run-engine-1');
  assert.strictEqual(inputs.length, 1, 'only the original human message may be recorded');
  assert.strictEqual(inputs.every((i) => i.record.source === 'human'), true);
  assert.strictEqual(inputs[0].record.rawContent, config.initialUserMessage);
  assert.doesNotMatch(inputs[0].record.rawContent, /UNIT_RESULT_START|AGENT_RELAY_UNIT/);

  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('engine: pause_next_node stops at the node boundary without creating the next worker (V20)', async () => {
  const { db, store, adapter, controller, config, dataDir } = setup();
  controller.startRun(config);

  // Complete unit 1, then pause before the handoff tick
  const first = await controller.tick();
  assert.strictEqual(first.kind, 'unit_executed');

  new ControlIntentLog(store).append('run-engine-1', 'pause_next_node');

  const second = await controller.tick();
  assert.strictEqual(second.kind, 'paused');
  assert.strictEqual((second as { reason?: string }).reason, 'user_pause_next_node');

  const run = store.getRun('run-engine-1');
  assert.strictEqual(run?.state, 'PAUSED');
  assert.strictEqual(run?.handoffCount, 0, 'no handoff may be started while pausing');
  assert.strictEqual(store.listChain('run-engine-1').length, 1, 'no successor session may be created');
  assert.strictEqual(adapter.created.length, 1);
  assert.strictEqual(adapter.authorizations.length, 1);

  // A paused run stays put no matter how often it is ticked
  const third = await controller.tick();
  assert.strictEqual(third.kind, 'paused');
  assert.strictEqual(adapter.created.length, 1);

  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('engine: resume continues in the existing session and still finishes the run (V22)', async () => {
  const { db, store, controller, config, dataDir } = setup();
  controller.startRun(config);
  const intents = new ControlIntentLog(store);

  await controller.tick();
  intents.append('run-engine-1', 'pause_next_node');
  assert.strictEqual((await controller.tick()).kind, 'paused');

  intents.append('run-engine-1', 'resume');
  const resumed = await controller.tick();
  assert.strictEqual(resumed.kind, 'handoff_performed', 'resume returns to the node boundary and continues');

  const outcomes = await controller.executeUntilSettled();
  assert.strictEqual(outcomes[outcomes.length - 1].kind, 'completed');
  assert.strictEqual(store.getRun('run-engine-1')?.state, 'COMPLETED');

  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('engine: stop_now cancels the run and a restarted controller never resumes it (V21)', async () => {
  const { db, store, adapter, controller, config, dataDir, dbPath } = setup();
  controller.startRun(config);
  await controller.tick();

  const intents = new ControlIntentLog(store);
  const stop = intents.append('run-engine-1', 'stop_now');

  const stopped = await controller.tick();
  assert.strictEqual(stopped.kind, 'stopped');
  assert.strictEqual((stopped as { intentId?: string }).intentId, stop.intentId);
  assert.strictEqual(store.getRun('run-engine-1')?.state, 'CANCELLED');

  const createdBeforeRestart = adapter.created.length;
  const submittedBeforeRestart = adapter.submitted.length;
  db.close();

  // A brand new controller process reads the same database
  const restartedDb = new RelayDatabase({ dbPath });
  const restartedStore = new RunStore(restartedDb);
  const restartedAdapter = new ScriptedAdapter();
  const restartedController = new RunController({
    store: restartedStore,
    dataDir,
    adapter: restartedAdapter,
    adapterName: 'claude',
    createCoordinator: (deps) =>
      new TwoPhaseHandshakeCoordinator(
        deps.stateMachine as HandoffStateMachine,
        deps.leaseManager as unknown as WorkspaceLeaseManager,
        deps.workspaceKey
      )
  });
  const rehydrated = restartedController.rehydrate('run-engine-1');
  assert.strictEqual(rehydrated?.state, 'CANCELLED');

  const outcome = await restartedController.tick();
  assert.strictEqual(outcome.kind, 'stopped');
  assert.strictEqual(restartedAdapter.created.length, 0, 'a cancelled run must never spawn a new worker after restart');
  assert.strictEqual(restartedAdapter.submitted.length, 0);

  // And the original counts are untouched
  assert.strictEqual(adapter.created.length, createdBeforeRestart);
  assert.strictEqual(adapter.submitted.length, submittedBeforeRestart);

  restartedDb.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('engine: a control intent arriving during the handoff window blocks the CAS and keeps one owner (V33)', async () => {
  let intents: ControlIntentLog | null = null;
  const adapter = new ScriptedAdapter({
    onCreateFresh: (sessionId) => {
      if (sessionId.endsWith('-s2')) {
        intents!.append('run-engine-1', 'pause_next_node');
      }
    }
  });
  const { db, store, controller, config, dataDir } = setup({ adapter });
  controller.startRun(config);

  intents = new ControlIntentLog(store);

  await controller.tick(); // unit 1 in session s1
  const handoffTick = await controller.tick();

  assert.strictEqual(handoffTick.kind, 'paused');
  const run = store.getRun('run-engine-1');
  assert.strictEqual(run?.state, 'PAUSED');
  assert.strictEqual(run?.currentSessionId?.endsWith('-s1'), true, 'ownership must not transfer');
  assert.strictEqual(store.getLeaseRow(run!.workspaceKey)?.currentOwner, run!.currentSessionId);
  assert.strictEqual(store.getLeaseRow(run!.workspaceKey)?.epoch, 1, 'the lease epoch must not advance');
  assert.strictEqual(adapter.wasAuthorized(`${run!.runId}-s2`), false, 'the new session must stay read-only');
  assert.ok(adapter.interrupted.includes(`${run!.runId}-s2`), 'the unprepared session is reaped');

  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('engine: a control intent delivered with the execution token invalidates it before any write (V33)', async () => {
  let intents: ControlIntentLog | null = null;
  const adapter = new ScriptedAdapter({
    onAuthorize: (sessionId) => {
      if (sessionId.endsWith('-s2')) {
        intents!.append('run-engine-1', 'stop_now');
      }
    }
  });
  const { db, store, controller, config, dataDir } = setup({ adapter });
  controller.startRun(config);

  intents = new ControlIntentLog(store);

  await controller.tick(); // unit 1 in session s1
  const outcomes = await controller.executeUntilSettled();

  assert.strictEqual(outcomes[0].kind, 'handoff_performed');
  assert.strictEqual(outcomes[1].kind, 'stopped', 'the stale token must not be spent on a new unit');
  assert.strictEqual(store.getRun('run-engine-1')?.state, 'CANCELLED');

  // s2 was authorized, but never submitted a unit prompt
  const s2Submits = adapter.submitted.filter((s) => s.sessionId.endsWith('-s2'));
  assert.strictEqual(s2Submits.length, 0, 'no write may be dispatched under a superseded intent watermark');

  // Only unit 1 completed
  const tasks = JSON.parse(store.getLatestTaskSnapshot('run-engine-1')!.snapshotJson) as Array<{ status: string }>;
  assert.deepStrictEqual(tasks.map((t) => t.status), ['completed', 'pending', 'pending', 'pending']);

  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('engine: an ACK reporting a different model fails the handoff without a second writer (V10)', async () => {
  const adapter = new ScriptedAdapter({
    modelOverrides: {
      'run-engine-1-s2': { provider: 'anthropic', model: 'claude-3-5-haiku', effort: 'low' }
    }
  });
  const { db, store, controller, config, dataDir } = setup({ adapter });
  controller.startRun(config);
  await controller.tick();

  const outcome = await controller.tick();
  assert.strictEqual(outcome.kind, 'recovery_required');
  assert.match((outcome as { reason: string }).reason, /Model mismatch/i);

  const run = store.getRun('run-engine-1');
  assert.strictEqual(run?.state, 'RECOVERY_REQUIRED');
  assert.strictEqual(run?.currentSessionId?.endsWith('-s1'), true);
  assert.strictEqual(store.getLeaseRow(run!.workspaceKey)?.epoch, 1, 'a failed handshake must not advance the lease');
  assert.strictEqual(adapter.wasAuthorized('run-engine-1-s2'), false);

  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('engine: three identical failures block the run across sessions (V23)', async () => {
  const adapter = new ScriptedAdapter({
    unitReplies: { u1: { status: 'failed', summary: 'build broken' } }
  });
  const { db, store, notifier, controller, config, dataDir } = setup({ adapter });
  controller.startRun(config);

  const outcomes = await controller.executeUntilSettled();
  assert.strictEqual(outcomes[outcomes.length - 1].kind, 'blocked');

  const run = store.getRun('run-engine-1');
  assert.strictEqual(run?.state, 'BLOCKED');
  assert.match(run?.blockedReason ?? '', /loop_detected_u1/);
  assert.strictEqual(store.listChain('run-engine-1').length, 3, 'failures span two handoffs, then stop');

  const failedOutcomes = outcomes.filter(
    (o) => o.kind === 'unit_executed' && (o as { status: string }).status === 'failed'
  );
  assert.strictEqual(failedOutcomes.length, 3);
  assert.strictEqual(notifier.ofType('run_blocked').length, 1);

  // The unit stays in progress rather than being falsely completed (V07)
  const tasks = JSON.parse(store.getLatestTaskSnapshot('run-engine-1')!.snapshotJson) as Array<{
    taskId: string;
    status: string;
    testEvidenceHash?: string;
  }>;
  assert.strictEqual(tasks[0].status, 'in_progress');
  assert.strictEqual(tasks[0].testEvidenceHash, undefined);

  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('engine: a completion without an evidence hash is downgraded to partial (V07)', async () => {
  const adapter = new ScriptedAdapter({
    unitReplies: { u1: { status: 'completed', summary: 'looks good to me' } }
  });
  const { db, store, controller, config, dataDir } = setup({ adapter });
  controller.startRun(config);

  const outcome = await controller.tick();
  assert.strictEqual(outcome.kind, 'unit_executed');
  assert.strictEqual((outcome as { status: string }).status, 'partial');

  const tasks = JSON.parse(store.getLatestTaskSnapshot('run-engine-1')!.snapshotJson) as Array<{
    taskId: string;
    status: string;
  }>;
  assert.strictEqual(tasks[0].status, 'in_progress');
  assert.strictEqual(store.getRun('run-engine-1')?.state, 'RUNNING');

  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('engine: rehydrate rebuilds ledger and task graph hashes verbatim (V22)', async () => {
  const dataDir = makeTempDir('agent-relay-rehydrate-');
  const dbPath = path.join(dataDir, 'relay.db');
  const first = setup({ dataDir, dbPath });
  first.controller.startRun(first.config);
  await first.controller.tick();

  const hashes = first.controller.getInvariantHashes();
  assert.ok(hashes.inputLedgerHeadHash.length > 0);
  assert.ok(hashes.taskSnapshotHash.length > 0);
  first.db.close();

  const secondDb = new RelayDatabase({ dbPath });
  const secondStore = new RunStore(secondDb);
  const secondController = new RunController({
    store: secondStore,
    dataDir,
    adapter: first.adapter, // 同一适配器实例＝重启后会话仍存活（真实场景由适配器重新附着）
    adapterName: 'claude',
    notifier: new RecordingNotifier(),
    createCoordinator: (deps) =>
      new TwoPhaseHandshakeCoordinator(
        deps.stateMachine as HandoffStateMachine,
        deps.leaseManager as unknown as WorkspaceLeaseManager,
        deps.workspaceKey
      )
  });

  secondController.rehydrate('run-engine-1');
  assert.deepStrictEqual(secondController.getInvariantHashes(), hashes);

  // 重建后的 run 必须真的继续推进，而不是停在 current_session_lost
  const resumed = await secondController.tick();
  assert.strictEqual(resumed.kind, 'handoff_performed', 'the rebuilt run must continue, not recover');
  const advanced = await secondController.tick();
  assert.strictEqual(advanced.kind, 'unit_executed');
  assert.strictEqual((advanced as { taskId: string }).taskId, 'u2');

  const tasks = JSON.parse(secondStore.getLatestTaskSnapshot('run-engine-1')!.snapshotJson) as Array<{
    status: string;
  }>;
  assert.strictEqual(tasks[0].status, 'completed', 'restored task state must be preserved');
  assert.strictEqual(tasks[1].status, 'completed', 'the rebuilt run must have completed the next unit');

  secondDb.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('engine: a handoff whose old session cannot be confirmed quiescent enters recovery (V19)', async () => {
  const overrides: Record<string, 'quiescent' | 'timeout' | 'error'> = {};
  const adapter = new ScriptedAdapter({ quiescenceOverrides: overrides });
  const { db, store, controller, config, dataDir } = setup({ adapter });

  controller.startRun(config);
  assert.strictEqual((await controller.tick()).kind, 'unit_executed');

  // From now on the old worker never confirms it has stopped writing
  overrides['run-engine-1-s1'] = 'timeout';

  const outcome = await controller.tick();
  assert.strictEqual(outcome.kind, 'recovery_required');
  assert.match((outcome as { reason: string }).reason, /old_session_quiescence_timeout/);

  const run = store.getRun('run-engine-1');
  assert.strictEqual(run?.state, 'RECOVERY_REQUIRED');
  assert.strictEqual(run?.handoffCount, 0, 'a failed quiescence must not advance the handoff');
  assert.strictEqual(store.getLeaseRow(run!.workspaceKey)?.epoch, 1, 'the lease must not advance');
  assert.strictEqual(store.listChain('run-engine-1').length, 1, 'no successor session may be created');
  assert.strictEqual(adapter.created.length, 1);

  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('engine: a pause arriving mid-handoff can still be resumed afterwards (V20)', async () => {
  let intents: ControlIntentLog | null = null;
  // 只注入一次：重试会以同一个 session id 再次 createFresh，
  // 若每次都注入，「一次暂停 + 一次 resume」就变成「每次交接都暂停」，测不到重试路径。
  let injected = false;
  const adapter = new ScriptedAdapter({
    onCreateFresh: (sessionId) => {
      if (!injected && sessionId.endsWith('-s2')) {
        injected = true;
        intents!.append('run-engine-1', 'pause_next_node');
      }
    }
  });
  const { db, store, controller, config, dataDir } = setup({ adapter });
  controller.startRun(config);
  intents = new ControlIntentLog(store);

  await controller.tick(); // unit 1 in s1
  assert.strictEqual((await controller.tick()).kind, 'paused');

  // 被阻塞的那次 pause 必须已被消费，否则它会一直压过 resume
  const paused = store.getRun('run-engine-1');
  assert.strictEqual(paused?.state, 'PAUSED');
  assert.strictEqual(store.listPendingIntents('run-engine-1').length, 0);
  assert.strictEqual(store.getHandoff('h-run-engine-1-1')?.state, 'ABANDONED');

  intents.append('run-engine-1', 'resume');
  const resumed = await controller.tick();
  assert.strictEqual(resumed.kind, 'handoff_performed', 'resume must be able to leave PAUSED');

  const outcomes = await controller.executeUntilSettled();
  assert.strictEqual(outcomes[outcomes.length - 1].kind, 'completed');
  assert.strictEqual(store.getRun('run-engine-1')?.state, 'COMPLETED');
  // 放弃的那次交接被重试，而不是被当成重复回调而阻塞
  assert.strictEqual(store.getHandoff('h-run-engine-1-1')?.state, 'COMPLETED');
  assert.strictEqual(store.getRun('run-engine-1')?.handoffCount, 3);

  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('engine: the no-progress counter survives a controller restart (V23)', async () => {
  const adapter = new ScriptedAdapter({
    unitReplies: { u1: { status: 'failed', summary: 'build broken' } }
  });
  const { db, store, controller, config, dataDir, dbPath } = setup({ adapter });

  controller.startRun(config);
  await controller.tick(); // 失败 1
  await controller.tick(); // 交接
  await controller.tick(); // 失败 2（新会话里）
  assert.strictEqual(store.getRun('run-engine-1')?.state, 'RUNNING');
  assert.strictEqual(
    store.listEvents('run-engine-1').filter((e) => e.type === 'unit_failed').length,
    2
  );
  db.close();

  // 重启：同一数据库、同一适配器实例（会话仍存活）
  const restartedDb = new RelayDatabase({ dbPath });
  const restartedStore = new RunStore(restartedDb);
  const restarted = new RunController({
    store: restartedStore,
    dataDir,
    adapter,
    adapterName: 'claude',
    notifier: new RecordingNotifier(),
    createCoordinator: (deps) =>
      new TwoPhaseHandshakeCoordinator(
        deps.stateMachine as HandoffStateMachine,
        deps.leaseManager as unknown as WorkspaceLeaseManager,
        deps.workspaceKey
      )
  });
  restarted.rehydrate('run-engine-1');

  const outcomes = await restarted.executeUntilSettled();
  assert.strictEqual(outcomes[outcomes.length - 1].kind, 'blocked', 'the third identical failure must block');
  assert.match(restartedStore.getRun('run-engine-1')?.blockedReason ?? '', /loop_detected_u1/);
  assert.strictEqual(
    restartedStore.listEvents('run-engine-1').filter((e) => e.type === 'unit_failed').length,
    3,
    'the counter must have been rebuilt from the event log, not restarted at zero'
  );

  restartedDb.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('engine: a new session that never becomes quiescent enters recovery without gaining ownership (V19)', async () => {
  const overrides: Record<string, 'quiescent' | 'timeout' | 'error'> = {};
  const adapter = new ScriptedAdapter({
    quiescenceOverrides: overrides,
    onCreateFresh: (sessionId) => {
      if (sessionId.endsWith('-s2')) {
        overrides[sessionId] = 'error';
      }
    }
  });
  const { db, store, controller, config, dataDir } = setup({ adapter });

  controller.startRun(config);
  assert.strictEqual((await controller.tick()).kind, 'unit_executed');

  const outcome = await controller.tick();
  assert.strictEqual(outcome.kind, 'recovery_required');
  assert.match((outcome as { reason: string }).reason, /new_session_quiescence_error/);

  const run = store.getRun('run-engine-1');
  assert.strictEqual(run?.state, 'RECOVERY_REQUIRED');
  assert.strictEqual(run?.currentSessionId?.endsWith('-s1'), true, 'ownership must not transfer');
  assert.strictEqual(store.getLeaseRow(run!.workspaceKey)?.epoch, 1);
  assert.strictEqual(adapter.wasAuthorized('run-engine-1-s2'), false, 'the new session must never be authorized');

  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('engine: a rebuilt controller whose session is gone enters recovery without spawning a worker (V21)', async () => {
  const { db, controller, config, dataDir, dbPath } = setup();
  controller.startRun(config);
  assert.strictEqual((await controller.tick()).kind, 'unit_executed');
  db.close();

  // 冷适配器：重启后旧会话已不可寻址
  const coldAdapter = new ScriptedAdapter();
  const restartedDb = new RelayDatabase({ dbPath });
  const restartedStore = new RunStore(restartedDb);
  const restarted = new RunController({
    store: restartedStore,
    dataDir,
    adapter: coldAdapter,
    adapterName: 'claude',
    notifier: new RecordingNotifier(),
    createCoordinator: (deps) =>
      new TwoPhaseHandshakeCoordinator(
        deps.stateMachine as HandoffStateMachine,
        deps.leaseManager as unknown as WorkspaceLeaseManager,
        deps.workspaceKey
      )
  });
  restarted.rehydrate('run-engine-1');

  const outcome = await restarted.tick();
  assert.strictEqual(outcome.kind, 'recovery_required');
  assert.match((outcome as { reason: string }).reason, /current_session_lost/);
  assert.strictEqual(restartedStore.getRun('run-engine-1')?.state, 'RECOVERY_REQUIRED');
  assert.strictEqual(coldAdapter.created.length, 0, 'a lost session must not spawn a replacement');
  assert.strictEqual(coldAdapter.submitted.length, 0);
  assert.strictEqual(restartedStore.listChain('run-engine-1').length, 1, 'no successor link may be appended');

  restartedDb.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
