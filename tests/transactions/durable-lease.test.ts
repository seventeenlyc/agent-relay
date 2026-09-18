// tests/transactions/durable-lease.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RelayDatabase } from '../../packages/controller/src/run/db.ts';
import { RunStore } from '../../packages/controller/src/run/store.ts';
import { DurableLeaseManager } from '../../packages/controller/src/handoff/durable-lease.ts';

function makeManager() {
  const db = new RelayDatabase({ dbPath: ':memory:' });
  const store = new RunStore(db);
  return { db, store, lease: new DurableLeaseManager(store) };
}

test('durable-lease: acquireInitialLease refuses a second owner for the same workspace', () => {
  const { db, lease } = makeManager();
  assert.strictEqual(lease.acquireInitialLease('ws-1', 'owner-1', 1), true);
  assert.strictEqual(lease.acquireInitialLease('ws-1', 'owner-2', 1), false);
  assert.strictEqual(lease.getLease('ws-1')?.currentOwner, 'owner-1');
  db.close();
});

test('durable-lease: CAS enforces owner, epoch and monotonicity (R10, V34)', () => {
  const { db, lease } = makeManager();
  lease.acquireInitialLease('ws-1', 'session-a', 1);

  assert.strictEqual(lease.compareAndSetOwner('ws-1', 'session-a', 'session-b', 1, 2), true);
  assert.strictEqual(lease.getLease('ws-1')?.currentOwner, 'session-b');
  assert.strictEqual(lease.getLease('ws-1')?.epoch, 2);

  assert.strictEqual(lease.compareAndSetOwner('ws-1', 'session-a', 'rogue', 1, 3), false, 'stale owner rejected');
  assert.strictEqual(lease.compareAndSetOwner('ws-1', 'session-b', 'rogue', 1, 3), false, 'stale epoch rejected');
  assert.strictEqual(lease.compareAndSetOwner('ws-1', 'session-b', 'rogue', 2, 2), false, 'epoch must increase');
  assert.strictEqual(lease.getLease('ws-1')?.currentOwner, 'session-b');
  db.close();
});

test('durable-lease: compareAndSetOwner returns false for an unknown workspace', () => {
  const { db, lease } = makeManager();
  assert.strictEqual(lease.compareAndSetOwner('missing', 'a', 'b', 1, 2), false);
  db.close();
});

test('durable-lease: getLease returns a defensive copy', () => {
  const { db, lease } = makeManager();
  lease.acquireInitialLease('ws-1', 'owner-1', 1);
  const snapshot = lease.getLease('ws-1');
  assert.ok(snapshot);
  snapshot!.currentOwner = 'mutated';
  assert.strictEqual(lease.getLease('ws-1')?.currentOwner, 'owner-1');
  db.close();
});

test('durable-lease: releaseLease requires the correct owner', () => {
  const { db, lease } = makeManager();
  lease.acquireInitialLease('ws-1', 'owner-1', 1);
  assert.strictEqual(lease.releaseLease('ws-1', 'wrong-owner'), false);
  assert.strictEqual(lease.releaseLease('ws-1', 'owner-1'), true);
  assert.strictEqual(lease.getLease('ws-1'), undefined);
  db.close();
});

test('durable-lease: independent workspaces operate in isolation (V31)', () => {
  const { db, lease } = makeManager();
  lease.acquireInitialLease('ws-a', 'owner-a', 1);
  lease.acquireInitialLease('ws-b', 'owner-b', 1);

  assert.strictEqual(lease.compareAndSetOwner('ws-a', 'owner-a', 'owner-a2', 1, 2), true);
  assert.strictEqual(lease.getLease('ws-b')?.currentOwner, 'owner-b');
  assert.strictEqual(lease.getLease('ws-b')?.epoch, 1);
  db.close();
});

test('durable-lease: ownership survives a controller restart (V21)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-relay-lease-'));
  const dbPath = path.join(dir, 'relay.db');

  const db1 = new RelayDatabase({ dbPath });
  const lease1 = new DurableLeaseManager(new RunStore(db1));
  lease1.acquireInitialLease('ws-persist', 'session-a', 1);
  lease1.compareAndSetOwner('ws-persist', 'session-a', 'session-b', 1, 2);
  db1.close();

  // Simulate a fresh controller process opening the same database
  const db2 = new RelayDatabase({ dbPath });
  const lease2 = new DurableLeaseManager(new RunStore(db2));
  assert.strictEqual(lease2.getLease('ws-persist')?.currentOwner, 'session-b');
  assert.strictEqual(lease2.getLease('ws-persist')?.epoch, 2);
  assert.strictEqual(
    lease2.compareAndSetOwner('ws-persist', 'session-a', 'rogue', 1, 3),
    false,
    'a restarted controller must still reject the superseded owner'
  );
  db2.close();

  fs.rmSync(dir, { recursive: true, force: true });
});
