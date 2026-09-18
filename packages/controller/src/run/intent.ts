// packages/controller/src/run/intent.ts
import type { RunStore, ControlIntentKind, ControlIntentRecord } from './store.ts';

export interface PendingControl {
  intentId: string;
  kind: ControlIntentKind;
  watermark: number;
  payload: Record<string, unknown>;
  createdAt: number;
}

/** 数值越小优先级越高。同级取最小水位，保证裁决可重放。 */
const PRIORITY: Record<ControlIntentKind, number> = {
  stop_now: 0,
  disable: 1,
  pause_next_node: 2,
  resume: 3
};

/**
 * 追加式控制意图日志。意图是 CLI 与 supervisor 之间唯一的控制通道：
 * CLI 只追加，RunController 在每个节点边界读取并消费。
 */
export class ControlIntentLog {
  private readonly store: RunStore;

  constructor(store: RunStore) {
    this.store = store;
  }

  public append(
    runId: string,
    kind: ControlIntentKind,
    payload: Record<string, unknown> = {}
  ): ControlIntentRecord {
    return this.store.transaction(() => this.store.appendIntent(runId, kind, payload));
  }

  public getWatermark(runId: string): number {
    return this.store.getLatestIntentWatermark(runId);
  }

  public listPending(runId: string): ControlIntentRecord[] {
    return this.store.listPendingIntents(runId);
  }

  public hasPending(runId: string): boolean {
    return this.listPending(runId).length > 0;
  }

  /** 按优先级（同级按水位升序）返回唯一待处理意图；没有则返回 null。 */
  public resolve(runId: string): PendingControl | null {
    const pending = this.listPending(runId);
    if (pending.length === 0) return null;

    const winner = pending.reduce((best, candidate) => {
      const bestRank = PRIORITY[best.kind];
      const candidateRank = PRIORITY[candidate.kind];
      if (candidateRank < bestRank) return candidate;
      if (candidateRank === bestRank && candidate.watermark < best.watermark) return candidate;
      return best;
    }, pending[0]);

    return {
      intentId: winner.intentId,
      kind: winner.kind,
      watermark: winner.watermark,
      payload: winner.payload,
      createdAt: winner.createdAt
    };
  }

  public consume(intentId: string): void {
    this.store.markIntentConsumed(intentId);
  }

  /** 未消费意图数量——非 0 时执行令牌失效（§5.3）。 */
  public pendingCount(runId: string): number {
    return this.listPending(runId).length;
  }
}
