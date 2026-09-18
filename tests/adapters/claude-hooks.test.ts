// tests/adapters/claude-hooks.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { HookDeduplicator, ClaudeHookHandler } from '../../packages/adapters/claude/src/hooks.ts';
import type { SystemHookEvent } from '../../packages/adapters/claude/src/types.ts';

test('hooks: deduplicator rejects identical hook events and evicts beyond window size', () => {
  const dedup = new HookDeduplicator(5); // small window for testing
  assert.strictEqual(dedup.shouldProcess('sess-1', 'Stop', 'hook-id-1'), true);
  // Duplicate within window
  assert.strictEqual(dedup.shouldProcess('sess-1', 'Stop', 'hook-id-1'), false);

  // Different hook id
  assert.strictEqual(dedup.shouldProcess('sess-1', 'Stop', 'hook-id-2'), true);

  // Eviction test
  for (let i = 3; i <= 10; i++) {
    dedup.shouldProcess('sess-1', 'Stop', `hook-id-${i}`);
  }
  // hook-id-1 should be evicted and thus processable again
  assert.strictEqual(dedup.shouldProcess('sess-1', 'Stop', 'hook-id-1'), true);
});

test('hooks: handler dispatches mapped events and prevents Stop hook infinite loop', () => {
  const handler = new ClaudeHookHandler();
  let stopTriggerCount = 0;
  handler.onHandoffTrigger(() => {
    stopTriggerCount++;
  });

  const stopEvent1: SystemHookEvent = {
    type: 'system',
    subtype: 'hook_response',
    session_id: 'sess-1',
    hook_id: 'stop-evt-1',
    hook_name: 'Stop:supervisor',
    hook_event: 'Stop',
    outcome: 'success'
  };

  handler.processEvent(stopEvent1);
  assert.strictEqual(stopTriggerCount, 1);

  // Re-entrancy of same Stop hook
  handler.processEvent(stopEvent1);
  assert.strictEqual(stopTriggerCount, 1); // Deduplicated!

  // Different session Stop hook
  const stopEvent2: SystemHookEvent = {
    type: 'system',
    subtype: 'hook_response',
    session_id: 'sess-2',
    hook_id: 'stop-evt-2',
    hook_name: 'Stop:supervisor',
    hook_event: 'Stop',
    outcome: 'success'
  };
  handler.processEvent(stopEvent2);
  assert.strictEqual(stopTriggerCount, 2);
});

test('hooks: handler dispatches PreCompact hook event with reason hook_pre_compact', () => {
  const handler = new ClaudeHookHandler();
  const triggers: Array<{ sessionId: string; reason: string }> = [];
  handler.onHandoffTrigger((sessionId, reason) => {
    triggers.push({ sessionId, reason });
  });

  const preCompactEvent: SystemHookEvent = {
    type: 'system',
    subtype: 'hook_response',
    session_id: 'sess-compact-1',
    hook_id: 'compact-evt-1',
    hook_name: 'PreCompact:snapshot',
    hook_event: 'PreCompact',
    outcome: 'success'
  };

  const processed = handler.processEvent(preCompactEvent);
  assert.strictEqual(processed, true);
  assert.strictEqual(triggers.length, 1);
  assert.deepStrictEqual(triggers[0], {
    sessionId: 'sess-compact-1',
    reason: 'hook_pre_compact'
  });

  // Duplicate PreCompact event is deduplicated
  const processedAgain = handler.processEvent(preCompactEvent);
  assert.strictEqual(processedAgain, false);
  assert.strictEqual(triggers.length, 1);
});

test('hooks: handler ignores non-system or non-hook events', () => {
  const handler = new ClaudeHookHandler();
  let triggerCount = 0;
  handler.onHandoffTrigger(() => {
    triggerCount++;
  });

  // Non-system event
  assert.strictEqual(handler.processEvent({ type: 'assistant', session_id: 'sess-1' } as any), false);

  // System init event (not hook)
  assert.strictEqual(handler.processEvent({ type: 'system', subtype: 'init', session_id: 'sess-1' } as any), false);

  // hook_started subtype (not hook_response)
  const hookStartedEvent: SystemHookEvent = {
    type: 'system',
    subtype: 'hook_started',
    session_id: 'sess-1',
    hook_id: 'stop-evt-start',
    hook_name: 'Stop:supervisor',
    hook_event: 'Stop'
  };
  assert.strictEqual(handler.processEvent(hookStartedEvent), false);
  assert.strictEqual(triggerCount, 0);
});

test('hooks: deduplicator clear resets tracked hashes', () => {
  const dedup = new HookDeduplicator(10);
  assert.strictEqual(dedup.shouldProcess('sess-1', 'Stop', 'hook-1'), true);
  assert.strictEqual(dedup.shouldProcess('sess-1', 'Stop', 'hook-1'), false);

  dedup.clear();
  assert.strictEqual(dedup.shouldProcess('sess-1', 'Stop', 'hook-1'), true);
});
