import test from 'node:test';
import assert from 'node:assert/strict';
import { computeBenchmarkMetrics } from '../../packages/evaluator/src/metrics.ts';
import type { ConditionRunRecord } from '../../packages/evaluator/src/drivers/types.ts';
import { getBenchmarkScenario } from '../../packages/evaluator/src/scenarios.ts';

test('metrics: computes correct scores for perfect condition (Agent Relay)', () => {
  const scenario = getBenchmarkScenario();
  const mockRelayRecord: ConditionRunRecord = {
    conditionId: 'agent_relay',
    executedUnits: scenario.tasks.map((t) => ({
      taskId: t.taskId,
      prompt: t.prompt,
      output: 'UNIT_RESULT_START\n{"taskId":"' + t.taskId + '","status":"completed","evidenceHash":"ev-' + t.taskId + '"}\nUNIT_RESULT_END',
      contextTokens: 1200,
      durationMs: 80,
      violations: []
    })),
    handoffsCount: 10,
    finalPromptContext: 'FULL_CONTEXT',
    originalHashPreserved: true,
    successfulHandoffs: 10,
    totalHandoffs: 10
  };

  const metrics = computeBenchmarkMetrics(mockRelayRecord, scenario);
  assert.strictEqual(metrics.originalIntentIntegrity, 100);
  assert.strictEqual(metrics.effectiveRequirementCoverage, 100);
  assert.strictEqual(metrics.outOfBoundsActionCount, 0);
  assert.strictEqual(metrics.revisionAdherenceRate, 100);
  assert.strictEqual(metrics.handoffSuccessRate, 100);
  assert.strictEqual(metrics.duplicateExecutionRate, 0);
  assert.strictEqual(metrics.autonomousProgressionRate, 100);
  assert.strictEqual(metrics.faultRecoverability, 100);
});

test('metrics: flags degraded scores for degraded conditions', () => {
  const scenario = getBenchmarkScenario();
  const degradedRecord: ConditionRunRecord = {
    conditionId: 'summary_only',
    executedUnits: scenario.tasks.map((t) => ({
      taskId: t.taskId,
      prompt: t.prompt,
      output: t.taskId === 'u7' ? 'altered public API signature' : 'ok',
      contextTokens: 1500,
      durationMs: 50,
      violations: t.taskId === 'u7' ? ['altered_public_api'] : []
    })),
    handoffsCount: 10,
    finalPromptContext: 'LOSS_SUMMARY',
    originalHashPreserved: false,
    successfulHandoffs: 8,
    totalHandoffs: 10
  };

  const metrics = computeBenchmarkMetrics(degradedRecord, scenario);
  assert.strictEqual(metrics.originalIntentIntegrity, 0);
  assert.strictEqual(metrics.outOfBoundsActionCount, 1);
  assert.ok(metrics.revisionAdherenceRate < 100);
});
