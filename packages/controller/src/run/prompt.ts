// packages/controller/src/run/prompt.ts
import type { TaskItem, RequirementContract } from '../../../protocol/src/types.ts';

export const UNIT_RESULT_START = 'UNIT_RESULT_START';
export const UNIT_RESULT_END = 'UNIT_RESULT_END';

export type UnitResultStatus = 'completed' | 'partial' | 'failed';

export interface UnitResult {
  taskId: string;
  status: UnitResultStatus;
  evidenceHash?: string;
  summary?: string;
}

const VALID_STATUSES: UnitResultStatus[] = ['completed', 'partial', 'failed'];

/**
 * 首次会话的启动简报。明确声明本提示是 generated_handoff（系统生成），
 * 不是新的人类授权——对应 V28 的系统提示隔离。
 */
export function buildRunBriefing(params: {
  goal: string;
  contract: RequirementContract;
  runId: string;
}): string {
  const lines: string[] = [
    '<<<AGENT_RELAY_RUN_BRIEFING>>>',
    'SOURCE: generated_handoff',
    `RUN_ID: ${params.runId}`,
    `GOAL: ${params.goal}`,
    'INSTRUCTION: The text below is controller-generated context, not a new human authorization.'
  ];

  if (params.contract.forbiddenItems.length > 0) {
    lines.push('FORBIDDEN_ITEMS:');
    for (const item of params.contract.forbiddenItems) {
      lines.push(`  - ${item}`);
    }
  }

  if (params.contract.acceptanceCriteria.length > 0) {
    lines.push('ACCEPTANCE_CRITERIA:');
    for (const item of params.contract.acceptanceCriteria) {
      lines.push(`  - ${item}`);
    }
  }

  lines.push('<<<END_AGENT_RELAY_RUN_BRIEFING>>>');
  return lines.join('\n');
}

/** 单个工作单元的提示词。携带机器可读标记，便于结果解析与范围守卫复核。 */
export function buildUnitPrompt(params: {
  task: TaskItem;
  contract: RequirementContract;
  runId: string;
}): string {
  const { task, contract } = params;
  const lines: string[] = [
    '<<<AGENT_RELAY_UNIT>>>',
    'SOURCE: generated_handoff',
    `RUN_ID: ${params.runId}`,
    `TASK_ID: ${task.taskId}`,
    `TASK_TITLE: ${task.title}`,
    `REQUIREMENT_ID: ${task.requirementId}`
  ];

  if (task.description) {
    lines.push(`TASK_DESCRIPTION: ${task.description}`);
  }
  if (contract.goals.length > 0) {
    lines.push(`GOALS: ${contract.goals.join(' | ')}`);
  }
  if (contract.forbiddenItems.length > 0) {
    lines.push('FORBIDDEN_ITEMS:');
    for (const item of contract.forbiddenItems) {
      lines.push(`  - ${item}`);
    }
  }
  if (task.allowedPaths.length > 0) {
    lines.push(`ALLOWED_PATHS: ${task.allowedPaths.join(', ')}`);
  }
  if (task.expectedArtifacts.length > 0) {
    lines.push(`EXPECTED_ARTIFACTS: ${task.expectedArtifacts.join(', ')}`);
  }

  lines.push(
    'INSTRUCTION: Complete only this unit. Do not begin the next unit. Do not add unrequested scope.',
    'When the unit reaches a verifiable boundary, reply with exactly one result block in this format:',
    UNIT_RESULT_START,
    '{"taskId":"' + task.taskId + '","status":"completed|partial|failed","evidenceHash":"<hash of the passing verification>","summary":"<one line>"}',
    UNIT_RESULT_END,
    'A "completed" status without evidenceHash will be treated as partial.',
    '<<<END_AGENT_RELAY_UNIT>>>'
  );
  return lines.join('\n');
}

/** 解析输出中**最后一段**完整结果块（会话输出跨单元累积，最近的一段属于当前单元）。 */
export function parseUnitResult(output: string): UnitResult | null {
  const endIndex = output.lastIndexOf(UNIT_RESULT_END);
  if (endIndex === -1) return null;

  const startIndex = output.lastIndexOf(UNIT_RESULT_START, endIndex);
  if (startIndex === -1 || startIndex >= endIndex) return null;

  const raw = output.slice(startIndex + UNIT_RESULT_START.length, endIndex).trim();
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const candidate = parsed as Record<string, unknown>;
  const taskId = candidate.taskId;
  const status = candidate.status;
  if (typeof taskId !== 'string' || taskId.trim() === '') return null;
  if (typeof status !== 'string' || !VALID_STATUSES.includes(status as UnitResultStatus)) return null;

  const result: UnitResult = { taskId, status: status as UnitResultStatus };
  if (typeof candidate.evidenceHash === 'string') result.evidenceHash = candidate.evidenceHash;
  if (typeof candidate.summary === 'string') result.summary = candidate.summary;
  return result;
}

/**
 * 完成态必须有当前版本的通过证据（03-技术设计.md §6）：缺证据的 completed 降级为 partial，
 * 任务保持 in_progress，下一次交接包携带失败证据与下一个诊断步骤（V07）。
 */
export function normalizeUnitResult(result: UnitResult): UnitResult {
  if (result.status !== 'completed') {
    return result;
  }
  if (typeof result.evidenceHash === 'string' && result.evidenceHash.trim() !== '') {
    return result;
  }
  return {
    taskId: result.taskId,
    status: 'partial',
    summary: result.summary
      ? `${result.summary} (downgraded: completed requires an evidence hash)`
      : 'Downgraded to partial: completed requires an evidence hash'
  };
}
