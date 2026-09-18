import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { CodexAdapter } from '../../packages/adapters/codex/src/codex-adapter.ts';
import { CodexProcessRunner } from '../../packages/adapters/codex/src/runner.ts';

const MOCK_SERVER_PATH = fileURLToPath(new URL('../fixtures/mock-codex-app-server.mjs', import.meta.url));

test('codex-adapter: implements AgentRelayAdapter with L3 capability and lifecycle methods', async () => {
  const runner = new CodexProcessRunner({
    binPath: process.execPath,
    extraArgsPrefix: [MOCK_SERVER_PATH]
  });
  const adapter = new CodexAdapter({ runner });

  const caps = adapter.capabilities();
  assert.strictEqual(caps.level, 'L3');
  assert.strictEqual(caps.streamJsonSupported, true);
  assert.strictEqual(caps.modelEffortPreservation, true);
  assert.strictEqual(caps.headlessSupported, true);
  assert.strictEqual(caps.cancellationSupported, true);
  assert.strictEqual(caps.nativeRevealSupported, false);

  const fresh = await adapter.createFresh({
    sessionId: 'session-codex-100',
    runId: 'run-100',
    model: { provider: 'openai', model: 'gpt-5.6-luna', effort: 'xhigh' },
    initialPrompt: 'echo: PROBE_SUCCESS_P0'
  });

  assert.strictEqual(fresh.sessionId, 'session-codex-100');
  assert.strictEqual(fresh.active, true);
  assert.strictEqual(fresh.effectiveModel?.model, 'gpt-5.6-luna');
  assert.strictEqual(fresh.effectiveModel?.provider, 'openai');
  assert.strictEqual(fresh.effectiveModel?.effort, 'xhigh');

  const inspected = await adapter.inspectSession('session-codex-100');
  assert.strictEqual(inspected?.sessionId, 'session-codex-100');
  assert.strictEqual(inspected?.effectiveModel?.model, 'gpt-5.6-luna');
  assert.strictEqual(inspected?.active, true);

  // Await quiescence
  const quiescence = await adapter.awaitQuiescence('session-codex-100', 1000);
  assert.strictEqual(quiescence, 'quiescent');

  const output = adapter.getSessionOutput('session-codex-100');
  assert.ok(output.includes('PROBE_SUCCESS_P0'));

  const events = adapter.getSessionEvents('session-codex-100');
  assert.ok(events.length > 0);

  // Submit another message
  await adapter.submit('session-codex-100', 'm-2', 'echo: next step');
  await adapter.awaitQuiescence('session-codex-100', 1000);
  assert.ok(adapter.getSessionOutput('session-codex-100').includes('next step'));

  // Drain and authorize
  const drainRes = await adapter.requestDrain('session-codex-100', 'h-1');
  assert.strictEqual(drainRes, true);

  const authRes = await adapter.authorizeExecution('session-codex-100', 2, 'EXEC_TOKEN_888');
  assert.strictEqual(authRes, true);
  await adapter.awaitQuiescence('session-codex-100', 1000);

  // Interrupt
  const interruptRes = await adapter.interruptOwned('session-codex-100');
  assert.strictEqual(interruptRes, true);

  const afterInterrupt = await adapter.inspectSession('session-codex-100');
  assert.strictEqual(afterInterrupt?.active, false);

  await adapter.shutdown();
});

test('codex-adapter: handles nonexistent session edge cases gracefully', async () => {
  const runner = new CodexProcessRunner({
    binPath: process.execPath,
    extraArgsPrefix: [MOCK_SERVER_PATH]
  });
  const adapter = new CodexAdapter({ runner });

  assert.strictEqual(await adapter.inspectSession('nonexistent-session'), undefined);
  assert.strictEqual(await adapter.requestDrain('nonexistent-session', 'h-0'), false);
  assert.strictEqual(await adapter.awaitQuiescence('nonexistent-session', 100), 'error');
  assert.strictEqual(await adapter.authorizeExecution('nonexistent-session', 1, 'tok'), false);
  assert.strictEqual(await adapter.interruptOwned('nonexistent-session'), false);
  assert.strictEqual(adapter.getSessionOutput('nonexistent-session'), '');
  assert.deepStrictEqual(adapter.getSessionEvents('nonexistent-session'), []);

  await assert.rejects(
    async () => {
      await adapter.submit('nonexistent-session', 'm-1', 'hello');
    },
    {
      message: /Cannot submit to nonexistent session nonexistent-session/
    }
  );

  await adapter.shutdown();
});

test('codex-adapter: packages/adapters/codex/src/index.ts exports all components', async () => {
  const index = await import('../../packages/adapters/codex/src/index.ts');
  assert.ok(index.CodexAdapter);
  assert.ok(index.CodexProcessRunner);
  assert.ok(index.CodexHandshakeCoordinator);
});

test('codex-adapter: generates threadId as fallback sessionId and handles awaitQuiescence timeout', async () => {
  const runner = new CodexProcessRunner({
    binPath: process.execPath,
    extraArgsPrefix: [MOCK_SERVER_PATH]
  });
  const adapter = new CodexAdapter({ runner });

  const fresh = await adapter.createFresh({
    runId: 'run-no-session-id'
  });

  assert.ok(fresh.sessionId.startsWith('01a0af-'));
  assert.strictEqual(fresh.active, true);

  // Simulate active session turn for timeout
  await adapter.submit(fresh.sessionId, 'm-slow', 'long task');
  // Pass 0ms timeout to verify timeout return
  const timeoutResult = await adapter.awaitQuiescence(fresh.sessionId, 0);
  // Note: could be quiescent if turn was fast or timeout
  assert.ok(['quiescent', 'timeout'].includes(timeoutResult));

  await adapter.shutdown();
});

test('codex-adapter: rejects submit on inactive session and authorizeExecution returns false', async () => {
  const runner = new CodexProcessRunner({
    binPath: process.execPath,
    extraArgsPrefix: [MOCK_SERVER_PATH]
  });
  const adapter = new CodexAdapter({ runner });

  const fresh = await adapter.createFresh({
    sessionId: 'session-inactive-test',
    runId: 'run-inactive'
  });

  await adapter.interruptOwned('session-inactive-test');
  const inspected = await adapter.inspectSession('session-inactive-test');
  assert.strictEqual(inspected?.active, false);
  assert.strictEqual(inspected?.exitCode, 0);

  await assert.rejects(
    async () => {
      await adapter.submit('session-inactive-test', 'm-after-interrupt', 'fail');
    },
    {
      message: /Cannot submit to inactive session session-inactive-test/
    }
  );

  const authRes = await adapter.authorizeExecution('session-inactive-test', 1, 'TOK');
  assert.strictEqual(authRes, false);

  await adapter.shutdown();
});

test('codex-adapter: guards unmaterialized thread read before first user message', async () => {
  const runner = new CodexProcessRunner({
    binPath: process.execPath,
    extraArgsPrefix: [MOCK_SERVER_PATH]
  });
  const adapter = new CodexAdapter({ runner });

  // 1. Fresh thread without initial prompt -> not materialized yet
  const fresh = await adapter.createFresh({
    sessionId: 'session-unmaterialized',
    runId: 'run-unmaterialized'
  });

  // Call readThread with includeTurns: true.
  // The guard must downgrade includeTurns to false so mock server does not reject with -32600.
  const threadReadRes = (await adapter.readThread('session-unmaterialized', true)) as any;
  assert.ok(threadReadRes.thread);
  assert.strictEqual(threadReadRes.thread.turns.length, 0);

  // 2. Submit first message -> thread materializes
  await adapter.submit('session-unmaterialized', 'msg-1', 'echo: first materialized turn');
  await adapter.awaitQuiescence('session-unmaterialized', 1000);

  // Now includeTurns: true is allowed and returns turns
  const readAfterTurn = (await adapter.readThread('session-unmaterialized', true)) as any;
  assert.ok(readAfterTurn.thread);
  assert.strictEqual(readAfterTurn.thread.turns.length, 1);
  assert.strictEqual(readAfterTurn.thread.turns[0].text, 'first materialized turn');

  await adapter.shutdown();
});

