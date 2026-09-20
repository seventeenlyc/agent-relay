import test from 'node:test';
import assert from 'node:assert/strict';
import { runFullBenchmark } from '../../packages/evaluator/src/runner.ts';

test('reporter: generates complete markdown table and structured telemetry for all 3 conditions', async () => {
  const { markdown, json } = await runFullBenchmark();
  assert.ok(markdown.includes('| 指标 | 原生单一长会话 | 仅摘要交接 | Agent Relay 完整方案 |'));
  assert.ok(markdown.includes('原话完整性'));
  assert.ok(markdown.includes('有效需求覆盖率'));
  assert.ok(markdown.includes('越界动作数'));
  assert.ok(markdown.includes('反例分析'));

  const parsed = JSON.parse(json);
  assert.ok(parsed.native_long);
  assert.ok(parsed.summary_only);
  assert.ok(parsed.agent_relay);
  assert.strictEqual(parsed.agent_relay.metrics.originalIntentIntegrity, 100);
});
