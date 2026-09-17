import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskGraph } from '../../packages/controller/src/tasks/graph.ts';
import { ScopeGuard } from '../../packages/controller/src/tasks/guard.ts';
import { TaskGraph as ControllerTaskGraph, ScopeGuard as ControllerScopeGuard } from '../../packages/controller/src/index.ts';
import type { RequirementContract } from '../../packages/protocol/src/types.ts';

test('tasks: DAG dependency validation and sequential progression', () => {
  const graph = new TaskGraph();
  const t1 = graph.addTask({ taskId: 't1', requirementId: 'req-1', title: 'Unit 1', allowedPaths: ['src/a.ts'] });
  const t2 = graph.addTask({ taskId: 't2', requirementId: 'req-1', title: 'Unit 2', dependencies: ['t1'], allowedPaths: ['src/b.ts'] });

  assert.strictEqual(graph.getNextActionableTask()?.taskId, 't1');

  // Attempting to complete t1 without evidence must fail
  assert.throws(() => graph.updateTaskStatus('t1', 'completed'), /requires testEvidenceHash/);

  // Complete with evidence
  graph.completeTaskWithEvidence('t1', 'sha256-test-evidence-v1');
  assert.strictEqual(graph.getTask('t1')?.status, 'completed');

  // Now t2 becomes actionable
  assert.strictEqual(graph.getNextActionableTask()?.taskId, 't2');
});

test('guard: rejects unauthorized scope expansion and unauthorized path edits (V04)', () => {
  const contract: RequirementContract = {
    requirementId: 'req-1',
    version: 1,
    goals: ['Implement feature A'],
    scopePaths: ['packages/core'],
    forbiddenItems: ['refactor entire codebase'],
    acceptanceCriteria: [],
    sourceInputIds: ['in-1'],
    status: 'active'
  };

  const guard = new ScopeGuard(contract);

  // Normal edit in allowed scope
  assert.doesNotThrow(() => guard.verifyPathAccess('packages/core/index.ts'));

  // Edit outside scope
  assert.throws(() => guard.verifyPathAccess('packages/unrelated/dangerous.ts'), /Scope violation/);

  // Proposed forbidden action
  assert.throws(() => guard.verifyProposedAction('Let us refactor entire codebase'), /Forbidden item detected/);
});

test('tasks: duplicate taskId and empty evidence rejection', () => {
  const graph = new TaskGraph();
  graph.addTask({ taskId: 't1', requirementId: 'req-1', title: 'Unit 1' });
  assert.throws(() => graph.addTask({ taskId: 't1', requirementId: 'req-1', title: 'Duplicate' }), /already exists/);

  assert.throws(() => graph.completeTaskWithEvidence('t1', ''), /evidenceHash is required/);
  assert.throws(() => graph.completeTaskWithEvidence('t1', '   '), /evidenceHash is required/);
  assert.throws(() => graph.completeTaskWithEvidence('non-existent', 'hash'), /not found/);
});

test('tasks: circular dependency prevention', () => {
  const graph = new TaskGraph();
  assert.throws(
    () => graph.addTask({ taskId: 't1', requirementId: 'req-1', title: 'Self dep', dependencies: ['t1'] }),
    /cannot depend on itself/
  );

  // x depends on y (which is not yet added)
  graph.addTask({ taskId: 'x', requirementId: 'req-1', title: 'Task X', dependencies: ['y'] });
  // adding y with dependency on x creates circular dependency (x -> y -> x)
  assert.throws(
    () => graph.addTask({ taskId: 'y', requirementId: 'req-1', title: 'Task Y', dependencies: ['x'] }),
    /circular dependency/
  );
});

test('tasks: isAllCompleted and getAllTasks lifecycle', () => {
  const graph = new TaskGraph();
  assert.strictEqual(graph.isAllCompleted(), false);

  graph.addTask({ taskId: 't1', requirementId: 'req-1', title: 'Unit 1' });
  graph.addTask({ taskId: 't2', requirementId: 'req-1', title: 'Unit 2', dependencies: ['t1'] });

  assert.strictEqual(graph.getAllTasks().length, 2);
  assert.strictEqual(graph.isAllCompleted(), false);

  graph.completeTaskWithEvidence('t1', 'evidence-1');
  assert.strictEqual(graph.isAllCompleted(), false);

  graph.updateTaskStatus('t2', 'cancelled');
  assert.strictEqual(graph.isAllCompleted(), true);
  assert.strictEqual(graph.getNextActionableTask(), undefined);
});

test('guard: supports open scope, Windows backslashes, path traversal, and Chinese forbidden items', () => {
  const openContract: RequirementContract = {
    requirementId: 'req-open',
    version: 1,
    goals: ['Any path allowed'],
    scopePaths: [],
    forbiddenItems: ['禁止修改生产数据库'],
    acceptanceCriteria: [],
    sourceInputIds: ['in-open'],
    status: 'active'
  };

  const guard = new ScopeGuard(openContract);
  // Open scope allows any path
  assert.doesNotThrow(() => guard.verifyPathAccess('any/random/path.ts'));
  assert.doesNotThrow(() => guard.verifyPathAccess('C:\\Windows\\System32\\test.ts'));

  // Chinese forbidden item check
  assert.throws(() => guard.verifyProposedAction('我们需要禁止修改生产数据库。'), /Forbidden item detected/);
  assert.throws(() => guard.verifyProposedAction('紧急操作：直接修改生产数据库'), /Forbidden item detected/);

  // Update contract to restricted scope
  const restrictedContract: RequirementContract = {
    ...openContract,
    requirementId: 'req-restricted',
    scopePaths: ['packages/controller', 'packages/protocol/src/types.ts'],
    forbiddenItems: ['delete all']
  };
  guard.updateContract(restrictedContract);

  // Windows backslash normalized
  assert.doesNotThrow(() => guard.verifyPathAccess('packages\\controller\\src\\index.ts'));
  // Exact file allowed
  assert.doesNotThrow(() => guard.verifyPathAccess('packages/protocol/src/types.ts'));
  // Prefix collision prevented (e.g. packages/controller-evil)
  assert.throws(() => guard.verifyPathAccess('packages/controller-evil/exploit.ts'), /Scope violation/);
  // Directory traversal outside scope prevented
  assert.throws(() => guard.verifyPathAccess('packages/controller/../../outside.ts'), /Scope violation/);
});

test('controller/index: exports TaskGraph and ScopeGuard', () => {
  assert.strictEqual(ControllerTaskGraph, TaskGraph);
  assert.strictEqual(ControllerScopeGuard, ScopeGuard);
});

