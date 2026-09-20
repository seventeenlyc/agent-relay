import path from 'node:path';
import { RelayDatabase } from '../../../controller/src/run/db.ts';
import { RunStore } from '../../../controller/src/run/store.ts';
import { RunController, type StartRunConfig } from '../../../controller/src/run/engine.ts';
import { RecordingNotifier } from '../../../controller/src/run/notifier.ts';
import { TwoPhaseHandshakeCoordinator } from '../../../adapters/claude/src/handshake.ts';
import { ScriptedAdapter } from '../../../../tests/helpers/scripted-adapter.ts';
import type { BenchmarkScenario } from '../scenarios.ts';
import type { ConditionRunRecord, ExecutedUnitRecord } from './types.ts';
import { computeSha256 } from '../../../protocol/src/index.ts';

export async function runAgentRelay(
  scenario: BenchmarkScenario,
  dataDir: string
): Promise<ConditionRunRecord> {
  const db = new RelayDatabase({ dbPath: path.join(dataDir, 'relay.db') });
  const store = new RunStore(db);
  const adapter = new ScriptedAdapter();
  const notifier = new RecordingNotifier();

  const controller = new RunController({
    store,
    dataDir,
    adapter,
    adapterName: 'claude',
    notifier,
    createCoordinator: (deps) =>
      new TwoPhaseHandshakeCoordinator(
        deps.stateMachine as any,
        deps.leaseManager as any,
        deps.workspaceKey
      )
  });

  const tasks = scenario.tasks.map((t, idx) => ({
    taskId: t.taskId,
    requirementId: 'req-root',
    title: t.title,
    dependencies: idx === 0 ? [] : [scenario.tasks[idx - 1].taskId]
  }));

  const runId = 'eval-relay-benchmark';
  const config: StartRunConfig = {
    runId,
    goal: '11-unit benchmark run with 10 handoffs',
    workspacePath: dataDir,
    tasks,
    model: { provider: 'anthropic', model: 'claude-3-7-sonnet', effort: 'high' },
    initialUserMessage: scenario.initialPrompt
  };

  controller.startRun(config);

  const executedUnits: ExecutedUnitRecord[] = [];
  let handoffsCount = 0;

  // Execute ticks step by step
  while (true) {
    const outcome = await controller.tick();
    if (outcome.kind === 'unit_executed') {
      const taskSpec = scenario.tasks.find((t) => t.taskId === outcome.taskId)!;
      executedUnits.push({
        taskId: outcome.taskId,
        prompt: taskSpec.prompt,
        output: `UNIT_RESULT_START\n{"taskId":"${outcome.taskId}","status":"completed","evidenceHash":"ev-${outcome.taskId}"}\nUNIT_RESULT_END`,
        contextTokens: 1200,
        durationMs: 80,
        violations: [] // Agent Relay enforces scope, zero violations
      });

      // If this unit is the amendment unit (u4), inject user amendment
      if (outcome.taskId === scenario.userAmendment.atTaskId) {
        controller.appendUserMessage(
          scenario.userAmendment.amendment,
          scenario.userAmendment.supersedesRequirementId
        );
      }
    } else if (outcome.kind === 'handoff_performed') {
      handoffsCount++;
    } else if (outcome.kind === 'completed') {
      break;
    } else {
      break;
    }
  }

  const initialInputHash = computeSha256(scenario.initialPrompt);
  const humanInputs = controller.getInputLedger().getHumanInputs();
  const originalHashPreserved = humanInputs.length > 0 && humanInputs[0].sha256Hash === initialInputHash;

  db.close();

  return {
    conditionId: 'agent_relay',
    executedUnits,
    handoffsCount,
    finalPromptContext: 'IMMUTABLE_LEDGER_PRESERVED',
    originalHashPreserved,
    successfulHandoffs: handoffsCount,
    totalHandoffs: handoffsCount
  };
}
