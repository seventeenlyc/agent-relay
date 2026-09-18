// tests/adapters/claude-adapter.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { ClaudeAdapter } from '../../packages/adapters/claude/src/claude-adapter.ts';
import { ClaudeProcessRunner } from '../../packages/adapters/claude/src/runner.ts';
import { ClaudeHookHandler } from '../../packages/adapters/claude/src/hooks.ts';

const MOCK_CLI_PATH = fileURLToPath(new URL('../fixtures/mock-claude-cli.mjs', import.meta.url));

test('claude-adapter: implements AgentRelayAdapter with L3 capability and lifecycle methods', async () => {
  const runner = new ClaudeProcessRunner({
    binPath: process.execPath,
    extraArgsPrefix: [MOCK_CLI_PATH]
  });
  const adapter = new ClaudeAdapter({ runner });

  const caps = adapter.capabilities();
  assert.strictEqual(caps.level, 'L3');
  assert.strictEqual(caps.streamJsonSupported, true);
  assert.strictEqual(caps.modelEffortPreservation, true);

  const fresh = await adapter.createFresh({
    sessionId: 'sess-claude-100',
    runId: 'run-100',
    model: { provider: 'anthropic', model: 'claude-3-7-sonnet', effort: 'high' },
    bare: true,
    initialPrompt: 'PROBE_OK'
  });

  assert.strictEqual(fresh.sessionId, 'sess-claude-100');
  assert.strictEqual(fresh.active, true);
  assert.strictEqual(fresh.effectiveModel?.model, 'claude-3-7-sonnet');

  const inspected = await adapter.inspectSession('sess-claude-100');
  assert.strictEqual(inspected?.sessionId, 'sess-claude-100');
  assert.strictEqual(inspected?.effectiveModel?.model, 'claude-3-7-sonnet');

  const drainRes = await adapter.requestDrain('sess-claude-100', 'h-1');
  assert.strictEqual(drainRes, true);

  const authRes = await adapter.authorizeExecution('sess-claude-100', 2, 'EXEC_TOKEN_999');
  assert.strictEqual(authRes, true);

  const quiescence = await adapter.awaitQuiescence('sess-claude-100', 500);
  assert.strictEqual(quiescence, 'quiescent');

  const interruptRes = await adapter.interruptOwned('sess-claude-100');
  assert.strictEqual(interruptRes, true);
});

test('claude-adapter: handles nonexistent session edge cases gracefully', async () => {
  const adapter = new ClaudeAdapter();

  assert.strictEqual(adapter.inspectSession('sess-missing'), undefined);
  assert.strictEqual(adapter.requestDrain('sess-missing', 'h-missing'), false);
  assert.strictEqual(adapter.authorizeExecution('sess-missing', 1, 'TOK'), false);
  assert.strictEqual(adapter.interruptOwned('sess-missing'), false);
  assert.strictEqual(await adapter.awaitQuiescence('sess-missing', 50), 'error');
  assert.throws(
    () => adapter.submit('sess-missing', 'msg-1', 'content'),
    /Cannot submit to inactive session/
  );
});

test('claude-adapter: generates uuid if sessionId not provided and wires hookHandler', async () => {
  const hookHandler = new ClaudeHookHandler();
  let hookTriggered = false;
  hookHandler.onHandoffTrigger(() => {
    hookTriggered = true;
  });

  const runner = new ClaudeProcessRunner({
    binPath: process.execPath,
    extraArgsPrefix: [MOCK_CLI_PATH]
  });
  const adapter = new ClaudeAdapter({ runner, hookHandler });

  assert.strictEqual(adapter.getHookHandler(), hookHandler);

  const fresh = await adapter.createFresh({
    runId: 'run-auto-uuid',
    bare: true,
    initialPrompt: 'PROBE_OK'
  });

  assert.ok(fresh.sessionId);
  assert.strictEqual(fresh.active, true);
});

test('claude-adapter: packages/adapters/claude/src/index.ts exports all components', async () => {
  const index = await import('../../packages/adapters/claude/src/index.ts');
  assert.ok(index.ClaudeAdapter);
  assert.ok(index.ClaudeProcessRunner);
  assert.ok(index.ClaudeHookHandler);
  assert.ok(index.HookDeduplicator);
});

test('claude-adapter: supports submit to active session and awaitQuiescence timeout', async () => {
  const runner = new ClaudeProcessRunner({
    binPath: process.execPath,
    extraArgsPrefix: [MOCK_CLI_PATH, '--sleep', '2000']
  });
  const adapter = new ClaudeAdapter({ runner });

  await adapter.createFresh({
    sessionId: 'sess-active-submit',
    runId: 'run-submit',
    bare: true
  });

  // Submit should succeed on active session
  adapter.submit('sess-active-submit', 'msg-submit-1', 'HELLO_ACTIVE');

  // awaitQuiescence should timeout when session is sleeping and not draining
  const quiescence = await adapter.awaitQuiescence('sess-active-submit', 100);
  assert.strictEqual(quiescence, 'timeout');

  // Interrupt terminates the active session
  const interrupted = adapter.interruptOwned('sess-active-submit');
  assert.strictEqual(interrupted, true);
});

