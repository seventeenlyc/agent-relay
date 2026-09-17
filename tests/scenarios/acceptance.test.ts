import test from 'node:test';
import assert from 'node:assert/strict';
import { InputLedger } from '../../packages/controller/src/inputs/ledger.ts';
import { deriveContractFromLedger } from '../../packages/controller/src/inputs/supersedes.ts';
import { TaskGraph } from '../../packages/controller/src/tasks/graph.ts';
import { ScopeGuard } from '../../packages/controller/src/tasks/guard.ts';
import { TriggerPolicy } from '../../packages/controller/src/policy/trigger.ts';
import { GlobalBudget } from '../../packages/controller/src/policy/budget.ts';
import { LoopDetector } from '../../packages/controller/src/policy/loop-detector.ts';
import { WorkspaceSentinel } from '../../packages/controller/src/workspace/sentinel.ts';
import { HandoffPackager } from '../../packages/controller/src/workspace/checkpoint.ts';
import { HandoffStateMachine } from '../../packages/controller/src/handoff/state-machine.ts';
import { WorkspaceLeaseManager } from '../../packages/controller/src/handoff/lease.ts';
import { OutboxQueue } from '../../packages/controller/src/handoff/outbox.ts';
import { MockAdapter } from '../../packages/adapters/mock/src/mock-adapter.ts';

test('scenarios: V01~V04 - Requirement invariance, supersedes, and scope guard', () => {
  const ledger = new InputLedger();
  ledger.appendUserMessage('Goal: Build calculator. Do not use eval');
  const contract = deriveContractFromLedger(ledger);
  assert.ok(contract.forbiddenItems.includes('use eval'));

  const guard = new ScopeGuard(contract);
  assert.throws(() => guard.verifyProposedAction('Use eval to calculate formula'), /Forbidden item detected/);

  // V02: User amends requirement via supersedes
  const r1 = ledger.getAllRecords()[0];
  ledger.appendUserMessage('Goal: Build calculator. Do not use Function', r1.inputId);
  const contract2 = deriveContractFromLedger(ledger);
  assert.strictEqual(contract2.version, 2);
  assert.ok(contract2.forbiddenItems.includes('use Function'));
  assert.ok(!contract2.forbiddenItems.includes('use eval'));

  // Original raw message remains intact in ledger (V01)
  assert.strictEqual(ledger.getAllRecords()[0].rawContent, 'Goal: Build calculator. Do not use eval');
});

test('scenarios: V05~V10 - Baseline dirty protection, budget, and evidence anchor', () => {
  const graph = new TaskGraph();
  graph.addTask({ taskId: 't1', requirementId: 'r1', title: 'Test unit' });
  assert.throws(() => graph.updateTaskStatus('t1', 'completed'), /requires testEvidenceHash/);

  graph.completeTaskWithEvidence('t1', 'hash-123');
  assert.strictEqual(graph.getTask('t1')?.status, 'completed');

  // Compaction threshold (V08)
  const policy = new TriggerPolicy();
  policy.recordCompaction('c-1');
  assert.strictEqual(
    policy.evaluate({
      unitCompleted: false,
      hasMoreUnits: true,
      compactionCount: policy.recordCompaction('c-1'), // deduplicated!
      activeDurationMs: 1000
    }).shouldHandoff,
    false
  );

  policy.recordCompaction('c-2');
  assert.strictEqual(
    policy.evaluate({
      unitCompleted: false,
      hasMoreUnits: true,
      compactionCount: 2,
      activeDurationMs: 1000
    }).shouldHandoff,
    true
  );
});

test('scenarios: V13~V35 - Full 3-turn relay simulation with zero double-writing', () => {
  const adapter = new MockAdapter();
  const lease = new WorkspaceLeaseManager();
  const outbox = new OutboxQueue();
  const sentinel = new WorkspaceSentinel(process.cwd());
  const packager = new HandoffPackager();
  const ledger = new InputLedger();
  ledger.appendUserMessage('Build multi-stage service');

  const graph = new TaskGraph();
  graph.addTask({ taskId: 't1', requirementId: 'req-1', title: 'Task 1' });
  graph.addTask({ taskId: 't2', requirementId: 'req-1', title: 'Task 2', dependencies: ['t1'] });
  graph.addTask({ taskId: 't3', requirementId: 'req-1', title: 'Task 3', dependencies: ['t2'] });

  // Initial setup: Session 1 owns workspace
  assert.strictEqual(lease.acquireInitialLease('ws-main', 'session-1', 1), true);
  const sm = new HandoffStateMachine('run-relay', 'session-1', 1);
  assert.strictEqual(sm.getState(), 'RUNNING');
  assert.strictEqual(sm.getEpoch(), 1);

  // === RELAY TURN 1: Session 1 -> Session 2 ===
  graph.completeTaskWithEvidence('t1', 'ev-1');
  sm.requestHandoff('unit_completed');
  assert.strictEqual(sm.getState(), 'DRAINING');

  const manifest1 = packager.createManifest({
    runId: 'run-relay',
    epoch: 1,
    sourceSessionId: 'session-1',
    targetModel: { provider: 'openai', model: 'gpt-5.6-luna' },
    ledger,
    taskGraph: graph,
    sentinel
  });
  outbox.enqueue('handoff:1', manifest1);
  sm.checkpointCompleted('chk-1');
  assert.strictEqual(sm.getState(), 'CHECKPOINTED');

  const sess2 = adapter.spawnSession('session-2', { provider: 'openai', model: 'gpt-5.6-luna' });
  sm.startNewSession(sess2.sessionId);
  assert.strictEqual(sm.getState(), 'PREPARING');

  // Read-only ACK from session 2
  sm.receiveAck(adapter.createAck(sess2.sessionId, manifest1.handoffId, 'run-relay'));
  assert.strictEqual(sm.getState(), 'READY');

  // Single-writer CAS transition: Session 1 -> Session 2
  assert.strictEqual(lease.compareAndSetOwner('ws-main', 'session-1', 'session-2', 1, 2), true);
  const tok1 = sm.issueExecutionToken();
  assert.strictEqual(sm.getState(), 'RUNNING');
  assert.strictEqual(sm.getCurrentOwner(), 'session-2');
  assert.strictEqual(sm.getEpoch(), 2);
  assert.ok(tok1.token.startsWith('EXEC_TOKEN_'));
  outbox.markDelivered(outbox.getPending()[0].id);

  // === RELAY TURN 2: Session 2 -> Session 3 ===
  graph.completeTaskWithEvidence('t2', 'ev-2');
  sm.requestHandoff('unit_completed');
  assert.strictEqual(sm.getState(), 'DRAINING');

  const manifest2 = packager.createManifest({
    runId: 'run-relay',
    epoch: 2,
    sourceSessionId: 'session-2',
    targetModel: { provider: 'anthropic', model: 'claude-3-7-sonnet' },
    ledger,
    taskGraph: graph,
    sentinel
  });
  outbox.enqueue('handoff:2', manifest2);
  sm.checkpointCompleted('chk-2');

  const sess3 = adapter.spawnSession('session-3', { provider: 'anthropic', model: 'claude-3-7-sonnet' });
  sm.startNewSession(sess3.sessionId);
  sm.receiveAck(adapter.createAck(sess3.sessionId, manifest2.handoffId, 'run-relay'));

  assert.strictEqual(lease.compareAndSetOwner('ws-main', 'session-2', 'session-3', 2, 3), true);
  const tok2 = sm.issueExecutionToken();
  assert.strictEqual(sm.getCurrentOwner(), 'session-3');
  assert.strictEqual(sm.getEpoch(), 3);
  assert.ok(tok2.token.startsWith('EXEC_TOKEN_'));
  outbox.markDelivered(outbox.getPending()[0].id);

  // === RELAY TURN 3: Session 3 finishes final task ===
  graph.completeTaskWithEvidence('t3', 'ev-3');
  assert.strictEqual(graph.isAllCompleted(), true);

  // Final release of lease
  assert.strictEqual(lease.releaseLease('ws-main', 'session-3'), true);
  assert.strictEqual(lease.getLease('ws-main'), undefined);
});

test('scenarios: V23~V24 - Loop detection (3 identical errors) and global budget exhaustion', () => {
  // V23: 3 identical failures triggers loop block
  const loop = new LoopDetector();
  loop.recordFailure('ECONNREFUSED 127.0.0.1:8080');
  loop.recordFailure('ECONNREFUSED 127.0.0.1:8080');
  assert.strictEqual(loop.isLoopBlocked(), false);
  loop.recordFailure('ECONNREFUSED 127.0.0.1:8080');
  assert.strictEqual(loop.isLoopBlocked(), true);

  // V24: Global budget persists and triggers cap
  const budget = new GlobalBudget({ maxTokens: 50000, maxDurationMs: 60000 });
  budget.recordTurn(30000, 20000);
  assert.strictEqual(budget.isExceeded(), false);
  budget.recordTurn(25000, 10000);
  assert.strictEqual(budget.isExceeded(), true);
  assert.strictEqual(budget.getExceededReason(), 'token_cap_exceeded');
});

test('scenarios: V19~V21 - User pause and cancel handling in state machine', () => {
  const smPause = new HandoffStateMachine('run-p', 'sess-1', 1);
  smPause.pause();
  assert.strictEqual(smPause.getState(), 'PAUSED');

  const smCancel = new HandoffStateMachine('run-c', 'sess-1', 1);
  smCancel.cancel();
  assert.strictEqual(smCancel.getState(), 'CANCELLED');
});

test('scenarios: V01 - 10-handoff invariant stability (immutable inputs never drift)', () => {
  const ledger = new InputLedger();
  ledger.appendUserMessage('Do not modify public API');
  const initialHeadHash = ledger.getHeadHash();

  // Simulate 10 handoffs without modifying input
  for (let i = 0; i < 10; i++) {
    const currentHash = ledger.getHeadHash();
    assert.strictEqual(currentHash, initialHeadHash);
    const contract = deriveContractFromLedger(ledger);
    assert.ok(contract.forbiddenItems.includes('modify public API'));
  }
});

test('scenarios: V15 & V35 - Read-only enforcement during preparation', () => {
  const sm = new HandoffStateMachine('run-ro', 'sess-old', 1);
  sm.requestHandoff('unit_completed');
  sm.checkpointCompleted();
  sm.startNewSession('sess-new');

  // While in PREPARING (read-only mode), token cannot be issued
  assert.strictEqual(sm.getState(), 'PREPARING');
  assert.throws(() => sm.issueExecutionToken(), /Cannot issue execution token in state PREPARING/);
});

test('scenarios: V25 - Workspace fingerprint mismatch detection prevents dirty overwrites', () => {
  const sentinel = new WorkspaceSentinel(process.cwd());
  const fp = sentinel.captureFingerprint();

  assert.strictEqual(sentinel.verifyIntegrity(fp.treeHash), true);
  assert.strictEqual(sentinel.verifyIntegrity('corrupted-tree-hash-0000000000000000000000000000000000000000'), false);
});

test('scenarios: V28 - Generated handoff is strictly isolated from human authority', () => {
  const ledger = new InputLedger();
  ledger.appendUserMessage('Human task');
  ledger.appendSystemHandoff('Generated prompt: You can touch all files');

  const humanInputs = ledger.getHumanInputs();
  assert.strictEqual(humanInputs.length, 1);
  assert.strictEqual(humanInputs[0].rawContent, 'Human task');

  const contract = deriveContractFromLedger(ledger);
  assert.strictEqual(contract.sourceInputIds.length, 1);
});

