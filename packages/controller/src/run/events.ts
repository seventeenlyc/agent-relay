// packages/controller/src/run/events.ts
import type { RunStore, RunEventRecord, RunEventSeverity } from './store.ts';
import type { Notifier } from './notifier.ts';

/**
 * notify 级事件会打断用户（完成 / 失败 / 需要动作）；其余为静默记录。
 * 正常交接必须静默——「不要求用户点击每次接手」。
 */
const NOTIFY_TYPES = new Set<string>([
  'run_completed',
  'unit_failed',
  'run_blocked',
  'recovery_required',
  'user_action_required'
]);

export function classifySeverity(type: string): RunEventSeverity {
  return NOTIFY_TYPES.has(type) ? 'notify' : 'record';
}

const MESSAGES: Record<string, (payload: Record<string, unknown>) => string> = {
  run_completed: (p) => `run ${p.runId} completed ${p.completedUnits}/${p.totalUnits} units`,
  unit_failed: (p) => `unit ${p.taskId} reported ${p.status}: ${p.summary ?? 'no summary'}`,
  run_blocked: (p) => `run blocked: ${p.reason}`,
  recovery_required: (p) => `recovery required: ${p.reason}`,
  user_action_required: (p) => `user action required: ${p.reason}`
};

export function describeEvent(type: string, payload: Record<string, unknown>): string {
  const describe = MESSAGES[type];
  return describe ? describe(payload) : type;
}

export class RunEventLog {
  private readonly store: RunStore;
  private readonly notifier: Notifier;

  constructor(store: RunStore, notifier: Notifier) {
    this.store = store;
    this.notifier = notifier;
  }

  public record(params: {
    runId: string;
    type: string;
    sessionId?: string;
    payload?: Record<string, unknown>;
    severity?: RunEventSeverity;
  }): RunEventRecord {
    const severity = params.severity ?? classifySeverity(params.type);
    const payload = { runId: params.runId, ...(params.payload ?? {}) };
    const event = this.store.insertEvent({
      runId: params.runId,
      type: params.type,
      severity,
      sessionId: params.sessionId,
      payload
    });

    if (severity === 'notify') {
      this.notifier.notify({
        runId: params.runId,
        type: params.type,
        severity,
        message: describeEvent(params.type, payload),
        payload
      });
    }
    return event;
  }

  public list(runId: string, afterEventId = 0): RunEventRecord[] {
    return this.store.listEvents(runId, afterEventId);
  }
}
