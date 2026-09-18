// tests/fixtures/mock-codex-app-server.mjs
// Emulates `codex app-server --stdio` JSON-RPC 2.0 server
import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin });
const threads = new Map();
let threadCounter = 1;
let turnCounter = 1;

function sendResponse(id, result, error = null) {
  const payload = { jsonrpc: '2.0', id };
  if (error) {
    payload.error = error;
  } else {
    payload.result = result;
  }
  process.stdout.write(JSON.stringify(payload) + '\n');
}

function sendNotification(method, params) {
  const payload = { jsonrpc: '2.0', method, params };
  process.stdout.write(JSON.stringify(payload) + '\n');
}

rl.on('line', (line) => {
  line = line.trim();
  if (!line) return;
  try {
    const msg = JSON.parse(line);
    const { id, method, params } = msg;

    if (method === 'initialize') {
      sendResponse(id, {
        userAgent: 'mock-codex/0.144.4 (Windows 10.0.26200)',
        codexHome: 'C:\\Users\\mock\\.codex',
        platformFamily: 'windows',
        platformOs: 'windows'
      });
    } else if (method === 'thread/start') {
      const threadId = params?.sessionId || `01a0af-${String(threadCounter++).padStart(6, '0')}`;
      const model = params?.model || 'gpt-5.6-luna';
      const cwd = params?.cwd || process.cwd();
      const ephemeral = Boolean(params?.ephemeral);
      const threadObj = {
        id: threadId,
        sessionId: params?.sessionId || threadId,
        source: 'vscode',
        ephemeral,
        cwd
      };
      threads.set(threadId, {
        thread: threadObj,
        model,
        modelProvider: 'openai',
        reasoningEffort: 'xhigh',
        cwd,
        turns: [],
        activeTurnId: null,
        interruptedTurnId: null
      });

      sendResponse(id, {
        thread: threadObj,
        model,
        modelProvider: 'openai',
        reasoningEffort: 'xhigh',
        cwd
      });

      sendNotification('thread/started', { thread: threadObj });
    } else if (method === 'turn/start') {
      const thread = threads.get(params?.threadId);
      if (!thread) {
        sendResponse(id, null, { code: -32602, message: 'Thread not found' });
        return;
      }
      const turnId = `turn-${String(turnCounter++).padStart(6, '0')}`;
      thread.activeTurnId = turnId;

      sendResponse(id, {
        turn: {
          id: turnId,
          items: [],
          status: 'inProgress'
        }
      });

      // Emit lifecycle sequence
      sendNotification('thread/status/changed', {
        threadId: thread.thread.id,
        status: { type: 'active' }
      });
      sendNotification('turn/started', {
        threadId: thread.thread.id,
        turn: { id: turnId, status: 'inProgress' }
      });

      const inputText = params?.input?.[0]?.text || '';
      let replyDelta = 'PROBE_SUCCESS_P0';
      if (inputText.includes('READ-ONLY PREPARATION MODE')) {
        // Echo structured ACK
        try {
          const match = inputText.match(/\{[\s\S]*"handoffId"[\s\S]*\}/);
          if (match) {
            const manifest = JSON.parse(match[0]);
            const ack = {
              handoffId: manifest.handoffId,
              runId: manifest.runId,
              newSessionId: thread.thread.sessionId || thread.thread.id,
              effectiveModel: { provider: 'openai', model: thread.model, effort: thread.reasoningEffort },
              verifiedInputHeadHash: manifest.inputLedgerHeadHash,
              verifiedTaskSnapshotHash: manifest.taskSnapshotHash,
              verifiedWorkspaceHash: manifest.workspaceFingerprint?.treeHash || 'hash-ws-default',
              ackTimestamp: Date.now()
            };
            replyDelta = '```json\n' + JSON.stringify(ack, null, 2) + '\n```';
          }
        } catch {
          replyDelta = 'ACK_GENERATION_FAILED';
        }
      } else if (inputText.includes('EXECUTION_AUTHORIZED')) {
        replyDelta = 'TASK_COMPLETED_SUCCESS';
      } else if (inputText.includes('echo:')) {
        replyDelta = inputText.replace('echo:', '').trim();
      }

      setTimeout(() => {
        if (thread.interruptedTurnId === turnId) {
          // Was interrupted
          return;
        }
        sendNotification('item/started', { threadId: thread.thread.id, turnId });
        sendNotification('item/agentMessage/delta', {
          threadId: thread.thread.id,
          turnId,
          delta: replyDelta
        });
        sendNotification('item/completed', {
          threadId: thread.thread.id,
          turnId,
          item: { type: 'agentMessage', text: replyDelta }
        });

        thread.turns.push({ id: turnId, status: 'completed', text: replyDelta });
        thread.activeTurnId = null;

        sendNotification('thread/status/changed', {
          threadId: thread.thread.id,
          status: { type: 'idle' }
        });
        sendNotification('turn/completed', {
          threadId: thread.thread.id,
          turn: { id: turnId, status: 'completed', durationMs: 40 }
        });
      }, 30);
    } else if (method === 'turn/interrupt') {
      const thread = threads.get(params?.threadId);
      if (thread && thread.activeTurnId) {
        const interruptedId = thread.activeTurnId;
        thread.interruptedTurnId = interruptedId;
        thread.activeTurnId = null;
        thread.turns.push({ id: interruptedId, status: 'interrupted' });

        sendResponse(id, {});
        sendNotification('thread/status/changed', {
          threadId: thread.thread.id,
          status: { type: 'idle' }
        });
        sendNotification('turn/completed', {
          threadId: thread.thread.id,
          turn: { id: interruptedId, status: 'interrupted', durationMs: 25 }
        });
      } else {
        sendResponse(id, {});
      }
    } else if (method === 'thread/read') {
      const thread = threads.get(params?.threadId);
      if (!thread) {
        sendResponse(id, null, { code: -32602, message: 'Thread not found' });
        return;
      }
      if (params?.includeTurns && thread.turns.length === 0) {
        sendResponse(id, null, {
          code: -32600,
          message: `thread ${params.threadId} is not materialized yet; includeTurns is unavailable before first user message`
        });
        return;
      }
      sendResponse(id, {
        thread: {
          ...thread.thread,
          turns: params?.includeTurns ? thread.turns : []
        }
      });
    } else if (method === 'test/hang') {
      // Intentionally do not respond to test client timeout
      return;
    } else {
      sendResponse(id, null, { code: -32601, message: `Method not found: ${method}` });
    }
  } catch (err) {
    process.stderr.write(`[MockServer Error]: ${String(err)}\n`);
  }
});

rl.on('close', () => {
  process.exit(0);
});

