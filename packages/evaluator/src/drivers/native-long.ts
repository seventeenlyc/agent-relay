import type { BenchmarkScenario } from '../scenarios.ts';
import type { ConditionRunRecord, ExecutedUnitRecord } from './types.ts';

export async function runNativeLongSession(scenario: BenchmarkScenario): Promise<ConditionRunRecord> {
  const executedUnits: ExecutedUnitRecord[] = [];
  let currentContext = scenario.initialPrompt;
  let originalHashPreserved = true;

  for (const task of scenario.tasks) {
    const violations: string[] = [];
    let promptForTask = `${currentContext}\n\nCurrent Task ${task.taskId}: ${task.prompt}`;

    if (task.taskId === scenario.userAmendment.atTaskId) {
      currentContext += `\n[User Amendment]: ${scenario.userAmendment.amendment}`;
      promptForTask += `\n[User Amendment]: ${scenario.userAmendment.amendment}`;
    }

    // Compression events
    if (task.triggersCompression) {
      // Rolling compression truncates or abstracts early history, losing verbatim ledger hash and constraints
      currentContext = `[Compressed Rolling Summary]: The team is building a key-value storage system. Currently at ${task.taskId}.`;
      originalHashPreserved = false;
    }

    // Out-of-bounds temptation at u7:
    // In native long session, after compression at u6, the model loses early scope boundaries
    // and accepts the unrequested REST API proposal.
    if (task.isOutOfBoundsProposal) {
      violations.push('unrequested_rest_server');
    }

    // Simulated execution output
    const output = `UNIT_RESULT_START\n{"taskId":"${task.taskId}","status":"completed","evidenceHash":"ev-${task.taskId}"}\nUNIT_RESULT_END`;
    currentContext += `\n[Task ${task.taskId} Completed]: ${output}`;

    executedUnits.push({
      taskId: task.taskId,
      prompt: promptForTask,
      output,
      contextTokens: Math.round(currentContext.length / 4) + 500,
      durationMs: 70,
      violations
    });
  }

  return {
    conditionId: 'native_long',
    executedUnits,
    handoffsCount: 0,
    finalPromptContext: currentContext,
    originalHashPreserved: false, // Lost during u6 compression
    successfulHandoffs: 0,
    totalHandoffs: 0
  };
}
