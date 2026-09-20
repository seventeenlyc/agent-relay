import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getBenchmarkScenario } from './scenarios.ts';
import { runNativeLongSession } from './drivers/native-long.ts';
import { runSummaryOnly } from './drivers/summary-only.ts';
import { runAgentRelay } from './drivers/agent-relay.ts';
import { computeBenchmarkMetrics } from './metrics.ts';
import {
  generateMarkdownReport,
  generateJsonTelemetry,
  type BenchmarkResultItem
} from './reporter.ts';

export async function runFullBenchmark(
  outputDir?: string
): Promise<{ markdown: string; json: string }> {
  const scenario = getBenchmarkScenario();

  // 1. Condition 1: Native Long Session
  const nativeRecord = await runNativeLongSession(scenario);
  const nativeMetrics = computeBenchmarkMetrics(nativeRecord, scenario);

  // 2. Condition 2: Summary-Only Cascading
  const summaryRecord = await runSummaryOnly(scenario);
  const summaryMetrics = computeBenchmarkMetrics(summaryRecord, scenario);

  // 3. Condition 3: Agent Relay Full Solution
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-relay-runner-'));
  let relayRecord;
  try {
    relayRecord = await runAgentRelay(scenario, tmpDir);
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best effort cleanup on Windows
    }
  }
  const relayMetrics = computeBenchmarkMetrics(relayRecord, scenario);

  const results = new Map<string, BenchmarkResultItem>([
    ['native_long', { record: nativeRecord, metrics: nativeMetrics }],
    ['summary_only', { record: summaryRecord, metrics: summaryMetrics }],
    ['agent_relay', { record: relayRecord, metrics: relayMetrics }]
  ]);

  const markdown = generateMarkdownReport(results);
  const json = generateJsonTelemetry(results);

  if (outputDir) {
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, 'benchmark-report.md'), markdown, 'utf8');
    fs.writeFileSync(path.join(outputDir, 'benchmark-results.json'), json, 'utf8');
  }

  return { markdown, json };
}
