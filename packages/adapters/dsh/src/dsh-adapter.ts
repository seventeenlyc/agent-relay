import { randomUUID } from 'node:crypto';
import type {
  AgentRelayAdapter,
  SessionCapabilities,
  SessionInspectResult,
  SpawnSessionConfig
} from '../../../protocol/src/adapter.ts';
import {
  DshProcessRunner,
  type DshProcessRunnerOptions
} from './runner.ts';
import type {
  DshInitializeParams,
  DshInitializeResult,
  DshSessionPromptParams,
  DshSessionPromptResult,
  DshJsonRpcNotification
} from './types.ts';

export interface DshAdapterOptions {
  runnerOptions?: DshProcessRunnerOptions;
  runnerFactory?: (sessionId: string, config: SpawnSessionConfig) => DshProcessRunner;
  runner?: DshProcessRunner;
}

interface DshSessionState {
  sessionId: string;
  runId: string;
  runner: DshProcessRunner;
  active: boolean;
  draining: boolean;
  isIdle: boolean;
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
  events: DshJsonRpcNotification[];
  exitCode?: number | null;
  quiescenceWaiters: Array<() => void>;
  unsubscribe: (() => void) | null;
}

export class DshAdapter implements AgentRelayAdapter {
  private readonly options: DshAdapterOptions;
  private readonly sessions: Map<string, DshSessionState> = new Map();

  constructor(options: DshAdapterOptions = {}) {
    this.options = options;
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
    const sessionId = config.sessionId || `dsh-${randomUUID()}`;
    const targetProvider = config.model?.provider || 'deepseek-official';
    const targetModel = config.model?.model || 'deepseek-chat';
    const targetEffort = config.model?.effort;
    const cwd = config.cwd || process.cwd();

    const runner = this.createRunner(sessionId, config);
    if (!runner.isRunning()) {
      await runner.start();
    }

    const state: DshSessionState = {
      sessionId,
      runId: config.runId,
      runner,
      active: true,
      draining: false,
      isIdle: true,
      effectiveModel: {
        provider: targetProvider,
        model: targetModel,
        ...(targetEffort !== undefined ? { effort: targetEffort } : {})
      },
      cwd,
      executionAuthorized: !config.readOnly,
      outputChunks: [],
      events: [],
      quiescenceWaiters: [],
      unsubscribe: null
    };

    const unsubscribe = runner.onNotification((notif) => {
      this.handleNotification(state, notif);
    });
    state.unsubscribe = unsubscribe;

    this.sessions.set(sessionId, state);

    // Initialize runtime worker
    const initParams: DshInitializeParams = {
      cwd,
      provider: targetProvider,
      model: targetModel
    };
    if (targetEffort !== undefined) {
      initParams.reasoningEffort = targetEffort;
    }

    try {
      await runner.sendRequest<DshInitializeResult>('initialize', initParams);
    } catch (err) {
      state.active = false;
      state.isIdle = true;
      this.notifyIfQuiescent(state);
      throw err;
    }

    // If initialPrompt provided, mark not idle and send session/prompt
    if (config.initialPrompt) {
      state.isIdle = false;
      try {
        await runner.sendRequest<DshSessionPromptResult>('session/prompt', {
          sessionId,
          contentBlocks: [
            {
              type: 'text',
              text: config.initialPrompt
            }
          ]
        });
      } catch (err) {
        state.isIdle = true;
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
      exitCode: s.active ? null : (s.exitCode ?? s.runner.getExitCode() ?? 0)
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
    try {
      await s.runner.sendRequest<DshSessionPromptResult>('session/prompt', {
        sessionId: s.sessionId,
        contentBlocks: [
          {
            type: 'text',
            text: content
          }
        ]
      });
    } catch (err) {
      s.isIdle = true;
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

    if (!s.active || s.isIdle) {
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
      `EXECUTION_TOKEN: ${executionToken} epoch=${epoch}. You may now execute write tasks.`
    );
    return true;
  }

  public async interruptOwned(sessionId: string): Promise<boolean> {
    const s = this.sessions.get(sessionId);
    if (!s) return false;

    s.active = false;
    s.isIdle = true;
    this.notifyIfQuiescent(s);

    if (s.unsubscribe) {
      s.unsubscribe();
      s.unsubscribe = null;
    }

    try {
      await s.runner.shutdown();
    } catch {
      await s.runner.terminate();
    }

    s.exitCode = s.runner.getExitCode() ?? 0;
    return true;
  }

  public getSessionOutput(sessionId: string): string {
    const s = this.sessions.get(sessionId);
    if (!s) return '';
    return s.outputChunks.join('');
  }

  public getSessionEvents(sessionId: string): DshJsonRpcNotification[] {
    const s = this.sessions.get(sessionId);
    if (!s) return [];
    return [...s.events];
  }

  public async shutdown(): Promise<void> {
    const shutdownPromises: Promise<void>[] = [];
    for (const [, s] of this.sessions) {
      s.active = false;
      s.isIdle = true;
      this.notifyIfQuiescent(s);

      if (s.unsubscribe) {
        s.unsubscribe();
        s.unsubscribe = null;
      }

      shutdownPromises.push(
        (async () => {
          try {
            await s.runner.shutdown();
          } catch {
            await s.runner.terminate();
          }
          s.exitCode = s.runner.getExitCode() ?? 0;
        })()
      );
    }
    await Promise.all(shutdownPromises);
  }

  private createRunner(sessionId: string, config: SpawnSessionConfig): DshProcessRunner {
    if (this.options.runnerFactory) {
      return this.options.runnerFactory(sessionId, config);
    }
    if (this.options.runner) {
      return this.options.runner;
    }
    return new DshProcessRunner({
      ...this.options.runnerOptions,
      cwd: config.cwd || this.options.runnerOptions?.cwd
    });
  }

  private handleNotification(state: DshSessionState, notif: DshJsonRpcNotification): void {
    state.events.push(notif);
    if (state.events.length > 500) {
      state.events.shift();
    }

    if (notif.method === 'session.status') {
      const status = (notif.params as any)?.status;
      if (status === 'idle') {
        state.isIdle = true;
        this.notifyIfQuiescent(state);
      } else if (status === 'running') {
        state.isIdle = false;
      }
    } else if (notif.method === 'session.event') {
      const text = (notif.params as any)?.text ?? (notif.params as any)?.data?.text;
      if (typeof text === 'string') {
        state.outputChunks.push(text);
      }
    }
  }

  private notifyIfQuiescent(s: DshSessionState): void {
    if (!s.active || s.isIdle) {
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
}
