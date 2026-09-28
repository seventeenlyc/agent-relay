import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { RelayDatabase } from '../../controller/src/run/db.ts';
import { RunController } from '../../controller/src/run/engine.ts';
import { RunStore } from '../../controller/src/run/store.ts';
import { createRuntimeForTarget, type RelayRuntime, type RuntimeFactoryOptions } from './runtime.ts';
import { buildStartTasks, type StartArgs } from './start.ts';

export interface StartIo {
  out(line: string): void;
  err(line: string): void;
}

export interface ExecuteStartOptions {
  dataDir: string;
  io: StartIo;
  runId?: string;
  createRuntime?: (target: StartArgs['target'], options: RuntimeFactoryOptions) => Promise<RelayRuntime> | RelayRuntime;
}

function modelFor(args: StartArgs): { provider: string; model: string; effort?: string } {
  const defaults = {
    codex: { provider: 'openai', model: 'gpt-5.6-luna', effort: 'xhigh' },
    claude: { provider: 'anthropic', model: 'claude-3-7-sonnet', effort: 'high' },
    dsh: { provider: 'deepseek-official', model: 'deepseek-chat' }
  }[args.target];

  const effort = args.effort ?? defaults.effort;
  return {
    provider: args.provider ?? defaults.provider,
    model: args.model ?? defaults.model,
    ...(effort ? { effort } : {})
  };
}

function exitCodeForState(state: string): number {
  return state === 'COMPLETED' ? 0 : 3;
}

export async function executeStart(args: StartArgs, options: ExecuteStartOptions): Promise<number> {
  const dataDir = path.resolve(options.dataDir);
  const runId = args.runId ?? options.runId ?? randomUUID();
  let runtime: RelayRuntime | undefined;
  let db: RelayDatabase | undefined;

  try {
    const runtimeOptions: RuntimeFactoryOptions = {
      cwd: args.workspace,
      dataDir
    };
    runtime = await (options.createRuntime
      ? options.createRuntime(args.target, runtimeOptions)
      : createRuntimeForTarget(args.target, runtimeOptions));
    if (runtime.adapterName !== args.target) {
      throw new Error(`runtime target mismatch: requested ${args.target}, got ${runtime.adapterName}`);
    }

    db = new RelayDatabase({ dbPath: path.join(dataDir, 'relay.db') });
    const store = new RunStore(db);
    const controller = new RunController({
      store,
      dataDir,
      adapter: runtime.adapter,
      adapterName: runtime.adapterName,
      createCoordinator: runtime.createCoordinator
    });
    const run = controller.startRun({
      runId,
      goal: args.goal,
      workspacePath: args.workspace,
      tasks: buildStartTasks(args),
      model: modelFor(args),
      initialUserMessage: args.prompt
    });

    options.io.out(`run started: ${run.runId} (${args.target})`);
    options.io.out(`data dir: ${dataDir}`);
    await controller.executeUntilSettled(args.maxTicks);

    const finalRun = store.getRun(run.runId);
    if (!finalRun) throw new Error(`run disappeared: ${run.runId}`);
    options.io.out(`run ${finalRun.runId} finished: ${finalRun.state}`);
    return exitCodeForState(finalRun.state);
  } catch (error) {
    options.io.err(`error: ${(error as Error).message}`);
    return 1;
  } finally {
    try {
      if (runtime) await runtime.shutdown();
    } catch (error) {
      options.io.err(`error shutting down ${args.target}: ${(error as Error).message}`);
    }
    db?.close();
  }
}

export const runStart = executeStart;
