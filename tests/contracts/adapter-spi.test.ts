import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { AgentRelayAdapter, SessionCapabilities, SpawnSessionConfig } from '../../packages/protocol/src/adapter.ts';
import { MockAdapter } from '../../packages/adapters/mock/src/mock-adapter.ts';
import { ClaudeAdapter } from '../../packages/adapters/claude/src/claude-adapter.ts';
import { ClaudeProcessRunner } from '../../packages/adapters/claude/src/runner.ts';
import { CodexAdapter } from '../../packages/adapters/codex/src/codex-adapter.ts';
import { CodexProcessRunner } from '../../packages/adapters/codex/src/runner.ts';
import { DshAdapter } from '../../packages/adapters/dsh/src/dsh-adapter.ts';

test('adapter-spi: MockAdapter implements AgentRelayAdapter interface', async () => {
  const adapter: AgentRelayAdapter = new MockAdapter();
  const caps = adapter.capabilities();
  assert.strictEqual(caps.level, 'L3');
  assert.strictEqual(caps.streamJsonSupported, true);
  assert.strictEqual(caps.modelEffortPreservation, true);

  const config: SpawnSessionConfig = {
    sessionId: 'sess-test-1',
    runId: 'run-1',
    model: { provider: 'anthropic', model: 'claude-3-7-sonnet', effort: 'high' }
  };
  const inspect = await adapter.createFresh(config);
  assert.strictEqual(inspect.sessionId, 'sess-test-1');
  assert.strictEqual(inspect.active, true);
  assert.strictEqual(inspect.effectiveModel?.model, 'claude-3-7-sonnet');
  assert.strictEqual(inspect.effectiveModel?.effort, 'high');

  const inspected = await adapter.inspectSession('sess-test-1');
  assert.strictEqual(inspected?.sessionId, 'sess-test-1');

  await adapter.submit('sess-test-1', 'msg-1', 'Hello world');

  const drainSuccess = await adapter.requestDrain('sess-test-1', 'handoff-1');
  assert.strictEqual(drainSuccess, true);

  const quiescence = await adapter.awaitQuiescence('sess-test-1', 1000);
  assert.strictEqual(quiescence, 'quiescent');

  const authorized = await adapter.authorizeExecution('sess-test-1', 2, 'TOKEN_123');
  assert.strictEqual(authorized, true);

  const interrupted = await adapter.interruptOwned('sess-test-1');
  assert.strictEqual(interrupted, true);

  const afterInterrupt = await adapter.inspectSession('sess-test-1');
  assert.strictEqual(afterInterrupt?.active, false);
});

test('adapter-spi: ClaudeAdapter implements AgentRelayAdapter interface', async () => {
  const mockCliPath = fileURLToPath(new URL('../fixtures/mock-claude-cli.mjs', import.meta.url));
  const runner = new ClaudeProcessRunner({
    binPath: process.execPath,
    extraArgsPrefix: [mockCliPath]
  });
  const adapter: AgentRelayAdapter = new ClaudeAdapter({ runner });

  const caps = adapter.capabilities();
  assert.strictEqual(caps.level, 'L3');
  assert.strictEqual(caps.streamJsonSupported, true);
  assert.strictEqual(caps.modelEffortPreservation, true);

  const config: SpawnSessionConfig = {
    sessionId: 'sess-spi-claude',
    runId: 'run-spi-1',
    model: { provider: 'anthropic', model: 'claude-3-7-sonnet', effort: 'high' },
    initialPrompt: 'PROBE_OK'
  };

  const inspect = await adapter.createFresh(config);
  assert.strictEqual(inspect.sessionId, 'sess-spi-claude');
  assert.strictEqual(inspect.active, true);
  assert.strictEqual(inspect.effectiveModel?.model, 'claude-3-7-sonnet');
  assert.strictEqual(inspect.effectiveModel?.effort, 'high');

  const inspected = await adapter.inspectSession('sess-spi-claude');
  assert.strictEqual(inspected?.sessionId, 'sess-spi-claude');

  const drainSuccess = await adapter.requestDrain('sess-spi-claude', 'handoff-spi');
  assert.strictEqual(drainSuccess, true);

  const quiescence = await adapter.awaitQuiescence('sess-spi-claude', 1000);
  assert.strictEqual(quiescence, 'quiescent');

  const authSuccess = await adapter.authorizeExecution('sess-spi-claude', 2, 'TOKEN_SPI');
  assert.strictEqual(authSuccess, true);

  const inspectDone = await adapter.inspectSession('sess-spi-claude');
  assert.strictEqual(inspectDone?.active, false);
  assert.strictEqual(inspectDone?.exitCode, 0);
});

test('adapter-spi: CodexAdapter implements AgentRelayAdapter interface', async () => {
  const mockServerPath = fileURLToPath(new URL('../fixtures/mock-codex-app-server.mjs', import.meta.url));

  const runner = new CodexProcessRunner({
    binPath: process.execPath,
    extraArgsPrefix: [mockServerPath]
  });
  const adapter: AgentRelayAdapter = new CodexAdapter({ runner });

  const caps = adapter.capabilities();
  assert.strictEqual(caps.level, 'L3');
  assert.strictEqual(caps.streamJsonSupported, true);
  assert.strictEqual(caps.modelEffortPreservation, true);
  assert.strictEqual(caps.headlessSupported, true);
  assert.strictEqual(caps.cancellationSupported, true);

  const config: SpawnSessionConfig = {
    sessionId: 'sess-spi-codex',
    runId: 'run-spi-codex-1',
    model: { provider: 'openai', model: 'gpt-5.6-luna', effort: 'xhigh' },
    initialPrompt: 'echo: codex-spi'
  };

  const inspect = await adapter.createFresh(config);
  assert.strictEqual(inspect.sessionId, 'sess-spi-codex');
  assert.strictEqual(inspect.active, true);
  assert.strictEqual(inspect.effectiveModel?.model, 'gpt-5.6-luna');
  assert.strictEqual(inspect.effectiveModel?.effort, 'xhigh');

  const inspected = await adapter.inspectSession('sess-spi-codex');
  assert.strictEqual(inspected?.sessionId, 'sess-spi-codex');

  const drainSuccess = await adapter.requestDrain('sess-spi-codex', 'handoff-codex');
  assert.strictEqual(drainSuccess, true);

  const quiescence = await adapter.awaitQuiescence('sess-spi-codex', 1000);
  assert.strictEqual(quiescence, 'quiescent');

  const authSuccess = await adapter.authorizeExecution('sess-spi-codex', 2, 'TOKEN_CODEX_SPI');
  assert.strictEqual(authSuccess, true);

  const interrupted = await adapter.interruptOwned('sess-spi-codex');
  assert.strictEqual(interrupted, true);

  const afterInterrupt = await adapter.inspectSession('sess-spi-codex');
  assert.strictEqual(afterInterrupt?.active, false);

  await adapter.shutdown();
});

test('adapter-spi: DshAdapter implements AgentRelayAdapter interface', async () => {
  const mockServerPath = fileURLToPath(new URL('../fixtures/mock-dsh-sdk-server.mjs', import.meta.url));

  const adapter: AgentRelayAdapter = new DshAdapter({
    runnerOptions: {
      binPath: process.execPath,
      extraArgsPrefix: [mockServerPath],
      startupGracePeriodMs: 50
    }
  });

  const caps = adapter.capabilities();
  assert.strictEqual(caps.level, 'L3');
  assert.strictEqual(caps.streamJsonSupported, true);
  assert.strictEqual(caps.modelEffortPreservation, true);
  assert.strictEqual(caps.headlessSupported, true);
  assert.strictEqual(caps.cancellationSupported, true);

  const config: SpawnSessionConfig = {
    sessionId: 'sess-spi-dsh',
    runId: 'run-spi-dsh-1',
    model: { provider: 'deepseek-official', model: 'deepseek-reasoner', effort: 'high' },
    initialPrompt: 'echo: dsh-spi'
  };

  const inspect = await adapter.createFresh(config);
  assert.strictEqual(inspect.sessionId, 'sess-spi-dsh');
  assert.strictEqual(inspect.active, true);
  assert.strictEqual(inspect.effectiveModel?.provider, 'deepseek-official');
  assert.strictEqual(inspect.effectiveModel?.model, 'deepseek-reasoner');
  assert.strictEqual(inspect.effectiveModel?.effort, 'high');

  const inspected = await adapter.inspectSession('sess-spi-dsh');
  assert.strictEqual(inspected?.sessionId, 'sess-spi-dsh');

  const drainSuccess = await adapter.requestDrain('sess-spi-dsh', 'handoff-dsh');
  assert.strictEqual(drainSuccess, true);

  const quiescence = await adapter.awaitQuiescence('sess-spi-dsh', 1000);
  assert.strictEqual(quiescence, 'quiescent');

  const authSuccess = await adapter.authorizeExecution('sess-spi-dsh', 2, 'TOKEN_DSH_SPI');
  assert.strictEqual(authSuccess, true);

  const interrupted = await adapter.interruptOwned('sess-spi-dsh');
  assert.strictEqual(interrupted, true);

  const afterInterrupt = await adapter.inspectSession('sess-spi-dsh');
  assert.strictEqual(afterInterrupt?.active, false);

  await (adapter as any).shutdown?.();
});



