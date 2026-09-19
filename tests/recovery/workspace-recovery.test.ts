// tests/recovery/workspace-recovery.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
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

function initGitRepo(dir: string): void {
  execSync('git init -b main', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.name "Tester"', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.email "tester@example.com"', { cwd: dir, stdio: 'ignore' });
}

function createCoordinator(deps: any) {
  return new TwoPhaseHandshakeCoordinator(
    deps.stateMachine as HandoffStateMachine,
    deps.leaseManager as unknown as WorkspaceLeaseManager,
    deps.workspaceKey
  );
}

test('V25 acceptance: Scenario 1, 3 & 4 - external branch switch and commit drift triggers RECOVERY_REQUIRED without destructive git reset, and heals cleanly upon checkout back', async () => {
  const workspaceDir = makeTempDir('agent-relay-v25-branch-ws-');
  const dataDir = makeTempDir('agent-relay-v25-branch-data-');
  const dbPath = path.join(dataDir, 'relay.db');

  initGitRepo(workspaceDir);

  // Commit baseline file
  const baseFile = path.join(workspaceDir, 'src', 'index.ts');
  fs.mkdirSync(path.dirname(baseFile), { recursive: true });
  fs.writeFileSync(baseFile, 'export const base = 1;\n', 'utf8');
  execSync('git add . && git commit -m "baseline commit"', { cwd: workspaceDir, stdio: 'ignore' });
  const baselineCommit = execSync('git rev-parse HEAD', { cwd: workspaceDir, encoding: 'utf8' }).trim();

  const db = new RelayDatabase({ dbPath });
  const store = new RunStore(db);
  const adapter = new ScriptedAdapter();
  const notifier = new RecordingNotifier();

  let crashTriggered = false;
  const faultHook: FaultHook = (point: FaultInjectionPoint, ctx: FaultContext) => {
    if (point === 'during_readonly_prep') {
      crashTriggered = true;
      throw new Error('SIMULATED_CRASH_DURING_HANDOFF');
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
    runId: 'run-v25-branch',
    goal: 'Test V25 workspace branch mismatch and safe recovery',
    workspacePath: workspaceDir,
    tasks: [
      { taskId: 'u1', requirementId: 'req-root', title: 'Task 1', dependencies: [] },
      { taskId: 'u2', requirementId: 'req-root', title: 'Task 2', dependencies: ['u1'] }
    ],
    model: { provider: 'anthropic', model: 'claude-3-7-sonnet', effort: 'high' },
    initialUserMessage: 'Execute tasks with strict workspace fingerprint defense against external git drift.'
  };

  controller1.startRun(config);

  // Tick 1: execute unit u1
  const outcome1 = await controller1.tick();
  assert.strictEqual(outcome1.kind, 'unit_executed');
  assert.strictEqual((outcome1 as { taskId: string }).taskId, 'u1');

  // Capture invariant hashes before crash
  const preCrashHashes = controller1.getInvariantHashes();
  assert.ok(preCrashHashes.inputLedgerHeadHash);
  assert.ok(preCrashHashes.taskSnapshotHash);

  // Tick 2: handoff begins -> crashes at during_readonly_prep
  await assert.rejects(
    async () => {
      await controller1.tick();
    },
    { message: 'SIMULATED_CRASH_DURING_HANDOFF' }
  );
  assert.strictEqual(crashTriggered, true, 'Fault hook must trigger simulated crash');

  // Assert DB state before recovery
  const handoffId = 'h-run-v25-branch-1';
  const handoffBefore = store.getHandoff(handoffId);
  assert.ok(handoffBefore, 'Handoff record must exist in DB');
  assert.strictEqual(handoffBefore!.state, 'CREATING');

  // ---------------------------------------------------------------------------
  // Scenario 1: Simulate external user switching branch and creating a new commit
  // ---------------------------------------------------------------------------
  execSync('git checkout -b user-feature-branch', { cwd: workspaceDir, stdio: 'ignore' });
  const featureFile = path.join(workspaceDir, 'src', 'feature.ts');
  fs.writeFileSync(featureFile, 'export const userFeature = 42;\n', 'utf8');
  execSync('git add . && git commit -m "user custom feature on new branch"', { cwd: workspaceDir, stdio: 'ignore' });
  const driftedCommit = execSync('git rev-parse HEAD', { cwd: workspaceDir, encoding: 'utf8' }).trim();
  assert.notStrictEqual(driftedCommit, baselineCommit, 'HEAD commit must have drifted from baseline');

  // Reboot controller
  const controller2 = new RunController({
    store,
    dataDir,
    adapter,
    adapterName: 'claude',
    notifier,
    createCoordinator
  });
  controller2.rehydrate('run-v25-branch');

  // Invoke reconcile() - must detect fingerprint mismatch!
  const recResult = await controller2.reconcile();
  assert.strictEqual(recResult.recoveredState, 'RECOVERY_REQUIRED');
  assert.strictEqual(recResult.requiresManualIntervention, true);
  assert.strictEqual(recResult.reason, 'workspace_fingerprint_mismatch');

  // Verify discrepancy details
  assert.strictEqual(recResult.discrepancyDetails?.expectedCommit, baselineCommit);
  assert.strictEqual(recResult.discrepancyDetails?.actualCommit, driftedCommit);

  // Verify structured event recorded
  const mismatchEvent = store.listEvents('run-v25-branch').find((e) => e.type === 'workspace_mismatch_detected');
  assert.ok(mismatchEvent, 'Structured event workspace_mismatch_detected must be logged');
  assert.strictEqual(mismatchEvent!.payload?.expectedCommit, baselineCommit);
  assert.strictEqual(mismatchEvent!.payload?.actualCommit, driftedCommit);

  // Task and checkpoint state must remain uncorrupted
  const postMismatchHashes = controller2.getInvariantHashes();
  assert.strictEqual(postMismatchHashes.inputLedgerHeadHash, preCrashHashes.inputLedgerHeadHash);
  assert.strictEqual(postMismatchHashes.taskSnapshotHash, preCrashHashes.taskSnapshotHash);

  // CORE IRONCLAD ASSERTION: Controller must NEVER call git checkout main or git reset!
  const currentBranch = execSync('git branch --show-current', { cwd: workspaceDir, encoding: 'utf8' }).trim();
  assert.strictEqual(currentBranch, 'user-feature-branch', 'Current git branch must remain user-feature-branch');
  const currentHead = execSync('git rev-parse HEAD', { cwd: workspaceDir, encoding: 'utf8' }).trim();
  assert.strictEqual(currentHead, driftedCommit, 'HEAD commit must remain the user drifted commit');
  assert.strictEqual(
    fs.readFileSync(featureFile, 'utf8'),
    'export const userFeature = 42;\n',
    'User authored feature code must be preserved intact'
  );

  // Controller tick while RECOVERY_REQUIRED halts safely without acting
  const tickOutcomeWhileRecovery = await controller2.tick();
  assert.strictEqual(tickOutcomeWhileRecovery.kind, 'recovery_required');
  assert.strictEqual(tickOutcomeWhileRecovery.reason, 'workspace_fingerprint_mismatch');

  // Invariant 1: Single writer lease has not been expanded or transferred
  const wsKey = normalizeWorkspaceKey(workspaceDir);
  const leaseWhileBlocked = store.getLeaseRow(wsKey);
  assert.ok(leaseWhileBlocked, 'Lease row exists');
  assert.strictEqual(leaseWhileBlocked!.currentOwner, 'run-v25-branch-s1', 'Lease was NOT transferred to session 2');
  assert.strictEqual(leaseWhileBlocked!.epoch, 1, 'Epoch was NOT incremented');

  // ---------------------------------------------------------------------------
  // Scenario 3: Human resolves the mismatch by switching back to baseline branch
  // ---------------------------------------------------------------------------
  execSync('git checkout main', { cwd: workspaceDir, stdio: 'ignore' });
  const restoredCommit = execSync('git rev-parse HEAD', { cwd: workspaceDir, encoding: 'utf8' }).trim();
  assert.strictEqual(restoredCommit, baselineCommit, 'Commit matches baseline after switching back to main');

  // Reconcile again: must detect fingerprint match and smoothly heal to PREPARING!
  const recResult2 = await controller2.reconcile();
  assert.strictEqual(recResult2.requiresManualIntervention, false);
  assert.strictEqual(recResult2.recoveredState, 'PREPARING');
  assert.ok(
    recResult2.healedActions.includes('resolved_workspace_mismatch'),
    'healedActions must record resolved_workspace_mismatch'
  );

  // Invariant 2: Hash stability immediately upon recovery
  const postRecHashes = controller2.getInvariantHashes();
  assert.strictEqual(
    postRecHashes.inputLedgerHeadHash,
    preCrashHashes.inputLedgerHeadHash,
    'Invariant 2: input ledger hash stable post-recovery'
  );
  assert.strictEqual(
    postRecHashes.taskSnapshotHash,
    preCrashHashes.taskSnapshotHash,
    'Invariant 2: task snapshot hash stable post-recovery'
  );

  // Resume handoff via controller.tick()
  const handoffOutcome = await controller2.tick();
  assert.strictEqual(handoffOutcome.kind, 'handoff_performed');
  assert.strictEqual((handoffOutcome as { handoffId: string }).handoffId, handoffId);

  // Invariant 1: Single valid writer during active session execution of unit 2
  const leaseDuringU2 = store.getLeaseRow(wsKey);
  assert.ok(leaseDuringU2);
  assert.strictEqual(leaseDuringU2!.currentOwner, 'run-v25-branch-s2');
  assert.strictEqual(leaseDuringU2!.epoch, 2);

  // Advance unit u2
  const u2Outcome = await controller2.tick();
  assert.strictEqual(u2Outcome.kind, 'unit_executed');
  assert.strictEqual((u2Outcome as { taskId: string }).taskId, 'u2');

  // Settle run
  const finalOutcome = await controller2.tick();
  assert.strictEqual(finalOutcome.kind, 'completed');

  // ---------------------------------------------------------------------------
  // Scenario 4: All 5 Mechanical Recovery Invariants
  // ---------------------------------------------------------------------------
  // 1. Single valid writer after completion (lease cleanly released)
  const finalLease = store.getLeaseRow(wsKey);
  assert.strictEqual(finalLease, undefined, 'Invariant 1: lease is cleanly released upon completion');

  // 2. Hash stability
  const finalHashes = controller2.getInvariantHashes();
  assert.strictEqual(
    finalHashes.inputLedgerHeadHash,
    preCrashHashes.inputLedgerHeadHash,
    'Invariant 2: human input ledger head hash unchanged'
  );

  // 3. Zero user data loss
  assert.strictEqual(
    fs.readFileSync(baseFile, 'utf8'),
    'export const base = 1;\n',
    'Invariant 3: base file intact'
  );
  // User branch user-feature-branch still exists in Git history!
  const allBranches = execSync('git branch', { cwd: workspaceDir, encoding: 'utf8' });
  assert.ok(allBranches.includes('user-feature-branch'), 'Invariant 3: user branch was preserved');
  const featureOnBranch = execSync('git show user-feature-branch:src/feature.ts', { cwd: workspaceDir, encoding: 'utf8' });
  assert.strictEqual(featureOnBranch, 'export const userFeature = 42;\n', 'Invariant 3: user feature commit intact');

  // 4. Task at-most-once completion
  const events = store.listEvents('run-v25-branch');
  const u1Completed = events.filter((e) => e.type === 'unit_completed' && e.payload?.taskId === 'u1');
  assert.strictEqual(u1Completed.length, 1, 'Invariant 4: u1 completed exactly once');
  const u2Completed = events.filter((e) => e.type === 'unit_completed' && e.payload?.taskId === 'u2');
  assert.strictEqual(u2Completed.length, 1, 'Invariant 4: u2 completed exactly once');

  db.close();
  fs.rmSync(workspaceDir, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('V25 acceptance: Scenario 2 & 4 - external untracked file addition and dirty modifications trigger RECOVERY_REQUIRED with zero file loss and safe resumption', async () => {
  const workspaceDir = makeTempDir('agent-relay-v25-dirty-ws-');
  const dataDir = makeTempDir('agent-relay-v25-dirty-data-');
  const dbPath = path.join(dataDir, 'relay.db');

  initGitRepo(workspaceDir);

  // Commit baseline service file
  const serviceFile = path.join(workspaceDir, 'src', 'service.ts');
  fs.mkdirSync(path.dirname(serviceFile), { recursive: true });
  fs.writeFileSync(serviceFile, 'export class Service { run() { return true; } }\n', 'utf8');
  execSync('git add . && git commit -m "initial baseline service"', { cwd: workspaceDir, stdio: 'ignore' });

  const db = new RelayDatabase({ dbPath });
  const store = new RunStore(db);
  const adapter = new ScriptedAdapter();
  const notifier = new RecordingNotifier();

  let crashTriggered = false;
  const faultHook: FaultHook = (point: FaultInjectionPoint, ctx: FaultContext) => {
    if (point === 'during_readonly_prep') {
      crashTriggered = true;
      throw new Error('SIMULATED_CRASH_BEFORE_HANDOFF');
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
    runId: 'run-v25-dirty',
    goal: 'Test V25 untracked and dirty files defense',
    workspacePath: workspaceDir,
    tasks: [
      { taskId: 'u1', requirementId: 'req-root', title: 'Task 1', dependencies: [] },
      { taskId: 'u2', requirementId: 'req-root', title: 'Task 2', dependencies: ['u1'] }
    ],
    model: { provider: 'anthropic', model: 'claude-3-7-sonnet', effort: 'high' },
    initialUserMessage: 'Execute tasks with strict zero data loss defense against untracked and modified files.'
  };

  controller1.startRun(config);

  // Tick 1: execute unit u1
  const outcome1 = await controller1.tick();
  assert.strictEqual(outcome1.kind, 'unit_executed');
  assert.strictEqual((outcome1 as { taskId: string }).taskId, 'u1');

  // Capture invariant hashes before crash
  const preCrashHashes = controller1.getInvariantHashes();

  // Tick 2: handoff begins -> crashes at during_readonly_prep
  await assert.rejects(
    async () => {
      await controller1.tick();
    },
    { message: 'SIMULATED_CRASH_BEFORE_HANDOFF' }
  );
  assert.strictEqual(crashTriggered, true);

  // ---------------------------------------------------------------------------
  // Scenario 2: User adds an untracked doc and modifies the existing service.ts
  // ---------------------------------------------------------------------------
  const untrackedDoc = path.join(workspaceDir, 'untracked-user-doc.md');
  const importantDocContent = '# Human Architecture Notes\nCRITICAL: Do NOT delete this document under any circumstances.\n';
  fs.writeFileSync(untrackedDoc, importantDocContent, 'utf8');

  const modifiedServiceContent = 'export class Service { run() { return "user manual override"; } }\n';
  fs.writeFileSync(serviceFile, modifiedServiceContent, 'utf8');

  // Reboot controller
  const controller2 = new RunController({
    store,
    dataDir,
    adapter,
    adapterName: 'claude',
    notifier,
    createCoordinator
  });
  controller2.rehydrate('run-v25-dirty');

  // Invoke reconcile() - must detect treeHash mismatch due to untracked and dirty files!
  const recResult = await controller2.reconcile();
  assert.strictEqual(recResult.recoveredState, 'RECOVERY_REQUIRED');
  assert.strictEqual(recResult.requiresManualIntervention, true);
  assert.strictEqual(recResult.reason, 'workspace_fingerprint_mismatch');

  // Verify discrepancy details
  assert.ok(recResult.discrepancyDetails);
  const untracked = recResult.discrepancyDetails.newUntrackedFiles as string[];
  const dirty = recResult.discrepancyDetails.newDirtyFiles as string[];
  assert.ok(untracked.includes('untracked-user-doc.md'), 'Must detect untracked-user-doc.md');
  assert.ok(dirty.some((f) => f.includes('src/service.ts') || f.includes('src\\service.ts')), 'Must detect modified service.ts');

  // CORE IRONCLAD ASSERTION: Zero files overwritten, discarded or reset!
  assert.strictEqual(fs.existsSync(untrackedDoc), true, 'Untracked user doc must NOT be deleted');
  assert.strictEqual(
    fs.readFileSync(untrackedDoc, 'utf8'),
    importantDocContent,
    'Untracked user doc content must be preserved verbatim'
  );
  assert.strictEqual(
    fs.readFileSync(serviceFile, 'utf8'),
    modifiedServiceContent,
    'Modified service.ts must NOT be reset by git reset --hard or git stash'
  );

  // Invariant 1: Single writer lease has not been expanded
  const wsKey = normalizeWorkspaceKey(workspaceDir);
  const leaseWhileBlocked = store.getLeaseRow(wsKey);
  assert.ok(leaseWhileBlocked);
  assert.strictEqual(leaseWhileBlocked!.currentOwner, 'run-v25-dirty-s1');
  assert.strictEqual(leaseWhileBlocked!.epoch, 1);

  // ---------------------------------------------------------------------------
  // Human resolves the mismatch: cleans up temporary dirty changes to match baseline
  // ---------------------------------------------------------------------------
  fs.rmSync(untrackedDoc);
  execSync('git checkout -- src/service.ts', { cwd: workspaceDir, stdio: 'ignore' });

  // Reconcile again: successfully heals to PREPARING!
  const recResult2 = await controller2.reconcile();
  assert.strictEqual(recResult2.requiresManualIntervention, false);
  assert.strictEqual(recResult2.recoveredState, 'PREPARING');
  assert.ok(recResult2.healedActions.includes('resolved_workspace_mismatch'));

  // Invariant 2: Hash stability post-recovery
  const postRecHashes = controller2.getInvariantHashes();
  assert.strictEqual(postRecHashes.inputLedgerHeadHash, preCrashHashes.inputLedgerHeadHash);
  assert.strictEqual(postRecHashes.taskSnapshotHash, preCrashHashes.taskSnapshotHash);

  // Complete handoff and unit 2
  const handoffOutcome = await controller2.tick();
  assert.strictEqual(handoffOutcome.kind, 'handoff_performed');

  const u2Outcome = await controller2.tick();
  assert.strictEqual(u2Outcome.kind, 'unit_executed');
  assert.strictEqual((u2Outcome as { taskId: string }).taskId, 'u2');

  const finalOutcome = await controller2.tick();
  assert.strictEqual(finalOutcome.kind, 'completed');

  // Verify final invariants
  const finalLease = store.getLeaseRow(wsKey);
  assert.strictEqual(finalLease, undefined, 'Lease cleanly released upon completion');

  const finalHashes = controller2.getInvariantHashes();
  assert.strictEqual(finalHashes.inputLedgerHeadHash, preCrashHashes.inputLedgerHeadHash);

  db.close();
  fs.rmSync(workspaceDir, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('V25 acceptance (Invariant 5): stop_now control intent takes absolute primacy over RECOVERY_REQUIRED state and halts in CANCELLED', async () => {
  const workspaceDir = makeTempDir('agent-relay-v25-stop-ws-');
  const dataDir = makeTempDir('agent-relay-v25-stop-data-');
  const dbPath = path.join(dataDir, 'relay.db');

  initGitRepo(workspaceDir);

  const baseFile = path.join(workspaceDir, 'src', 'main.ts');
  fs.mkdirSync(path.dirname(baseFile), { recursive: true });
  fs.writeFileSync(baseFile, 'export const val = 1;\n', 'utf8');
  execSync('git add . && git commit -m "init"', { cwd: workspaceDir, stdio: 'ignore' });

  const db = new RelayDatabase({ dbPath });
  const store = new RunStore(db);
  const adapter = new ScriptedAdapter();
  const notifier = new RecordingNotifier();

  let crashTriggered = false;
  const faultHook: FaultHook = (point: FaultInjectionPoint, ctx: FaultContext) => {
    if (point === 'during_readonly_prep') {
      crashTriggered = true;
      throw new Error('SIMULATED_CRASH_BEFORE_HANDOFF');
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
    runId: 'run-v25-stop',
    goal: 'Test V25 stop intent primacy',
    workspacePath: workspaceDir,
    tasks: [
      { taskId: 'u1', requirementId: 'req-root', title: 'Task 1', dependencies: [] },
      { taskId: 'u2', requirementId: 'req-root', title: 'Task 2', dependencies: ['u1'] }
    ],
    model: { provider: 'anthropic', model: 'claude-3-7-sonnet', effort: 'high' },
    initialUserMessage: 'Stop intent primacy test.'
  };

  controller1.startRun(config);
  await controller1.tick(); // u1

  await assert.rejects(
    async () => {
      await controller1.tick();
    },
    { message: 'SIMULATED_CRASH_BEFORE_HANDOFF' }
  );

  // User alters workspace
  execSync('git checkout -b drifted-branch', { cwd: workspaceDir, stdio: 'ignore' });
  fs.writeFileSync(path.join(workspaceDir, 'drift.txt'), 'drift', 'utf8');
  execSync('git add . && git commit -m "drift"', { cwd: workspaceDir, stdio: 'ignore' });

  // User also issues a stop_now intent!
  const intents = new ControlIntentLog(store);
  intents.append('run-v25-stop', 'stop_now');

  // Reboot controller
  const controller2 = new RunController({
    store,
    dataDir,
    adapter,
    adapterName: 'claude',
    notifier,
    createCoordinator
  });
  controller2.rehydrate('run-v25-stop');

  // Reconcile must honour stop_now intent with top priority (Phase 1 intent guard)
  const recResult = await controller2.reconcile();
  assert.strictEqual(recResult.recoveredState, 'CANCELLED');
  assert.strictEqual(recResult.requiresManualIntervention, false);
  assert.ok(recResult.healedActions.includes('honoured_stop_intent'));
  assert.strictEqual(store.getRun('run-v25-stop')?.state, 'CANCELLED');

  // Lease is cleanly released
  const wsKey = normalizeWorkspaceKey(workspaceDir);
  const lease = store.getLeaseRow(wsKey);
  assert.strictEqual(lease, undefined, 'Lease must be released on cancellation');

  // Zero user data loss: drift.txt on drifted-branch is preserved
  assert.strictEqual(fs.readFileSync(path.join(workspaceDir, 'drift.txt'), 'utf8'), 'drift');

  db.close();
  fs.rmSync(workspaceDir, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
});
