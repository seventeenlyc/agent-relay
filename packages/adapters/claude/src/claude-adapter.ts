import { randomUUID } from 'node:crypto';
import type {
  AgentRelayAdapter,
  SessionCapabilities,
  SessionInspectResult,
  SpawnSessionConfig
} from '../../../protocol/src/adapter.ts';
import { ClaudeProcessRunner } from './runner.ts';
import { ClaudeHookHandler } from './hooks.ts';
import type { ClaudeStreamEvent, SystemInitEvent } from './types.ts';

export interface ClaudeAdapterOptions {
  runner?: ClaudeProcessRunner;
  hookHandler?: ClaudeHookHandler;
}

interface SessionState {
  sessionId: string;
  runId: string;
  active: boolean;
  draining: boolean;
  effectiveModel?: {
    provider: string;
    model: string;
    effort?: string;
  };
  cwd: string;
  executionAuthorized: boolean;
  executionToken?: string;
  epoch?: number;
  lastEvents: ClaudeStreamEvent[];
  exitCode?: number | null;
}

export class ClaudeAdapter implements AgentRelayAdapter {
  private readonly runner: ClaudeProcessRunner;
  private readonly hookHandler: ClaudeHookHandler;
  private readonly sessions: Map<string, SessionState> = new Map();

  constructor(options: ClaudeAdapterOptions = {}) {
    this.runner = options.runner || new ClaudeProcessRunner();
    this.hookHandler = options.hookHandler || new ClaudeHookHandler();
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
    const sid = config.sessionId || randomUUID();
    const state: SessionState = {
      sessionId: sid,
      runId: config.runId,
      active: true,
      draining: false,
      cwd: config.cwd || process.cwd(),
      executionAuthorized: !config.readOnly,
      lastEvents: []
    };
    this.sessions.set(sid, state);

    // Asynchronously launch session run
    this.runner
      .runSession({
        sessionId: sid,
        runId: config.runId,
        resume: false, // Strict fresh session
        model: config.model,
        bare: config.bare,
        noPersistence: config.noPersistence,
        includeHookEvents: config.includeHookEvents,
        cwd: state.cwd,
        env: config.env,
        initialPrompt: config.initialPrompt,
        keepStdinOpen: true,
        onEvent: (ev) => {
          state.lastEvents.push(ev);
          if (state.lastEvents.length > 100) {
            state.lastEvents.shift();
          }
          if (ev.type === 'system' && (ev as Record<string, unknown>).subtype === 'init') {
            const initEv = ev as SystemInitEvent;
            state.effectiveModel = {
              provider: 'anthropic',
              model: initEv.model,
              effort: config.model?.effort
            };
          }
          this.hookHandler.processEvent(ev);
        }
      })
      .then((res) => {
        state.active = false;
        state.exitCode = res.code;
      })
      .catch(() => {
        state.active = false;
        state.exitCode = 1;
      });

    // Wait briefly for system:init or return initial state
    const start = Date.now();
    while (Date.now() - start < 50) {
      if (state.effectiveModel || !state.active) {
        break;
      }
      await new Promise((r) => setTimeout(r, 5));
    }

    if (!state.effectiveModel && config.model) {
      state.effectiveModel = config.model;
    }

    return {
      sessionId: sid,
      active: state.active,
      effectiveModel: state.effectiveModel || config.model,
      cwd: state.cwd,
      exitCode: state.exitCode !== undefined ? state.exitCode : (state.active ? null : 0)
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
      exitCode: s.exitCode !== undefined ? s.exitCode : (s.active ? null : 0)
    };
  }

  public submit(sessionId: string, _messageId: string, content: string, _epoch?: number): void {
    const s = this.sessions.get(sessionId);
    if (!s || !s.active) {
      throw new Error(`Cannot submit to inactive session ${sessionId}`);
    }
    const delivered = this.runner.sendInput(sessionId, content);
    if (!delivered) {
      throw new Error(`Failed to deliver input to session ${sessionId}: stdin is not writable`);
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
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (!s.active || s.draining) {
        return 'quiescent';
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    return 'timeout';
  }

  public authorizeExecution(sessionId: string, epoch: number, executionToken: string): boolean {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    s.executionAuthorized = true;
    s.epoch = epoch;
    s.executionToken = executionToken;
    this.runner.sendInput(
      sessionId,
      `EXECUTION_AUTHORIZED: token=${executionToken} epoch=${epoch}. You may now execute write tasks.`
    );
    return true;
  }

  public interruptOwned(sessionId: string): boolean {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    s.active = false;
    return this.runner.terminateSession(sessionId);
  }

  public getHookHandler(): ClaudeHookHandler {
    return this.hookHandler;
  }
}
