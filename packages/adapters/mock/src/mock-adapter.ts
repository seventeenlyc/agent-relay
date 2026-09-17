import { randomUUID } from 'node:crypto';
import type { HandoffAckPacket } from '../../../protocol/src/types.ts';

export interface MockSession {
  sessionId: string;
  model: { provider: string; model: string };
  active: boolean;
}

export class MockAdapter {
  public sessions: Map<string, MockSession> = new Map();

  public spawnSession(sessionId: string, model: { provider: string; model: string }): MockSession {
    const session: MockSession = { sessionId, model, active: true };
    this.sessions.set(sessionId, session);
    return session;
  }

  public createAck(sessionId: string, handoffId: string, runId: string): HandoffAckPacket {
    const sess = this.sessions.get(sessionId);
    return {
      handoffId,
      runId,
      newSessionId: sessionId,
      effectiveModel: sess ? sess.model : { provider: 'mock', model: 'mock-model' },
      verifiedInputHeadHash: 'hash-input',
      verifiedTaskSnapshotHash: 'hash-task',
      verifiedWorkspaceHash: 'hash-ws',
      ackTimestamp: Date.now()
    };
  }

  public terminateSession(sessionId: string): void {
    const sess = this.sessions.get(sessionId);
    if (sess) {
      sess.active = false;
    }
  }
}
