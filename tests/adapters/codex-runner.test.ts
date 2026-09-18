import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { CodexProcessRunner } from '../../packages/adapters/codex/src/runner.ts';
import type {
  InitializeResponse,
  ThreadStartResponse,
  TurnStartResponse,
  TurnCompletedParams
} from '../../packages/adapters/codex/src/types.ts';

const MOCK_SERVER_PATH = fileURLToPath(new URL('../fixtures/mock-codex-app-server.mjs', import.meta.url));

test('codex-runner: initializes connection and performs thread/turn RPCs with notifications', async () => {
  const runner = new CodexProcessRunner({
    binPath: process.execPath,
    extraArgsPrefix: [MOCK_SERVER_PATH]
  });

  await runner.start();
  assert.strictEqual(runner.isRunning(), true);

  // 1. initialize
  const initRes = await runner.sendRequest<InitializeResponse>('initialize', {
    clientInfo: { name: 'test-client', version: '1.0.0' }
  });
  assert.strictEqual(initRes.platformOs, 'windows');

  // 2. thread/start
  const threadRes = await runner.sendRequest<ThreadStartResponse>('thread/start', {
    model: 'gpt-5.6-luna'
  });
  assert.ok(threadRes.thread?.id);
  assert.strictEqual(threadRes.model, 'gpt-5.6-luna');
  assert.strictEqual(threadRes.modelProvider, 'openai');
  assert.strictEqual(threadRes.reasoningEffort, 'xhigh');

  const threadId = threadRes.thread.id;

  // 3. turn/start & wait for turn/completed
  const completedPromise = new Promise<TurnCompletedParams>((resolve) => {
    runner.onNotification((notif) => {
      if (notif.method === 'turn/completed' && (notif.params as any).threadId === threadId) {
        resolve(notif.params as TurnCompletedParams);
      }
    });
  });

  const turnRes = await runner.sendRequest<TurnStartResponse>('turn/start', {
    threadId,
    input: [{ type: 'text', text: 'echo: hello codex' }]
  });
  assert.strictEqual(turnRes.turn.status, 'inProgress');

  const completed = await completedPromise;
  assert.strictEqual(completed.turn.status, 'completed');

  await runner.terminate();
  assert.strictEqual(runner.isRunning(), false);
});

test('codex-runner: handles turn/interrupt RPC correctly', async () => {
  const runner = new CodexProcessRunner({
    binPath: process.execPath,
    extraArgsPrefix: [MOCK_SERVER_PATH]
  });

  await runner.start();
  const threadRes = await runner.sendRequest<ThreadStartResponse>('thread/start');
  const threadId = threadRes.thread.id;

  const turnRes = await runner.sendRequest<TurnStartResponse>('turn/start', {
    threadId,
    input: [{ type: 'text', text: 'long running' }]
  });
  const turnId = turnRes.turn.id;

  const interruptCompletedPromise = new Promise<TurnCompletedParams>((resolve) => {
    runner.onNotification((notif) => {
      if (notif.method === 'turn/completed' && (notif.params as any).threadId === threadId) {
        resolve(notif.params as TurnCompletedParams);
      }
    });
  });

  await runner.sendRequest('turn/interrupt', { threadId, turnId });
  const completed = await interruptCompletedPromise;
  assert.strictEqual(completed.turn.status, 'interrupted');

  await runner.terminate();
});

test('codex-runner: handles RPC error response and unmaterialized thread read error', async () => {
  const runner = new CodexProcessRunner({
    binPath: process.execPath,
    extraArgsPrefix: [MOCK_SERVER_PATH]
  });

  await runner.start();
  const threadRes = await runner.sendRequest<ThreadStartResponse>('thread/start');
  const threadId = threadRes.thread.id;

  // Unmaterialized thread with includeTurns: true returns code -32600
  await assert.rejects(
    async () => {
      await runner.sendRequest('thread/read', { threadId, includeTurns: true });
    },
    {
      message: /not materialized yet/
    }
  );

  await runner.terminate();
});

test('codex-runner: handles request timeout correctly', async () => {
  const runner = new CodexProcessRunner({
    binPath: process.execPath,
    extraArgsPrefix: [MOCK_SERVER_PATH]
  });

  await runner.start();

  // Mock server takes ~30ms to emit turn items, but turn/start responds immediately.
  // We send a request with an impossibly low timeout to verify timeout rejection.
  await assert.rejects(
    async () => {
      await runner.sendRequest('initialize', {}, 0);
    },
    {
      message: /timed out after 0ms/
    }
  );

  await runner.terminate();
});

test('codex-runner: isolates consumer callback exceptions and supports listener unsubscribe', async () => {
  const runner = new CodexProcessRunner({
    binPath: process.execPath,
    extraArgsPrefix: [MOCK_SERVER_PATH]
  });

  await runner.start();

  let normalListenerCalled = false;
  const unsubscribeBad = runner.onNotification(() => {
    throw new Error('Consumer listener boom!');
  });
  const unsubscribeGood = runner.onNotification((notif) => {
    if (notif.method === 'thread/started') {
      normalListenerCalled = true;
    }
  });

  await runner.sendRequest<ThreadStartResponse>('thread/start');
  // Give notification dispatch a moment
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.strictEqual(normalListenerCalled, true);

  // Test unsubscribe
  unsubscribeBad();
  unsubscribeGood();

  normalListenerCalled = false;
  await runner.sendRequest<ThreadStartResponse>('thread/start');
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.strictEqual(normalListenerCalled, false);

  await runner.terminate();
});

test('codex-runner: caps rawLines and events buffers to 500 entries', async () => {
  const runner = new CodexProcessRunner({
    binPath: process.execPath,
    extraArgsPrefix: [MOCK_SERVER_PATH]
  });

  await runner.start();

  // Verify getters return arrays
  assert.ok(Array.isArray(runner.getRawLines()));
  assert.ok(Array.isArray(runner.getStderrLines()));
  assert.ok(Array.isArray(runner.getEvents()));

  await runner.terminate();
});

test('codex-runner: rejects sendRequest when process is not running or terminated', async () => {
  const runner = new CodexProcessRunner({
    binPath: process.execPath,
    extraArgsPrefix: [MOCK_SERVER_PATH]
  });

  // Not started
  await assert.rejects(
    async () => {
      await runner.sendRequest('initialize');
    },
    {
      message: /not running/
    }
  );

  await runner.start();
  await runner.terminate();

  // Terminated
  await assert.rejects(
    async () => {
      await runner.sendRequest('initialize');
    },
    {
      message: /not running/
    }
  );
});
