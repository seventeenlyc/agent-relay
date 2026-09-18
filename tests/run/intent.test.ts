// tests/run/intent.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { RelayDatabase } from '../../packages/controller/src/run/db.ts';
import { RunStore } from '../../packages/controller/src/run/store.ts';
import { ControlIntentLog } from '../../packages/controller/src/run/intent.ts';

function setup(runId = 'run-intent') {
  const db = new RelayDatabase({ dbPath: ':memory:' });
  const store = new RunStore(db);
  store.insertRun({
    runId,
    workspaceKey: `ws-${runId}`,
    workspacePath: `C:/tmp/${runId}`,
    goal: 'intent test',
    state: 'RUNNING',
    unitCount: 4
  });
  return { db, store, log: new ControlIntentLog(store), runId };
}

test('intent: append assigns strictly increasing watermarks starting at 1', () => {
  const { db, log, runId } = setup();
  assert.strictEqual(log.getWatermark(runId), 0);
  assert.strictEqual(log.append(runId, 'pause_next_node').watermark, 1);
  assert.strictEqual(log.append(runId, 'resume').watermark, 2);
  assert.strictEqual(log.getWatermark(runId), 2);
  db.close();
});

test('intent: resolve picks stop_now ahead of a later-arriving pause', () => {
  const { db, log, runId } = setup();
  log.append(runId, 'pause_next_node');
  log.append(runId, 'stop_now');

  const resolved = log.resolve(runId);
  assert.ok(resolved);
  assert.strictEqual(resolved?.kind, 'stop_now');
  assert.strictEqual(resolved?.watermark, 2);
  db.close();
});

test('intent: resolve prefers the lowest watermark among equal-priority intents', () => {
  const { db, log, runId } = setup();
  const first = log.append(runId, 'stop_now');
  log.append(runId, 'stop_now');

  const resolved = log.resolve(runId);
  assert.strictEqual(resolved?.intentId, first.intentId, 'the earliest stop intent must win');
  db.close();
});

test('intent: priority order is stop_now > disable > pause_next_node > resume', () => {
  const { db, log, runId } = setup();
  log.append(runId, 'resume');
  log.append(runId, 'pause_next_node');
  assert.strictEqual(log.resolve(runId)?.kind, 'pause_next_node');

  log.append(runId, 'disable');
  assert.strictEqual(log.resolve(runId)?.kind, 'disable');

  log.append(runId, 'stop_now');
  assert.strictEqual(log.resolve(runId)?.kind, 'stop_now');
  db.close();
});

test('intent: consume removes an intent from resolution and is idempotent', () => {
  const { db, log, runId } = setup();
  const intent = log.append(runId, 'pause_next_node');
  assert.strictEqual(log.hasPending(runId), true);

  log.consume(intent.intentId);
  assert.strictEqual(log.hasPending(runId), false);
  assert.strictEqual(log.resolve(runId), null);

  // Second consume must not throw or resurrect the intent
  log.consume(intent.intentId);
  assert.strictEqual(log.hasPending(runId), false);
  db.close();
});

test('intent: replaying the same intent list never double-executes (V13)', () => {
  const { db, log, runId } = setup();
  log.append(runId, 'stop_now');

  const firstPass = log.resolve(runId);
  assert.ok(firstPass);
  log.consume(firstPass!.intentId);

  // A rescheduled controller tick reads the same table again
  const secondPass = log.resolve(runId);
  assert.strictEqual(secondPass, null, 'a consumed intent must never be resolved twice');
  db.close();
});

test('intent: a later pause does not resurrect after a stop was consumed', () => {
  const { db, log, runId } = setup();
  const stop = log.append(runId, 'stop_now');
  log.consume(stop.intentId);

  const pause = log.append(runId, 'pause_next_node');
  assert.strictEqual(log.resolve(runId)?.intentId, pause.intentId);
  assert.strictEqual(log.getWatermark(runId), 2, 'watermarks never reset after consumption');
  db.close();
});
