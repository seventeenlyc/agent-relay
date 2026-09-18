// packages/cli/src/cli.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RelayDatabase } from '../../controller/src/run/db.ts';
import { RunStore, TERMINAL_RUN_STATES, type RunRecord } from '../../controller/src/run/store.ts';
import { ControlIntentLog } from '../../controller/src/run/intent.ts';
import type { ControlIntentKind } from '../../controller/src/run/store.ts';
import { SessionChainLedger } from '../../controller/src/run/chain.ts';
import { buildRunStatus, renderStatusCard, renderStatusJson } from '../../controller/src/run/status.ts';
import { renderChain } from './render.ts';

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

export interface CliDeps {
  io?: CliIo;
  env?: NodeJS.ProcessEnv;
}

const USAGE = [
  '用法 (usage): agent-relay <command> [--run <id>] [--data-dir <path>] [options]',
  '',
  '命令:',
  '  status    显示状态卡（--json 输出结构化结果）',
  '  chain     显示旧→新会话链',
  '  pause     在下一安全节点暂停（不创建下一执行会话）',
  '  stop      立即停止',
  '  resume    从暂停中继续',
  '  disable   禁用自动交接',
  '  watch     轮询刷新状态卡（--interval <ms>，--iterations <n>）'
].join('\n');

const COMMANDS = ['status', 'chain', 'pause', 'stop', 'resume', 'disable', 'watch'] as const;
type Command = (typeof COMMANDS)[number];

interface ParsedArgs {
  command: Command;
  runId?: string;
  dataDir?: string;
  json: boolean;
  intervalMs: number;
  iterations?: number;
}

class UsageError extends Error {}
class NotFoundError extends Error {}

export function resolveDataDir(explicit: string | undefined, env: NodeJS.ProcessEnv): string {
  if (explicit) return path.resolve(explicit);
  if (env.AGENT_RELAY_DATA_DIR) return path.resolve(env.AGENT_RELAY_DATA_DIR);
  if (process.platform === 'win32') {
    const localAppData = env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
    return path.join(localAppData, 'agent-relay');
  }
  const stateHome = env.XDG_STATE_HOME ?? path.join(os.homedir(), '.local', 'state');
  return path.join(stateHome, 'agent-relay');
}

function parseArgs(argv: string[]): ParsedArgs {
  if (argv.length === 0) {
    throw new UsageError('missing command');
  }
  const command = argv[0] as Command;
  if (!COMMANDS.includes(command)) {
    throw new UsageError(`unknown command: ${argv[0]}`);
  }

  const parsed: ParsedArgs = { command, json: false, intervalMs: 2000 };

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    const takeValue = (): string => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new UsageError(`${arg} requires a value`);
      }
      i++;
      return value;
    };

    switch (arg) {
      case '--run':
        parsed.runId = takeValue();
        break;
      case '--data-dir':
        parsed.dataDir = takeValue();
        break;
      case '--json':
        parsed.json = true;
        break;
      case '--interval':
        parsed.intervalMs = Number(takeValue());
        if (!Number.isFinite(parsed.intervalMs) || parsed.intervalMs < 0) {
          throw new UsageError('--interval must be a non-negative number');
        }
        break;
      case '--iterations':
        parsed.iterations = Number(takeValue());
        if (!Number.isInteger(parsed.iterations) || parsed.iterations < 1) {
          throw new UsageError('--iterations must be a positive integer');
        }
        break;
      default:
        throw new UsageError(`unknown option: ${arg}`);
    }
  }

  return parsed;
}

function isTerminal(run: RunRecord): boolean {
  return TERMINAL_RUN_STATES.includes(run.state);
}

function resolveRun(store: RunStore, requested: string | undefined): RunRecord {
  if (requested) {
    const run = store.getRun(requested);
    if (!run) throw new NotFoundError(`no run with id ${requested}`);
    return run;
  }

  const active = store.listRuns().filter((run) => !isTerminal(run));
  // 活动 run 为空时退回到全部 run：唯一的终态 run 也要能解析出来，
  // 状态守卫才能按设计 §9.3 以退出码 3 拒绝，而不是错报 run 不存在（退出码 2）。
  const candidates = active.length > 0 ? active : store.listRuns();
  if (candidates.length === 0) {
    throw new NotFoundError('no run found; specify --run or start a run first');
  }
  if (candidates.length > 1) {
    throw new NotFoundError(`several active runs found; specify one with --run (${candidates.map((r) => r.runId).join(', ')})`);
  }
  return candidates[0];
}

function openStore(dataDir: string): { db: RelayDatabase; store: RunStore } | null {
  const dbPath = path.join(dataDir, 'relay.db');
  if (!fs.existsSync(dbPath)) {
    return null;
  }
  const db = new RelayDatabase({ dbPath });
  return { db, store: new RunStore(db) };
}

const INTENT_GUARD: Record<'pause' | 'stop' | 'resume' | 'disable', { kind: ControlIntentKind; allows: (run: RunRecord) => boolean; rejection: string }> = {
  pause: {
    kind: 'pause_next_node',
    allows: (run) => !isTerminal(run),
    rejection: 'cannot pause a run in state'
  },
  stop: {
    kind: 'stop_now',
    allows: (run) => !isTerminal(run),
    rejection: 'cannot stop a run in state'
  },
  resume: {
    kind: 'resume',
    allows: (run) => run.state === 'PAUSED',
    rejection: 'cannot resume a run in state'
  },
  disable: {
    kind: 'disable',
    allows: (run) => !isTerminal(run),
    rejection: 'cannot disable a run in state'
  }
};

export async function runCli(argv: string[], deps: CliDeps = {}): Promise<number> {
  const io: CliIo = deps.io ?? {
    out: (line: string) => process.stdout.write(`${line}\n`),
    err: (line: string) => process.stderr.write(`${line}\n`)
  };
  const env = deps.env ?? process.env;

  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    io.err((err as Error).message);
    io.err(USAGE);
    return 1;
  }

  const dataDir = resolveDataDir(args.dataDir, env);
  const opened = openStore(dataDir);
  if (!opened) {
    io.err(`no run found: ${path.join(dataDir, 'relay.db')} does not exist`);
    return 2;
  }
  const { db, store } = opened;

  try {
    const run = resolveRun(store, args.runId);

    switch (args.command) {
      case 'status': {
        const view = buildRunStatus(store, run.runId);
        io.out(args.json ? renderStatusJson(view) : renderStatusCard(view).trimEnd());
        return 0;
      }

      case 'chain': {
        const links = new SessionChainLedger(store).list(run.runId);
        if (args.json) {
          io.out(JSON.stringify(links, null, 2));
        } else {
          io.out(renderChain(links).trimEnd());
        }
        return 0;
      }

      case 'watch': {
        const iterations = args.iterations ?? Number.POSITIVE_INFINITY;
        for (let i = 0; i < iterations; i++) {
          if (i > 0 && args.intervalMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, args.intervalMs));
          }
          const view = buildRunStatus(store, run.runId);
          io.out(args.json ? renderStatusJson(view) : renderStatusCard(view).trimEnd());
          if (TERMINAL_RUN_STATES.includes(view.state)) {
            break;
          }
        }
        return 0;
      }

      default: {
        const action = args.command as 'pause' | 'stop' | 'resume' | 'disable';
        const rule = INTENT_GUARD[action];
        if (!rule.allows(run)) {
          io.err(`${rule.rejection} ${run.state}`);
          return 3;
        }
        // 先落库，再打印确认——确认输出即代表意图已持久化
        const intent = new ControlIntentLog(store).append(run.runId, rule.kind);
        io.out(`${action} requested for run ${run.runId} (watermark ${intent.watermark}, intent ${intent.intentId})`);
        return 0;
      }
    }
  } catch (err) {
    if (err instanceof NotFoundError) {
      io.err(err.message);
      return 2;
    }
    io.err(`error: ${(err as Error).message}`);
    return 1;
  } finally {
    db.close();
  }
}
