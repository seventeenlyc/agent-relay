import type { HandoffAckPacket } from '../../../protocol/src/types.ts';
import type {
  AgentRelayAdapter,
  SessionCapabilities,
  SessionInspectResult,
  SpawnSessionConfig
} from '../../../protocol/src/adapter.ts';

export interface MockSession {
  sessionId: string;
  model: { provider: string; model: string; effort?: string };
  active: boolean;
  cwd: string;
  draining?: boolean;
  executionAuthorized?: boolean;
  executionToken?: string;
  epoch?: number;
}

export class MockAdapter implements AgentRelayAdapter {
  public sessions: Map<string, MockSession> = new Map();
  public readonly output: Map<string, string[]> = new Map();

  public capabilities(): SessionCapabilities {
    return {
      level: 'L3',
      streamJsonSupported: true,
      modelEffortPreservation: true,
      nativeRevealSupported: false,
      headlessSupported: true,
      cancellationSupported: true
    };
  }

  public spawnSession(sessionId: string, model: { provider: string; model: string; effort?: string }): MockSession {
    const session: MockSession = { sessionId, model, active: true, cwd: process.cwd() };
    this.sessions.set(sessionId, session);
    return session;
  }

  public createFresh(config: SpawnSessionConfig): SessionInspectResult {
    const sid = config.sessionId || `mock-sess-${Date.now()}`;
    const model = config.model || { provider: 'mock', model: 'mock-model' };
    const session: MockSession = {
      sessionId: sid,
      model,
      active: true,
      cwd: config.cwd || process.cwd(),
      draining: false,
      executionAuthorized: !config.readOnly
    };
    this.sessions.set(sid, session);
    this.output.set(sid, []);
    return {
      sessionId: sid,
      active: true,
      effectiveModel: model,
      cwd: session.cwd,
      exitCode: null
    };
  }

  public inspectSession(sessionId: string): SessionInspectResult | undefined {
    const sess = this.sessions.get(sessionId);
    if (!sess) return undefined;
    return {
      sessionId: sess.sessionId,
      active: sess.active,
      effectiveModel: sess.model,
      cwd: sess.cwd,
      exitCode: sess.active ? null : 0
    };
  }

  public submit(sessionId: string, _messageId: string, content: string, _epoch?: number): void {
    const sess = this.sessions.get(sessionId);
    if (!sess || !sess.active) {
      throw new Error(`Cannot submit to inactive or nonexistent session: ${sessionId}`);
    }
    const chunks = this.output.get(sessionId) ?? [];
    chunks.push(content);
    this.output.set(sessionId, chunks);
  }

  public getSessionOutput(sessionId: string): string {
    return (this.output.get(sessionId) ?? []).join('\n');
  }

  public requestDrain(sessionId: string, _handoffId: string): boolean {
    const sess = this.sessions.get(sessionId);
    if (!sess) return false;
    sess.draining = true;
    return true;
  }

  public awaitQuiescence(sessionId: string, _timeoutMs?: number): Promise<'quiescent' | 'timeout' | 'error'> {
    const sess = this.sessions.get(sessionId);
    if (!sess) return Promise.resolve('error');
    return Promise.resolve('quiescent');
  }

  public authorizeExecution(sessionId: string, epoch: number, executionToken: string): boolean {
    const sess = this.sessions.get(sessionId);
    if (!sess) return false;
    sess.executionAuthorized = true;
    sess.epoch = epoch;
    sess.executionToken = executionToken;
    return true;
  }

  public interruptOwned(sessionId: string): boolean {
    const sess = this.sessions.get(sessionId);
    if (!sess) return false;
    sess.active = false;
    return true;
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
    this.interruptOwned(sessionId);
  }
}
