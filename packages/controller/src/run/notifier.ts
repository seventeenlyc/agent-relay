// packages/controller/src/run/notifier.ts
import type { RunEventSeverity } from './store.ts';

export interface RunNotification {
  runId: string;
  type: string;
  severity: RunEventSeverity;
  message: string;
  payload: Record<string, unknown>;
}

export interface Notifier {
  notify(notification: RunNotification): void;
}

/** 默认实现：把 notify 级事件写到 stderr，不打断 stdout 的结构化输出。 */
export class ConsoleNotifier implements Notifier {
  public notify(notification: RunNotification): void {
    process.stderr.write(`[agent-relay] ${notification.type}: ${notification.message}\n`);
  }
}

/** 测试用实现：把所有通知保存在内存中供断言。 */
export class RecordingNotifier implements Notifier {
  public readonly notifications: RunNotification[] = [];

  public notify(notification: RunNotification): void {
    this.notifications.push({ ...notification, payload: { ...notification.payload } });
  }

  public ofType(type: string): RunNotification[] {
    return this.notifications.filter((n) => n.type === type);
  }

  public clear(): void {
    this.notifications.length = 0;
  }
}
