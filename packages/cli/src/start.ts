import fs from 'node:fs';
import path from 'node:path';

export type StartTarget = 'codex' | 'claude' | 'dsh';

export interface StartTask {
  taskId: string;
  requirementId: string;
  title: string;
  description?: string;
  dependencies?: string[];
  allowedPaths?: string[];
  expectedArtifacts?: string[];
}

export interface StartArgs {
  target: StartTarget;
  workspace: string;
  goal: string;
  prompt: string;
  runId?: string;
  dataDir?: string;
  tasksFile?: string;
  provider?: string;
  model?: string;
  effort?: string;
  maxTicks: number;
}

class StartUsageError extends Error {}

function takeOption(argv: string[], index: number, arg: string): { value: string; nextIndex: number } {
  const equalsIndex = arg.indexOf('=');
  if (equalsIndex !== -1) {
    const value = arg.slice(equalsIndex + 1);
    if (!value) throw new StartUsageError(`${arg.slice(0, equalsIndex)} requires a value`);
    return { value, nextIndex: index };
  }

  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new StartUsageError(`${arg} requires a value`);
  }
  return { value, nextIndex: index + 1 };
}

export function parseStartArgs(argv: string[], cwd = process.cwd()): StartArgs {
  const parsed: Partial<StartArgs> = { maxTicks: 100 };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      throw new StartUsageError(`unknown argument: ${arg}`);
    }

    const optionName = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
    const option = takeOption(argv, index, arg);
    index = option.nextIndex;

    switch (optionName) {
      case '--target':
        if (option.value !== 'codex' && option.value !== 'claude' && option.value !== 'dsh') {
          throw new StartUsageError('--target must be one of codex, claude, dsh');
        }
        parsed.target = option.value;
        break;
      case '--workspace':
        parsed.workspace = path.resolve(option.value);
        break;
      case '--goal':
        parsed.goal = option.value;
        break;
      case '--prompt':
        parsed.prompt = option.value;
        break;
      case '--run':
        parsed.runId = option.value;
        break;
      case '--data-dir':
        parsed.dataDir = path.resolve(option.value);
        break;
      case '--tasks-file':
        parsed.tasksFile = path.resolve(option.value);
        break;
      case '--provider':
        parsed.provider = option.value;
        break;
      case '--model':
        parsed.model = option.value;
        break;
      case '--effort':
        parsed.effort = option.value;
        break;
      case '--max-ticks': {
        const maxTicks = Number(option.value);
        if (!Number.isInteger(maxTicks) || maxTicks < 1) {
          throw new StartUsageError('--max-ticks must be a positive integer');
        }
        parsed.maxTicks = maxTicks;
        break;
      }
      default:
        throw new StartUsageError(`unknown option: ${optionName}`);
    }
  }

  if (!parsed.target) throw new StartUsageError('--target is required');
  if (!parsed.workspace) throw new StartUsageError('--workspace is required');
  if (!parsed.goal) throw new StartUsageError('--goal is required');
  if (!parsed.prompt) throw new StartUsageError('--prompt is required');

  return parsed as StartArgs;
}

function parseTask(value: unknown, index: number): StartTask {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new StartUsageError(`task ${index + 1} must be an object`);
  }

  const task = value as Record<string, unknown>;
  for (const field of ['taskId', 'requirementId', 'title']) {
    if (typeof task[field] !== 'string' || !task[field]) {
      throw new StartUsageError(`task ${index + 1} requires a non-empty ${field}`);
    }
  }

  for (const field of ['dependencies', 'allowedPaths', 'expectedArtifacts']) {
    if (task[field] !== undefined && (!Array.isArray(task[field]) || !(task[field] as unknown[]).every((item) => typeof item === 'string'))) {
      throw new StartUsageError(`task ${index + 1} ${field} must be an array of strings`);
    }
  }

  return {
    taskId: task.taskId as string,
    requirementId: task.requirementId as string,
    title: task.title as string,
    ...(typeof task.description === 'string' ? { description: task.description } : {}),
    ...(task.dependencies ? { dependencies: [...(task.dependencies as string[])] } : {}),
    ...(task.allowedPaths ? { allowedPaths: [...(task.allowedPaths as string[])] } : {}),
    ...(task.expectedArtifacts ? { expectedArtifacts: [...(task.expectedArtifacts as string[])] } : {})
  };
}

export function buildStartTasks(args: StartArgs): StartTask[] {
  if (!args.tasksFile) {
    return [
      {
        taskId: 'main',
        requirementId: 'req-root',
        title: args.goal,
        description: args.goal
      }
    ];
  }

  if (!fs.existsSync(args.tasksFile)) {
    throw new StartUsageError(`tasks file does not exist: ${args.tasksFile}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(args.tasksFile, 'utf8'));
  } catch (error) {
    throw new StartUsageError(`tasks file is not valid JSON: ${(error as Error).message}`);
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new StartUsageError('tasks file must contain a non-empty JSON array');
  }

  return parsed.map(parseTask);
}
