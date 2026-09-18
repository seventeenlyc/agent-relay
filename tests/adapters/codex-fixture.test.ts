import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const MOCK_SERVER_PATH = fileURLToPath(new URL('../fixtures/mock-codex-app-server.mjs', import.meta.url));

test('codex-fixture: mock app-server starts and handles initialize, thread/start, and turn/start via JSON-RPC 2.0', async () => {
  const proc = spawn(process.execPath, [MOCK_SERVER_PATH], {
    stdio: ['pipe', 'pipe', 'pipe']
  });

  const rl = readline.createInterface({ input: proc.stdout! });
  const responses: any[] = [];
  const notifications: any[] = [];

  rl.on('line', (line) => {
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined) {
        responses.push(msg);
      } else if (msg.method) {
        notifications.push(msg);
      }
    } catch {}
  });

  const waitFor = async (predicate: () => boolean, timeoutMs = 2000) => {
    const start = Date.now();
    while (!predicate() && Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  try {
    // 1. Send initialize
    proc.stdin!.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { clientInfo: { name: 'test-runner', version: '0.1.0' } }
      }) + '\n'
    );

    // 2. Send thread/start
    proc.stdin!.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'thread/start',
        params: { cwd: process.cwd(), model: 'gpt-5.6-luna' }
      }) + '\n'
    );

    // Wait for responses
    await waitFor(() => responses.some((r) => r.id === 2) && notifications.some((n) => n.method === 'thread/started'));

    const initRes = responses.find((r) => r.id === 1);
    assert.ok(initRes);
    assert.strictEqual(initRes.result.platformOs, 'windows');
    assert.ok(initRes.result.codexHome);

    const threadRes = responses.find((r) => r.id === 2);
    assert.ok(threadRes);
    assert.ok(threadRes.result.thread?.id?.startsWith('01a0af-'));
    assert.strictEqual(threadRes.result.model, 'gpt-5.6-luna');
    assert.strictEqual(threadRes.result.modelProvider, 'openai');
    assert.strictEqual(threadRes.result.reasoningEffort, 'xhigh');

    const threadStartedNotif = notifications.find((n) => n.method === 'thread/started');
    assert.ok(threadStartedNotif);

    // 3. Send turn/start
    const threadId = threadRes.result.thread.id;
    proc.stdin!.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'turn/start',
        params: {
          threadId,
          input: [{ type: 'text', text: 'Reply with PROBE_SUCCESS_P0' }]
        }
      }) + '\n'
    );

    // Wait for turn completion notifications
    await waitFor(() => notifications.some((n) => n.method === 'turn/completed'));

    const turnRes = responses.find((r) => r.id === 3);
    assert.ok(turnRes);
    assert.strictEqual(turnRes.result.turn?.status, 'inProgress');

    const deltaNotif = notifications.find((n) => n.method === 'item/agentMessage/delta');
    assert.ok(deltaNotif);
    assert.strictEqual(deltaNotif.params.delta, 'PROBE_SUCCESS_P0');

    const turnCompletedNotif = notifications.find((n) => n.method === 'turn/completed');
    assert.ok(turnCompletedNotif);
    assert.strictEqual(turnCompletedNotif.params.turn?.status, 'completed');
  } finally {
    rl.close();
    proc.stdin?.destroy();
    proc.kill();
  }
});
