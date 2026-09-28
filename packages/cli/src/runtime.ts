import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { AgentRelayAdapter } from '../../protocol/src/adapter.ts';
import type { RunControllerOptions } from '../../controller/src/run/engine.ts';
import { CodexAdapter } from '../../adapters/codex/src/codex-adapter.ts';
import { CodexProcessRunner } from '../../adapters/codex/src/runner.ts';
import { CodexHandshakeCoordinator } from '../../adapters/codex/src/handshake.ts';
import { ClaudeAdapter } from '../../adapters/claude/src/claude-adapter.ts';
import { ClaudeProcessRunner } from '../../adapters/claude/src/runner.ts';
import { TwoPhaseHandshakeCoordinator } from '../../adapters/claude/src/handshake.ts';
import type { StartTarget } from './start.ts';

export interface BuiltInRuntimeOptions {
  cwd: string;
  codexRunner?: CodexProcessRunner;
  claudeRunner?: ClaudeProcessRunner;
}

export interface DshRuntimeOptions {
  cwd: string;
  dataDir: string;
  dshRunnerOptions?: Record<string, unknown>;
}

export interface RuntimeFactoryOptions extends DshRuntimeOptions {
  dshPluginPath?: string;
  codexRunner?: CodexProcessRunner;
  claudeRunner?: ClaudeProcessRunner;
}

export interface RelayRuntime {
  adapter: AgentRelayAdapter;
  adapterName: 'codex' | 'claude' | 'dsh';
  createCoordinator: RunControllerOptions['createCoordinator'];
  shutdown(): Promise<void>;
}

type ShutdownCapableAdapter = AgentRelayAdapter & {
  shutdown?: () => Promise<void> | void;
};

async function shutdownAdapter(adapter: ShutdownCapableAdapter): Promise<void> {
  if (adapter.shutdown) {
    await adapter.shutdown();
  }
};

export function createBuiltInRuntime(
  target: Exclude<StartTarget, 'dsh'>,
  options: BuiltInRuntimeOptions
): RelayRuntime {
  if (target === 'codex') {
    const adapter = new CodexAdapter({
      runner: options.codexRunner ?? new CodexProcessRunner({ cwd: options.cwd })
    });
    return {
      adapter,
      adapterName: 'codex',
      createCoordinator: (deps) =>
        new CodexHandshakeCoordinator(deps.stateMachine, deps.leaseManager, deps.workspaceKey),
      shutdown: () => shutdownAdapter(adapter)
    };
  }

  const adapter = new ClaudeAdapter({ runner: options.claudeRunner });
  return {
    adapter,
    adapterName: 'claude',
    createCoordinator: (deps) =>
      new TwoPhaseHandshakeCoordinator(deps.stateMachine, deps.leaseManager, deps.workspaceKey),
    shutdown: () => shutdownAdapter(adapter)
  };
}

function isRelayRuntime(value: unknown): value is RelayRuntime {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.adapter === 'object' &&
    candidate.adapter !== null &&
    (candidate.adapterName === 'codex' || candidate.adapterName === 'claude' || candidate.adapterName === 'dsh') &&
    typeof candidate.createCoordinator === 'function' &&
    typeof candidate.shutdown === 'function'
  );
}

export async function loadDshRuntime(pluginPath: string, options: DshRuntimeOptions): Promise<RelayRuntime> {
  const resolvedPath = path.resolve(pluginPath);
  const plugin = (await import(pathToFileURL(resolvedPath).href)) as {
    pluginManifest?: unknown;
    createRuntime?: (options: DshRuntimeOptions) => Promise<unknown> | unknown;
  };
  const manifest = plugin.pluginManifest as Record<string, unknown> | undefined;
  if (
    !manifest ||
    manifest.id !== 'agent-relay-dsh' ||
    manifest.target !== 'dsh' ||
    manifest.protocolVersion !== 1 ||
    typeof plugin.createRuntime !== 'function'
  ) {
    throw new Error(`invalid DSH plugin manifest: ${resolvedPath}`);
  }

  const runtime = await plugin.createRuntime({
    cwd: options.cwd,
    dataDir: options.dataDir,
    runnerOptions: options.dshRunnerOptions
  });
  if (!isRelayRuntime(runtime) || runtime.adapterName !== 'dsh') {
    throw new Error(`DSH plugin returned an invalid runtime: ${resolvedPath}`);
  }
  return runtime;
}

export function defaultDshPluginPath(): string {
  return fileURLToPath(new URL('../../../integrations/dsh-plugin.mjs', import.meta.url));
}

export async function createRuntimeForTarget(target: StartTarget, options: RuntimeFactoryOptions): Promise<RelayRuntime> {
  if (target === 'dsh') {
    return loadDshRuntime(options.dshPluginPath ?? defaultDshPluginPath(), options);
  }
  return createBuiltInRuntime(target, options);
}
