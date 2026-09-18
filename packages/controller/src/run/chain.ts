// packages/controller/src/run/chain.ts
import type { RunStore, SessionChainLink, InsertChainLinkParams } from './store.ts';

/**
 * 会话链：旧 → 新会话链接的追加式账本。
 * 历史会话只封存（supersededAt）不删除，满足「旧会话保留可查，不自动删除」。
 */
export class SessionChainLedger {
  private readonly store: RunStore;

  constructor(store: RunStore) {
    this.store = store;
  }

  public append(params: Omit<InsertChainLinkParams, 'sequence'>): SessionChainLink {
    return this.store.transaction(() => {
      const sequence = this.store.nextChainSequence(params.runId);
      return this.store.insertChainLink({ ...params, sequence });
    });
  }

  public list(runId: string): SessionChainLink[] {
    return this.store.listChain(runId);
  }

  public currentSessionId(runId: string): string | undefined {
    const latest = this.store.getLatestChainLink(runId);
    return latest?.nextSessionId;
  }

  public getActiveSessionId(runId: string): string | undefined {
    const links = this.store.listChain(runId);
    const active = [...links].reverse().find((l) => l.supersededAt === undefined);
    return active?.nextSessionId;
  }

  public supersede(sessionId: string): void {
    this.store.transaction(() => {
      const links = this.store.findChainLinksBySession(sessionId);
      if (links.length === 0) {
        throw new Error(`SessionChainLedger: unknown session ${sessionId}`);
      }
      if (links.every((link) => link.supersededAt !== undefined)) {
        return; // 已封存，保持不变（幂等）
      }
      this.store.markSessionSuperseded(sessionId);
    });
  }
}
