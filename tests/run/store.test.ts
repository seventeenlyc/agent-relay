// tests/run/store.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { RelayDatabase } from '../../packages/controller/src/run/db.ts';
import { RunStore } from '../../packages/controller/src/run/store.ts';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-relay-store-'));
}

test('store: migrate is idempotent and records schema version', () => {
  const db = new RelayDatabase({ dbPath: ':memory:' });
  db.migrate();
  db.migrate();
  const row = db.prepare('SELECT value FROM schema_meta WHERE key = ?').get('schema_version') as
    | { value: string }
    | undefined;
  assert.ok(row);
  assert.strictEqual(row?.value, '1');
  db.close();
});

test('store: transaction rolls back every write when the callback throws', () => {
  const db = new RelayDatabase({ dbPath: ':memory:' });
  const store = new RunStore(db);
  store.insertRun({
    runId: 'run-rollback',
    workspaceKey: 'ws-rollback',
    workspacePath: 'C:/tmp/ws-rollback',
    goal: 'rollback test',
    state: 'INITIALIZING',
    unitCount: 3
  });

  assert.throws(() => {
    store.transaction(() => {
      store.updateRunState('run-rollback', 'RUNNING');
      store.appendIntent('run-rollback', 'stop_now');
      throw new Error('boom');
    });
  }, /boom/);

  assert.strictEqual(store.getRun('run-rollback')?.state, 'INITIALIZING');
  assert.deepStrictEqual(store.listIntents('run-rollback'), []);
  db.close();
});

test('store: nested transactions use savepoints and keep outer work on inner failure', () => {
  const db = new RelayDatabase({ dbPath: ':memory:' });
  const store = new RunStore(db);
  store.insertRun({
    runId: 'run-nested',
    workspaceKey: 'ws-nested',
    workspacePath: 'C:/tmp/ws-nested',
    goal: 'nested test',
    state: 'INITIALIZING',
    unitCount: 2
  });

  store.transaction(() => {
    store.updateRunState('run-nested', 'RUNNING');
    assert.throws(() => {
      store.transaction(() => {
        store.appendIntent('run-nested', 'disable');
        throw new Error('inner-boom');
      });
    }, /inner-boom/);
  });

  assert.strictEqual(store.getRun('run-nested')?.state, 'RUNNING');
  assert.deepStrictEqual(store.listIntents('run-nested'), []);
  db.close();
});

test('store: only one active run may hold a workspace key (V34)', () => {
  const db = new RelayDatabase({ dbPath: ':memory:' });
  const store = new RunStore(db);
  store.insertRun({
    runId: 'run-a',
    workspaceKey: 'ws-shared',
    workspacePath: 'C:/tmp/ws-shared',
    goal: 'first',
    state: 'RUNNING',
    unitCount: 1
  });

  assert.throws(() => {
    store.insertRun({
      runId: 'run-b',
      workspaceKey: 'ws-shared',
      workspacePath: 'C:/tmp/ws-shared',
      goal: 'second',
      state: 'RUNNING',
      unitCount: 1
    });
  }, /UNIQUE|constraint/i);

  assert.strictEqual(store.getActiveRunByWorkspace('ws-shared')?.runId, 'run-a');

  // Terminal runs release the workspace key
  store.updateRunState('run-a', 'COMPLETED');
  assert.strictEqual(store.getActiveRunByWorkspace('ws-shared'), undefined);
  store.insertRun({
    runId: 'run-b',
    workspaceKey: 'ws-shared',
    workspacePath: 'C:/tmp/ws-shared',
    goal: 'second',
    state: 'RUNNING',
    unitCount: 1
  });
  assert.strictEqual(store.getActiveRunByWorkspace('ws-shared')?.runId, 'run-b');
  db.close();
});

test('store: handoff ids are a deduplication key (V13)', () => {
  const db = new RelayDatabase({ dbPath: ':memory:' });
  const store = new RunStore(db);
  store.insertRun({
    runId: 'run-h',
    workspaceKey: 'ws-h',
    workspacePath: 'C:/tmp/ws-h',
    goal: 'handoff dedup',
    state: 'RUNNING',
    unitCount: 1
  });

  const first = store.insertHandoff({
    handoffId: 'h-1',
    runId: 'run-h',
    epoch: 1,
    sourceSessionId: 'session-a',
    state: 'REQUESTED'
  });
  assert.strictEqual(first, true);

  const duplicate = store.insertHandoff({
    handoffId: 'h-1',
    runId: 'run-h',
    epoch: 1,
    sourceSessionId: 'session-a',
    state: 'REQUESTED'
  });
  assert.strictEqual(duplicate, false, 'duplicate handoffId must be rejected, not re-inserted');
  assert.strictEqual(store.getHandoff('h-1')?.state, 'REQUESTED');
  db.close();
});

test('store: intent watermarks are monotonic and unique per run', () => {
  const db = new RelayDatabase({ dbPath: ':memory:' });
  const store = new RunStore(db);
  store.insertRun({
    runId: 'run-w',
    workspaceKey: 'ws-w',
    workspacePath: 'C:/tmp/ws-w',
    goal: 'watermark',
    state: 'RUNNING',
    unitCount: 1
  });

  const a = store.appendIntent('run-w', 'pause_next_node');
  const b = store.appendIntent('run-w', 'stop_now');
  assert.strictEqual(a.watermark, 1);
  assert.strictEqual(b.watermark, 2);
  assert.strictEqual(store.getLatestIntentWatermark('run-w'), 2);
  assert.deepStrictEqual(
    store.listIntents('run-w').map((i) => i.kind),
    ['pause_next_node', 'stop_now']
  );

  // Independent runs have independent watermark sequences
  store.insertRun({
    runId: 'run-w2',
    workspaceKey: 'ws-w2',
    workspacePath: 'C:/tmp/ws-w2',
    goal: 'watermark 2',
    state: 'RUNNING',
    unitCount: 1
  });
  assert.strictEqual(store.appendIntent('run-w2', 'disable').watermark, 1);
  db.close();
});

test('store: WAL makes committed writes visible to a separate process (V22)', () => {
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'relay.db');
  const db = new RelayDatabase({ dbPath });
  const store = new RunStore(db);
  store.insertRun({
    runId: 'run-wal',
    workspaceKey: 'ws-wal',
    workspacePath: dir,
    goal: 'cross process',
    state: 'RUNNING',
    unitCount: 2
  });
  store.appendIntent('run-wal', 'pause_next_node');

  const readerScript = fileURLToPath(new URL('../fixtures/read-intents.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [readerScript, dbPath, 'run-wal'], {
    encoding: 'utf8',
    env: { ...process.env }
  });

  assert.strictEqual(result.status, 0, `reader process failed: ${result.stderr}`);
  assert.match(result.stdout, /watermark=1/, 'a separate process must observe the committed intent');
  assert.match(result.stdout, /kind=pause_next_node/);

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('store: lease table enforces single owner with monotonic epoch CAS', () => {
  const db = new RelayDatabase({ dbPath: ':memory:' });
  const store = new RunStore(db);

  assert.strictEqual(store.tryInsertLease('ws-lease', 'session-a', 1), true);
  assert.strictEqual(store.tryInsertLease('ws-lease', 'session-b', 1), false);

  assert.strictEqual(store.casLeaseRow('ws-lease', 'session-a', 'session-b', 1, 2), true);
  assert.strictEqual(store.getLeaseRow('ws-lease')?.currentOwner, 'session-b');
  assert.strictEqual(store.getLeaseRow('ws-lease')?.epoch, 2);

  // Stale owner / stale epoch / non-monotonic epoch all rejected
  assert.strictEqual(store.casLeaseRow('ws-lease', 'session-a', 'rogue', 1, 3), false);
  assert.strictEqual(store.casLeaseRow('ws-lease', 'session-b', 'rogue', 1, 3), false);
  assert.strictEqual(store.casLeaseRow('ws-lease', 'session-b', 'rogue', 2, 2), false);
  assert.strictEqual(store.getLeaseRow('ws-lease')?.currentOwner, 'session-b');

  assert.strictEqual(store.deleteLease('ws-lease', 'rogue'), false);
  assert.strictEqual(store.deleteLease('ws-lease', 'session-b'), true);
  assert.strictEqual(store.getLeaseRow('ws-lease'), undefined);
  db.close();
});
