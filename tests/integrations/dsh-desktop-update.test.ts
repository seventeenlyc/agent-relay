import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { DshSessionMaterializer } from '../../integrations/dsh-package/lib/materializer.js';
import { RelayDispatcher } from '../../integrations/dsh-package/skills/agent-relay/scripts/dispatch.mjs';
import { apply } from '../../integrations/dsh-package/lib/index.js';
import { publishDshEndpoint } from '../../integrations/dsh-package/lib/connection.js';

const script = fileURLToPath(new URL('../../integrations/dsh-package/skills/agent-relay/scripts/dispatch.mjs', import.meta.url));

function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-desktop-update-'));
  const keys = ['USERPROFILE', 'HOME', 'LOCALAPPDATA', 'AGENT_RELAY_DATA_DIR', 'DSH_WEB_URL'];
  const before = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  process.env.USERPROFILE = process.env.HOME = dir;
  process.env.LOCALAPPDATA = dir;
  process.env.AGENT_RELAY_DATA_DIR = path.join(dir, 'agent-relay');
  delete process.env.DSH_WEB_URL;
  t.after(() => {
    for (const k of keys) if (before[k] === undefined) delete process.env[k]; else process.env[k] = before[k];
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test('Windows CLI displays usage and fails when stages are missing', () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8', windowsHide: true, env });
  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /Usage:/);
});

test('materializer discovers the live origin published by the host instead of the old fixed port', t => {
  const dir = sandbox(t);
  fs.mkdirSync(path.join(dir, '.dsh', 'agent-relay'), { recursive: true });
  const record = path.join(dir, '.dsh', 'agent-relay', 'endpoint.json');
  fs.writeFileSync(record, JSON.stringify({ origin: 'http://127.0.0.1:45671', pid: process.pid }));
  assert.equal(new DshSessionMaterializer().baseUrl, 'http://127.0.0.1:45671');
  fs.writeFileSync(record, JSON.stringify({ origin: 'http://127.0.0.1:45672', pid: process.pid }));
  assert.equal(new DshSessionMaterializer().baseUrl, 'http://127.0.0.1:45672');
  process.env.DSH_WEB_URL = 'http://127.0.0.1:45673/?token=private';
  assert.equal(new DshSessionMaterializer().baseUrl, 'http://127.0.0.1:45673');
});

test('missing endpoint fails with an actionable error instead of silently selecting a stale port', t => {
  sandbox(t);
  assert.throws(() => new DshSessionMaterializer(), /DSH_WEB_URL/);
});

for (const scenario of ['timeout', 'rpc rejection', 'background']) {
  test(`pipeline does not report completion after ${scenario}`, async t => {
    t.mock.method(console, 'log', () => {});
    const dir = sandbox(t);
    const dbPath = path.join(dir, 'agent-relay', 'relay.db');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    // Replace only external DSH work; runPipeline and SQLite persistence are real.
    const dispatcher = Object.create(RelayDispatcher.prototype);
    dispatcher.workspacePath = dir;
    dispatcher.baseUrl = 'http://127.0.0.1:45671';
    const created = [];
    dispatcher.createSession = async title => { created.push(title); return 'session-' + created.length; };
    dispatcher.sendPrompt = async () => {
      if (scenario === 'rpc rejection') throw new Error('prompt rejected');
      return { result: { ok: true } };
    };
    dispatcher.waitSettled = async () => null;
    const stages = [{ title: 'one', prompt: 'first', wait: scenario !== 'background' }, { title: 'two', prompt: 'second' }];
    if (scenario === 'background') {
      const result = await dispatcher.runPipeline(stages.slice(0, 1), 'test-background');
      assert.equal(result.state, 'RUNNING');
    } else {
      await assert.rejects(dispatcher.runPipeline(stages, 'test-' + scenario), /timeout|prompt rejected/i);
      assert.deepEqual(created, ['one']);
    }
    const db = new DatabaseSync(dbPath);
    try {
      const run = db.prepare('SELECT * FROM runs').get();
      assert.equal(run.state, scenario === 'background' ? 'RUNNING' : 'RECOVERY_REQUIRED');
      assert.equal(run.current_session_id, 'session-1');
    } finally { db.close(); }
  });
}

for (const reason of ['completed', 'error', 'max-tokens', 'cancelled']) {
  test(`settlement checks durable turn result: ${reason}`, async () => {
    const dispatcher = Object.create(RelayDispatcher.prototype);
    dispatcher.pollIntervalMs = 1;
    dispatcher.rpc = async (method, payload) => {
      assert.equal(typeof payload.args, 'object', 'DSH requires an args envelope');
      assert.ok(['session/list', 'session/page'].includes(method), 'use a public HTTP endpoint');
      if (method === 'session/page') assert.equal(payload.args.request.throughSeq, 2);
      return ({ result: { ok: true, value: method === 'session/list'
      ? { items: [{ sessionId: 'fast', running: false, projections: { asOfSeq: 2 } }] }
      : { records: [{ type: 'event', event: { type: 'turn/start', seq: 1 } },
          { type: 'event', event: { type: 'turn/end', seq: 2, data: { reason: { kind: reason } } } }] } } });
    };
    if (reason === 'completed') assert.equal((await dispatcher.waitSettled('fast', 30))?.sessionId, 'fast');
    else await assert.rejects(dispatcher.waitSettled('fast', 30), new RegExp(reason));
  });
}

test('host publishes when the web service is injected, without waiting for a legacy ready event', t => {
  const dir = sandbox(t);
  let ready, dispose;
  apply({
    on() {},
    inject(deps, cb) {
      if (deps.includes('webServer')) cb({
        webServer: { getOrigin: () => 'http://127.0.0.1:45674' },
        on(event, fn) { if (event === 'ready') ready = fn; },
        effect(fn) { dispose = fn(); },
      });
    },
  });
  const file = path.join(dir, '.dsh', 'agent-relay', 'endpoint.json');
  assert.equal(fs.existsSync(file), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { origin: 'http://127.0.0.1:45674', pid: process.pid });
  dispose();
  assert.equal(fs.existsSync(file), false);
});

test('rejected HTTP RPC cannot masquerade as successful prompt dispatch', async t => {
  const dir = sandbox(t);
  const dsh = path.join(dir, '.dsh');
  fs.mkdirSync(path.join(dsh, 'storages'), { recursive: true });
  fs.writeFileSync(path.join(dsh, '.credentials.yaml'), 'client-connection/browser-session:\n  secret: ZHVtbXk\n');
  fs.writeFileSync(path.join(dsh, 'storages', 'workspace.json'), JSON.stringify({ tables: { workspaces: { exact: { path: dir } } } }));
  const server = createServer((req, res) => {
    req.resume();
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ result: { ok: false, error: { message: 'model unavailable' } } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const cleanup = publishDshEndpoint('http://127.0.0.1:' + server.address().port);
  t.after(cleanup);
  const dispatcher = new RelayDispatcher(dir);
  await assert.rejects(dispatcher.sendPrompt('session-test', 'hello'), /model unavailable/);
  await assert.rejects(new DshSessionMaterializer().materializeSession({ workspacePath: dir, title: 'test' }), /session\/create failed/);
});

test('active runs in different physical workspaces do not block each other', async t => {
  t.mock.method(console, 'log', () => {});
  const dir = sandbox(t);
  for (const name of ['workspace-one', 'workspace-two']) {
    const dispatcher = Object.create(RelayDispatcher.prototype);
    dispatcher.workspacePath = path.join(dir, name);
    dispatcher.baseUrl = 'http://127.0.0.1:45671';
    dispatcher.createSession = async () => name;
    dispatcher.sendPrompt = async () => ({ result: { ok: true } });
    await dispatcher.runPipeline([{ title: name, prompt: 'hello', wait: false }], name);
  }
  const db = new DatabaseSync(path.join(dir, 'agent-relay', 'relay.db'));
  try { assert.equal(db.prepare('SELECT count(DISTINCT workspace_key) AS n FROM runs').get().n, 2); }
  finally { db.close(); }
});
