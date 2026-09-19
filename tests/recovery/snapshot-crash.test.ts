// tests/recovery/snapshot-crash.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RelayDatabase } from '../../packages/controller/src/run/db.ts';
import { RunStore } from '../../packages/controller/src/run/store.ts';
import {
  RunController,
  type StartRunConfig,
  type FaultInjectionPoint,
  type FaultHook,
  type FaultContext
} from '../../packages/controller/src/run/engine.ts';
import { RecordingNotifier } from '../../packages/controller/src/run/notifier.ts';
import { ControlIntentLog } from '../../packages/controller/src/run/intent.ts';
import { HandoffStateMachine } from '../../packages/controller/src/handoff/state-machine.ts';
import { WorkspaceLeaseManager } from '../../packages/controller/src/handoff/lease.ts';
import { TwoPhaseHandshakeCoordinator } from '../../packages/adapters/claude/src/handshake.ts';
import { normalizeWorkspaceKey } from '../../packages/controller/src/workspace/key.ts';
import { ScriptedAdapter } from '../helpers/scripted-adapter.ts';

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function createCoordinator(deps: any) {
  return new TwoPhaseHandshakeCoordinator(
    deps.stateMachine as HandoffStateMachine,
    deps.leaseManager as unknown as WorkspaceLeaseManager,
    deps.workspaceKey
  );
}

test('V16 acceptance: half-written corrupted snapshot during write is purged on reconcile and handoff retries cleanly', async () => {
  const dataDir = makeTempDir('agent-relay-v16-corrupt-');
  const dbPath = path.join(dataDir, 'relay.db');
  const db = new RelayDatabase({ dbPath });
  const store = new RunStore(db);
  const adapter = new ScriptedAdapter();
  const notifier = new RecordingNotifier();

  // Create a user source file to verify zero user data loss
  const userFile = path.join(dataDir, 'src', 'main.ts');
  fs.mkdirSync(path.dirname(userFile), { recursive: true });
  fs.writeFileSync(userFile, 'export const value = 42;\n', 'utf8');

  let crashTriggered = false;
  const faultHook: FaultHook = (point: FaultInjectionPoint, ctx: FaultContext) => {
    if (point === 'during_snapshot_write') {
      crashTriggered = true;
      const handoffDir = path.join(dataDir, ctx.runId, 'handoffs', ctx.handoffId!);
      fs.mkdirSync(handoffDir, { recursive: true });
      // 写入损坏或截断的 JSON 文件，模拟断电
      fs.writeFileSync(path.join(handoffDir, 'manifest.json'), '{"incomplete": "half written json...', 'utf8');
      throw new Error('CRASH_DURING_SNAPSHOT_WRITE');
    }
  };

  const controller1 = new RunController({
    store,
    dataDir,
    adapter,
    adapterName: 'claude',
    notifier,
    faultHook,
    createCoordinator
  });

  const config: StartRunConfig = {
    runId: 'run-v16-corrupt',
    goal: 'Test corrupted snapshot crash and recovery',
    workspacePath: dataDir,
    tasks: [
      { taskId: 'u1', requirementId: 'req-root', title: 'Task 1', dependencies: [] },
      { taskId: 'u2', requirementId: 'req-root', title: 'Task 2', dependencies: ['u1'] }
    ],
    model: { provider: 'anthropic', model: 'claude-3-7-sonnet', effort: 'high' },
    initialUserMessage: 'Execute tasks with resilience against corrupted snapshot write crashes.'
  };

  controller1.startRun(config);

  // Tick 1: execute unit u1
  const first = await controller1.tick();
  assert.strictEqual(first.kind, 'unit_executed');
  assert.strictEqual((first as { taskId: string }).taskId, 'u1');

  // Capture invariant hashes before crash
  const preCrashHashes = controller1.getInvariantHashes();
  assert.ok(preCrashHashes.inputLedgerHeadHash);
  assert.ok(preCrashHashes.taskSnapshotHash);

  // Tick 2: handoff begins -> triggers during_snapshot_write and crashes
  await assert.rejects(
    async () => {
      await controller1.tick();
    },
    { message: 'CRASH_DURING_SNAPSHOT_WRITE' }
  );
  assert.strictEqual(crashTriggered, true);

  const handoffId = 'h-run-v16-corrupt-1';
  const manifestPath = path.join(dataDir, 'run-v16-corrupt', 'handoffs', handoffId, 'manifest.json');
  assert.strictEqual(fs.existsSync(manifestPath), true, 'Corrupted manifest must exist on disk before recovery');
  assert.strictEqual(store.getHandoff(handoffId)?.state, 'REQUESTED', 'Handoff state must not be committed before crash');

  // Reboot controller
  const controller2 = new RunController({
    store,
    dataDir,
    adapter,
    adapterName: 'claude',
    notifier,
    createCoordinator
  });
  controller2.rehydrate('run-v16-corrupt');

  // Invoke reconcile()
  const recResult = await controller2.reconcile();
  assert.strictEqual(recResult.requiresManualIntervention, false);
  assert.strictEqual(recResult.recoveredState, 'RUNNING');
  assert.ok(recResult.healedActions.includes(`purged_corrupted_snapshot:${handoffId}`));
  assert.strictEqual(fs.existsSync(manifestPath), false, 'Corrupted manifest must be purged from disk');
  assert.strictEqual(store.getHandoff(handoffId)?.state, 'ABANDONED', 'Handoff must be marked ABANDONED');

  // Verify invariant hashes immediately after recovery
  const postRecHashes = controller2.getInvariantHashes();
  assert.strictEqual(postRecHashes.inputLedgerHeadHash, preCrashHashes.inputLedgerHeadHash, 'Invariant 2: input ledger hash stable');
  assert.strictEqual(postRecHashes.taskSnapshotHash, preCrashHashes.taskSnapshotHash, 'Invariant 2: task snapshot hash stable');

  // Now advance controller2: handoff retries and completes cleanly
  const handoffOutcome = await controller2.tick();
  assert.strictEqual(handoffOutcome.kind, 'handoff_performed');
  assert.strictEqual(fs.existsSync(manifestPath), true, 'Clean manifest must now exist on disk');
  const cleanManifestJson = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.strictEqual(cleanManifestJson.handoffId, handoffId);
  assert.strictEqual(store.getHandoff(handoffId)?.state, 'COMPLETED');

  // Advance unit u2
  const u2Outcome = await controller2.tick();
  assert.strictEqual(u2Outcome.kind, 'unit_executed');
  assert.strictEqual((u2Outcome as { taskId: string }).taskId, 'u2');

  // Verify Invariant 1: Single valid writer during active session execution
  const wsKey = normalizeWorkspaceKey(dataDir);
  const lease = store.getLeaseRow(wsKey);
  assert.ok(lease, 'Invariant 1: lease row must exist during active execution');
  assert.strictEqual(lease.currentOwner, controller2.getCurrentSessionId(), 'Invariant 1: currentOwner matches active session');
  assert.strictEqual(lease.epoch, 2, 'Invariant 1: epoch incremented monotonically');

  // Settle run
  const finalOutcome = await controller2.tick();
  assert.strictEqual(finalOutcome.kind, 'completed');

  // Verify 5 Mechanical Invariants
  // 1. Single valid writer after completion (lease cleanly released)
  const finalLease = store.getLeaseRow(wsKey);
  assert.strictEqual(finalLease, undefined, 'Invariant 1: lease is cleanly released upon completion');

  // 2. Hash stability
  const finalHashes = controller2.getInvariantHashes();
  assert.strictEqual(finalHashes.inputLedgerHeadHash, preCrashHashes.inputLedgerHeadHash, 'Invariant 2: human input ledger head hash unchanged');

  // 3. Zero user data loss
  assert.strictEqual(fs.readFileSync(userFile, 'utf8'), 'export const value = 42;\n', 'Invariant 3: user workspace code preserved');

  // 4. Task at-most-once completion
  const events = store.listEvents('run-v16-corrupt');
  const u1Completed = events.filter((e) => e.type === 'unit_completed' && e.payload?.taskId === 'u1');
  assert.strictEqual(u1Completed.length, 1, 'Invariant 4: u1 completed exactly once');
  const u2Completed = events.filter((e) => e.type === 'unit_completed' && e.payload?.taskId === 'u2');
  assert.strictEqual(u2Completed.length, 1, 'Invariant 4: u2 completed exactly once');

  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('V16 acceptance: orphan snapshot on disk before DB commit is purged and retried cleanly', async () => {
  const dataDir = makeTempDir('agent-relay-v16-orphan-');
  const dbPath = path.join(dataDir, 'relay.db');
  const db = new RelayDatabase({ dbPath });
  const store = new RunStore(db);
  const adapter = new ScriptedAdapter();
  const notifier = new RecordingNotifier();

  const userFile = path.join(dataDir, 'docs', 'readme.txt');
  fs.mkdirSync(path.dirname(userFile), { recursive: true });
  fs.writeFileSync(userFile, 'Documentation baseline\n', 'utf8');

  let crashTriggered = false;
  const faultHook: FaultHook = (point: FaultInjectionPoint, ctx: FaultContext) => {
    if (point === 'after_snapshot_file_written') {
      crashTriggered = true;
      throw new Error('CRASH_AFTER_SNAPSHOT_FILE_WRITTEN');
    }
  };

  const controller1 = new RunController({
    store,
    dataDir,
    adapter,
    adapterName: 'claude',
    notifier,
    faultHook,
    createCoordinator
  });

  const config: StartRunConfig = {
    runId: 'run-v16-orphan',
    goal: 'Test orphan snapshot purge before DB commit',
    workspacePath: dataDir,
    tasks: [
      { taskId: 'u1', requirementId: 'req-root', title: 'Task 1', dependencies: [] },
      { taskId: 'u2', requirementId: 'req-root', title: 'Task 2', dependencies: ['u1'] }
    ],
    model: { provider: 'anthropic', model: 'claude-3-7-sonnet', effort: 'high' },
    initialUserMessage: 'Execute tasks with orphan snapshot detection.'
  };

  controller1.startRun(config);

  // Tick 1: u1
  const first = await controller1.tick();
  assert.strictEqual(first.kind, 'unit_executed');
  assert.strictEqual((first as { taskId: string }).taskId, 'u1');

  const preCrashHashes = controller1.getInvariantHashes();

  // Tick 2: handoff begins -> manifest written to disk -> crash thrown
  await assert.rejects(
    async () => {
      await controller1.tick();
    },
    { message: 'CRASH_AFTER_SNAPSHOT_FILE_WRITTEN' }
  );
  assert.strictEqual(crashTriggered, true);

  const handoffId = 'h-run-v16-orphan-1';
  const manifestPath = path.join(dataDir, 'run-v16-orphan', 'handoffs', handoffId, 'manifest.json');
  assert.strictEqual(fs.existsSync(manifestPath), true, 'Snapshot file was written to disk');
  const handoffBefore = store.getHandoff(handoffId);
  assert.strictEqual(handoffBefore?.state, 'REQUESTED', 'DB handoff must NOT be updated to SNAPSHOTTED');
  assert.strictEqual(handoffBefore?.manifestHash, undefined, 'DB manifestHash was not committed');

  // Reboot controller
  const controller2 = new RunController({
    store,
    dataDir,
    adapter,
    adapterName: 'claude',
    notifier,
    createCoordinator
  });
  controller2.rehydrate('run-v16-orphan');

  // Invoke reconcile()
  const recResult = await controller2.reconcile();
  assert.strictEqual(recResult.requiresManualIntervention, false);
  assert.strictEqual(recResult.recoveredState, 'RUNNING');
  assert.ok(recResult.healedActions.includes(`purged_corrupted_snapshot:${handoffId}`));
  assert.strictEqual(fs.existsSync(manifestPath), false, 'Orphan snapshot file must be purged');
  assert.strictEqual(store.getHandoff(handoffId)?.state, 'ABANDONED', 'Uncommitted handoff marked ABANDONED');

  // Resume handoff
  const handoffOutcome = await controller2.tick();
  assert.strictEqual(handoffOutcome.kind, 'handoff_performed');
  assert.strictEqual(fs.existsSync(manifestPath), true, 'Clean manifest now published on disk');
  const publishedHandoff = store.getHandoff(handoffId);
  assert.strictEqual(publishedHandoff?.state, 'COMPLETED');
  assert.ok(publishedHandoff?.manifestHash, 'manifestHash properly committed');

  // Finish u2 & run
  const u2Outcome = await controller2.tick();
  assert.strictEqual(u2Outcome.kind, 'unit_executed');

  // 1. Single valid writer during active execution
  const wsKey = normalizeWorkspaceKey(dataDir);
  const lease = store.getLeaseRow(wsKey);
  assert.ok(lease, 'Invariant 1: lease row must exist');
  assert.strictEqual(lease.currentOwner, controller2.getCurrentSessionId(), 'Invariant 1: currentOwner matches active session');
  assert.strictEqual(lease.epoch, 2, 'Invariant 1: epoch incremented monotonically');

  const finalOutcome = await controller2.tick();
  assert.strictEqual(finalOutcome.kind, 'completed');

  // 5 Invariants Verification
  // 1. Single valid writer after completion (lease cleanly released)
  assert.strictEqual(store.getLeaseRow(wsKey), undefined, 'Invariant 1: lease cleanly released');

  // 2. Hash stability
  const finalHashes = controller2.getInvariantHashes();
  assert.strictEqual(finalHashes.inputLedgerHeadHash, preCrashHashes.inputLedgerHeadHash, 'Invariant 2: human input ledger head hash unchanged');

  // 3. Zero user data loss
  assert.strictEqual(fs.readFileSync(userFile, 'utf8'), 'Documentation baseline\n', 'Invariant 3: user workspace code preserved');

  // 4. Task at-most-once completion
  const events = store.listEvents('run-v16-orphan');
  const u1Count = events.filter((e) => e.type === 'unit_completed' && e.payload?.taskId === 'u1').length;
  assert.strictEqual(u1Count, 1, 'Invariant 4: u1 completed exactly once');
  const u2Count = events.filter((e) => e.type === 'unit_completed' && e.payload?.taskId === 'u2').length;
  assert.strictEqual(u2Count, 1, 'Invariant 4: u2 completed exactly once');

  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('V16 acceptance (Invariants): intent primacy is strictly preserved across snapshot crash and reboot', async () => {
  const dataDir = makeTempDir('agent-relay-v16-intent-');
  const dbPath = path.join(dataDir, 'relay.db');
  const db = new RelayDatabase({ dbPath });
  const store = new RunStore(db);
  const intents = new ControlIntentLog(store);
  const adapter = new ScriptedAdapter();
  const notifier = new RecordingNotifier();

  let crashTriggered = false;
  const faultHook: FaultHook = (point: FaultInjectionPoint, ctx: FaultContext) => {
    if (point === 'during_snapshot_write') {
      crashTriggered = true;
      const handoffDir = path.join(dataDir, ctx.runId, 'handoffs', ctx.handoffId!);
      fs.mkdirSync(handoffDir, { recursive: true });
      fs.writeFileSync(path.join(handoffDir, 'manifest.json'), '{"corrupted": true', 'utf8');
      throw new Error('CRASH_DURING_SNAPSHOT_WRITE');
    }
  };

  const controller1 = new RunController({
    store,
    dataDir,
    adapter,
    adapterName: 'claude',
    notifier,
    faultHook,
    createCoordinator
  });

  const config: StartRunConfig = {
    runId: 'run-v16-intent',
    goal: 'Test intent primacy across crash recovery',
    workspacePath: dataDir,
    tasks: [
      { taskId: 'u1', requirementId: 'req-root', title: 'Task 1', dependencies: [] },
      { taskId: 'u2', requirementId: 'req-root', title: 'Task 2', dependencies: ['u1'] }
    ],
    model: { provider: 'anthropic', model: 'claude-3-7-sonnet', effort: 'high' },
    initialUserMessage: 'Intent primacy test message.'
  };

  controller1.startRun(config);
  await controller1.tick(); // u1 completes

  await assert.rejects(
    async () => {
      await controller1.tick();
    },
    { message: 'CRASH_DURING_SNAPSHOT_WRITE' }
  );
  assert.strictEqual(crashTriggered, true);

  // Simulate user submitting a stop_now intent during or after crash
  intents.append('run-v16-intent', 'stop_now', { reason: 'User aborts run following crash' });

  // Reboot controller
  const controller2 = new RunController({
    store,
    dataDir,
    adapter,
    adapterName: 'claude',
    notifier,
    createCoordinator
  });
  controller2.rehydrate('run-v16-intent');

  // Reconcile must purge corrupted snapshot AND honour stop_now intent
  const recResult = await controller2.reconcile();
  assert.strictEqual(recResult.recoveredState, 'CANCELLED', 'Invariant 5: recovered state must be CANCELLED');
  assert.ok(recResult.healedActions.includes('purged_corrupted_snapshot:h-run-v16-intent-1'));
  assert.ok(recResult.healedActions.includes('honoured_stop_intent'), 'Invariant 5: stop intent must be honoured');

  // Calling tick() must stay in stopped
  const tickOutcome = await controller2.tick();
  assert.strictEqual(tickOutcome.kind, 'stopped', 'Invariant 5: stopped run must not execute further units');

  // Verify task u2 was never executed
  const events = store.listEvents('run-v16-intent');
  const u2Started = events.filter(
    (e) => (e.type === 'unit_started' || e.type === 'unit_completed') && e.payload?.taskId === 'u2'
  );
  assert.strictEqual(u2Started.length, 0, 'u2 must never have started or executed');

  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('V16 acceptance (Invariants): pause state is preserved across snapshot crash and can resume', async () => {
  const dataDir = makeTempDir('agent-relay-v16-pause-');
  const dbPath = path.join(dataDir, 'relay.db');
  const db = new RelayDatabase({ dbPath });
  const store = new RunStore(db);
  const intents = new ControlIntentLog(store);
  const adapter = new ScriptedAdapter();
  const notifier = new RecordingNotifier();

  let crashTriggered = false;
  const faultHook: FaultHook = (point: FaultInjectionPoint, ctx: FaultContext) => {
    if (point === 'during_snapshot_write') {
      crashTriggered = true;
      const handoffDir = path.join(dataDir, ctx.runId, 'handoffs', ctx.handoffId!);
      fs.mkdirSync(handoffDir, { recursive: true });
      fs.writeFileSync(path.join(handoffDir, 'manifest.json'), '{"corrupted": true', 'utf8');
      throw new Error('CRASH_DURING_SNAPSHOT_WRITE');
    }
  };

  const controller1 = new RunController({
    store,
    dataDir,
    adapter,
    adapterName: 'claude',
    notifier,
    faultHook,
    createCoordinator
  });

  const config: StartRunConfig = {
    runId: 'run-v16-pause',
    goal: 'Test pause intent primacy across crash recovery',
    workspacePath: dataDir,
    tasks: [
      { taskId: 'u1', requirementId: 'req-root', title: 'Task 1', dependencies: [] },
      { taskId: 'u2', requirementId: 'req-root', title: 'Task 2', dependencies: ['u1'] }
    ],
    model: { provider: 'anthropic', model: 'claude-3-7-sonnet', effort: 'high' },
    initialUserMessage: 'Pause intent primacy test message.'
  };

  controller1.startRun(config);
  await controller1.tick(); // u1 completes

  await assert.rejects(
    async () => {
      await controller1.tick();
    },
    { message: 'CRASH_DURING_SNAPSHOT_WRITE' }
  );
  assert.strictEqual(crashTriggered, true);

  // Set paused state before restart
  store.updateRunState('run-v16-pause', 'PAUSED', { pauseReason: 'user_paused' });

  // Reboot controller
  const controller2 = new RunController({
    store,
    dataDir,
    adapter,
    adapterName: 'claude',
    notifier,
    createCoordinator
  });
  controller2.rehydrate('run-v16-pause');

  // Reconcile must purge corrupted snapshot AND preserve PAUSED state
  const recResult = await controller2.reconcile();
  assert.strictEqual(recResult.recoveredState, 'PAUSED', 'Invariant 5: recovered state must be PAUSED');
  assert.ok(recResult.healedActions.includes('purged_corrupted_snapshot:h-run-v16-pause-1'));

  // Calling tick() must stay paused
  const tickOutcome = await controller2.tick();
  assert.strictEqual(tickOutcome.kind, 'paused');

  // Now resume
  intents.append('run-v16-pause', 'resume', {});
  const resumeOutcome = await controller2.tick();
  assert.strictEqual(resumeOutcome.kind, 'handoff_performed');

  const u2Outcome = await controller2.tick();
  assert.strictEqual(u2Outcome.kind, 'unit_executed');

  const finalOutcome = await controller2.tick();
  assert.strictEqual(finalOutcome.kind, 'completed');

  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
