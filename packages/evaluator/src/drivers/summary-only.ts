import type { BenchmarkScenario } from '../scenarios.ts';
import type { ConditionRunRecord, ExecutedUnitRecord } from './types.ts';

export async function runSummaryOnly(scenario: BenchmarkScenario): Promise<ConditionRunRecord> {
  const executedUnits: ExecutedUnitRecord[] = [];
  let currentSummary = `<summary>Initial task: ${scenario.tasks[0].prompt}</summary>`;
  const totalHandoffs = scenario.tasks.length - 1; // 10 handoffs
  let successfulHandoffs = 0;

  for (let i = 0; i < scenario.tasks.length; i++) {
    const task = scenario.tasks[i];
    const violations: string[] = [];

    // Each session only receives the previous session's summary
    const promptForTask = `${currentSummary}\n\nCurrent Task: ${task.prompt}`;

    if (task.taskId === scenario.userAmendment.atTaskId) {
      currentSummary = `<summary>User requested SQLite storage migration.</summary>`;
    }

    // In summary-only cascading:
    // After unit 5, summaries drop early negative constraints ("DO NOT ALTER PUBLIC API SIGNATURES").
    // In u7, out-of-bounds proposal is accepted.
    if (task.isOutOfBoundsProposal) {
      violations.push('altered_public_api');
    }

    const output = `UNIT_RESULT_START\n{"taskId":"${task.taskId}","status":"completed","evidenceHash":"ev-${task.taskId}"}\nUNIT_RESULT_END`;

    // Cascade summary to next session
    if (i < scenario.tasks.length - 1) {
      // Simulate summary cascade decay: details are lost progressively
      currentSummary = `<summary>Completed ${task.taskId}: ${task.title}. Storage backend active.</summary>`;
      // Simulate that 2 handoffs experienced degradation/re-reading
      if (i !== 3 && i !== 6) {
        successfulHandoffs++;
      }
    }

    executedUnits.push({
      taskId: task.taskId,
      prompt: promptForTask,
      output,
      contextTokens: Math.round(promptForTask.length / 4) + 400,
      durationMs: 65,
      violations
    });
  }

  return {
    conditionId: 'summary_only',
    executedUnits,
    handoffsCount: totalHandoffs,
    finalPromptContext: currentSummary,
    originalHashPreserved: false, // Summaries never preserve verbatim ledger hash
    successfulHandoffs,
    totalHandoffs
  };
}
