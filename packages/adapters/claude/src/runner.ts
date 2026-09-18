import { spawn, type ChildProcess } from 'node:child_process';
import readline from 'node:readline';
import type { ClaudeStreamEvent, ProcessRunOptions, ProcessRunResult } from './types.ts';

export interface ClaudeProcessRunnerOptions {
  binPath?: string;
  extraArgsPrefix?: string[];
}

export class ClaudeProcessRunner {
  private readonly binPath: string;
  private readonly extraArgsPrefix: string[];
  private activeProcesses: Map<string, ChildProcess> = new Map();

  constructor(options: ClaudeProcessRunnerOptions = {}) {
    this.binPath = options.binPath || process.env.CLAUDE_BIN_PATH || 'claude';
    this.extraArgsPrefix = options.extraArgsPrefix || [];
  }

  public runSession(options: ProcessRunOptions): Promise<ProcessRunResult> {
    const startTime = Date.now();
    const effectiveSessionId = options.sessionId;

    const cliArgs: string[] = [
      ...this.extraArgsPrefix,
      '-p',
      '--output-format',
      'stream-json',
      '--input-format',
      'stream-json',
      '--verbose'
    ];

    if (options.resume) {
      cliArgs.push('--resume', effectiveSessionId);
    } else {
      cliArgs.push('--session-id', effectiveSessionId);
    }

    if (options.noPersistence) {
      cliArgs.push('--no-session-persistence');
    }

    if (options.bare) {
      cliArgs.push('--bare');
    }

    if (options.includeHookEvents) {
      cliArgs.push('--include-hook-events');
    }

    if (options.model?.model) {
      cliArgs.push('--model', options.model.model);
    }

    if (options.model?.effort) {
      cliArgs.push('--effort', options.model.effort);
    }

    const proc = spawn(this.binPath, cliArgs, {
      cwd: options.cwd || process.cwd(),
      env: { ...process.env, ...options.env },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    this.activeProcesses.set(effectiveSessionId, proc);

    if (proc.stdin) {
      proc.stdin.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code !== 'EPIPE') {
          // Suppress broken pipe if child exits early
        }
      });
    }

    const rlStdout = readline.createInterface({ input: proc.stdout! });
    const rlStderr = readline.createInterface({ input: proc.stderr! });

    const MAX_BUFFER_LINES = 500;
    const events: ClaudeStreamEvent[] = [];
    const rawLines: string[] = [];
    const stderrLines: string[] = [];
    let timedOut = false;
    let timeoutTimer: NodeJS.Timeout | null = null;

    if (options.timeoutMs && options.timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        this.killProcess(proc);
      }, options.timeoutMs);
    }

    rlStdout.on('line', (line) => {
      rawLines.push(line);
      if (rawLines.length > MAX_BUFFER_LINES) {
        rawLines.shift();
      }
      let ev: ClaudeStreamEvent | null = null;
      try {
        ev = JSON.parse(line) as ClaudeStreamEvent;
        events.push(ev);
        if (events.length > MAX_BUFFER_LINES) {
          events.shift();
        }
      } catch {
        // Raw line fallback
      }
      if (ev && options.onEvent) {
        try {
          options.onEvent(ev);
        } catch {
          // Isolate consumer callback errors
        }
      }
    });

    rlStderr.on('line', (line) => {
      stderrLines.push(line);
      if (stderrLines.length > MAX_BUFFER_LINES) {
        stderrLines.shift();
      }
      if (options.onStderr) {
        try {
          options.onStderr(line);
        } catch {
          // Isolate consumer callback errors
        }
      }
    });

    // Write initial user message if provided, or close stdin if not keeping open
    if (options.initialPrompt !== undefined && proc.stdin && proc.stdin.writable) {
      const payload =
        JSON.stringify({
          type: 'user',
          message: {
            role: 'user',
            content: options.initialPrompt
          }
        }) + '\n';
      try {
        proc.stdin.write(payload);
        if (!options.keepStdinOpen) {
          proc.stdin.end();
        }
      } catch {
        // Ignore EPIPE
      }
    } else if (options.initialPrompt === undefined && !options.keepStdinOpen && proc.stdin && proc.stdin.writable) {
      try {
        proc.stdin.end();
      } catch {
        // Ignore EPIPE
      }
    }

    return new Promise((resolve, reject) => {
      proc.on('close', (code) => {
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
          timeoutTimer = null;
        }
        this.activeProcesses.delete(effectiveSessionId);
        const durationMs = Date.now() - startTime;
        resolve({
          sessionId: effectiveSessionId,
          code,
          durationMs,
          timedOut,
          events,
          rawLines,
          stderrLines
        });
      });

      proc.on('error', (err) => {
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
          timeoutTimer = null;
        }
        this.activeProcesses.delete(effectiveSessionId);
        reject(err);
      });
    });
  }

  public sendInput(sessionId: string, text: string): boolean {
    const proc = this.activeProcesses.get(sessionId);
    if (!proc || !proc.stdin || !proc.stdin.writable) return false;
    const payload =
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: text
        }
      }) + '\n';
    try {
      proc.stdin.write(payload);
      return true;
    } catch {
      return false;
    }
  }

  public terminateSession(sessionId: string): boolean {
    const proc = this.activeProcesses.get(sessionId);
    if (!proc) return false;
    this.killProcess(proc);
    return true;
  }

  private killProcess(proc: ChildProcess): void {
    try {
      proc.kill('SIGTERM');
      const timer = setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {}
      }, 1000);
      if (timer && typeof timer.unref === 'function') {
        timer.unref();
      }
    } catch {}
  }
}
