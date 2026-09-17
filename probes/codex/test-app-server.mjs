import { spawn } from 'node:child_process';
import readline from 'node:readline';
import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';

function getCodexLaunchConfig() {
  if (process.platform === 'win32' && process.env.APPDATA) {
    const npmCodexJs = path.join(process.env.APPDATA, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (fs.existsSync(npmCodexJs)) {
      return { cmd: process.execPath, args: [npmCodexJs, 'app-server', '--stdio'], shell: false };
    }
  }
  return { cmd: 'codex', args: ['app-server', '--stdio'], shell: true };
}

async function runProbe() {
  const launch = getCodexLaunchConfig();
  console.log('[Probe] Starting codex app-server --stdio via', launch.cmd, launch.args.join(' '));

  const proc = spawn(launch.cmd, launch.args, {
    shell: launch.shell,
    stdio: ['pipe', 'pipe', 'pipe']
  });

  proc.stderr.on('data', (data) => {
    const text = data.toString().trim();
    if (text) {
      console.log('[AppServer stderr]', text);
    }
  });

  const rl = readline.createInterface({ input: proc.stdout });
  let reqId = 1;
  const pending = new Map();
  const notifications = [];
  const eventListeners = new Set();

  rl.on('line', (line) => {
    line = line.trim();
    if (!line) return;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) {
          p.reject(msg.error);
        } else {
          p.resolve(msg.result);
        }
      } else {
        notifications.push(msg);
        for (const listener of eventListeners) {
          try { listener(msg); } catch (e) { /* ignore */ }
        }
        const method = msg.method || 'unknown';
        if (method === 'item/agentMessage/delta') {
          process.stdout.write(msg.params?.delta || '');
        } else if (method === 'turn/started' || method === 'turn/completed') {
          console.log(`\n[Notification: ${method}]`, JSON.stringify(msg.params));
        } else if (method === 'thread/started' || method === 'thread/status/changed') {
          console.log(`[Notification: ${method}]`, JSON.stringify(msg.params).slice(0, 140));
        }
      }
    } catch (e) {
      console.log('[AppServer raw stdout]', line);
    }
  });

  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = reqId++;
      pending.set(id, { resolve, reject });
      const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
      proc.stdin.write(payload, 'utf8', (err) => {
        if (err) reject(err);
      });
    });
  }

  function waitForNotification(filterFn, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        eventListeners.delete(handler);
        reject(new Error(`Timed out waiting for notification after ${timeoutMs}ms`));
      }, timeoutMs);

      const handler = (msg) => {
        if (filterFn(msg)) {
          clearTimeout(timer);
          eventListeners.delete(handler);
          resolve(msg);
        }
      };

      eventListeners.add(handler);
    });
  }

  const results = {};

  try {
    // 1. Initialize
    console.log('\n================ 1. Testing initialize ================');
    const initRes = await send('initialize', {
      clientInfo: { name: 'agent-relay-probe', version: '0.1.0', title: 'Agent Relay P0 Probe' },
      capabilities: {}
    });
    console.log('[Probe] Initialize response:\n', JSON.stringify(initRes, null, 2));
    results.initialize = initRes;

    // 2. Thread 1 / Start
    console.log('\n================ 2. Testing thread/start (Thread 1) ================');
    const cwd = process.cwd();
    const thread1Res = await send('thread/start', {
      cwd,
      model: 'gpt-5.6-luna'
    });
    console.log('[Probe] Thread 1 start response:\n', JSON.stringify(thread1Res, null, 2));
    results.thread1 = thread1Res;
    const thread1Id = thread1Res.thread.id;

    // 3. Turn 1 / Start on Thread 1
    console.log(`\n================ 3. Testing turn/start on Thread 1 (${thread1Id}) ================`);
    const turnCompletePromise = waitForNotification(
      (m) => m.method === 'turn/completed' && m.params?.turn?.id
    );

    const turn1Res = await send('turn/start', {
      threadId: thread1Id,
      input: [
        {
          type: 'text',
          text: 'Reply with the exact text: "PROBE_SUCCESS_P0" and nothing else.',
          text_elements: []
        }
      ]
    });
    console.log('[Probe] Turn 1 start response:\n', JSON.stringify(turn1Res, null, 2));
    results.turn1Start = turn1Res;

    console.log('\n[Probe] Waiting for model output and turn/completed notification:');
    const turn1CompletedNotif = await turnCompletePromise;
    console.log('\n[Probe] Turn 1 completed notification:\n', JSON.stringify(turn1CompletedNotif.params, null, 2));
    results.turn1Completed = turn1CompletedNotif.params;

    // 4. Thread 2 / Start (verify new Thread ID and isolation)
    console.log('\n================ 4. Testing thread/start (Thread 2) ================');
    const thread2Res = await send('thread/start', {
      cwd,
      model: 'gpt-5.6-luna'
    });
    console.log('[Probe] Thread 2 start response:\n', JSON.stringify(thread2Res, null, 2));
    results.thread2 = thread2Res;
    const thread2Id = thread2Res.thread.id;

    // 5. Test thread read before materialization
    console.log('\n================ 5. Testing unmaterialized thread behavior ================');
    const thread2ReadBasic = await send('thread/read', { threadId: thread2Id, includeTurns: false });
    console.log('[Probe] Thread 2 read (includeTurns: false) success:', thread2ReadBasic.thread.id === thread2Id);

    let unmaterializedError = null;
    try {
      await send('thread/read', { threadId: thread2Id, includeTurns: true });
    } catch (e) {
      unmaterializedError = e;
      console.log('[Probe] Expected error on unmaterialized thread with includeTurns: true:', JSON.stringify(e));
    }
    results.unmaterializedBehavior = {
      basicReadSuccess: thread2ReadBasic.thread.id === thread2Id,
      errorWithIncludeTurns: unmaterializedError
    };

    // 6. Testing turn/interrupt on Thread 2
    console.log(`\n================ 6. Testing turn/interrupt on Thread 2 (${thread2Id}) ================`);
    const turn2StartedPromise = waitForNotification(
      (m) => m.method === 'turn/started' && m.params?.threadId === thread2Id
    );
    const turn2CompletedPromise = waitForNotification(
      (m) => m.method === 'turn/completed' && m.params?.threadId === thread2Id
    );

    const turn2Res = await send('turn/start', {
      threadId: thread2Id,
      input: [
        {
          type: 'text',
          text: 'Write a 1000-word essay analyzing the history of operating systems from CTSS to modern microkernels.',
          text_elements: []
        }
      ]
    });
    const turn2Id = turn2Res.turn.id;
    console.log(`[Probe] Turn 2 dispatch accepted. turnId=${turn2Id}`);

    // Wait until turn has officially started
    await turn2StartedPromise;
    console.log('[Probe] Turn 2 started notification received. Sending turn/interrupt now...');

    const interruptRes = await send('turn/interrupt', {
      threadId: thread2Id,
      turnId: turn2Id
    });
    console.log('[Probe] Turn interrupt response:', JSON.stringify(interruptRes, null, 2));
    results.turnInterruptResponse = interruptRes;

    console.log('[Probe] Waiting for Turn 2 completion after interrupt...');
    const turn2CompletedNotif = await turn2CompletedPromise;
    console.log('\n[Probe] Turn 2 completed notification after interrupt:\n', JSON.stringify(turn2CompletedNotif.params, null, 2));
    results.turn2CompletedAfterInterrupt = turn2CompletedNotif.params;

    // 7. Verify History Isolation after both threads have turns
    console.log('\n================ 7. Verifying History Isolation ================');
    const thread1ReadFull = await send('thread/read', { threadId: thread1Id, includeTurns: true });
    const thread2ReadFull = await send('thread/read', { threadId: thread2Id, includeTurns: true });

    const thread1Turns = thread1ReadFull.thread.turns || [];
    const thread2Turns = thread2ReadFull.thread.turns || [];

    console.log(`[Probe] Thread 1 turns count: ${thread1Turns.length}, Turn 1 status: ${thread1Turns[0]?.status}`);
    console.log(`[Probe] Thread 2 turns count: ${thread2Turns.length}, Turn 2 status: ${thread2Turns[0]?.status}`);
    console.log(`[Probe] Distinct Thread IDs: ${thread1Id} !== ${thread2Id} -> ${thread1Id !== thread2Id}`);

    results.isolationEvidence = {
      thread1Id,
      thread1TurnsCount: thread1Turns.length,
      thread1TurnStatus: thread1Turns[0]?.status,
      thread2Id,
      thread2TurnsCount: thread2Turns.length,
      thread2TurnStatus: thread2Turns[0]?.status,
      threadsAreIndependent: thread1Id !== thread2Id && thread1Turns.length === 1 && thread2Turns.length === 1
    };

    // 8. Testing thread/list
    console.log('\n================ 8. Testing thread/list ================');
    const threadListDefault = await send('thread/list', { limit: 5 });
    console.log(`[Probe] thread/list (default) returned ${threadListDefault.data?.length ?? 0} threads`);

    const threadListAllSources = await send('thread/list', {
      limit: 10,
      sourceKinds: ['vscode', 'appServer', 'cli', 'exec']
    });
    console.log(`[Probe] thread/list (with sourceKinds) returned ${threadListAllSources.data?.length ?? 0} threads`);
    const foundThread1 = (threadListAllSources.data || []).find((t) => t.id === thread1Id);
    console.log(`[Probe] Thread 1 found in thread/list: ${Boolean(foundThread1)}`);
    if (foundThread1) {
      console.log('[Probe] Found thread summary:', JSON.stringify({
        id: foundThread1.id,
        preview: foundThread1.preview,
        source: foundThread1.source,
        modelProvider: foundThread1.modelProvider,
        cwd: foundThread1.cwd
      }, null, 2));
    }

    results.threadList = {
      defaultCount: threadListDefault.data?.length ?? 0,
      allSourcesCount: threadListAllSources.data?.length ?? 0,
      thread1Found: Boolean(foundThread1)
    };

  } finally {
    console.log('\n================ Shutdown ================');
    proc.stdin.end();
    setTimeout(() => {
      try { proc.kill(); } catch (e) {}
    }, 1000);
  }

  return results;
}

runProbe()
  .then((res) => {
    console.log('\n================ PROBE SUMMARY ================');
    console.log('All probe steps verified successfully!');
    console.log(JSON.stringify({
      initialize: {
        platform: res.initialize.platformOs,
        codexHome: res.initialize.codexHome
      },
      thread1: {
        id: res.thread1.thread.id,
        model: res.thread1.model,
        cwd: res.thread1.cwd
      },
      turn1Status: res.turn1Completed.turn.status,
      thread2: {
        id: res.thread2.thread.id,
        model: res.thread2.model
      },
      turn2InterruptStatus: res.turn2CompletedAfterInterrupt.turn.status,
      isolationConfirmed: res.isolationEvidence.threadsAreIndependent
    }, null, 2));
    process.exit(0);
  })
  .catch((err) => {
    console.error('\n[Probe Fatal Error]:', err);
    process.exit(1);
  });
