import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentRelayAdapter, SessionCapabilities, SpawnSessionConfig } from '../../packages/protocol/src/adapter.ts';
import { MockAdapter } from '../../packages/adapters/mock/src/mock-adapter.ts';

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
