// tests/run/outbox-store.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { RelayDatabase } from '../../packages/controller/src/run/db.ts';
import { RunStore } from '../../packages/controller/src/run/store.ts';
import type { OutboxRow, EnqueueOutboxInput } from '../../packages/controller/src/run/store.ts';

test('outbox: enqueueOutbox inserts a PENDING message and returns it', () => {
  const db = new RelayDatabase({ dbPath: ':memory:' });
  let clock = 1_000;
  const store = new RunStore(db, () => clock);

  const input: EnqueueOutboxInput = {
    runId: 'run-ob-1',
    topic: 'handoff:request',
    handoffId: 'h-1',
    targetSessionId: 'session-target',
    payload: { key: 'value', nested: { depth: 1 } }
  };

  const row = store.enqueueOutbox(input);

  assert.ok(typeof row.msgId === 'string' && row.msgId.length > 0, 'msgId must be auto-generated');
  assert.strictEqual(row.runId, 'run-ob-1');
  assert.strictEqual(row.handoffId, 'h-1');
  assert.strictEqual(row.topic, 'handoff:request');
  assert.strictEqual(row.targetSessionId, 'session-target');
  assert.strictEqual(row.state, 'PENDING');
  assert.strictEqual(row.attempts, 0);
  assert.strictEqual(row.lastError, null);
  assert.strictEqual(row.createdAt, 1_000);
  assert.strictEqual(row.updatedAt, 1_000);
  assert.deepStrictEqual(JSON.parse(row.payload), { key: 'value', nested: { depth: 1 } });
  db.close();
});

test('outbox: enqueueOutbox uses caller-supplied msgId when provided', () => {
  const db = new RelayDatabase({ dbPath: ':memory:' });
  const store = new RunStore(db);

  const row = store.enqueueOutbox({
    msgId: 'custom-id-42',
    runId: 'run-ob-2',
    topic: 'session:spawn'
  });

  assert.strictEqual(row.msgId, 'custom-id-42');
  assert.strictEqual(row.payload, '{}');
  assert.strictEqual(row.handoffId, null);
  assert.strictEqual(row.targetSessionId, null);
  db.close();
});

test('outbox: getOutbox retrieves a message by primary key', () => {
  const db = new RelayDatabase({ dbPath: ':memory:' });
  const store = new RunStore(db);

  const inserted = store.enqueueOutbox({
    msgId: 'msg-get-1',
    runId: 'run-ob-3',
    topic: 'handoff:ack',
    payload: { info: 'round-trip' }
  });

  const fetched = store.getOutbox('msg-get-1');
  assert.ok(fetched);
  assert.deepStrictEqual(fetched, inserted);

  assert.strictEqual(store.getOutbox('nonexistent'), undefined);
  db.close();
});

test('outbox: updateOutboxState changes state and updatedAt', () => {
  const db = new RelayDatabase({ dbPath: ':memory:' });
  let clock = 2_000;
  const store = new RunStore(db, () => clock);

  store.enqueueOutbox({
    msgId: 'msg-upd-1',
    runId: 'run-ob-4',
    topic: 'session:spawn'
  });

  clock = 3_000;
  store.updateOutboxState('msg-upd-1', 'DISPATCHED');
  const dispatched = store.getOutbox('msg-upd-1')!;
  assert.strictEqual(dispatched.state, 'DISPATCHED');
  assert.strictEqual(dispatched.updatedAt, 3_000);
  assert.strictEqual(dispatched.attempts, 0, 'attempts unchanged without incrementAttempts');
  assert.strictEqual(dispatched.lastError, null);

  clock = 4_000;
  store.updateOutboxState('msg-upd-1', 'FAILED', {
    incrementAttempts: true,
    lastError: 'connection refused'
  });
  const failed = store.getOutbox('msg-upd-1')!;
  assert.strictEqual(failed.state, 'FAILED');
  assert.strictEqual(failed.attempts, 1);
  assert.strictEqual(failed.lastError, 'connection refused');
  assert.strictEqual(failed.updatedAt, 4_000);

  clock = 5_000;
  store.updateOutboxState('msg-upd-1', 'DISPATCHED', { incrementAttempts: true });
  const retried = store.getOutbox('msg-upd-1')!;
  assert.strictEqual(retried.attempts, 2);
  assert.strictEqual(retried.lastError, 'connection refused', 'lastError preserved when not explicitly set');
  db.close();
});

test('outbox: findOutboxByHandoff returns the latest message for a handoff+topic pair', () => {
  const db = new RelayDatabase({ dbPath: ':memory:' });
  let clock = 10_000;
  const store = new RunStore(db, () => clock);

  clock = 10_000;
  store.enqueueOutbox({
    msgId: 'msg-hf-old',
    runId: 'run-ob-5',
    handoffId: 'hf-dedup',
    topic: 'handoff:request'
  });

  clock = 11_000;
  store.enqueueOutbox({
    msgId: 'msg-hf-new',
    runId: 'run-ob-5',
    handoffId: 'hf-dedup',
    topic: 'handoff:request'
  });

  // Same handoff, different topic -- should not match
  clock = 12_000;
  store.enqueueOutbox({
    msgId: 'msg-hf-other-topic',
    runId: 'run-ob-5',
    handoffId: 'hf-dedup',
    topic: 'handoff:ack'
  });

  const found = store.findOutboxByHandoff('hf-dedup', 'handoff:request');
  assert.ok(found);
  assert.strictEqual(found!.msgId, 'msg-hf-new', 'must return the newest message for the handoff+topic');

  assert.strictEqual(store.findOutboxByHandoff('nonexistent-hf', 'handoff:request'), undefined);
  db.close();
});

test('outbox: listPendingOutbox returns PENDING and DISPATCHED messages sorted by created_at ASC', () => {
  const db = new RelayDatabase({ dbPath: ':memory:' });
  let clock = 20_000;
  const store = new RunStore(db, () => clock);

  clock = 20_000;
  store.enqueueOutbox({ msgId: 'msg-p1', runId: 'run-ob-6', topic: 'a' });

  clock = 21_000;
  store.enqueueOutbox({ msgId: 'msg-p2', runId: 'run-ob-6', topic: 'b' });

  clock = 22_000;
  store.enqueueOutbox({ msgId: 'msg-p3', runId: 'run-ob-6', topic: 'c' });

  // Mark msg-p2 as DISPATCHED -- still should appear in pending list
  clock = 23_000;
  store.updateOutboxState('msg-p2', 'DISPATCHED');

  // Mark msg-p3 as ACKED -- should NOT appear in pending list
  clock = 24_000;
  store.updateOutboxState('msg-p3', 'ACKED');

  // Message for a different run -- should NOT appear
  clock = 25_000;
  store.enqueueOutbox({ msgId: 'msg-other', runId: 'run-ob-OTHER', topic: 'd' });

  const pending = store.listPendingOutbox('run-ob-6');
  assert.strictEqual(pending.length, 2);
  assert.deepStrictEqual(
    pending.map((r) => r.msgId),
    ['msg-p1', 'msg-p2'],
    'PENDING and DISPATCHED in created_at ASC order'
  );
  assert.strictEqual(pending[0].state, 'PENDING');
  assert.strictEqual(pending[1].state, 'DISPATCHED');
  db.close();
});

test('outbox: FAILED messages are excluded from listPendingOutbox', () => {
  const db = new RelayDatabase({ dbPath: ':memory:' });
  let clock = 30_000;
  const store = new RunStore(db, () => clock);

  clock = 30_000;
  store.enqueueOutbox({ msgId: 'msg-f1', runId: 'run-ob-7', topic: 'x' });

  clock = 31_000;
  store.updateOutboxState('msg-f1', 'FAILED', { lastError: 'timeout' });

  const pending = store.listPendingOutbox('run-ob-7');
  assert.strictEqual(pending.length, 0);
  db.close();
});

test('outbox: run_outbox table survives idempotent migration', () => {
  const db = new RelayDatabase({ dbPath: ':memory:' });
  const store = new RunStore(db);
  store.enqueueOutbox({ msgId: 'msg-mig', runId: 'run-mig', topic: 'mig' });

  // Re-run migration -- must not drop the table
  db.migrate();

  const row = store.getOutbox('msg-mig');
  assert.ok(row);
  assert.strictEqual(row!.msgId, 'msg-mig');
  db.close();
});
