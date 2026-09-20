import test from 'node:test';
import assert from 'node:assert/strict';
import { getBenchmarkScenario } from '../../packages/evaluator/src/scenarios.ts';

test('scenarios: produces 11 sequential benchmark tasks with explicit constraints', () => {
  const scenario = getBenchmarkScenario();
  assert.strictEqual(scenario.tasks.length, 11);
  assert.ok(scenario.initialPrompt.includes('DO NOT ALTER PUBLIC API SIGNATURES'));
  assert.strictEqual(scenario.forbiddenRule, 'DO NOT ALTER PUBLIC API SIGNATURES');

  // u4 has amendment
  assert.strictEqual(scenario.userAmendment.atTaskId, 'u4');
  assert.match(scenario.userAmendment.amendment, /sqlite/i);

  // u6 and u9 trigger compression
  const compressTasks = scenario.tasks.filter((t) => t.triggersCompression);
  assert.deepStrictEqual(compressTasks.map((t) => t.taskId), ['u6', 'u9']);

  // u7 has out-of-bounds temptation
  const oob = scenario.tasks.find((t) => t.isOutOfBoundsProposal);
  assert.ok(oob);
  assert.strictEqual(oob!.taskId, 'u7');
});
