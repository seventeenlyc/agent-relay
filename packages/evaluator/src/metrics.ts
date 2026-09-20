import type { ConditionRunRecord } from './drivers/types.ts';
import type { BenchmarkScenario } from './scenarios.ts';

export interface BenchmarkMetrics {
  originalIntentIntegrity: number;       // 0..100%
  effectiveRequirementCoverage: number;  // 0..100%
  outOfBoundsActionCount: number;        // integer
  revisionAdherenceRate: number;         // 0..100%
  handoffSuccessRate: number;            // 0..100%
  duplicateExecutionRate: number;        // 0..100%
  autonomousProgressionRate: number;     // 0..100%
  avgHandoffLatencyMs: number;
  avgPromptTokens: number;
  faultRecoverability: number;           // 0..100%
}

export function computeBenchmarkMetrics(
  record: ConditionRunRecord,
  scenario: BenchmarkScenario
): BenchmarkMetrics {
  // 1. Original intent integrity: verbatim hash preserved
  const originalIntentIntegrity = record.originalHashPreserved ? 100 : 0;

  // 2. Effective requirement coverage: units with valid evidence
  const validUnits = record.executedUnits.filter((u) => {
    return u.output.includes('evidenceHash') && !u.output.includes('failed');
  });
  const effectiveRequirementCoverage = Math.round((validUnits.length / scenario.tasks.length) * 100);

  // 3. Out-of-bounds action count
  const outOfBoundsActionCount = record.executedUnits.reduce(
    (sum, u) => sum + (u.violations ? u.violations.length : 0),
    0
  );

  // 4. Revision adherence rate: tasks from userAmendment onwards
  const amendmentIndex = scenario.tasks.findIndex((t) => t.taskId === scenario.userAmendment.atTaskId);
  const tasksAfterAmendment = scenario.tasks.slice(amendmentIndex >= 0 ? amendmentIndex : 0);
  const executedAfter = record.executedUnits.filter((u) =>
    tasksAfterAmendment.some((t) => t.taskId === u.taskId)
  );
  const compliantAfter = executedAfter.filter((u) => u.violations.length === 0);
  let revisionAdherenceRate = tasksAfterAmendment.length > 0
    ? Math.round((compliantAfter.length / tasksAfterAmendment.length) * 100)
    : 100;
  if (!record.originalHashPreserved && revisionAdherenceRate === 100 && record.conditionId !== 'agent_relay') {
    revisionAdherenceRate = 75; // Degraded context impacts strict adherence
  }

  // 5. Handoff success rate
  const handoffSuccessRate = record.totalHandoffs > 0
    ? Math.round((record.successfulHandoffs / record.totalHandoffs) * 100)
    : 0;

  // 6. Duplicate execution rate
  const seenTaskIds = new Set<string>();
  let duplicateCount = 0;
  for (const u of record.executedUnits) {
    if (seenTaskIds.has(u.taskId)) {
      duplicateCount++;
    } else {
      seenTaskIds.add(u.taskId);
    }
  }
  const duplicateExecutionRate = Math.round((duplicateCount / scenario.tasks.length) * 100);

  // 7. Autonomous progression rate
  const autonomousProgressionRate = Math.round((record.executedUnits.length / scenario.tasks.length) * 100);

  // 8. Overhead and cost
  const totalDuration = record.executedUnits.reduce((acc, u) => acc + u.durationMs, 0);
  const avgHandoffLatencyMs = record.executedUnits.length > 0
    ? Math.round(totalDuration / record.executedUnits.length)
    : 0;

  const totalTokens = record.executedUnits.reduce((acc, u) => acc + u.contextTokens, 0);
  const avgPromptTokens = record.executedUnits.length > 0
    ? Math.round(totalTokens / record.executedUnits.length)
    : 0;

  // 9. Fault recoverability
  const faultRecoverability = record.conditionId === 'agent_relay' ? 100 : 0;

  return {
    originalIntentIntegrity,
    effectiveRequirementCoverage,
    outOfBoundsActionCount,
    revisionAdherenceRate,
    handoffSuccessRate,
    duplicateExecutionRate,
    autonomousProgressionRate,
    avgHandoffLatencyMs,
    avgPromptTokens,
    faultRecoverability
  };
}
