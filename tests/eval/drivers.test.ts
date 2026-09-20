import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getBenchmarkScenario } from '../../packages/evaluator/src/scenarios.ts';
import { runNativeLongSession } from '../../packages/evaluator/src/drivers/native-long.ts';
import { runSummaryOnly } from '../../packages/evaluator/src/drivers/summary-only.ts';
import { runAgentRelay } from '../../packages/evaluator/src/drivers/agent-relay.ts';

test('drivers: Condition 1 (native long) executes 11 units in single session with compression degradation', async () => {
  const scenario = getBenchmarkScenario();
  const res = await runNativeLongSession(scenario);
  assert.strictEqual(res.executedUnits.length, 11);
  assert.strictEqual(res.handoffsCount, 0);
  assert.strictEqual(res.originalHashPreserved, false); // Context lost due to natural rolling compression
});

test('drivers: Condition 2 (summary only) executes 10 handoffs with cascading summary decay', async () => {
  const scenario = getBenchmarkScenario();
  const res = await runSummaryOnly(scenario);
  assert.strictEqual(res.executedUnits.length, 11);
  assert.strictEqual(res.handoffsCount, 10);
  assert.strictEqual(res.originalHashPreserved, false); // Summaries lose verbatim inputs
});

test('drivers: Condition 3 (agent relay) executes 10 handoffs with 100% hash preservation and scope enforcement', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-relay-'));
  try {
    const scenario = getBenchmarkScenario();
    const res = await runAgentRelay(scenario, tmpDir);
    assert.strictEqual(res.executedUnits.length, 11);
    assert.strictEqual(res.handoffsCount, 10);
    assert.strictEqual(res.originalHashPreserved, true); // Immutable ledger intact
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
