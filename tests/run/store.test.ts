// tests/run/store.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { InputRecord } from '../../packages/protocol/src/types.ts';
import type { AgentRelayEvent } from '../../packages/protocol/src/events.ts';
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
  try {
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

    // 三进程拓扑（CLI / supervisor / 投影）完全依赖 WAL，必须显式断言而不是假定
    const journal = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string } | undefined;
    assert.strictEqual(journal?.journal_mode, 'wal');

    const readerScript = fileURLToPath(new URL('../fixtures/read-intents.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [readerScript, dbPath, 'run-wal'], {
      encoding: 'utf8',
      env: { ...process.env }
    });

    assert.strictEqual(result.status, 0, `reader process failed: ${result.stderr}`);
    assert.match(result.stdout, /watermark=1/, 'a separate process must observe the committed intent');
    assert.match(result.stdout, /kind=pause_next_node/);
  } finally {
    // Windows 上未关闭的 SQLite 句柄会阻止目录删除
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
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

test('store: a failed COMMIT does not poison the connection depth', () => {
  const db = new RelayDatabase({ dbPath: ':memory:' });
  const store = new RunStore(db);
  db.exec('CREATE TABLE fk_parent (id INTEGER PRIMARY KEY)');
  db.exec(
    `CREATE TABLE fk_child (
       id        INTEGER PRIMARY KEY,
       parent_id INTEGER REFERENCES fk_parent(id) DEFERRABLE INITIALLY DEFERRED
     )`
  );
  store.insertRun({
    runId: 'run-commit-fail',
    workspaceKey: 'ws-commit-fail',
    workspacePath: 'C:/tmp/ws-commit-fail',
    goal: 'commit failure',
    state: 'RUNNING',
    unitCount: 1
  });

  // 延迟外键违约只在 COMMIT 时暴露：COMMIT 本身失败（SQLITE_BUSY/IOERR/FULL 的真实同类）
  assert.throws(() => {
    store.transaction(() => {
      db.exec('INSERT INTO fk_child (id, parent_id) VALUES (1, 404)');
    });
  }, /FOREIGN KEY|constraint/i);

  // depth 必须恰好回到 0，后续事务（含嵌套 savepoint）仍要能用
  const intent = store.transaction(() => {
    store.updateRunState('run-commit-fail', 'DRAINING');
    return store.transaction(() => store.appendIntent('run-commit-fail', 'stop_now'));
  });
  assert.strictEqual(intent.watermark, 1);
  assert.strictEqual(store.getRun('run-commit-fail')?.state, 'DRAINING');
  assert.deepStrictEqual(
    store.listIntents('run-commit-fail').map((i) => i.kind),
    ['stop_now']
  );
  db.close();
});

test('store: input ledger round-trips every field verbatim', () => {
  const db = new RelayDatabase({ dbPath: ':memory:' });
  const store = new RunStore(db);
  store.insertRun({
    runId: 'run-in',
    workspaceKey: 'ws-in',
    workspacePath: 'C:/tmp/ws-in',
    goal: 'inputs',
    state: 'RUNNING',
    unitCount: 1
  });

  const first: InputRecord = {
    inputId: 'in-1',
    source: 'human',
    timestamp: 1700000000000,
    rawContent: '第一条原话，不得改写',
    sha256Hash: 'sha-1',
    // listInputs 恒定输出这两个键（无值时为 undefined），显式写出以便做全量结构比对
    supersedesId: undefined,
    metadata: undefined
  };
  const second: InputRecord = {
    inputId: 'in-2',
    source: 'generated_handoff',
    timestamp: 1700000001000,
    rawContent: 'second raw content',
    sha256Hash: 'sha-2',
    supersedesId: 'in-1',
    metadata: { channel: 'cli', nested: { round: 2 }, tags: ['a', 'b'] }
  };

  const seqOne = store.nextInputSeq('run-in');
  store.appendInputRow('run-in', seqOne, first);
  const seqTwo = store.nextInputSeq('run-in');
  store.appendInputRow('run-in', seqTwo, second);

  assert.strictEqual(seqOne, 1);
  assert.strictEqual(seqTwo, 2);
  const rows = store.listInputs('run-in');
  assert.strictEqual(rows.length, 2);
  assert.deepStrictEqual(rows, [
    { seq: 1, record: first },
    { seq: 2, record: second }
  ]);
  assert.deepStrictEqual(rows[1].record.metadata, { channel: 'cli', nested: { round: 2 }, tags: ['a', 'b'] });
  assert.strictEqual(rows[1].record.supersedesId, 'in-1');
  assert.strictEqual(rows[0].record.supersedesId, undefined);
  assert.strictEqual(rows[0].record.rawContent, '第一条原话，不得改写');
  assert.strictEqual(rows[1].record.source, 'generated_handoff');
  db.close();
});

test('store: task snapshots round-trip and the latest wins', () => {
  const db = new RelayDatabase({ dbPath: ':memory:' });
  const store = new RunStore(db);

  const firstJson = '{"tasks":[{"taskId":"t1"}]}';
  const secondJson = '{"tasks":[{"taskId":"t1"},{"taskId":"t2"}]}';
  store.appendTaskSnapshot('run-snap', store.nextTaskSnapshotSeq('run-snap'), firstJson, 'hash-alpha');
  store.appendTaskSnapshot('run-snap', store.nextTaskSnapshotSeq('run-snap'), secondJson, 'hash-beta');

  const latest = store.getLatestTaskSnapshot('run-snap');
  assert.ok(latest);
  assert.strictEqual(latest?.runId, 'run-snap');
  assert.strictEqual(latest?.seq, 2);
  assert.strictEqual(latest?.snapshotJson, secondJson);
  assert.strictEqual(latest?.snapshotHash, 'hash-beta');
  assert.ok((latest?.createdAt ?? 0) > 0);
  db.close();
});

test('store: updateRunState bumps updatedAt monotonically', () => {
  const db = new RelayDatabase({ dbPath: ':memory:' });
  let clock = 1_000;
  const store = new RunStore(db, () => clock);
  store.insertRun({
    runId: 'run-clock',
    workspaceKey: 'ws-clock',
    workspacePath: 'C:/tmp/ws-clock',
    goal: 'clock',
    state: 'INITIALIZING',
    unitCount: 1
  });

  const created = store.getRun('run-clock');
  assert.strictEqual(created?.createdAt, 1_000);
  assert.strictEqual(created?.updatedAt, 1_000);

  clock = 1_500;
  store.updateRunState('run-clock', 'RUNNING');
  const running = store.getRun('run-clock');
  assert.ok(typeof running?.updatedAt === 'number' && running.updatedAt > 0);
  assert.strictEqual(running?.updatedAt, 1_500);
  assert.ok((running?.updatedAt ?? 0) > (created?.updatedAt ?? 0), 'updatedAt must strictly increase');

  clock = 2_000;
  store.updateRunState('run-clock', 'DRAINING');
  assert.strictEqual(store.getRun('run-clock')?.updatedAt, 2_000);
  db.close();
});

test('store: BLOCKED runs still occupy the workspace key', () => {
  const db = new RelayDatabase({ dbPath: ':memory:' });
  const store = new RunStore(db);
  store.insertRun({
    runId: 'run-blocked',
    workspaceKey: 'ws-blocked',
    workspacePath: 'C:/tmp/ws-blocked',
    goal: 'blocked',
    state: 'BLOCKED',
    unitCount: 1
  });

  // BLOCKED 不是终态：仍占用工作区键，直到用户取消或禁用
  assert.strictEqual(store.getActiveRunByWorkspace('ws-blocked')?.runId, 'run-blocked');
  assert.strictEqual(store.getActiveRunByWorkspace('ws-blocked')?.state, 'BLOCKED');

  assert.throws(() => {
    store.insertRun({
      runId: 'run-blocked-2',
      workspaceKey: 'ws-blocked',
      workspacePath: 'C:/tmp/ws-blocked',
      goal: 'second',
      state: 'RUNNING',
      unitCount: 1
    });
  }, /UNIQUE|constraint/i);
  db.close();
});

test('store: run events round-trip payload objects in id order', () => {
  const db = new RelayDatabase({ dbPath: ':memory:' });
  const store = new RunStore(db);

  const first = store.insertEvent({
    runId: 'run-ev',
    type: 'session:start',
    severity: 'record',
    sessionId: 'session-a',
    payload: { epoch: 1, nested: { attempt: 1 } }
  });
  const second = store.insertEvent({
    runId: 'run-ev',
    type: 'unit:completed',
    severity: 'notify',
    payload: { unitId: 'u-1' }
  });

  assert.ok(Number.isInteger(first.eventId) && first.eventId > 0);
  assert.ok(second.eventId > first.eventId, 'eventId must be assigned in insertion order');

  const events = store.listEvents('run-ev');
  assert.strictEqual(events.length, 2);
  assert.deepStrictEqual(events.map((e) => e.eventId), [first.eventId, second.eventId]);
  assert.deepStrictEqual(events[0].payload, { epoch: 1, nested: { attempt: 1 } });
  assert.strictEqual(events[0].type, 'session:start');
  assert.strictEqual(events[0].severity, 'record');
  assert.strictEqual(events[0].sessionId, 'session-a');
  assert.strictEqual(events[1].sessionId, undefined);
  assert.deepStrictEqual(events[1].payload, { unitId: 'u-1' });

  const after = store.listEvents('run-ev', first.eventId);
  assert.deepStrictEqual(after.map((e) => e.eventId), [second.eventId]);
  db.close();
});

test('store: ledger events round-trip every field', () => {
  const db = new RelayDatabase({ dbPath: ':memory:' });
  const store = new RunStore(db);

  const first: AgentRelayEvent = {
    eventId: 'evt-1',
    type: 'handoff:ack',
    runId: 'run-ledger',
    sessionId: 'session-ledger',
    timestamp: 1700000005000,
    payload: { handoffId: 'h-1', nested: { depth: 2 } }
  };
  const second: AgentRelayEvent = {
    eventId: 'evt-2',
    type: 'unit:completed',
    runId: 'run-ledger',
    sessionId: 'session-ledger',
    timestamp: 1700000006000,
    payload: { unitId: 'u-9' }
  };

  store.appendLedgerEvent('run-ledger', store.nextLedgerEventSeq('run-ledger'), first);
  store.appendLedgerEvent('run-ledger', store.nextLedgerEventSeq('run-ledger'), second);

  assert.deepStrictEqual(store.listLedgerEvents('run-ledger'), [first, second]);
  db.close();
});

test('store: markIntentConsumed removes intents from the pending list', () => {
  const db = new RelayDatabase({ dbPath: ':memory:' });
  let clock = 5_000;
  const store = new RunStore(db, () => clock);
  store.insertRun({
    runId: 'run-consume',
    workspaceKey: 'ws-consume',
    workspacePath: 'C:/tmp/ws-consume',
    goal: 'consume',
    state: 'RUNNING',
    unitCount: 1
  });

  const first = store.appendIntent('run-consume', 'pause_next_node');
  store.appendIntent('run-consume', 'stop_now');
  assert.deepStrictEqual(store.listPendingIntents('run-consume').map((i) => i.watermark), [1, 2]);
  assert.strictEqual(store.listPendingIntents('run-consume')[0].consumedAt, undefined);

  clock = 6_000;
  store.markIntentConsumed(first.intentId);
  assert.deepStrictEqual(store.listPendingIntents('run-consume').map((i) => i.watermark), [2]);
  assert.strictEqual(store.listIntents('run-consume')[0].consumedAt, 6_000);

  // 重复消费不得覆盖首次消费时间
  clock = 7_000;
  store.markIntentConsumed(first.intentId);
  assert.strictEqual(store.listIntents('run-consume')[0].consumedAt, 6_000);
  db.close();
});
