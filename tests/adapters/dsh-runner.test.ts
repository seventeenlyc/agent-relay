import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  DshProcessRunner,
  resolveDshLaunchConfig,
  type DshLaunchConfig
} from '../../packages/adapters/dsh/src/runner.ts';
import type { DshJsonRpcNotification } from '../../packages/adapters/dsh/src/types.ts';

const MOCK_SERVER_PATH = fileURLToPath(new URL('../fixtures/mock-dsh-sdk-server.mjs', import.meta.url));

test('dsh-runner: resolveDshLaunchConfig returns default config or localAppData config', () => {
  const config: DshLaunchConfig = resolveDshLaunchConfig();
  assert.ok(config.command);
  assert.ok(Array.isArray(config.args));
  assert.ok(config.args.includes('--profile') && config.args.includes('sdk'));
});

test('dsh-runner: resolveDshLaunchConfig resolves direct node when current.json exists and files exist', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-test-appdata-'));
  const originalLocalAppData = process.env.LOCALAPPDATA;
  try {
    process.env.LOCALAPPDATA = tmpDir;
    const runtimeDir = path.join(tmpDir, 'DSH Desktop', 'runtime');
    const versionDir = path.join(runtimeDir, 'v1.0.0');
    const nodeDir = path.join(versionDir, 'node');
    fs.mkdirSync(nodeDir, { recursive: true });

    const fakeNodeExe = path.join(nodeDir, 'node.exe');
    fs.writeFileSync(fakeNodeExe, '');

    const fakeBinJs = path.join(versionDir, 'cli.js');
    fs.writeFileSync(fakeBinJs, '');

    const currentJson = {
      relativeDir: 'v1.0.0',
      entryRelativePath: 'cli.js'
    };
    fs.writeFileSync(path.join(runtimeDir, 'current.json'), JSON.stringify(currentJson));

    const config = resolveDshLaunchConfig();
    assert.strictEqual(config.directNode, true);
    assert.strictEqual(config.command, fakeNodeExe);
    assert.deepStrictEqual(config.args, [fakeBinJs, '--profile', 'sdk']);
    assert.strictEqual(config.runtimeDir, versionDir);
  } finally {
    process.env.LOCALAPPDATA = originalLocalAppData;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('dsh-runner: launches mock server, sends initialize, session/prompt, and receives notifications', async () => {
  const runner = new DshProcessRunner({
    binPath: process.execPath,
    extraArgsPrefix: [MOCK_SERVER_PATH],
    startupGracePeriodMs: 50
  });

  const notifications: DshJsonRpcNotification[] = [];
  runner.onNotification((notif) => {
    notifications.push(notif);
  });

  await runner.start();
  assert.strictEqual(runner.isRunning(), true);
  assert.strictEqual(runner.getExitCode(), null);

  try {
    const initRes = await runner.sendRequest<any>('initialize', {
      cwd: process.cwd(),
      provider: 'deepseek-official',
      model: 'deepseek-chat'
    });
    assert.strictEqual(initRes.serverInfo.name, 'deepseek-harness-sdk-runtime');
    assert.strictEqual(initRes.serverInfo.version, '0.0.1');

    const promptRes = await runner.sendRequest<any>('session/prompt', {
      sessionId: 'session-runner-1',
      contentBlocks: [{ type: 'text', text: 'echo: hello from runner' }]
    });
    assert.ok(promptRes.messageId);

    // Wait for idle notification
    const start = Date.now();
    while (!notifications.some((n) => n.method === 'session.status' && (n.params as any)?.status === 'idle') && Date.now() - start < 2000) {
      await new Promise((r) => setTimeout(r, 10));
    }

    const hasRunning = notifications.some(
      (n) => n.method === 'session.status' && (n.params as any)?.status === 'running'
    );
    assert.strictEqual(hasRunning, true);

    const hasIdle = notifications.some(
      (n) => n.method === 'session.status' && (n.params as any)?.status === 'idle'
    );
    assert.strictEqual(hasIdle, true);

    const messageEvent = notifications.find(
      (n) => n.method === 'session.event' && (n.params as any)?.event === 'assistant/message'
    );
    assert.ok(messageEvent);
    assert.strictEqual((messageEvent.params as any)?.text, 'hello from runner');

    await runner.shutdown();
    assert.strictEqual(runner.isRunning(), false);
    assert.strictEqual(runner.getExitCode(), 0);
  } finally {
    await runner.terminate();
  }
});

test('dsh-runner: rejects request when server responds with JSON-RPC error', async () => {
  const runner = new DshProcessRunner({
    binPath: process.execPath,
    extraArgsPrefix: [MOCK_SERVER_PATH],
    startupGracePeriodMs: 50
  });

  await runner.start();
  try {
    await assert.rejects(
      async () => {
        await runner.sendRequest('initialize', {
          cwd: process.cwd(),
          provider: 'invalid-provider',
          model: 'deepseek-chat'
        });
      },
      {
        message: /no adapter registered for provider/
      }
    );
  } finally {
    await runner.terminate();
  }
});

test('dsh-runner: handles deterministic request timeout cleanly', async () => {
  const runner = new DshProcessRunner({
    binPath: process.execPath,
    extraArgsPrefix: [MOCK_SERVER_PATH],
    startupGracePeriodMs: 50
  });

  await runner.start();
  try {
    await assert.rejects(
      async () => {
        await runner.sendRequest('test/hang', {}, 50);
      },
      {
        message: /timed out after 50ms/
      }
    );
  } finally {
    await runner.terminate();
  }
});

test('dsh-runner: isolates notification listener errors and supports unsubscribe', async () => {
  const runner = new DshProcessRunner({
    binPath: process.execPath,
    extraArgsPrefix: [MOCK_SERVER_PATH],
    startupGracePeriodMs: 50
  });

  await runner.start();
  try {
    let goodListenerCalled = false;
    const unsubBad = runner.onNotification(() => {
      throw new Error('Listener exploded');
    });
    const unsubGood = runner.onNotification((notif) => {
      if (notif.method === 'session.status') {
        goodListenerCalled = true;
      }
    });

    await runner.sendRequest('initialize', {
      cwd: process.cwd(),
      provider: 'deepseek-official',
      model: 'deepseek-chat'
    });

    await runner.sendRequest('session/prompt', {
      sessionId: 'sess-listener-test',
      contentBlocks: [{ type: 'text', text: 'echo: test' }]
    });

    const start = Date.now();
    while (!goodListenerCalled && Date.now() - start < 2000) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.strictEqual(goodListenerCalled, true);

    unsubBad();
    unsubGood();
  } finally {
    await runner.terminate();
  }
});

test('dsh-runner: caps stdoutBuffer, stderrBuffer, and notificationBuffer to 500 entries with FIFO eviction', async () => {
  const script = [
    'for (let i = 1; i <= 550; i++) {',
    '  console.log(JSON.stringify({ jsonrpc: "2.0", method: "test/event", params: { index: i } }));',
    '  console.error("stderr-" + i);',
    '}',
    'process.stdin.resume();'
  ].join('\n');

  const runner = new DshProcessRunner({
    binPath: process.execPath,
    extraArgsPrefix: ['-e', script],
    startupGracePeriodMs: 50
  });

  await runner.start();
  try {
    const start = Date.now();
    while (
      (runner.getNotificationBuffer().length < 500 ||
        (runner.getNotificationBuffer()[0]?.params as any)?.index < 51) &&
      Date.now() - start < 5000
    ) {
      await new Promise((r) => setTimeout(r, 20));
    }

    const stdoutBuf = runner.getStdoutBuffer();
    const stderrBuf = runner.getStderrBuffer();
    const notifBuf = runner.getNotificationBuffer();

    assert.strictEqual(stdoutBuf.length, 500);
    assert.strictEqual(stderrBuf.length, 500);
    assert.strictEqual(notifBuf.length, 500);

    // FIFO eviction verification: older items 1..50 must be shifted out, items 51..550 retained
    assert.strictEqual((notifBuf[0]?.params as any)?.index, 51);
    assert.strictEqual((notifBuf[499]?.params as any)?.index, 550);
    assert.strictEqual(stderrBuf[0], 'stderr-51');
    assert.strictEqual(stderrBuf[499], 'stderr-550');
  } finally {
    await runner.terminate();
  }
});

test('dsh-runner: rejects start() if process exits prematurely during startup (code 0 or non-zero)', async () => {
  const runnerCode0 = new DshProcessRunner({
    binPath: process.execPath,
    extraArgsPrefix: ['-e', 'process.exit(0)'],
    startupGracePeriodMs: 1000
  });

  await assert.rejects(
    async () => {
      await runnerCode0.start();
    },
    {
      message: /exited prematurely during startup/
    }
  );

  const runnerCode1 = new DshProcessRunner({
    binPath: process.execPath,
    extraArgsPrefix: ['-e', 'process.exit(1)'],
    startupGracePeriodMs: 1000
  });

  await assert.rejects(
    async () => {
      await runnerCode1.start();
    },
    {
      message: /exited prematurely during startup/
    }
  );
});

test('dsh-runner: rejects sendRequest when process is not running or terminated', async () => {
  const runner = new DshProcessRunner({
    binPath: process.execPath,
    extraArgsPrefix: [MOCK_SERVER_PATH],
    startupGracePeriodMs: 50
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
