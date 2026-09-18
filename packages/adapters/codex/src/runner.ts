import { spawn, type ChildProcess } from 'node:child_process';
import readline from 'node:readline';
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcNotification
} from './types.ts';

export interface CodexProcessRunnerOptions {
  binPath?: string;
  extraArgsPrefix?: string[];
  cwd?: string;
  env?: Record<string, string>;
  onStderr?: (line: string) => void;
  startupGracePeriodMs?: number;
}

export type NotificationListener = (notification: JsonRpcNotification) => void;

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const MAX_BUFFER_LINES = 500;

export class CodexProcessRunner {
  private readonly binPath: string;
  private readonly extraArgsPrefix: string[];
  private readonly cwd: string;
  private readonly env: Record<string, string>;
  private readonly onStderrCallback?: (line: string) => void;
  private readonly startupGracePeriodMs: number;

  private process: ChildProcess | null = null;
  private startPromise: Promise<void> | null = null;
  private rlStdout: readline.Interface | null = null;
  private rlStderr: readline.Interface | null = null;
  private reqIdCounter = 1;
  private pendingRequests: Map<number | string, PendingRequest> = new Map();
  private notificationListeners: Set<NotificationListener> = new Set();
  private rawLines: string[] = [];
  private stderrLines: string[] = [];
  private events: JsonRpcNotification[] = [];

  constructor(options: CodexProcessRunnerOptions = {}) {
    this.binPath = options.binPath || process.env.CODEX_BIN_PATH || 'codex';
    this.extraArgsPrefix = options.extraArgsPrefix || ['app-server', '--stdio'];
    this.cwd = options.cwd || process.cwd();
    this.env = options.env || {};
    this.onStderrCallback = options.onStderr;
    this.startupGracePeriodMs = options.startupGracePeriodMs ?? 100;
  }

  public start(): Promise<void> {
    if (this.process && this.isRunning()) {
      return Promise.resolve();
    }
    if (this.startPromise) {
      return this.startPromise;
    }

    this.startPromise = new Promise<void>((resolve, reject) => {
      try {
        const proc = spawn(this.binPath, this.extraArgsPrefix, {
          cwd: this.cwd,
          env: { ...process.env, ...this.env },
          stdio: ['pipe', 'pipe', 'pipe']
        });

        this.process = proc;

        proc.stdin?.on('error', (err: NodeJS.ErrnoException) => {
          if (err.code !== 'EPIPE') {
            // Suppress unhandled EPIPE on child shutdown
          }
        });

        const rlStdout = readline.createInterface({ input: proc.stdout! });
        const rlStderr = readline.createInterface({ input: proc.stderr! });
        this.rlStdout = rlStdout;
        this.rlStderr = rlStderr;

        rlStdout.on('line', (line) => {
          this.rawLines.push(line);
          if (this.rawLines.length > MAX_BUFFER_LINES) {
            this.rawLines.shift();
          }
          this.handleStdoutLine(line);
        });

        rlStderr.on('line', (line) => {
          this.stderrLines.push(line);
          if (this.stderrLines.length > MAX_BUFFER_LINES) {
            this.stderrLines.shift();
          }
          if (this.onStderrCallback) {
            try {
              this.onStderrCallback(line);
            } catch {
              // Isolate callback error
            }
          }
        });

        let settled = false;

        proc.on('error', (err) => {
          this.cleanupProcess();
          if (!settled) {
            settled = true;
            clearTimeout(initTimer);
            reject(err);
          }
        });

        proc.once('close', () => {
          if (!settled) {
            settled = true;
            clearTimeout(initTimer);
            this.cleanupProcess();
            reject(new Error('Codex process closed prematurely during startup'));
          } else {
            this.cleanupProcess();
          }
        });

        proc.once('exit', (code, signal) => {
          if (!settled) {
            settled = true;
            clearTimeout(initTimer);
            this.cleanupProcess();
            const exitDetail = code !== null ? `code ${code}` : `signal ${signal}`;
            reject(new Error(`Codex process exited prematurely during startup with ${exitDetail}`));
          }
        });

        // Give process a brief moment to initialize stdio
        const initTimer = setTimeout(() => {
          if (!settled) {
            settled = true;
            resolve();
          }
        }, this.startupGracePeriodMs);
      } catch (err) {
        this.cleanupProcess();
        reject(err as Error);
      }
    });

    return this.startPromise;
  }

  public isRunning(): boolean {
    return (
      this.process !== null &&
      !this.process.killed &&
      this.process.exitCode === null &&
      this.process.signalCode === null
    );
  }

  public onNotification(listener: NotificationListener): () => void {
    this.notificationListeners.add(listener);
    return () => {
      this.notificationListeners.delete(listener);
    };
  }

  public sendRequest<TRes = unknown>(
    method: string,
    params?: unknown,
    timeoutMs = 30000
  ): Promise<TRes> {
    if (!this.isRunning() || !this.process || !this.process.stdin || !this.process.stdin.writable) {
      return Promise.reject(new Error('Codex process is not running or stdin is closed'));
    }

    const id = this.reqIdCounter++;
    const payload: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method
    };
    if (params !== undefined) {
      payload.params = params;
    }

    return new Promise<TRes>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`JSON-RPC request '${method}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingRequests.set(id, {
        resolve,
        reject,
        timer
      });

      try {
        this.process!.stdin!.write(JSON.stringify(payload) + '\n', 'utf8', (err) => {
          if (err) {
            clearTimeout(timer);
            this.pendingRequests.delete(id);
            reject(err);
          }
        });
      } catch (err) {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(err as Error);
      }
    });
  }

  public terminate(): Promise<void> {
    if (!this.process) {
      return Promise.resolve();
    }

    const proc = this.process;
    return new Promise((resolve) => {
      let resolved = false;
      let forceTimer: NodeJS.Timeout | null = null;

      const finish = () => {
        if (!resolved) {
          resolved = true;
          if (forceTimer) {
            clearTimeout(forceTimer);
            forceTimer = null;
          }
          this.cleanupProcess();
          resolve();
        }
      };

      if (proc.exitCode !== null || proc.signalCode !== null) {
        finish();
        return;
      }

      proc.once('close', finish);
      proc.once('exit', finish);

      try {
        if (proc.stdin && !proc.stdin.destroyed && proc.stdin.writable) {
          proc.stdin.end();
        }
      } catch {
        // Ignore stdin end error
      }

      forceTimer = setTimeout(() => {
        try {
          if (proc.exitCode === null && proc.signalCode === null) {
            proc.kill('SIGKILL');
          }
        } catch {}
        finish();
      }, 500);
      if (typeof forceTimer.unref === 'function') {
        forceTimer.unref();
      }

      try {
        proc.kill('SIGTERM');
      } catch {
        finish();
        return;
      }
    });
  }

  public getRawLines(): string[] {
    return [...this.rawLines];
  }

  public getStderrLines(): string[] {
    return [...this.stderrLines];
  }

  public getEvents(): JsonRpcNotification[] {
    return [...this.events];
  }

  private handleStdoutLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const msg = JSON.parse(trimmed);
      if (msg.id !== undefined && msg.id !== null && this.pendingRequests.has(msg.id)) {
        const pending = this.pendingRequests.get(msg.id)!;
        this.pendingRequests.delete(msg.id);
        clearTimeout(pending.timer);

        if (msg.error) {
          const errMsg = msg.error.message || `JSON-RPC error code ${msg.error.code}`;
          const err = new Error(errMsg);
          (err as any).code = msg.error.code;
          (err as any).data = msg.error.data;
          pending.reject(err);
        } else {
          pending.resolve(msg.result);
        }
      } else if (msg.method && (msg.id === undefined || msg.id === null)) {
        const notif: JsonRpcNotification = {
          jsonrpc: '2.0',
          method: msg.method,
          params: msg.params
        };

        this.events.push(notif);
        if (this.events.length > MAX_BUFFER_LINES) {
          this.events.shift();
        }

        for (const listener of this.notificationListeners) {
          try {
            listener(notif);
          } catch {
            // Isolate listener error
          }
        }
      }
    } catch {
      // Non-JSON line fallback
    }
  }

  private cleanupProcess(): void {
    if (this.rlStdout) {
      try {
        this.rlStdout.close();
      } catch {}
      this.rlStdout = null;
    }
    if (this.rlStderr) {
      try {
        this.rlStderr.close();
      } catch {}
      this.rlStderr = null;
    }
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Codex process terminated'));
    }
    this.pendingRequests.clear();
    this.process = null;
    this.startPromise = null;
  }
}
