import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createBuiltInRuntime, loadDshRuntime } from '../../packages/cli/src/runtime.ts';
import { CodexAdapter } from '../../packages/adapters/codex/src/codex-adapter.ts';
import { CodexProcessRunner } from '../../packages/adapters/codex/src/runner.ts';
import { ClaudeAdapter } from '../../packages/adapters/claude/src/claude-adapter.ts';
import { ClaudeProcessRunner } from '../../packages/adapters/claude/src/runner.ts';
import { DshAdapter } from '../../packages/adapters/dsh/src/dsh-adapter.ts';

const MOCK_CODEX_PATH = fileURLToPath(new URL('../fixtures/mock-codex-app-server.mjs', import.meta.url));
const MOCK_CLAUDE_PATH = fileURLToPath(new URL('../fixtures/mock-claude-cli.mjs', import.meta.url));

test('runtime factory: maps codex to CodexAdapter and Codex handshake coordinator', async () => {
  const runtime = createBuiltInRuntime('codex', {
    cwd: process.cwd(),
    codexRunner: new CodexProcessRunner({
      binPath: process.execPath,
      extraArgsPrefix: [MOCK_CODEX_PATH]
    })
  });

  assert.ok(runtime.adapter instanceof CodexAdapter);
  assert.strictEqual(runtime.adapterName, 'codex');
  assert.strictEqual(runtime.adapter.capabilities().level, 'L3');
  assert.strictEqual(
    runtime.createCoordinator({ stateMachine: {} as any, leaseManager: {} as any, workspaceKey: 'ws', runId: 'run' }).constructor.name,
    'CodexHandshakeCoordinator'
  );
  await runtime.shutdown();
});

test('runtime factory: maps claude to ClaudeAdapter and Claude handshake coordinator', async () => {
  const runtime = createBuiltInRuntime('claude', {
    cwd: process.cwd(),
    claudeRunner: new ClaudeProcessRunner({
      binPath: process.execPath,
      extraArgsPrefix: [MOCK_CLAUDE_PATH]
    })
  });

  assert.ok(runtime.adapter instanceof ClaudeAdapter);
  assert.strictEqual(runtime.adapterName, 'claude');
  assert.strictEqual(runtime.adapter.capabilities().level, 'L3');
  assert.strictEqual(
    runtime.createCoordinator({ stateMachine: {} as any, leaseManager: {} as any, workspaceKey: 'ws', runId: 'run' }).constructor.name,
    'TwoPhaseHandshakeCoordinator'
  );
  await runtime.shutdown();
});

test('runtime factory: loads and validates the native DSH plugin runtime', async () => {
  const pluginPath = fileURLToPath(new URL('../../integrations/dsh-plugin.mjs', import.meta.url));
  const runtime = await loadDshRuntime(pluginPath, {
    cwd: process.cwd(),
    dataDir: process.cwd()
  });

  assert.ok(runtime.adapter instanceof DshAdapter);
  assert.strictEqual(runtime.adapterName, 'dsh');
  assert.strictEqual(
    runtime.createCoordinator({ stateMachine: {} as any, leaseManager: {} as any, workspaceKey: 'ws', runId: 'run' }).constructor.name,
    'DshHandshakeCoordinator'
  );
  await runtime.shutdown();
});

test('runtime factory: rejects a DSH plugin with an invalid manifest', async () => {
  const pluginPath = fileURLToPath(new URL('../fixtures/invalid-dsh-plugin.mjs', import.meta.url));
  await assert.rejects(
    () => loadDshRuntime(pluginPath, { cwd: process.cwd(), dataDir: process.cwd() }),
    /invalid DSH plugin manifest/
  );
});
