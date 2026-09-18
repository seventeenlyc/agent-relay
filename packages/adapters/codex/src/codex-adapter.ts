import { randomUUID } from 'node:crypto';
import type {
  AgentRelayAdapter,
  SessionCapabilities,
  SessionInspectResult,
  SpawnSessionConfig
} from '../../../protocol/src/adapter.ts';
import { CodexProcessRunner } from './runner.ts';
import type {
  InitializeResponse,
  ThreadStartResponse,
  TurnStartResponse,
  JsonRpcNotification,
  TurnCompletedParams,
  ItemDeltaParams,
  ThreadStatusChangedParams
} from './types.ts';

export interface CodexAdapterOptions {
  runner?: CodexProcessRunner;
}

interface CodexSessionState {
  sessionId: string;
  threadId: string;
  runId: string;
  active: boolean;
  draining: boolean;
  isIdle: boolean;
  activeTurnId: string | null;
  hasUserMessage: boolean;
  effectiveModel?: {
    provider: string;
    model: string;
    effort?: string;
  };
  cwd: string;
  executionAuthorized: boolean;
  executionToken?: string;
  epoch?: number;
  outputChunks: string[];
  events: JsonRpcNotification[];
  exitCode?: number | null;
  quiescenceWaiters: Array<() => void>;
}

export class CodexAdapter implements AgentRelayAdapter {
  private readonly runner: CodexProcessRunner;
  private readonly sessions: Map<string, CodexSessionState> = new Map();
  private readonly threadToSession: Map<string, string> = new Map();
  private initialized = false;
  private unsubscribeNotifications: (() => void) | null = null;

  constructor(options: CodexAdapterOptions = {}) {
    this.runner = options.runner || new CodexProcessRunner();
    this.setupNotificationHandler();
  }

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

  public async createFresh(config: SpawnSessionConfig): Promise<SessionInspectResult> {
    await this.ensureInitialized();

    const targetModel = config.model?.model || 'gpt-5.6-luna';
    const targetProvider = config.model?.provider || 'openai';
    const targetEffort = config.model?.effort || 'xhigh';
    const cwd = config.cwd || process.cwd();

    // Spawn thread via thread/start
    const threadRes = await this.runner.sendRequest<ThreadStartResponse>('thread/start', {
      cwd,
      model: targetModel,
      ephemeral: Boolean(config.noPersistence)
    });

    const threadId = threadRes.thread.id;
    const sessionId = config.sessionId || threadId;

    const state: CodexSessionState = {
      sessionId,
      threadId,
      runId: config.runId,
      active: true,
      draining: false,
      isIdle: true,
      activeTurnId: null,
      hasUserMessage: false,
      effectiveModel: {
        provider: threadRes.modelProvider || targetProvider,
        model: threadRes.model || targetModel,
        effort: threadRes.reasoningEffort || targetEffort
      },
      cwd: threadRes.cwd || cwd,
      executionAuthorized: !config.readOnly,
      outputChunks: [],
      events: [],
      quiescenceWaiters: []
    };

    this.sessions.set(sessionId, state);
    this.threadToSession.set(threadId, sessionId);

    // If initial prompt is provided, start turn
    if (config.initialPrompt) {
      state.isIdle = false;
      state.hasUserMessage = true;
      try {
        const turnRes = await this.runner.sendRequest<TurnStartResponse>('turn/start', {
          threadId,
          input: [
            {
              type: 'text',
              text: config.initialPrompt
            }
          ]
        });
        state.activeTurnId = turnRes.turn.id;
      } catch (err) {
        state.isIdle = true;
        state.activeTurnId = null;
        this.notifyIfQuiescent(state);
        throw err;
      }
    }

    return {
      sessionId,
      active: state.active,
      effectiveModel: state.effectiveModel,
      cwd: state.cwd,
      exitCode: null
    };
  }

  public inspectSession(sessionId: string): SessionInspectResult | undefined {
    const s = this.sessions.get(sessionId);
    if (!s) return undefined;
    return {
      sessionId: s.sessionId,
      active: s.active,
      effectiveModel: s.effectiveModel,
      cwd: s.cwd,
      exitCode: s.active ? null : (s.exitCode ?? 0)
    };
  }

  public async submit(sessionId: string, _messageId: string, content: string, _epoch?: number): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) {
      throw new Error(`Cannot submit to nonexistent session ${sessionId}`);
    }
    if (!s.active) {
      throw new Error(`Cannot submit to inactive session ${sessionId}`);
    }

    s.isIdle = false;
    s.hasUserMessage = true;
    try {
      const turnRes = await this.runner.sendRequest<TurnStartResponse>('turn/start', {
        threadId: s.threadId,
        input: [
          {
            type: 'text',
            text: content
          }
        ]
      });
      s.activeTurnId = turnRes.turn.id;
    } catch (err) {
      s.isIdle = true;
      s.activeTurnId = null;
      this.notifyIfQuiescent(s);
      throw err;
    }
  }

  public requestDrain(sessionId: string, _handoffId: string): boolean {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    s.draining = true;
    return true;
  }

  public async awaitQuiescence(sessionId: string, timeoutMs = 3000): Promise<'quiescent' | 'timeout' | 'error'> {
    const s = this.sessions.get(sessionId);
    if (!s) return 'error';

    if (!s.active || (s.isIdle && s.activeTurnId === null)) {
      return 'quiescent';
    }

    return new Promise<'quiescent' | 'timeout'>((resolve) => {
      let timer: NodeJS.Timeout | null = null;
      const waiter = () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        resolve('quiescent');
      };

      timer = setTimeout(() => {
        timer = null;
        const idx = s.quiescenceWaiters.indexOf(waiter);
        if (idx !== -1) {
          s.quiescenceWaiters.splice(idx, 1);
        }
        resolve('timeout');
      }, timeoutMs);

      s.quiescenceWaiters.push(waiter);
    });
  }

  public async authorizeExecution(sessionId: string, epoch: number, executionToken: string): Promise<boolean> {
    const s = this.sessions.get(sessionId);
    if (!s || !s.active) return false;
    s.executionAuthorized = true;
    s.epoch = epoch;
    s.executionToken = executionToken;
    await this.submit(
      sessionId,
      `auth-${Date.now()}`,
      `EXECUTION_AUTHORIZED: token=${executionToken} epoch=${epoch}. You may now execute write tasks.`
    );
    return true;
  }

  public async interruptOwned(sessionId: string): Promise<boolean> {
    const s = this.sessions.get(sessionId);
    if (!s) return false;

    if (s.activeTurnId) {
      try {
        await this.runner.sendRequest('turn/interrupt', {
          threadId: s.threadId,
          turnId: s.activeTurnId
        });
      } catch {
        // If turn/interrupt fails, continue with marking inactive
      }
    }
    s.active = false;
    s.isIdle = true;
    s.activeTurnId = null;
    this.notifyIfQuiescent(s);
    return true;
  }

  public async readThread(sessionId: string, includeTurns = false): Promise<unknown> {
    const s = this.sessions.get(sessionId);
    if (!s) {
      throw new Error(`Cannot read thread for nonexistent session ${sessionId}`);
    }
    // Guard: before first user message, thread/read(includeTurns: true) must not be called
    const safeIncludeTurns = s.hasUserMessage ? includeTurns : false;
    return this.runner.sendRequest('thread/read', {
      threadId: s.threadId,
      includeTurns: safeIncludeTurns
    });
  }

  public getSessionOutput(sessionId: string): string {
    const s = this.sessions.get(sessionId);
    if (!s) return '';
    return s.outputChunks.join('');
  }

  public getSessionEvents(sessionId: string): JsonRpcNotification[] {
    const s = this.sessions.get(sessionId);
    if (!s) return [];
    return [...s.events];
  }

  public async shutdown(): Promise<void> {
    if (this.unsubscribeNotifications) {
      this.unsubscribeNotifications();
      this.unsubscribeNotifications = null;
    }
    for (const [, s] of this.sessions) {
      s.active = false;
      s.isIdle = true;
      s.activeTurnId = null;
      this.notifyIfQuiescent(s);
    }
    await this.runner.terminate();
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      if (!this.runner.isRunning()) {
        await this.runner.start();
      }
      await this.runner.sendRequest<InitializeResponse>('initialize', {
        clientInfo: { name: 'agent-relay-codex', version: '0.1.0' }
      });
      this.initialized = true;
    }
  }

  private notifyIfQuiescent(s: CodexSessionState): void {
    if (!s.active || (s.isIdle && s.activeTurnId === null)) {
      const waiters = s.quiescenceWaiters.splice(0, s.quiescenceWaiters.length);
      for (const waiter of waiters) {
        try {
          waiter();
        } catch {
          // Isolate callback error
        }
      }
    }
  }

  private setupNotificationHandler(): void {
    this.unsubscribeNotifications = this.runner.onNotification((notif) => {
      const threadId = (notif.params as any)?.threadId;
      if (!threadId) return;
      const sessionId = this.threadToSession.get(threadId);
      if (!sessionId) return;
      const s = this.sessions.get(sessionId);
      if (!s) return;

      s.events.push(notif);
      if (s.events.length > 500) {
        s.events.shift();
      }

      if (notif.method === 'thread/status/changed') {
        const params = notif.params as ThreadStatusChangedParams;
        s.isIdle = params.status.type === 'idle';
        this.notifyIfQuiescent(s);
      } else if (notif.method === 'item/agentMessage/delta') {
        const params = notif.params as ItemDeltaParams;
        if (params.delta) {
          s.outputChunks.push(params.delta);
        }
      } else if (notif.method === 'turn/completed') {
        const params = notif.params as TurnCompletedParams;
        if (!s.activeTurnId || s.activeTurnId === params.turn?.id) {
          s.activeTurnId = null;
        }
        s.isIdle = true;
        this.notifyIfQuiescent(s);
      }
    });
  }
}
