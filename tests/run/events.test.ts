// tests/run/events.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { RelayDatabase } from '../../packages/controller/src/run/db.ts';
import { RunStore } from '../../packages/controller/src/run/store.ts';
import { RunEventLog, classifySeverity, describeEvent } from '../../packages/controller/src/run/events.ts';
import { RecordingNotifier } from '../../packages/controller/src/run/notifier.ts';
import type { RunNotification } from '../../packages/controller/src/run/notifier.ts';

function setup(runId = 'run-events') {
  const db = new RelayDatabase({ dbPath: ':memory:' });
  const store = new RunStore(db);
  store.insertRun({
    runId,
    workspaceKey: `ws-${runId}`,
    workspacePath: `C:/tmp/${runId}`,
    goal: 'events test',
    state: 'RUNNING',
    unitCount: 4
  });
  const notifier = new RecordingNotifier();
  return { db, store, notifier, log: new RunEventLog(store, notifier), runId };
}

test('events: every notify-type event classifies as notify', () => {
  // 单一列表驱动全部断言：删掉其中任何一项都会让对应断言失败，
  // 因此从 NOTIFY_TYPES 白名单里移除任何类型都无法悄悄通过。
  const notifyTypes = [
    'run_completed',
    'unit_failed',
    'run_blocked',
    'recovery_required',
    'user_action_required'
  ];
  assert.strictEqual(notifyTypes.length, 5, 'the notify whitelist must be pinned wholesale, not sampled');

  for (const type of notifyTypes) {
    assert.strictEqual(classifySeverity(type), 'notify', `${type} must interrupt the user`);
  }
});

test('events: normal rotation types classify as record', () => {
  const rotationTypes = ['handoff_requested', 'session_created', 'unit_completed', 'unit_started', 'run_started'];
  for (const type of rotationTypes) {
    assert.strictEqual(classifySeverity(type), 'record', `${type} must stay silent`);
  }
});

test('events: record notifies exactly once for a notify type and persists the notify severity', () => {
  const { db, notifier, log, runId } = setup();
  const event = log.record({
    runId,
    type: 'unit_failed',
    sessionId: 'worker-A',
    payload: { taskId: 'u-3', status: 'error', summary: 'boom' }
  });

  assert.strictEqual(notifier.notifications.length, 1);
  const notification = notifier.notifications[0];
  assert.strictEqual(notification.runId, runId);
  assert.strictEqual(notification.type, 'unit_failed');
  assert.strictEqual(notification.severity, 'notify');
  assert.ok(notification.message.length > 0, 'a notify event must carry a message');
  assert.match(notification.message, /u-3/);
  assert.strictEqual(event.severity, 'notify');

  const persisted = log.list(runId);
  assert.strictEqual(persisted.length, 1);
  assert.strictEqual(persisted[0].severity, 'notify');
  assert.strictEqual(persisted[0].sessionId, 'worker-A');
  db.close();
});

test('events: record stays silent for a record type (连续三次交接没有确认弹窗)', () => {
  const { db, notifier, log, runId } = setup();
  const event = log.record({ runId, type: 'handoff_requested', payload: { epoch: 2 } });

  assert.strictEqual(notifier.notifications.length, 0, 'a normal handoff must never interrupt the user');
  assert.strictEqual(event.severity, 'record');
  assert.strictEqual(log.list(runId)[0].severity, 'record');
  db.close();
});

test('events: an explicit severity override wins over classification', () => {
  const { db, notifier, log, runId } = setup();
  log.record({
    runId,
    type: 'run_completed',
    severity: 'record',
    payload: { completedUnits: 4, totalUnits: 4 }
  });
  assert.strictEqual(notifier.notifications.length, 0, 'a downgraded notify type must stay silent');

  log.record({ runId, type: 'handoff_requested', severity: 'notify', payload: { reason: 'forced' } });
  assert.strictEqual(notifier.notifications.length, 1);
  assert.strictEqual(notifier.notifications[0].severity, 'notify');

  assert.deepStrictEqual(
    log.list(runId).map((e) => e.severity),
    ['record', 'notify']
  );
  db.close();
});

test('events: stored payload carries the authoritative runId merged with the caller payload', () => {
  const { db, log, runId } = setup();
  log.record({ runId, type: 'unit_completed', payload: { taskId: 'u-1', durationMs: 42 } });

  const [event] = log.list(runId);
  assert.strictEqual(event.payload.runId, runId);
  assert.strictEqual(event.payload.taskId, 'u-1');
  assert.strictEqual(event.payload.durationMs, 42);
  db.close();
});

test('events: RecordingNotifier copies defensively, filters by type and clears', () => {
  const notifier = new RecordingNotifier();
  const original: RunNotification = {
    runId: 'run-events',
    type: 'run_blocked',
    severity: 'notify',
    message: 'run blocked: cap reached',
    payload: { reason: 'cap reached' }
  };

  notifier.notify(original);
  notifier.notify({
    runId: 'run-events',
    type: 'unit_failed',
    severity: 'notify',
    message: 'unit u-9 failed',
    payload: { taskId: 'u-9' }
  });

  // 事后修改原始对象不得改变已捕获的副本
  original.payload.reason = 'mutated after capture';
  assert.strictEqual(notifier.notifications[0].payload.reason, 'cap reached');

  assert.strictEqual(notifier.ofType('run_blocked').length, 1);
  assert.strictEqual(notifier.ofType('unit_failed').length, 1);
  assert.strictEqual(notifier.ofType('run_completed').length, 0);

  notifier.clear();
  assert.strictEqual(notifier.notifications.length, 0);
});

test('events: describeEvent names the run and falls back to the bare type', () => {
  const message = describeEvent('run_completed', { runId: 'run-events', completedUnits: 3, totalUnits: 4 });
  assert.match(message, /run-events/);
  assert.match(message, /3\/4/);

  assert.strictEqual(describeEvent('mystery_event', { runId: 'run-events' }), 'mystery_event');
});
