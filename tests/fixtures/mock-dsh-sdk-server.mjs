// tests/fixtures/mock-dsh-sdk-server.mjs
// Emulates `dsh --profile sdk` JSON-RPC 2.0 server over stdio
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';

const rl = readline.createInterface({
  input: process.stdin
});

let initialized = false;
let configuredProvider = null;
let configuredModel = null;
let configuredEffort = null;
const sessions = new Map();

function sendResponse(id, result, error = null) {
  const resp = { jsonrpc: '2.0', id };
  if (error) {
    resp.error = error;
  } else {
    resp.result = result;
  }
  process.stdout.write(JSON.stringify(resp) + '\n');
}

function sendNotification(method, params) {
  const notif = { jsonrpc: '2.0', method, params };
  process.stdout.write(JSON.stringify(notif) + '\n');
}

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch (err) {
    sendResponse(null, undefined, { code: -32700, message: 'Parse error' });
    return;
  }

  const { id, method, params } = msg;

  if (method === 'initialize') {
    const provider = params?.provider;
    const model = params?.model;
    if (provider !== 'deepseek-official') {
      sendResponse(id, undefined, {
        code: -32603,
        message: `no adapter registered for provider: ${provider}`
      });
      return;
    }
    initialized = true;
    configuredProvider = provider;
    configuredModel = model || 'deepseek-chat';
    configuredEffort = params?.reasoningEffort;

    sendResponse(id, {
      serverInfo: {
        name: 'deepseek-harness-sdk-runtime',
        version: '0.0.1'
      }
    });
    return;
  }

  if (method === 'test/hang') {
    // Deliberately do not respond to test timeout handling
    return;
  }

  if (method === 'shutdown') {
    sendResponse(id, {});
    process.exit(0);
  }

  if (method === 'session/prompt') {
    const sessionId = params?.sessionId || randomUUID();
    const contentBlocks = params?.contentBlocks || [];
    const text = contentBlocks.map((b) => b.text).join('\n');
    const messageId = randomUUID();

    let session = sessions.get(sessionId);
    if (!session) {
      session = { sessionId, messages: [] };
      sessions.set(sessionId, session);
    }
    session.messages.push(text);

    sendResponse(id, { messageId });

    // Emit initial status running
    sendNotification('session.status', { sessionId, status: 'running' });
    sendNotification('session.event', { sessionId, event: 'turn/start', data: { turn: 1 } });
    sendNotification('session.event', { sessionId, event: 'step/start', data: { turn: 1, step: 1 } });

    // Check if preparation prompt requesting ACK
    if (text.includes('PREPARATION_MODE: READ_ONLY')) {
      const handoffIdMatch = text.match(/HANDOFF_ID:\s*([^\s\n]+)/);
      const inputHashMatch = text.match(/INPUT_HEAD_HASH:\s*([^\s\n]+)/);
      const snapshotHashMatch = text.match(/TASK_SNAPSHOT_HASH:\s*([^\s\n]+)/);
      const workspaceHashMatch = text.match(/WORKSPACE_TREE_HASH:\s*([^\s\n]+)/);

      const ackPacket = {
        handoffId: handoffIdMatch ? handoffIdMatch[1] : 'unknown',
        newSessionId: sessionId,
        verifiedInputHeadHash: inputHashMatch ? inputHashMatch[1] : '',
        verifiedTaskSnapshotHash: snapshotHashMatch ? snapshotHashMatch[1] : '',
        verifiedWorkspaceHash: workspaceHashMatch ? workspaceHashMatch[1] : '',
        effectiveModel: {
          provider: configuredProvider || 'deepseek-official',
          model: configuredModel || 'deepseek-chat',
          effort: configuredEffort
        },
        status: 'READY'
      };

      const ackText = `HANDOFF_ACK_START\n${JSON.stringify(ackPacket, null, 2)}\nHANDOFF_ACK_END`;
      sendNotification('session.event', {
        sessionId,
        event: 'assistant/message',
        text: ackText
      });
    } else if (text.includes('EXECUTION_TOKEN:')) {
      sendNotification('session.event', {
        sessionId,
        event: 'assistant/message',
        text: `EXECUTION_AUTHORIZED: ${text.slice(0, 50)}`
      });
    } else if (text.startsWith('echo:')) {
      sendNotification('session.event', {
        sessionId,
        event: 'assistant/message',
        text: text.slice(5).trim()
      });
    } else {
      sendNotification('session.event', {
        sessionId,
        event: 'assistant/message',
        text: `Processed: ${text.slice(0, 100)}`
      });
    }

    // Emit idle status
    setTimeout(() => {
      sendNotification('session.status', { sessionId, status: 'idle' });
    }, 20);
    return;
  }

  sendResponse(id, undefined, {
    code: -32601,
    message: `Method not found: ${method}`
  });
});

rl.on('close', () => {
  process.exit(0);
});
