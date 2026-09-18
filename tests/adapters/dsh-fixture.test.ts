import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import type {
  DshJsonRpcRequest,
  DshJsonRpcResponse,
  DshJsonRpcNotification,
  DshInitializeParams,
  DshInitializeResult,
  DshSessionPromptContentBlock,
  DshSessionPromptParams,
  DshSessionPromptResult,
  DshSessionStatusParams,
  DshSessionEventParams
} from '../../packages/adapters/dsh/src/types.ts';

const MOCK_SERVER_PATH = fileURLToPath(new URL('../fixtures/mock-dsh-sdk-server.mjs', import.meta.url));

const waitFor = async (predicate: () => boolean, timeoutMs = 2000) => {
  const start = Date.now();
  while (!predicate() && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 10));
  }
};

test('dsh-fixture: mock sdk server starts and handles initialize, session/prompt, and shutdown via JSON-RPC 2.0', async () => {
  const proc = spawn(process.execPath, [MOCK_SERVER_PATH], {
    stdio: ['pipe', 'pipe', 'pipe']
  });

  const rl = readline.createInterface({ input: proc.stdout! });
  const responses: DshJsonRpcResponse<any>[] = [];
  const notifications: DshJsonRpcNotification<any>[] = [];

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

  try {
    // 1. Send initialize with deepseek-official and deepseek-chat
    const initReq: DshJsonRpcRequest<DshInitializeParams> = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { cwd: process.cwd(), provider: 'deepseek-official', model: 'deepseek-chat' }
    };
    proc.stdin!.write(JSON.stringify(initReq) + '\n');

    await waitFor(() => responses.some((r) => r.id === 1));

    const initRes = responses.find((r) => r.id === 1);
    assert.ok(initRes);
    assert.strictEqual(initRes.result.serverInfo.name, 'deepseek-harness-sdk-runtime');
    assert.strictEqual(initRes.result.serverInfo.version, '0.0.1');

    // 2. Send session/prompt
    const promptReq: DshJsonRpcRequest<DshSessionPromptParams> = {
      jsonrpc: '2.0',
      id: 2,
      method: 'session/prompt',
      params: {
        sessionId: 'dsh-session-001',
        contentBlocks: [{ type: 'text', text: 'echo: hello dsh' }]
      }
    };
    proc.stdin!.write(JSON.stringify(promptReq) + '\n');

    await waitFor(() => responses.some((r) => r.id === 2));

    const promptRes = responses.find((r) => r.id === 2);
    assert.ok(promptRes);
    assert.ok(promptRes.result.messageId);

    // Wait for idle status notification
    await waitFor(() =>
      notifications.some((n) => n.method === 'session.status' && n.params?.status === 'idle')
    );

    // Check notifications received
    const runningStatus = notifications.find(
      (n) => n.method === 'session.status' && n.params?.status === 'running'
    );
    assert.ok(runningStatus);

    const idleStatus = notifications.find(
      (n) => n.method === 'session.status' && n.params?.status === 'idle'
    );
    assert.ok(idleStatus);

    const messageEvent = notifications.find(
      (n) => n.method === 'session.event' && n.params?.event === 'assistant/message'
    );
    assert.ok(messageEvent);
    assert.strictEqual(messageEvent.params?.text, 'hello dsh');

    // 3. Send shutdown
    proc.stdin!.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'shutdown',
        params: {}
      }) + '\n'
    );

    const exitCode = await new Promise((resolve) => {
      proc.on('close', (code) => resolve(code));
    });
    assert.strictEqual(exitCode, 0);
  } finally {
    rl.close();
    proc.stdin?.destroy();
    proc.kill();
  }
});

test('dsh-fixture: rejects invalid provider on initialize with -32603', async () => {
  const proc = spawn(process.execPath, [MOCK_SERVER_PATH], {
    stdio: ['pipe', 'pipe', 'pipe']
  });

  const rl = readline.createInterface({ input: proc.stdout! });
  const responses: DshJsonRpcResponse<any>[] = [];

  rl.on('line', (line) => {
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined) responses.push(msg);
    } catch {}
  });

  try {
    proc.stdin!.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { cwd: process.cwd(), provider: 'unsupported-provider', model: 'deepseek-chat' }
      }) + '\n'
    );

    await waitFor(() => responses.some((r) => r.id === 1));

    const initRes = responses.find((r) => r.id === 1);
    assert.ok(initRes);
    assert.ok(initRes.error);
    assert.strictEqual(initRes.error.code, -32603);
    assert.ok(initRes.error.message.includes('no adapter registered for provider'));
  } finally {
    rl.close();
    proc.stdin?.destroy();
    proc.kill();
  }
});

test('dsh-fixture: processes PREPARATION_MODE: READ_ONLY and generates HANDOFF_ACK packet', async () => {
  const proc = spawn(process.execPath, [MOCK_SERVER_PATH], {
    stdio: ['pipe', 'pipe', 'pipe']
  });

  const rl = readline.createInterface({ input: proc.stdout! });
  const responses: DshJsonRpcResponse<any>[] = [];
  const notifications: DshJsonRpcNotification<any>[] = [];

  rl.on('line', (line) => {
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined) responses.push(msg);
      else if (msg.method) notifications.push(msg);
    } catch {}
  });

  try {
    // 1. Initialize
    proc.stdin!.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          cwd: process.cwd(),
          provider: 'deepseek-official',
          model: 'deepseek-reasoner',
          reasoningEffort: 'high'
        }
      }) + '\n'
    );

    await waitFor(() => responses.some((r) => r.id === 1));

    // 2. Preparation prompt
    const prepPrompt = [
      'PREPARATION_MODE: READ_ONLY',
      'HANDOFF_ID: handoff-test-456',
      'INPUT_HEAD_HASH: in-hash-111',
      'TASK_SNAPSHOT_HASH: task-hash-222',
      'WORKSPACE_TREE_HASH: ws-hash-333'
    ].join('\n');

    proc.stdin!.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'session/prompt',
        params: {
          sessionId: 'dsh-session-ack-test',
          contentBlocks: [{ type: 'text', text: prepPrompt }]
        }
      }) + '\n'
    );

    await waitFor(() =>
      notifications.some(
        (n) =>
          n.method === 'session.event' &&
          n.params?.event === 'assistant/message' &&
          n.params?.text?.includes('HANDOFF_ACK_START')
      )
    );

    const ackEvent = notifications.find(
      (n) =>
        n.method === 'session.event' &&
        n.params?.event === 'assistant/message' &&
        n.params?.text?.includes('HANDOFF_ACK_START')
    );
    assert.ok(ackEvent);
    const ackText: string = ackEvent.params.text;
    assert.ok(ackText.includes('HANDOFF_ACK_START'));
    assert.ok(ackText.includes('HANDOFF_ACK_END'));

    const jsonMatch = ackText.match(/HANDOFF_ACK_START\s*([\s\S]*?)\s*HANDOFF_ACK_END/);
    assert.ok(jsonMatch);
    const ackPacket = JSON.parse(jsonMatch[1]);
    assert.strictEqual(ackPacket.handoffId, 'handoff-test-456');
    assert.strictEqual(ackPacket.verifiedInputHeadHash, 'in-hash-111');
    assert.strictEqual(ackPacket.verifiedTaskSnapshotHash, 'task-hash-222');
    assert.strictEqual(ackPacket.verifiedWorkspaceHash, 'ws-hash-333');
    assert.strictEqual(ackPacket.effectiveModel.provider, 'deepseek-official');
    assert.strictEqual(ackPacket.effectiveModel.model, 'deepseek-reasoner');
    assert.strictEqual(ackPacket.effectiveModel.effort, 'high');
    assert.strictEqual(ackPacket.status, 'READY');
  } finally {
    rl.close();
    proc.stdin?.destroy();
    proc.kill();
  }
});

test('dsh-types: type contracts can be instantiated and validated', () => {
  const req: DshJsonRpcRequest<DshInitializeParams> = {
    jsonrpc: '2.0',
    id: 'req-1',
    method: 'initialize',
    params: {
      cwd: '/workspace',
      provider: 'deepseek-official',
      model: 'deepseek-chat',
      reasoningEffort: 'medium',
      maxTokens: 4096
    }
  };
  assert.strictEqual(req.id, 'req-1');

  const res: DshJsonRpcResponse<DshInitializeResult> = {
    jsonrpc: '2.0',
    id: 'req-1',
    result: {
      serverInfo: {
        name: 'deepseek-harness-sdk-runtime',
        version: '0.0.1'
      }
    }
  };
  assert.strictEqual(res.result?.serverInfo.name, 'deepseek-harness-sdk-runtime');

  const notif: DshJsonRpcNotification<DshSessionStatusParams> = {
    jsonrpc: '2.0',
    method: 'session.status',
    params: {
      sessionId: 'sess-1',
      status: 'idle'
    }
  };
  assert.strictEqual(notif.params?.status, 'idle');
});
