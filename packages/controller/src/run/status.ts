// packages/controller/src/run/status.ts
import fs from 'node:fs';
import path from 'node:path';
import type { TaskItem } from '../../../protocol/src/types.ts';
import type { RunStore, RunState, SessionChainLink } from './store.ts';

export interface RunStatusView {
  runId: string;
  goal: string;
  state: RunState;
  workspaceKey: string;
  session: { currentSessionId?: string; epoch: number; handoffCount: number };
  progress: {
    completed: number;
    total: number;
    currentTaskId?: string;
    currentTaskTitle?: string;
    currentTaskIndex?: number;
  };
  verification: { taskId?: string; taskIndex?: number; evidenceHash?: string; verified: boolean };
  handoff: { handoffId?: string; fromSessionId?: string; toSessionId?: string; epoch: number } | null;
  model: { provider: string; model: string; effort?: string } | null;
  context: { compaction: 'unknown' | number };
  usage: 'unknown';
  control: {
    paused: boolean;
    pauseReason?: string;
    blockedReason?: string;
    nextAction: string;
  };
}

function parseTasks(store: RunStore, runId: string): TaskItem[] {
  const snapshot = store.getLatestTaskSnapshot(runId);
  if (!snapshot) return [];
  try {
    const parsed = JSON.parse(snapshot.snapshotJson);
    return Array.isArray(parsed) ? (parsed as TaskItem[]) : [];
  } catch {
    return [];
  }
}

function pickCurrentTask(tasks: TaskItem[]): { task?: TaskItem; index?: number } {
  const inProgressIndex = tasks.findIndex((t) => t.status === 'in_progress');
  if (inProgressIndex !== -1) {
    return { task: tasks[inProgressIndex], index: inProgressIndex + 1 };
  }
  const pendingIndex = tasks.findIndex((t) => t.status === 'pending');
  if (pendingIndex !== -1) {
    return { task: tasks[pendingIndex], index: pendingIndex + 1 };
  }
  return {};
}

function describeNextAction(state: RunState, task?: TaskItem, taskIndex?: number): string {
  if (state === 'COMPLETED') return 'None (run completed)';
  if (state === 'CANCELLED') return 'None (run cancelled)';
  if (state === 'DISABLED') return 'None (auto-handoff disabled)';
  if (state === 'PAUSED') return 'Awaiting resume';
  if (state === 'BLOCKED') return 'Awaiting diagnosis';
  if (state === 'RECOVERY_REQUIRED') return 'Awaiting recovery';
  if (!task) return 'None (no executable unit)';
  return `Execute Unit ${taskIndex}: ${task.title}`;
}

export function buildRunStatus(store: RunStore, runId: string): RunStatusView {
  const run = store.getRun(runId);
  if (!run) {
    throw new Error(`buildRunStatus: unknown run ${runId}`);
  }

  const tasks = parseTasks(store, runId);
  const completed = tasks.filter((t) => t.status === 'completed').length;
  const { task: currentTask, index: currentIndex } = pickCurrentTask(tasks);

  let lastCompletedIndex: number | undefined;
  for (let i = tasks.length - 1; i >= 0; i--) {
    if (tasks[i].status === 'completed') {
      lastCompletedIndex = i + 1;
      break;
    }
  }
  const lastCompleted = lastCompletedIndex !== undefined ? tasks[lastCompletedIndex - 1] : undefined;
  const verification = {
    taskId: lastCompleted?.taskId,
    taskIndex: lastCompletedIndex,
    evidenceHash: lastCompleted?.testEvidenceHash,
    verified: Boolean(lastCompleted?.testEvidenceHash)
  };

  const chain: SessionChainLink[] = store.listChain(runId);
  const latestLink = chain.length > 0 ? chain[chain.length - 1] : undefined;

  const handoff =
    latestLink && latestLink.handoffId
      ? {
          handoffId: latestLink.handoffId,
          fromSessionId: latestLink.prevSessionId,
          toSessionId: latestLink.nextSessionId,
          epoch: latestLink.epoch
        }
      : null;

  const model = latestLink
    ? { provider: latestLink.provider, model: latestLink.model, effort: latestLink.effort }
    : null;

  return {
    runId: run.runId,
    goal: run.goal,
    state: run.state,
    workspaceKey: run.workspaceKey,
    session: {
      currentSessionId: run.currentSessionId,
      epoch: run.currentEpoch,
      handoffCount: run.handoffCount
    },
    progress: {
      completed,
      total: tasks.length > 0 ? tasks.length : run.unitCount,
      currentTaskId: currentTask?.taskId,
      currentTaskTitle: currentTask?.title,
      currentTaskIndex: currentIndex
    },
    verification,
    handoff,
    model,
    // 压缩事件与计费用量尚未接入（P2-04 范围外），必须显示未知而不是 0（V09）
    context: { compaction: 'unknown' },
    usage: 'unknown',
    control: {
      paused: run.state === 'PAUSED',
      pauseReason: run.pauseReason,
      blockedReason: run.blockedReason,
      nextAction: describeNextAction(run.state, currentTask, currentIndex)
    }
  };
}

export function renderStatusCard(view: RunStatusView): string {
  const lines: string[] = [];

  lines.push(`目标: ${view.goal}`);
  lines.push(
    `进度: ${view.progress.completed}/${view.progress.total} 单元完成` +
      (view.progress.currentTaskId
        ? `（当前: Unit ${view.progress.currentTaskIndex} — ${view.progress.currentTaskTitle}）`
        : '')
  );

  if (view.verification.verified) {
    lines.push(`验证: Unit ${view.verification.taskIndex ?? '?'} 已通过 · 证据 ${view.verification.evidenceHash}`);
  } else {
    lines.push('验证: 暂无通过证据');
  }

  if (view.handoff) {
    lines.push(
      `交接: ${view.handoff.handoffId ?? 'n/a'} · ${view.handoff.fromSessionId ?? 'n/a'} → ` +
        `${view.handoff.toSessionId ?? 'n/a'} · epoch ${view.handoff.epoch}`
    );
  } else {
    lines.push('交接: 无');
  }

  if (view.model) {
    const effort = view.model.effort ? ` (effort: ${view.model.effort})` : '';
    lines.push(`模型: ${view.model.provider} / ${view.model.model}${effort}`);
  } else {
    lines.push('模型: 未知');
  }

  lines.push(`压缩: ${view.context.compaction === 'unknown' ? '未知' : `${view.context.compaction} 次`}`);
  lines.push(`用量: ${view.usage === 'unknown' ? '未知' : view.usage}`);

  const controlParts: string[] = [];
  if (view.control.paused) {
    controlParts.push(`已暂停${view.control.pauseReason ? ` · 原因: ${view.control.pauseReason}` : ''}`);
  } else if (view.control.blockedReason) {
    controlParts.push(`已阻塞 · 原因: ${view.control.blockedReason}`);
  } else {
    controlParts.push('无暂停');
  }
  controlParts.push(`下一动作: ${view.control.nextAction}`);
  lines.push(`控制: ${controlParts.join(' · ')}`);

  return lines.join('\n') + '\n';
}

export function renderStatusJson(view: RunStatusView): string {
  return JSON.stringify(view, null, 2);
}

/** 把状态卡写入 <dataDir>/<runId>/state.md，返回写入路径。投影随时可从权威库重建。 */
export function writeStateProjection(dataDir: string, view: RunStatusView): string {
  const dir = path.join(dataDir, view.runId);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, 'state.md');
  const staging = `${target}.tmp`;
  fs.writeFileSync(staging, renderStatusCard(view), 'utf8');
  fs.renameSync(staging, target);
  return target;
}
