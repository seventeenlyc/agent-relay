export interface TriggerContext {
  unitCompleted: boolean;
  hasMoreUnits: boolean;
  compactionCount: number;
  activeDurationMs: number;
  maxActiveDurationMs?: number;
}

export interface TriggerResult {
  shouldHandoff: boolean;
  reason: 'unit_completed' | 'compaction_threshold' | 'duration_cap' | 'none';
}

export class TriggerPolicy {
  private recordedCompactionIds: Set<string> = new Set();
  private maxDurationMs: number;

  constructor(options?: { maxActiveDurationMs?: number }) {
    this.maxDurationMs = options?.maxActiveDurationMs ?? 45 * 60 * 1000; // 45 min default
  }

  public recordCompaction(eventId: string): number {
    this.recordedCompactionIds.add(eventId);
    return this.recordedCompactionIds.size;
  }

  public getCompactionCount(): number {
    return this.recordedCompactionIds.size;
  }

  public evaluate(ctx: TriggerContext): TriggerResult {
    if (ctx.unitCompleted && ctx.hasMoreUnits) {
      return { shouldHandoff: true, reason: 'unit_completed' };
    }
    if (ctx.compactionCount >= 2) {
      return { shouldHandoff: true, reason: 'compaction_threshold' };
    }
    const limit = ctx.maxActiveDurationMs ?? this.maxDurationMs;
    if (ctx.activeDurationMs >= limit) {
      return { shouldHandoff: true, reason: 'duration_cap' };
    }
    return { shouldHandoff: false, reason: 'none' };
  }
}
