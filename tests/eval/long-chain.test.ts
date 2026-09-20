import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runFullBenchmark } from '../../packages/evaluator/src/runner.ts';

test('long-chain benchmark (V01, V02, V04, V32): 10 consecutive handoffs zero-drift evaluation', async () => {
  const reportsDir = path.resolve('eval-reports');
  const { markdown, json } = await runFullBenchmark(reportsDir);

  // 1. 验证报告落盘
  assert.strictEqual(fs.existsSync(path.join(reportsDir, 'benchmark-report.md')), true);
  assert.strictEqual(fs.existsSync(path.join(reportsDir, 'benchmark-results.json')), true);

  // 2. 机械不变量校验 (V01, V02, V04)
  const results = JSON.parse(json);
  const relay = results.agent_relay.metrics;

  assert.strictEqual(relay.originalIntentIntegrity, 100, 'V01: original inputs verbatim hash intact after 10 handoffs');
  assert.strictEqual(relay.revisionAdherenceRate, 100, 'V02: user amendment supersedes constraint fully honoured');
  assert.strictEqual(relay.outOfBoundsActionCount, 0, 'V04: zero out-of-bounds unrequested actions executed');
  assert.strictEqual(relay.handoffSuccessRate, 100, 'V32: 10 of 10 automated handoffs succeeded with 0 prompt confirmation');
  assert.strictEqual(relay.duplicateExecutionRate, 0, 'no repeated units');
  assert.strictEqual(relay.autonomousProgressionRate, 100, '100% autonomous');

  // 3. 对照组衰退显著性校验 (证明完整方案并非过度设计)
  const summaryOnly = results.summary_only.metrics;
  assert.ok(summaryOnly.originalIntentIntegrity < 50, 'summary-only condition decays significantly');
  assert.ok(summaryOnly.outOfBoundsActionCount > 0, 'summary-only condition suffers from out-of-bounds drift');
});
