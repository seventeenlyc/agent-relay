import { spawn, type ChildProcess } from 'node:child_process';
import readline from 'node:readline';
import path from 'node:path';
import fs from 'node:fs';
import type {
  DshJsonRpcRequest,
  DshJsonRpcResponse,
  DshJsonRpcNotification
} from './types.ts';

export interface DshLaunchConfig {
  command: string;
  args: string[];
  directNode: boolean;
  runtimeDir?: string;
}

export function resolveDshLaunchConfig(): DshLaunchConfig {
  const localAppData = process.env.LOCALAPPDATA || '';
  const currentJsonPath = path.join(localAppData, 'DSH Desktop', 'runtime', 'current.json');

  if (fs.existsSync(currentJsonPath)) {
    try {
      const state = JSON.parse(fs.readFileSync(currentJsonPath, 'utf8'));
      if (state && typeof state.relativeDir === 'string' && typeof state.entryRelativePath === 'string') {
        const runtimeDir = path.join(localAppData, 'DSH Desktop', 'runtime', state.relativeDir);
        const nodeExe = path.join(runtimeDir, 'node', 'node.exe');
        const binJs = path.join(runtimeDir, state.entryRelativePath);
        if (fs.existsSync(nodeExe) && fs.existsSync(binJs)) {
          return {
            command: nodeExe,
            args: [binJs, '--profile', 'sdk'],
            directNode: true,
            runtimeDir
          };
        }
      }
    } catch {
      // Fallback to global CLI
    }
  }

  return {
    command: process.platform === 'win32' ? 'dsh.cmd' : 'dsh',
    args: ['--profile', 'sdk'],
    directNode: false
  };
}

export interface DshProcessRunnerOptions {
  binPath?: string;
  extraArgsPrefix?: string[];
  cwd?: string;
  env?: Record<string, string>;
  startupGracePeriodMs?: number;
}

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (reason: any) => void;
  timer: NodeJS.Timeout;
}

export class DshProcessRunner {
  private readonly options: DshProcessRunnerOptions;
  private proc: ChildProcess | null = null;
  private startPromise: Promise<void> | null = null;
  private stdoutRl: readline.Interface | null = null;
  private stderrRl: readline.Interface | null = null;
  private nextId = 1;
  private readonly pendingRequests = new Map<number | string, PendingRequest>();
  private readonly notificationListeners = new Set<(notification: DshJsonRpcNotification) => void>();
  private readonly stdoutBuffer: string[] = [];
  private readonly stderrBuffer: string[] = [];
  private readonly notificationBuffer: DshJsonRpcNotification[] = [];
  private readonly MAX_BUFFER_LINES = 500;
  private exitCode: number | null = null;

  constructor(options: DshProcessRunnerOptions = {}) {
    this.options = options;
  }

  public isRunning(): boolean {
    return (
      this.proc !== null &&
      !this.proc.killed &&
      this.proc.exitCode === null &&
      this.proc.signalCode === null
    );
  }

  public getExitCode(): number | null {
    if (this.exitCode !== null) return this.exitCode;
    if (this.proc && this.proc.exitCode !== null) return this.proc.exitCode;
    return null;
  }

  public start(): Promise<void> {
    if (this.proc && this.isRunning()) {
      return Promise.resolve();
    }
    if (this.startPromise) {
      return this.startPromise;
    }

    this.exitCode = null;

    this.startPromise = new Promise<void>((resolve, reject) => {
      let command: string;
      let args: string[];
      let useShell = false;

      if (this.options.binPath) {
        command = this.options.binPath;
        args = [...(this.options.extraArgsPrefix || [])];
      } else {
        const launchConfig = resolveDshLaunchConfig();
        command = launchConfig.command;
        args = [...(this.options.extraArgsPrefix || []), ...launchConfig.args];
        useShell = !launchConfig.directNode && process.platform === 'win32';
      }

      try {
        const proc = spawn(command, args, {
          cwd: this.options.cwd || process.cwd(),
          env: {
            ...process.env,
            ...(this.options.env || {})
          },
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: useShell
        });

        this.proc = proc;

        proc.stdin?.on('error', (err: NodeJS.ErrnoException) => {
          if (err.code !== 'EPIPE') {
            // Suppress unhandled EPIPE on child shutdown
          }
        });

        const stdoutRl = readline.createInterface({ input: proc.stdout!, terminal: false });
        const stderrRl = readline.createInterface({ input: proc.stderr!, terminal: false });
        this.stdoutRl = stdoutRl;
        this.stderrRl = stderrRl;

        stdoutRl.on('line', (line) => this.handleStdoutLine(line));
        stderrRl.on('line', (line) => this.handleStderrLine(line));

        proc.on('exit', (code) => {
          if (code !== null) {
            this.exitCode = code;
          }
        });

        let settled = false;

        proc.on('error', (err) => {
          this.cleanup();
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
            this.cleanup();
            reject(new Error('DSH process closed prematurely during startup'));
          } else {
            this.cleanup();
          }
        });

        proc.once('exit', (code, signal) => {
          if (!settled) {
            settled = true;
            clearTimeout(initTimer);
            this.cleanup();
            const exitDetail = code !== null ? `code ${code}` : `signal ${signal}`;
            reject(new Error(`DSH process exited prematurely during startup with ${exitDetail}`));
          }
        });

        const initTimer = setTimeout(() => {
          if (!settled) {
            settled = true;
            resolve();
          }
        }, this.options.startupGracePeriodMs ?? 250);
      } catch (err) {
        this.cleanup();
        reject(err as Error);
      }
    });

    return this.startPromise;
  }

  public isRunningProcess(): boolean {
    return this.isRunning();
  }

  public sendRequest<T = any>(method: string, params?: any, timeoutMs = 30000): Promise<T> {
    if (!this.isRunning() || !this.proc || !this.proc.stdin || !this.proc.stdin.writable) {
      return Promise.reject(new Error('Cannot send request: DSH process is not running or stdin is closed'));
    }

    const id = this.nextId++;
    const req: DshJsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method
    };
    if (params !== undefined) {
      req.params = params;
    }

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`JSON-RPC request '${method}' timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      this.pendingRequests.set(id, { resolve, reject, timer });

      try {
        this.proc!.stdin!.write(JSON.stringify(req) + '\n', 'utf8', (err) => {
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

  public onNotification(listener: (notif: DshJsonRpcNotification) => void): () => void {
    this.notificationListeners.add(listener);
    return () => {
      this.notificationListeners.delete(listener);
    };
  }

  public getStdoutBuffer(): string[] {
    return [...this.stdoutBuffer];
  }

  public getRawLines(): string[] {
    return [...this.stdoutBuffer];
  }

  public getStderrBuffer(): string[] {
    return [...this.stderrBuffer];
  }

  public getNotificationBuffer(): DshJsonRpcNotification[] {
    return [...this.notificationBuffer];
  }

  public async shutdown(timeoutMs = 5000): Promise<void> {
    if (!this.isRunning() || !this.proc) return;

    const proc = this.proc;
    const exitPromise = new Promise<void>((resolve) => {
      if (proc.exitCode !== null || proc.signalCode !== null) {
        return resolve();
      }
      proc.once('exit', () => resolve());
      proc.once('close', () => resolve());
    });

    try {
      await this.sendRequest('shutdown', {}, timeoutMs);
      let raceTimer: NodeJS.Timeout | null = null;
      try {
        await Promise.race([
          exitPromise,
          new Promise((resolve) => {
            raceTimer = setTimeout(resolve, 500);
            raceTimer.unref();
          })
        ]);
      } finally {
        if (raceTimer) {
          clearTimeout(raceTimer);
        }
      }
    } catch {
      // Ignore shutdown RPC error and terminate
    }

    await this.terminate();
  }

  public terminate(): Promise<void> {
    if (!this.proc) {
      return Promise.resolve();
    }

    const proc = this.proc;
    return new Promise((resolve) => {
      let resolved = false;
      let forceTimer: NodeJS.Timeout | null = null;

      const finish = (code?: number | null) => {
        if (!resolved) {
          resolved = true;
          if (forceTimer) {
            clearTimeout(forceTimer);
            forceTimer = null;
          }
          if (code !== undefined && code !== null) {
            this.exitCode = code;
          } else if (proc.exitCode !== null) {
            this.exitCode = proc.exitCode;
          }
          this.cleanup();
          resolve();
        }
      };

      if (proc.exitCode !== null || proc.signalCode !== null) {
        finish();
        return;
      }

      proc.once('close', (code) => finish(code));
      proc.once('exit', (code) => finish(code));

      try {
        if (proc.stdin && !proc.stdin.destroyed && proc.stdin.writable) {
          proc.stdin.end();
        }
      } catch {
        // Ignore stdin close error
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
      }
    });
  }

  public cleanup(): void {
    if (this.stdoutRl) {
      try {
        this.stdoutRl.close();
      } catch {}
      this.stdoutRl = null;
    }
    if (this.stderrRl) {
      try {
        this.stderrRl.close();
      } catch {}
      this.stderrRl = null;
    }
    for (const [, req] of this.pendingRequests) {
      clearTimeout(req.timer);
      req.reject(new Error('DSH process terminated'));
    }
    this.pendingRequests.clear();
    this.proc = null;
    this.startPromise = null;
  }

  private handleStdoutLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    this.stdoutBuffer.push(line);
    if (this.stdoutBuffer.length > this.MAX_BUFFER_LINES) {
      this.stdoutBuffer.shift();
    }

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
        const notif: DshJsonRpcNotification = {
          jsonrpc: '2.0',
          method: msg.method,
          params: msg.params
        };

        this.notificationBuffer.push(notif);
        if (this.notificationBuffer.length > this.MAX_BUFFER_LINES) {
          this.notificationBuffer.shift();
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

  private handleStderrLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    this.stderrBuffer.push(line);
    if (this.stderrBuffer.length > this.MAX_BUFFER_LINES) {
      this.stderrBuffer.shift();
    }
  }
}
