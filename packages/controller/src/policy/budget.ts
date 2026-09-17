export interface BudgetLimits {
  maxTokens?: number;
  maxDurationMs?: number;
  maxTurns?: number;
}

export class GlobalBudget {
  private consumedTokens = 0;
  private elapsedDurationMs = 0;
  private turnCount = 0;
  private limits: BudgetLimits;

  constructor(limits: BudgetLimits) {
    this.limits = { ...limits };
  }

  public recordTurn(tokensUsed: number, durationMs: number): void {
    this.consumedTokens += tokensUsed;
    this.elapsedDurationMs += durationMs;
    this.turnCount++;
  }

  public isExceeded(): boolean {
    return this.getExceededReason() !== null;
  }

  public getExceededReason(): 'token_cap_exceeded' | 'duration_cap_exceeded' | 'turn_cap_exceeded' | null {
    if (typeof this.limits.maxTokens === 'number' && this.consumedTokens >= this.limits.maxTokens) {
      return 'token_cap_exceeded';
    }
    if (typeof this.limits.maxDurationMs === 'number' && this.elapsedDurationMs >= this.limits.maxDurationMs) {
      return 'duration_cap_exceeded';
    }
    if (typeof this.limits.maxTurns === 'number' && this.turnCount >= this.limits.maxTurns) {
      return 'turn_cap_exceeded';
    }
    return null;
  }

  public getStats(): { consumedTokens: number; elapsedDurationMs: number; turnCount: number } {
    return {
      consumedTokens: this.consumedTokens,
      elapsedDurationMs: this.elapsedDurationMs,
      turnCount: this.turnCount,
    };
  }
}
