import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { AgentRelayAdapter, SpawnSessionConfig } from '../../packages/protocol/src/adapter.ts';
import { DshAdapter } from '../../packages/adapters/dsh/src/dsh-adapter.ts';

const MOCK_SERVER_PATH = fileURLToPath(new URL('../fixtures/mock-dsh-sdk-server.mjs', import.meta.url));

test('dsh-adapter: capabilities reports L3 and preserves deepseek features', () => {
  const adapter = new DshAdapter();
  const caps = adapter.capabilities();
  assert.strictEqual(caps.level, 'L3');
  assert.strictEqual(caps.streamJsonSupported, true);
  assert.strictEqual(caps.modelEffortPreservation, true);
  assert.strictEqual(caps.nativeRevealSupported, false);
  assert.strictEqual(caps.headlessSupported, true);
  assert.strictEqual(caps.cancellationSupported, true);
});

test('dsh-adapter: full lifecycle with createFresh, initialPrompt, output inspection, submit, drain, quiescence, authorizeExecution', async () => {
  const adapter = new DshAdapter({
    runnerOptions: {
      binPath: process.execPath,
      extraArgsPrefix: [MOCK_SERVER_PATH],
      startupGracePeriodMs: 50
    }
  });

  try {
    const config: SpawnSessionConfig = {
      sessionId: 'dsh-session-lifecycle-1',
      runId: 'run-dsh-1',
      model: { provider: 'deepseek-official', model: 'deepseek-reasoner', effort: 'high' },
      initialPrompt: 'echo: hello from dsh initial prompt'
    };

    const inspect = await adapter.createFresh(config);
    assert.strictEqual(inspect.sessionId, 'dsh-session-lifecycle-1');
    assert.strictEqual(inspect.active, true);
    assert.strictEqual(inspect.effectiveModel?.provider, 'deepseek-official');
    assert.strictEqual(inspect.effectiveModel?.model, 'deepseek-reasoner');
    assert.strictEqual(inspect.effectiveModel?.effort, 'high');
    assert.strictEqual(inspect.exitCode, null);

    const quiescence1 = await adapter.awaitQuiescence('dsh-session-lifecycle-1', 2000);
    assert.strictEqual(quiescence1, 'quiescent');

    const output1 = adapter.getSessionOutput('dsh-session-lifecycle-1');
    assert.ok(output1.includes('hello from dsh initial prompt'), `Expected output to include prompt reply, got: ${output1}`);

    const events = adapter.getSessionEvents('dsh-session-lifecycle-1');
    assert.ok(events.length > 0);

    // Submit subsequent prompt
    await adapter.submit('dsh-session-lifecycle-1', 'msg-2', 'echo: second prompt');
    const quiescence2 = await adapter.awaitQuiescence('dsh-session-lifecycle-1', 2000);
    assert.strictEqual(quiescence2, 'quiescent');

    const output2 = adapter.getSessionOutput('dsh-session-lifecycle-1');
    assert.ok(output2.includes('second prompt'));

    // Request drain
    const drainSuccess = adapter.requestDrain('dsh-session-lifecycle-1', 'handoff-dsh-1');
    assert.strictEqual(drainSuccess, true);

    // Authorize execution
    const authSuccess = await adapter.authorizeExecution('dsh-session-lifecycle-1', 1, 'TOKEN_AUTH_ABC');
    assert.strictEqual(authSuccess, true);

    const quiescence3 = await adapter.awaitQuiescence('dsh-session-lifecycle-1', 2000);
    assert.strictEqual(quiescence3, 'quiescent');

    const output3 = adapter.getSessionOutput('dsh-session-lifecycle-1');
    assert.ok(output3.includes('EXECUTION_AUTHORIZED'));

    // Interrupt session
    const interrupted = await adapter.interruptOwned('dsh-session-lifecycle-1');
    assert.strictEqual(interrupted, true);

    const inspectedAfter = adapter.inspectSession('dsh-session-lifecycle-1');
    assert.ok(inspectedAfter);
    assert.strictEqual(inspectedAfter.active, false);
    assert.strictEqual(typeof inspectedAfter.exitCode, 'number');
  } finally {
    await adapter.shutdown();
  }
});

test('dsh-adapter: dedicated worker architecture - interrupting one session terminates only its worker without affecting others', async () => {
  const adapter = new DshAdapter({
    runnerOptions: {
      binPath: process.execPath,
      extraArgsPrefix: [MOCK_SERVER_PATH],
      startupGracePeriodMs: 50
    }
  });

  try {
    // Spawn two distinct sessions
    const s1 = await adapter.createFresh({
      sessionId: 'dsh-dedicated-1',
      runId: 'run-w1',
      model: { provider: 'deepseek-official', model: 'deepseek-chat' },
      initialPrompt: 'echo: session 1 ready'
    });

    const s2 = await adapter.createFresh({
      sessionId: 'dsh-dedicated-2',
      runId: 'run-w2',
      model: { provider: 'deepseek-official', model: 'deepseek-chat' },
      initialPrompt: 'echo: session 2 ready'
    });

    assert.strictEqual(s1.active, true);
    assert.strictEqual(s2.active, true);

    await adapter.awaitQuiescence('dsh-dedicated-1', 2000);
    await adapter.awaitQuiescence('dsh-dedicated-2', 2000);

    // Interrupt only session 1
    const interrupted1 = await adapter.interruptOwned('dsh-dedicated-1');
    assert.strictEqual(interrupted1, true);

    const inspect1 = adapter.inspectSession('dsh-dedicated-1');
    assert.strictEqual(inspect1?.active, false);

    // Verify session 2 is still active and operational
    const inspect2 = adapter.inspectSession('dsh-dedicated-2');
    assert.strictEqual(inspect2?.active, true);

    await adapter.submit('dsh-dedicated-2', 'msg-w2-cont', 'echo: session 2 still alive');
    const quiescence2 = await adapter.awaitQuiescence('dsh-dedicated-2', 2000);
    assert.strictEqual(quiescence2, 'quiescent');

    const output2 = adapter.getSessionOutput('dsh-dedicated-2');
    assert.ok(output2.includes('session 2 still alive'));

    // Now interrupt session 2
    const interrupted2 = await adapter.interruptOwned('dsh-dedicated-2');
    assert.strictEqual(interrupted2, true);
    assert.strictEqual(adapter.inspectSession('dsh-dedicated-2')?.active, false);
  } finally {
    await adapter.shutdown();
  }
});

test('dsh-adapter: generates default sessionId when omitted in config', async () => {
  const adapter = new DshAdapter({
    runnerOptions: {
      binPath: process.execPath,
      extraArgsPrefix: [MOCK_SERVER_PATH],
      startupGracePeriodMs: 50
    }
  });

  try {
    const inspect = await adapter.createFresh({
      runId: 'run-default-id'
    });

    assert.ok(inspect.sessionId.startsWith('dsh-'), `Expected sessionId to start with dsh-, got: ${inspect.sessionId}`);
    assert.strictEqual(inspect.active, true);
    assert.strictEqual(inspect.effectiveModel?.provider, 'deepseek-official');
    assert.strictEqual(inspect.effectiveModel?.model, 'deepseek-chat');
  } finally {
    await adapter.shutdown();
  }
});

test('dsh-adapter: edge cases on nonexistent or inactive session', async () => {
  const adapter = new DshAdapter({
    runnerOptions: {
      binPath: process.execPath,
      extraArgsPrefix: [MOCK_SERVER_PATH],
      startupGracePeriodMs: 50
    }
  });

  try {
    // Nonexistent checks
    assert.strictEqual(adapter.inspectSession('nonexistent-session'), undefined);
    assert.strictEqual(adapter.requestDrain('nonexistent-session', 'h1'), false);
    assert.strictEqual(await adapter.awaitQuiescence('nonexistent-session'), 'error');
    assert.strictEqual(await adapter.authorizeExecution('nonexistent-session', 1, 'token'), false);
    assert.strictEqual(await adapter.interruptOwned('nonexistent-session'), false);
    assert.strictEqual(adapter.getSessionOutput('nonexistent-session'), '');
    assert.deepStrictEqual(adapter.getSessionEvents('nonexistent-session'), []);

    await assert.rejects(
      async () => {
        await adapter.submit('nonexistent-session', 'm1', 'hello');
      },
      {
        message: /Cannot submit to nonexistent session nonexistent-session/
      }
    );

    // Create session, interrupt it, then check submit rejects for inactive session
    await adapter.createFresh({
      sessionId: 'dsh-inactive-test',
      runId: 'run-inactive'
    });

    await adapter.interruptOwned('dsh-inactive-test');

    await assert.rejects(
      async () => {
        await adapter.submit('dsh-inactive-test', 'm2', 'hello');
      },
      {
        message: /Cannot submit to inactive session dsh-inactive-test/
      }
    );
  } finally {
    await adapter.shutdown();
  }
});

test('dsh-adapter: awaitQuiescence returns timeout if not quiescent within timeoutMs', async () => {
  const adapter = new DshAdapter({
    runnerOptions: {
      binPath: process.execPath,
      extraArgsPrefix: [MOCK_SERVER_PATH],
      startupGracePeriodMs: 50
    }
  });

  try {
    // Mock server takes ~20ms to become idle after prompt
    const inspect = await adapter.createFresh({
      sessionId: 'dsh-timeout-test',
      runId: 'run-timeout',
      initialPrompt: 'echo: slow message'
    });

    // Submitting prompt resets idle
    const submitPromise = adapter.submit('dsh-timeout-test', 'msg-slow', 'echo: slower message');
    // Immediately check quiescence with 1ms timeout
    const quiescence = await adapter.awaitQuiescence('dsh-timeout-test', 1);
    assert.strictEqual(quiescence, 'timeout');

    await submitPromise;
    // With adequate timeout it should become quiescent
    const quiescenceFinal = await adapter.awaitQuiescence('dsh-timeout-test', 2000);
    assert.strictEqual(quiescenceFinal, 'quiescent');
  } finally {
    await adapter.shutdown();
  }
});
