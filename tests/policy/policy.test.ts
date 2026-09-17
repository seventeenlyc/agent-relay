import test from 'node:test';
import assert from 'node:assert/strict';
import { TriggerPolicy } from '../../packages/controller/src/policy/trigger.ts';
import { GlobalBudget } from '../../packages/controller/src/policy/budget.ts';
import { LoopDetector } from '../../packages/controller/src/policy/loop-detector.ts';
import {
  TriggerPolicy as ExportedTriggerPolicy,
  GlobalBudget as ExportedGlobalBudget,
  LoopDetector as ExportedLoopDetector,
} from '../../packages/controller/src/index.ts';

test('policy: unit completed triggers handoff if next unit exists (R2)', () => {
  const policy = new TriggerPolicy();
  const res = policy.evaluate({
    unitCompleted: true,
    hasMoreUnits: true,
    compactionCount: 0,
    activeDurationMs: 5000,
  });
  assert.strictEqual(res.shouldHandoff, true);
  assert.strictEqual(res.reason, 'unit_completed');
});

test('policy: deduplicates compaction events and triggers on second compaction (V08)', () => {
  const policy = new TriggerPolicy();
  // Duplicate compaction event
  assert.strictEqual(policy.recordCompaction('compaction-event-1'), 1);
  assert.strictEqual(policy.recordCompaction('compaction-event-1'), 1); // Deduplicated!
  assert.strictEqual(policy.getCompactionCount(), 1);

  assert.strictEqual(policy.recordCompaction('compaction-event-2'), 2);
  assert.strictEqual(policy.getCompactionCount(), 2);

  const res = policy.evaluate({
    unitCompleted: false,
    hasMoreUnits: true,
    compactionCount: 2,
    activeDurationMs: 1000,
  });
  assert.strictEqual(res.shouldHandoff, true);
  assert.strictEqual(res.reason, 'compaction_threshold');
});

test('policy: triggers on duration cap and respects custom duration limit', () => {
  const defaultPolicy = new TriggerPolicy();
  // 45 minutes default
  const resBelow = defaultPolicy.evaluate({
    unitCompleted: false,
    hasMoreUnits: true,
    compactionCount: 1,
    activeDurationMs: 44 * 60 * 1000,
  });
  assert.strictEqual(resBelow.shouldHandoff, false);
  assert.strictEqual(resBelow.reason, 'none');

  const resAtLimit = defaultPolicy.evaluate({
    unitCompleted: false,
    hasMoreUnits: true,
    compactionCount: 1,
    activeDurationMs: 45 * 60 * 1000,
  });
  assert.strictEqual(resAtLimit.shouldHandoff, true);
  assert.strictEqual(resAtLimit.reason, 'duration_cap');

  // Custom limit in evaluate options overrides default
  const resCustom = defaultPolicy.evaluate({
    unitCompleted: false,
    hasMoreUnits: true,
    compactionCount: 0,
    activeDurationMs: 10000,
    maxActiveDurationMs: 10000,
  });
  assert.strictEqual(resCustom.shouldHandoff, true);
  assert.strictEqual(resCustom.reason, 'duration_cap');

  // Custom limit in constructor
  const customPolicy = new TriggerPolicy({ maxActiveDurationMs: 20000 });
  const resCustomConstructed = customPolicy.evaluate({
    unitCompleted: false,
    hasMoreUnits: true,
    compactionCount: 0,
    activeDurationMs: 20000,
  });
  assert.strictEqual(resCustomConstructed.shouldHandoff, true);
  assert.strictEqual(resCustomConstructed.reason, 'duration_cap');

  // Unit completed but no more units: does not handoff if under duration limit
  const resCompletedNoMore = defaultPolicy.evaluate({
    unitCompleted: true,
    hasMoreUnits: false,
    compactionCount: 0,
    activeDurationMs: 1000,
  });
  assert.strictEqual(resCompletedNoMore.shouldHandoff, false);
  assert.strictEqual(resCompletedNoMore.reason, 'none');
});

test('loop-detector: halts after 3 consecutive identical failures without resetting across sessions (V23)', () => {
  const detector = new LoopDetector();
  detector.recordFailure('compile error: syntax at line 12');
  detector.recordFailure('compile error: syntax at line 12');
  assert.strictEqual(detector.isLoopBlocked(), false);

  detector.recordFailure('compile error: syntax at line 12');
  assert.strictEqual(detector.isLoopBlocked(), true);
});

test('loop-detector: handles trimming, non-consecutive failures, custom threshold, and reset', () => {
  const detector = new LoopDetector(2);
  // Trimming handles surrounding whitespace
  detector.recordFailure('error: something broke\n');
  assert.strictEqual(detector.isLoopBlocked(), false);
  detector.recordFailure('  error: something broke  ');
  assert.strictEqual(detector.isLoopBlocked(), true);

  // Reset clears state
  detector.reset();
  assert.strictEqual(detector.isLoopBlocked(), false);

  // Consecutive required
  const standardDetector = new LoopDetector(3);
  standardDetector.recordFailure('error-A');
  standardDetector.recordFailure('error-A');
  standardDetector.recordFailure('error-B'); // breaks sequence
  standardDetector.recordFailure('error-A');
  assert.strictEqual(standardDetector.isLoopBlocked(), false);

  standardDetector.recordFailure('error-A');
  standardDetector.recordFailure('error-A'); // now 3 consecutive error-A
  assert.strictEqual(standardDetector.isLoopBlocked(), true);
});

test('budget: global budget inherits across runs and halts when exceeded (V24)', () => {
  const budget = new GlobalBudget({ maxTokens: 10000, maxDurationMs: 60000, maxTurns: 10 });
  budget.recordTurn(5000, 10000);
  assert.strictEqual(budget.isExceeded(), false);
  assert.strictEqual(budget.getExceededReason(), null);

  budget.recordTurn(6000, 10000);
  assert.strictEqual(budget.isExceeded(), true);
  assert.strictEqual(budget.getExceededReason(), 'token_cap_exceeded');

  const stats = budget.getStats();
  assert.strictEqual(stats.consumedTokens, 11000);
  assert.strictEqual(stats.elapsedDurationMs, 20000);
  assert.strictEqual(stats.turnCount, 2);
});

test('budget: tracks duration and turn caps correctly', () => {
  const durationBudget = new GlobalBudget({ maxDurationMs: 5000 });
  durationBudget.recordTurn(100, 4999);
  assert.strictEqual(durationBudget.isExceeded(), false);
  durationBudget.recordTurn(100, 1);
  assert.strictEqual(durationBudget.isExceeded(), true);
  assert.strictEqual(durationBudget.getExceededReason(), 'duration_cap_exceeded');

  const turnBudget = new GlobalBudget({ maxTurns: 3 });
  turnBudget.recordTurn(100, 100);
  turnBudget.recordTurn(100, 100);
  assert.strictEqual(turnBudget.isExceeded(), false);
  turnBudget.recordTurn(100, 100);
  assert.strictEqual(turnBudget.isExceeded(), true);
  assert.strictEqual(turnBudget.getExceededReason(), 'turn_cap_exceeded');
});

test('policy: exports are re-exported correctly from controller root', () => {
  assert.strictEqual(typeof ExportedTriggerPolicy, 'function');
  assert.strictEqual(typeof ExportedGlobalBudget, 'function');
  assert.strictEqual(typeof ExportedLoopDetector, 'function');
});
