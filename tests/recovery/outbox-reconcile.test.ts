// tests/recovery/outbox-reconcile.test.ts
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

test('V14 acceptance: server session created but response lost recovers via outbox rebind and finishes run without duplicate worker', async () => {
  const dataDir = makeTempDir('agent-relay-v14-rebind-');
  const dbPath = path.join(dataDir, 'relay.db');
  const db = new RelayDatabase({ dbPath });
  const store = new RunStore(db);
  const adapter = new ScriptedAdapter();
  const notifier = new RecordingNotifier();

  // Create a user source file to verify zero user data loss (Invariant 3)
  const userFile = path.join(dataDir, 'src', 'calculator.ts');
  fs.mkdirSync(path.dirname(userFile), { recursive: true });
  fs.writeFileSync(userFile, 'export function add(a: number, b: number) { return a + b; }\n', 'utf8');

  let crashTriggered = false;
  const faultHook: FaultHook = (point: FaultInjectionPoint, ctx: FaultContext) => {
    if (point === 'session_create_response_lost') {
      crashTriggered = true;
      throw new Error('CRASH_SESSION_CREATE_RESPONSE_LOST');
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
    runId: 'run-v14-rebind',
    goal: 'Test V14 session creation response lost outbox reconcile',
    workspacePath: dataDir,
    tasks: [
      { taskId: 'u1', requirementId: 'req-root', title: 'Task 1', dependencies: [] },
      { taskId: 'u2', requirementId: 'req-root', title: 'Task 2', dependencies: ['u1'] }
    ],
    model: { provider: 'anthropic', model: 'claude-3-7-sonnet', effort: 'high' },
    initialUserMessage: 'Execute tasks with outbox reconcile on lost session response.'
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

  // Tick 2: handoff begins -> adapter.createFresh called -> crashes at session_create_response_lost
  await assert.rejects(
    async () => {
      await controller1.tick();
    },
    { message: 'CRASH_SESSION_CREATE_RESPONSE_LOST' }
  );
  assert.strictEqual(crashTriggered, true, 'Fault hook must have triggered crash');

  // Assert adapter state at crash time: exactly 2 sessions created (s1 and s2)
  assert.strictEqual(adapter.created.length, 2, 'Adapter must have created s1 and s2 before crash');
  assert.deepStrictEqual(adapter.created, ['run-v14-rebind-s1', 'run-v14-rebind-s2']);
  const createdCallsBeforeReboot = adapter.created.length;

  // Assert DB state before recovery
  const handoffId = 'h-run-v14-rebind-1';
  const handoffBefore = store.getHandoff(handoffId);
  assert.ok(handoffBefore, 'Handoff record must exist in DB');
  assert.strictEqual(handoffBefore!.state, 'CREATING', 'Handoff state must be CREATING at crash');
  assert.strictEqual(handoffBefore!.targetSessionId, 'run-v14-rebind-s2');

  const pendingOutbox = store.listPendingOutbox('run-v14-rebind');
  assert.strictEqual(pendingOutbox.length, 1, 'Outbox must contain pending create_session message');
  assert.strictEqual(pendingOutbox[0].topic, 'create_session');
  assert.strictEqual(pendingOutbox[0].targetSessionId, 'run-v14-rebind-s2');

  // Reboot controller
  const controller2 = new RunController({
    store,
    dataDir,
    adapter,
    adapterName: 'claude',
    notifier,
    createCoordinator
  });
  controller2.rehydrate('run-v14-rebind');

  // Invoke reconcile()
  const recResult = await controller2.reconcile();
  assert.strictEqual(recResult.requiresManualIntervention, false, 'Recovery must not require manual intervention');
  assert.strictEqual(recResult.recoveredState, 'PREPARING', 'Recovered state must be PREPARING');
  assert.ok(
    recResult.healedActions.includes('rebound_session:run-v14-rebind-s2'),
    'healedActions must record rebound_session:run-v14-rebind-s2'
  );

  // Verify invariant hashes immediately after recovery
  const postRecHashes = controller2.getInvariantHashes();
  assert.strictEqual(postRecHashes.inputLedgerHeadHash, preCrashHashes.inputLedgerHeadHash, 'Invariant 2: input ledger hash stable');
  assert.strictEqual(postRecHashes.taskSnapshotHash, preCrashHashes.taskSnapshotHash, 'Invariant 2: task snapshot hash stable');

  // Assert adapter createFresh was NOT called again (no zombie/duplicate session spawned!)
  assert.strictEqual(
    adapter.created.length,
    createdCallsBeforeReboot,
    'Must NOT duplicate session creation on reconcile'
  );

  // Assert DB states post-reconcile
  const handoffPostRec = store.getHandoff(handoffId);
  assert.strictEqual(handoffPostRec?.state, 'PREPARING', 'Handoff state must advance to PREPARING');
  const outboxPostRec = store.findOutboxByHandoff(handoffId, 'create_session');
  assert.strictEqual(outboxPostRec?.state, 'DISPATCHED', 'Outbox state must be DISPATCHED');

  // Advance controller2: tick() resumes the handoff from PREPARING, parses ACK, completes CAS lease and authorizes execution
  const handoffOutcome = await controller2.tick();
  assert.strictEqual(handoffOutcome.kind, 'handoff_performed', 'controller.tick() must complete resumed handoff');
  assert.strictEqual((handoffOutcome as { handoffId: string }).handoffId, handoffId);

  // Assert handoff and outbox are COMPLETED and ACKED
  assert.strictEqual(store.getHandoff(handoffId)?.state, 'COMPLETED');
  assert.strictEqual(store.findOutboxByHandoff(handoffId, 'create_session')?.state, 'ACKED');

  // Verify Invariant 1: Single valid writer during execution of unit 2
  const wsKey = normalizeWorkspaceKey(dataDir);
  const leaseDuring = store.getLeaseRow(wsKey);
  assert.ok(leaseDuring, 'Invariant 1: lease must exist during execution');
  assert.strictEqual(leaseDuring!.currentOwner, 'run-v14-rebind-s2', 'Invariant 1: currentOwner is session 2');
  assert.strictEqual(leaseDuring!.epoch, 2, 'Invariant 1: epoch strictly incremented to 2');

  // Advance unit u2
  const u2Outcome = await controller2.tick();
  assert.strictEqual(u2Outcome.kind, 'unit_executed');
  assert.strictEqual((u2Outcome as { taskId: string }).taskId, 'u2');

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
  assert.strictEqual(
    fs.readFileSync(userFile, 'utf8'),
    'export function add(a: number, b: number) { return a + b; }\n',
    'Invariant 3: user workspace code preserved intact'
  );

  // 4. Task at-most-once completion
  const events = store.listEvents('run-v14-rebind');
  const u1Completed = events.filter((e) => e.type === 'unit_completed' && e.payload?.taskId === 'u1');
  assert.strictEqual(u1Completed.length, 1, 'Invariant 4: u1 completed exactly once');
  const u2Completed = events.filter((e) => e.type === 'unit_completed' && e.payload?.taskId === 'u2');
  assert.strictEqual(u2Completed.length, 1, 'Invariant 4: u2 completed exactly once');

  // Ensure total created sessions is strictly 2 throughout entire run lifecycle
  assert.strictEqual(adapter.created.length, 2, 'Total sessions created must strictly equal 2 (zero duplicate workers)');

  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('V17 acceptance: crash after owner CAS replays idempotent execution token with identical epoch and completes chain', async () => {
  const dataDir = makeTempDir('agent-relay-v17-token-');
  const dbPath = path.join(dataDir, 'relay.db');
  const db = new RelayDatabase({ dbPath });
  const store = new RunStore(db);
  const adapter = new ScriptedAdapter();
  const notifier = new RecordingNotifier();

  // Create a user source file to verify zero user data loss (Invariant 3)
  const userFile = path.join(dataDir, 'src', 'database.ts');
  fs.mkdirSync(path.dirname(userFile), { recursive: true });
  fs.writeFileSync(userFile, 'export const dbConfig = { host: "localhost", port: 5432 };\n', 'utf8');

  let crashTriggered = false;
  let epochAtCrash: number | undefined;
  const faultHook: FaultHook = (point: FaultInjectionPoint, ctx: FaultContext) => {
    if (point === 'after_owner_cas') {
      crashTriggered = true;
      epochAtCrash = ctx.epoch;
      throw new Error('CRASH_AFTER_OWNER_CAS');
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
    runId: 'run-v17-token',
    goal: 'Test V17 token replay after owner CAS crash',
    workspacePath: dataDir,
    tasks: [
      { taskId: 'u1', requirementId: 'req-root', title: 'Task 1', dependencies: [] },
      { taskId: 'u2', requirementId: 'req-root', title: 'Task 2', dependencies: ['u1'] }
    ],
    model: { provider: 'anthropic', model: 'claude-3-7-sonnet', effort: 'high' },
    initialUserMessage: 'Execute tasks with idempotent token replay after owner CAS crash.'
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

  // Tick 2: handoff begins -> Step 7 CAS completes -> crashes at after_owner_cas
  await assert.rejects(
    async () => {
      await controller1.tick();
    },
    { message: 'CRASH_AFTER_OWNER_CAS' }
  );
  assert.strictEqual(crashTriggered, true, 'Fault hook must have triggered crash after owner CAS');
  assert.strictEqual(epochAtCrash, 2, 'Epoch at CAS must be 2');

  const handoffId = 'h-run-v17-token-1';
  const targetSessionId = 'run-v17-token-s2';

  // Assert DB state before recovery:
  // 1. handoff state is AUTHORIZED
  const handoffBefore = store.getHandoff(handoffId);
  assert.ok(handoffBefore, 'Handoff record must exist in DB');
  assert.strictEqual(handoffBefore!.state, 'AUTHORIZED', 'Handoff state must be AUTHORIZED at crash');
  assert.strictEqual(handoffBefore!.targetSessionId, targetSessionId);

  // 2. session_chain does NOT have targetSessionId yet (Step 8 token delivery did not complete)
  const chainBefore = store.listChain('run-v17-token');
  const targetInChainBefore = chainBefore.some((c) => c.nextSessionId === targetSessionId);
  assert.strictEqual(targetInChainBefore, false, 'Session chain must NOT yet include targetSessionId before token replay');

  // 3. Lease owner is already targetSessionId with epoch 2 (CAS succeeded)
  const wsKey = normalizeWorkspaceKey(dataDir);
  const leaseBefore = store.getLeaseRow(wsKey);
  assert.ok(leaseBefore, 'Lease row must exist in DB');
  assert.strictEqual(leaseBefore!.currentOwner, targetSessionId);
  assert.strictEqual(leaseBefore!.epoch, 2);

  // 4. Outbox message is still DISPATCHED (not ACKED)
  const outboxBefore = store.findOutboxByHandoff(handoffId, 'create_session');
  assert.ok(outboxBefore);
  assert.strictEqual(outboxBefore!.state, 'DISPATCHED');

  // Record adapter authorizations for targetSessionId before reboot
  const targetAuthorizationsBefore = adapter.authorizations.filter((a) => a.sessionId === targetSessionId).length;
  assert.strictEqual(targetAuthorizationsBefore, 0, 'No authorizeExecution call for target session before crash at after_owner_cas');

  // Reboot controller
  const controller2 = new RunController({
    store,
    dataDir,
    adapter,
    adapterName: 'claude',
    notifier,
    createCoordinator
  });
  controller2.rehydrate('run-v17-token');

  // Invoke reconcile()
  const recResult = await controller2.reconcile();
  assert.strictEqual(recResult.requiresManualIntervention, false, 'Recovery must not require manual intervention');
  assert.strictEqual(recResult.recoveredState, 'RUNNING', 'Recovered state must be restored to RUNNING');
  assert.ok(
    recResult.healedActions.includes(`replayed_execution_token:${targetSessionId}`),
    'healedActions must record replayed_execution_token'
  );

  // Verify invariant hashes immediately after recovery
  const postRecHashes = controller2.getInvariantHashes();
  assert.strictEqual(postRecHashes.inputLedgerHeadHash, preCrashHashes.inputLedgerHeadHash, 'Invariant 2: input ledger hash stable');
  assert.strictEqual(postRecHashes.taskSnapshotHash, preCrashHashes.taskSnapshotHash, 'Invariant 2: task snapshot hash stable');

  // Verify adapter received authorizeExecution call with matching epoch (2)
  const targetAuthorizationsAfter = adapter.authorizations.filter((a) => a.sessionId === targetSessionId);
  assert.strictEqual(targetAuthorizationsAfter.length, 1, 'Target session must have received 1 authorizeExecution call');
  assert.strictEqual(targetAuthorizationsAfter[0].sessionId, targetSessionId);
  assert.strictEqual(targetAuthorizationsAfter[0].epoch, 2, 'Replayed token must carry identical epoch 2');
  assert.ok(targetAuthorizationsAfter[0].token, 'Token string must be present');

  // Verify session_chain appended targetSessionId and superseded sourceSessionId
  const chainAfter = store.listChain('run-v17-token');
  const targetLink = chainAfter.find((c) => c.nextSessionId === targetSessionId);
  assert.ok(targetLink, 'Session chain must now contain targetSessionId link');
  assert.strictEqual(targetLink!.prevSessionId, 'run-v17-token-s1');
  assert.strictEqual(targetLink!.epoch, 2);

  const sourceLink = chainAfter.find((c) => c.nextSessionId === 'run-v17-token-s1');
  assert.ok(sourceLink, 'Source link must exist in chain');
  assert.ok(sourceLink!.supersededAt, 'Source session must be marked superseded with timestamp');

  // Verify handoff state is COMPLETED and outbox is ACKED
  assert.strictEqual(store.getHandoff(handoffId)?.state, 'COMPLETED');
  assert.strictEqual(store.findOutboxByHandoff(handoffId, 'create_session')?.state, 'ACKED');

  // Verify run state is RUNNING
  const runPostRec = store.getRun('run-v17-token');
  assert.strictEqual(runPostRec?.state, 'RUNNING');
  assert.strictEqual(runPostRec?.currentSessionId, targetSessionId);

  // Advance unit u2
  const u2Outcome = await controller2.tick();
  assert.strictEqual(u2Outcome.kind, 'unit_executed');
  assert.strictEqual((u2Outcome as { taskId: string }).taskId, 'u2');

  // Verify Invariant 1: Single valid writer during unit 2 execution
  const leaseDuring = store.getLeaseRow(wsKey);
  assert.ok(leaseDuring, 'Invariant 1: lease must exist during execution');
  assert.strictEqual(leaseDuring!.currentOwner, targetSessionId, 'Invariant 1: currentOwner matches active session');
  assert.strictEqual(leaseDuring!.epoch, 2, 'Invariant 1: epoch is 2');

  // Settle run
  const finalOutcome = await controller2.tick();
  assert.strictEqual(finalOutcome.kind, 'completed');

  // Verify 5 Mechanical Invariants
  // 1. Single valid writer after completion (lease cleanly released)
  const finalLease = store.getLeaseRow(wsKey);
  assert.strictEqual(finalLease, undefined, 'Invariant 1: lease cleanly released upon completion');

  // 2. Hash stability
  const finalHashes = controller2.getInvariantHashes();
  assert.strictEqual(finalHashes.inputLedgerHeadHash, preCrashHashes.inputLedgerHeadHash, 'Invariant 2: input ledger hash unchanged');

  // 3. Zero user data loss
  assert.strictEqual(
    fs.readFileSync(userFile, 'utf8'),
    'export const dbConfig = { host: "localhost", port: 5432 };\n',
    'Invariant 3: user workspace code preserved intact'
  );

  // 4. Task at-most-once completion
  const events = store.listEvents('run-v17-token');
  const u1Completed = events.filter((e) => e.type === 'unit_completed' && e.payload?.taskId === 'u1');
  assert.strictEqual(u1Completed.length, 1, 'Invariant 4: u1 completed exactly once');
  const u2Completed = events.filter((e) => e.type === 'unit_completed' && e.payload?.taskId === 'u2');
  assert.strictEqual(u2Completed.length, 1, 'Invariant 4: u2 completed exactly once');

  // Total sessions created is strictly 2 (no duplicate worker spawned)
  assert.strictEqual(adapter.created.length, 2, 'Total sessions created must strictly equal 2');

  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('V14 & V17 Invariant 5: control intent (stop_now) has highest priority when injected following crash', async () => {
  const dataDir = makeTempDir('agent-relay-invariants-intent-');
  const dbPath = path.join(dataDir, 'relay.db');
  const db = new RelayDatabase({ dbPath });
  const store = new RunStore(db);
  const intents = new ControlIntentLog(store);
  const adapter = new ScriptedAdapter();
  const notifier = new RecordingNotifier();

  const userFile = path.join(dataDir, 'data.txt');
  fs.writeFileSync(userFile, 'critical user data\n', 'utf8');

  let crashTriggered = false;
  const faultHook: FaultHook = (point: FaultInjectionPoint, ctx: FaultContext) => {
    if (point === 'session_create_response_lost') {
      crashTriggered = true;
      throw new Error('CRASH_FOR_INTENT_TEST');
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
    runId: 'run-inv-intent',
    goal: 'Test Invariant 5 intent primacy on recovery',
    workspacePath: dataDir,
    tasks: [
      { taskId: 'u1', requirementId: 'req-root', title: 'Task 1', dependencies: [] },
      { taskId: 'u2', requirementId: 'req-root', title: 'Task 2', dependencies: ['u1'] }
    ],
    model: { provider: 'anthropic', model: 'claude-3-7-sonnet', effort: 'high' },
    initialUserMessage: 'Intent primacy test.'
  };

  controller1.startRun(config);
  await controller1.tick(); // u1 completes

  await assert.rejects(
    async () => {
      await controller1.tick();
    },
    { message: 'CRASH_FOR_INTENT_TEST' }
  );
  assert.strictEqual(crashTriggered, true);

  // User submits stop_now intent before or during reboot
  intents.append('run-inv-intent', 'stop_now', { reason: 'User aborted run after crash' });

  // Reboot controller
  const controller2 = new RunController({
    store,
    dataDir,
    adapter,
    adapterName: 'claude',
    notifier,
    createCoordinator
  });
  controller2.rehydrate('run-inv-intent');

  // Reconcile must honour stop_now intent with highest priority
  const recResult = await controller2.reconcile();
  assert.strictEqual(recResult.recoveredState, 'CANCELLED', 'Invariant 5: recovered state must be CANCELLED');
  assert.ok(recResult.healedActions.includes('honoured_stop_intent'), 'Invariant 5: stop intent must be honoured');

  // Calling tick() must stay in stopped state
  const tickOutcome = await controller2.tick();
  assert.strictEqual(tickOutcome.kind, 'stopped', 'Invariant 5: stopped run must not execute further units');

  // Verify task u2 was never executed
  const events = store.listEvents('run-inv-intent');
  const u2Completed = events.filter((e) => e.type === 'unit_completed' && e.payload?.taskId === 'u2');
  assert.strictEqual(u2Completed.length, 0, 'Invariant 5: u2 was never executed after cancel');

  // User data intact
  assert.strictEqual(fs.readFileSync(userFile, 'utf8'), 'critical user data\n', 'Invariant 3: user data intact');

  // Lease cleanly released
  const wsKey = normalizeWorkspaceKey(dataDir);
  assert.strictEqual(store.getLeaseRow(wsKey), undefined, 'Invariant 1: lease released on cancel');

  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('V17 Invariant 5: control intent (stop_now) following after_owner_cas crash halts in CANCELLED and invalidates execution token', async () => {
  const dataDir = makeTempDir('agent-relay-v17-intent-');
  const dbPath = path.join(dataDir, 'relay.db');
  const db = new RelayDatabase({ dbPath });
  const store = new RunStore(db);
  const intents = new ControlIntentLog(store);
  const adapter = new ScriptedAdapter();
  const notifier = new RecordingNotifier();

  const userFile = path.join(dataDir, 'src', 'app.ts');
  fs.mkdirSync(path.dirname(userFile), { recursive: true });
  fs.writeFileSync(userFile, 'console.log("App startup");\n', 'utf8');

  let crashTriggered = false;
  const faultHook: FaultHook = (point: FaultInjectionPoint, ctx: FaultContext) => {
    if (point === 'after_owner_cas') {
      crashTriggered = true;
      throw new Error('CRASH_AFTER_OWNER_CAS_FOR_INTENT');
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
    runId: 'run-v17-intent',
    goal: 'Test V17 intent primacy after CAS crash',
    workspacePath: dataDir,
    tasks: [
      { taskId: 'u1', requirementId: 'req-root', title: 'Task 1', dependencies: [] },
      { taskId: 'u2', requirementId: 'req-root', title: 'Task 2', dependencies: ['u1'] }
    ],
    model: { provider: 'anthropic', model: 'claude-3-7-sonnet', effort: 'high' },
    initialUserMessage: 'Execute pipeline.'
  };

  controller1.startRun(config);
  await controller1.tick(); // u1 completes

  await assert.rejects(
    async () => {
      await controller1.tick();
    },
    { message: 'CRASH_AFTER_OWNER_CAS_FOR_INTENT' }
  );
  assert.strictEqual(crashTriggered, true);

  // User submits stop_now intent after crash
  intents.append('run-v17-intent', 'stop_now', { reason: 'User halts run following after_owner_cas crash' });

  // Reboot controller
  const controller2 = new RunController({
    store,
    dataDir,
    adapter,
    adapterName: 'claude',
    notifier,
    createCoordinator
  });
  controller2.rehydrate('run-v17-intent');

  // Reconcile must honour stop_now intent first
  const recResult = await controller2.reconcile();
  assert.strictEqual(recResult.recoveredState, 'CANCELLED', 'Invariant 5: recovered state must be CANCELLED');
  assert.ok(recResult.healedActions.includes('honoured_stop_intent'), 'Invariant 5: stop intent must be honoured');

  // Verify tick() remains stopped
  const tickOutcome = await controller2.tick();
  assert.strictEqual(tickOutcome.kind, 'stopped', 'Invariant 5: tick() must stay in stopped');

  // Lease cleanly released
  const wsKey = normalizeWorkspaceKey(dataDir);
  assert.strictEqual(store.getLeaseRow(wsKey), undefined, 'Invariant 1: lease released on cancel');

  // User file intact
  assert.strictEqual(fs.readFileSync(userFile, 'utf8'), 'console.log("App startup");\n', 'Invariant 3: user code intact');

  // u2 was never executed
  const events = store.listEvents('run-v17-intent');
  const u2Completed = events.filter((e) => e.type === 'unit_completed' && e.payload?.taskId === 'u2');
  assert.strictEqual(u2Completed.length, 0, 'Invariant 4: u2 was never executed');

  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('V17 acceptance: idempotent reconcile() re-invocation does not duplicate chain links or repeat authorization', async () => {
  const dataDir = makeTempDir('agent-relay-v17-idempotent-');
  const dbPath = path.join(dataDir, 'relay.db');
  const db = new RelayDatabase({ dbPath });
  const store = new RunStore(db);
  const adapter = new ScriptedAdapter();
  const notifier = new RecordingNotifier();

  let crashTriggered = false;
  const faultHook: FaultHook = (point: FaultInjectionPoint, ctx: FaultContext) => {
    if (point === 'after_owner_cas') {
      crashTriggered = true;
      throw new Error('CRASH_AFTER_OWNER_CAS_IDEMPOTENT');
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
    runId: 'run-v17-idem',
    goal: 'Test V17 idempotency',
    workspacePath: dataDir,
    tasks: [
      { taskId: 'u1', requirementId: 'req-root', title: 'Task 1', dependencies: [] },
      { taskId: 'u2', requirementId: 'req-root', title: 'Task 2', dependencies: ['u1'] }
    ],
    model: { provider: 'anthropic', model: 'claude-3-7-sonnet', effort: 'high' },
    initialUserMessage: 'Execute pipeline.'
  };

  controller1.startRun(config);
  await controller1.tick(); // u1 completes

  await assert.rejects(
    async () => {
      await controller1.tick();
    },
    { message: 'CRASH_AFTER_OWNER_CAS_IDEMPOTENT' }
  );
  assert.strictEqual(crashTriggered, true);

  const controller2 = new RunController({
    store,
    dataDir,
    adapter,
    adapterName: 'claude',
    notifier,
    createCoordinator
  });
  controller2.rehydrate('run-v17-idem');

  // First reconcile: heals V17
  const rec1 = await controller2.reconcile();
  assert.strictEqual(rec1.recoveredState, 'RUNNING');
  assert.ok(rec1.healedActions.includes('replayed_execution_token:run-v17-idem-s2'));

  const chainAfterRec1 = store.listChain('run-v17-idem');
  assert.strictEqual(chainAfterRec1.length, 2, 'Chain must have exactly 2 links (s1 and s2)');
  const targetAuthorizations1 = adapter.authorizations.filter((a) => a.sessionId === 'run-v17-idem-s2').length;
  assert.strictEqual(targetAuthorizations1, 1, 'Target session must have 1 authorization');

  // Second reconcile immediately after: idempotent, no-op
  const rec2 = await controller2.reconcile();
  assert.strictEqual(rec2.recoveredState, 'RUNNING');
  assert.strictEqual(rec2.requiresManualIntervention, false);

  const chainAfterRec2 = store.listChain('run-v17-idem');
  assert.strictEqual(chainAfterRec2.length, 2, 'Chain must still have exactly 2 links (zero duplicates)');
  const targetAuthorizations2 = adapter.authorizations.filter((a) => a.sessionId === 'run-v17-idem-s2').length;
  assert.strictEqual(targetAuthorizations2, 1, 'Target session must still have exactly 1 authorization');

  // Advance to completion
  await controller2.tick(); // u2
  const finalOutcome = await controller2.tick(); // complete
  assert.strictEqual(finalOutcome.kind, 'completed');

  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
