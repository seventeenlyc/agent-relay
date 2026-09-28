import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RelayDatabase } from '../../packages/controller/src/run/db.ts';
import { RunStore } from '../../packages/controller/src/run/store.ts';

const MOCK_DSH_PATH = fileURLToPath(new URL('../fixtures/mock-dsh-sdk-server.mjs', import.meta.url));
const PLUGIN_PATH = '../../integrations/dsh-plugin.mjs';

test('dsh plugin: exposes a versioned manifest and runtime factory', async () => {
  const plugin = await import(PLUGIN_PATH);

  assert.deepStrictEqual(plugin.pluginManifest, {
    id: 'agent-relay-dsh',
    version: '0.1.0',
    protocolVersion: 1,
    target: 'dsh'
  });
  assert.strictEqual(typeof plugin.createRuntime, 'function');
  assert.strictEqual(typeof plugin.apply, 'function');

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-relay-dsh-plugin-'));
  try {
    const runtime = await plugin.createRuntime({
      cwd: process.cwd(),
      dataDir,
      runnerOptions: {
        binPath: process.execPath,
        extraArgsPrefix: [MOCK_DSH_PATH]
      }
    });

    assert.strictEqual(runtime.adapterName, 'dsh');
    assert.strictEqual(runtime.adapter.capabilities().level, 'L3');
    assert.strictEqual(
      runtime.createCoordinator({ stateMachine: {} as any, leaseManager: {} as any, workspaceKey: 'ws', runId: 'run' }).constructor.name,
      'DshHandshakeCoordinator'
    );
    await runtime.shutdown();
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('dsh plugin: apply registers the observed event bridge and logs only when opted in', async () => {
  const plugin = await import(PLUGIN_PATH);
  const listeners = new Map<string, (session: unknown, event: unknown) => void>();
  plugin.apply({
    on(event: string, listener: (session: unknown, payload: unknown) => void) {
      listeners.set(event, listener);
    }
  });

  assert.strictEqual(listeners.has('session/event'), true);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-relay-dsh-events-'));
  const logPath = path.join(dir, 'events.jsonl');
  const originalLog = process.env.AGENT_RELAY_EVENT_LOG;
  process.env.AGENT_RELAY_EVENT_LOG = logPath;
  try {
    listeners.get('session/event')?.({ id: 'session-1' }, { event: 'assistant/message', text: 'hello' });
    const lines = fs.readFileSync(logPath, 'utf8').trim().split(/\r?\n/);
    assert.strictEqual(lines.length, 1);
    assert.deepStrictEqual(JSON.parse(lines[0]), {
      source: 'dsh_event',
      sessionId: 'session-1',
      event: { event: 'assistant/message', text: 'hello' }
    });
  } finally {
    if (originalLog === undefined) delete process.env.AGENT_RELAY_EVENT_LOG;
    else process.env.AGENT_RELAY_EVENT_LOG = originalLog;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('dsh plugin: apply registers the 5 native relay_* control tools and persists intents to relay.db', async () => {
  const plugin = await import(PLUGIN_PATH);
  const tools = new Map<string, any>();

  plugin.apply({
    on() {},
    inject(deps: string[], cb: (c: any) => void) {
      assert.deepStrictEqual(deps, ['tools']);
      cb({
        tools: {
          register(tool: any) {
            tools.set(tool.name, tool);
          }
        }
      });
    }
  });

  assert.deepStrictEqual(
    [...tools.keys()],
    ['relay_status', 'relay_pause', 'relay_resume', 'relay_stop', 'relay_chain', 'relay_materialize']
  );

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-relay-dsh-tools-'));
  const prevDataDir = process.env.AGENT_RELAY_DATA_DIR;
  process.env.AGENT_RELAY_DATA_DIR = tmpDir;

  let db: RelayDatabase | null = null;
  try {
    const noDbStatus = await tools.get('relay_status').execute({});
    assert.strictEqual(noDbStatus.found, false);

    const noDbChain = await tools.get('relay_chain').execute({});
    assert.strictEqual(noDbChain.found, false);
    assert.strictEqual(noDbChain.runId, undefined);

    db = new RelayDatabase({ dbPath: path.join(tmpDir, 'relay.db') });
    const store = new RunStore(db);
    store.insertRun({
      runId: 'run-tool-test',
      workspaceKey: 'ws-tool-test',
      workspacePath: tmpDir,
      goal: 'Verify DSH native control tools',
      state: 'RUNNING',
      unitCount: 2,
      model: { provider: 'deepseek-official', model: 'deepseek-chat' }
    });
    store.insertChainLink({
      runId: 'run-tool-test',
      sequence: 1,
      nextSessionId: 'dsh-sess-1',
      adapter: 'dsh',
      provider: 'deepseek-official',
      model: 'deepseek-chat',
      epoch: 1,
      reason: 'initial_spawn'
    });
    db.close();
    db = null;

    const statusOut = await tools.get('relay_status').execute({});
    assert.strictEqual(statusOut.found, true);
    assert.strictEqual(statusOut.runId, 'run-tool-test');
    assert.strictEqual(statusOut.run.state, 'RUNNING');

    const chainOut = await tools.get('relay_chain').execute({});
    assert.strictEqual(chainOut.found, true);
    assert.strictEqual(chainOut.runId, 'run-tool-test');
    assert.strictEqual(chainOut.links.length, 1);

    const pauseOut = await tools.get('relay_pause').execute({});
    assert.strictEqual(pauseOut.applied, true);
    assert.strictEqual(pauseOut.watermark, 1);

    const resumeRejected = await tools.get('relay_resume').execute({});
    assert.strictEqual(resumeRejected.applied, false);

    const stopOut = await tools.get('relay_stop').execute({});
    assert.strictEqual(stopOut.applied, true);
    assert.strictEqual(stopOut.watermark, 2);
  } finally {
    if (db) db.close();
    if (prevDataDir === undefined) delete process.env.AGENT_RELAY_DATA_DIR;
    else process.env.AGENT_RELAY_DATA_DIR = prevDataDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('dsh plugin: DshHandoffHook automatically intercepts marker and precompact triggers', async () => {
  const plugin = await import(PLUGIN_PATH);
  const { DshHandoffHook } = plugin;
  assert.strictEqual(typeof DshHandoffHook, 'function');

  const triggered: any[] = [];
  const fakeCtx = {
    on: () => {}
  };
  const hook = new DshHandoffHook(fakeCtx);
  hook.onTrigger((payload: any) => {
    triggered.push(payload);
  });

  // 1. Test assistant/message with HANDOFF_ACK_START marker
  const markerEvent = {
    type: 'assistant/message',
    seq: 10,
    data: {
      message: {
        content: [
          { type: 'text', text: 'Epoch 1 完成。\nHANDOFF_ACK_START\n{"epoch":1}\nHANDOFF_ACK_END' }
        ]
      }
    }
  };
  const processedMarker = await hook.processEvent({ id: 'sess-test-1' }, markerEvent);
  assert.strictEqual(processedMarker, true);
  assert.strictEqual(triggered.length, 1);
  assert.strictEqual(triggered[0].sourceSessionId, 'sess-test-1');
  assert.strictEqual(triggered[0].reason, 'marker_trigger');

  // Test deduplication: same event should not trigger again
  const duplicateMarker = await hook.processEvent({ id: 'sess-test-1' }, markerEvent);
  assert.strictEqual(duplicateMarker, false);
  assert.strictEqual(triggered.length, 1);

  // 2. Test compaction/start (PreCompact hook)
  const compactEvent = {
    type: 'compaction/start',
    seq: 11
  };
  const processedCompact = await hook.processEvent({ id: 'sess-test-2' }, compactEvent);
  assert.strictEqual(processedCompact, true);
  assert.strictEqual(triggered.length, 2);
  assert.strictEqual(triggered[1].sourceSessionId, 'sess-test-2');
  assert.strictEqual(triggered[1].reason, 'hook_pre_compact');
  assert.strictEqual(triggered[1].compaction, true);
});
