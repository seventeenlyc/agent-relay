// tests/run/prompt.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  UNIT_RESULT_START,
  UNIT_RESULT_END,
  buildRunBriefing,
  buildUnitPrompt,
  parseUnitResult,
  normalizeUnitResult
} from '../../packages/controller/src/run/prompt.ts';
import { InputLedger } from '../../packages/controller/src/inputs/ledger.ts';
import { deriveContractFromLedger } from '../../packages/controller/src/inputs/supersedes.ts';
import { TaskGraph } from '../../packages/controller/src/tasks/graph.ts';

function makeContext() {
  const ledger = new InputLedger();
  ledger.appendUserMessage('Build the ingestion pipeline. Do not change the public API.');
  const contract = deriveContractFromLedger(ledger);
  const graph = new TaskGraph();
  graph.addTask({
    taskId: 'unit-2',
    requirementId: 'req-root',
    title: 'Transformer Encoder',
    description: 'Implement the encoder layer',
    allowedPaths: ['packages/model'],
    expectedArtifacts: ['packages/model/encoder.ts']
  });
  return { ledger, contract, graph, task: graph.getTask('unit-2')! };
}

test('prompt: buildRunBriefing carries goal, forbidden items and read-only handoff rules', () => {
  const { ledger, contract } = makeContext();
  const briefing = buildRunBriefing({ goal: 'Ship the pipeline', contract, runId: 'run-1' });

  assert.match(briefing, /Ship the pipeline/);
  // 禁止项由 deriveContractFromLedger 提取，已剥离否定前缀（标题 FORBIDDEN_ITEMS 本身就是否定），
  // 因此断言的是派生后的条目而不是人类原话——原话的逐字保真由账本负责，不由简报负责。
  assert.deepStrictEqual(contract.forbiddenItems, ['change the public API']);
  assert.ok(briefing.includes('FORBIDDEN_ITEMS:'));
  assert.ok(briefing.includes('change the public API'));
  assert.match(briefing, /generated_handoff/);
  assert.ok(briefing.includes('run-1'));
});

test('prompt: buildUnitPrompt emits machine-readable markers for the unit and its bounds', () => {
  const { contract, task } = makeContext();
  const prompt = buildUnitPrompt({ task, contract, runId: 'run-1' });

  assert.ok(prompt.includes('TASK_ID: unit-2'), 'task id must be machine-readable');
  assert.ok(prompt.includes('RUN_ID: run-1'));
  assert.match(prompt, /Transformer Encoder/);
  assert.match(prompt, /packages\/model/);
  assert.match(prompt, /packages\/model\/encoder\.ts/);
  assert.ok(prompt.includes(UNIT_RESULT_START), 'the prompt must state the required reply format');
  assert.ok(prompt.includes(UNIT_RESULT_END));
  assert.ok(prompt.includes('"status"'));
});

test('prompt: parseUnitResult reads the last complete result block', () => {
  const first = `${UNIT_RESULT_START}\n{"taskId":"unit-1","status":"completed","evidenceHash":"ev-1"}\n${UNIT_RESULT_END}`;
  const second = `${UNIT_RESULT_START}\n{"taskId":"unit-2","status":"partial","summary":"tests failing"}\n${UNIT_RESULT_END}`;

  const parsed = parseUnitResult(`noise\n${first}\nmore noise\n${second}\ntrailing`);
  assert.ok(parsed);
  assert.strictEqual(parsed?.taskId, 'unit-2');
  assert.strictEqual(parsed?.status, 'partial');
  assert.strictEqual(parsed?.summary, 'tests failing');
});

test('prompt: parseUnitResult returns null for missing, unterminated or invalid blocks', () => {
  assert.strictEqual(parseUnitResult(''), null);
  assert.strictEqual(parseUnitResult('no blocks here'), null);
  assert.strictEqual(parseUnitResult(`${UNIT_RESULT_START}\n{"taskId":"x"`), null, 'unterminated block');
  assert.strictEqual(parseUnitResult(`${UNIT_RESULT_START}\nnot json\n${UNIT_RESULT_END}`), null);
  assert.strictEqual(
    parseUnitResult(`${UNIT_RESULT_START}\n{"status":"completed"}\n${UNIT_RESULT_END}`),
    null,
    'a result without a taskId is not usable'
  );
  assert.strictEqual(
    parseUnitResult(`${UNIT_RESULT_START}\n{"taskId":"t","status":"nonsense"}\n${UNIT_RESULT_END}`),
    null,
    'unknown status must be rejected rather than coerced'
  );
});

test('prompt: normalizeUnitResult downgrades a completion without evidence to partial', () => {
  const withoutEvidence = normalizeUnitResult({ taskId: 'unit-1', status: 'completed' });
  assert.strictEqual(withoutEvidence.status, 'partial');
  assert.match(withoutEvidence.summary ?? '', /evidence/i);

  const withEvidence = normalizeUnitResult({ taskId: 'unit-1', status: 'completed', evidenceHash: 'ev-1' });
  assert.strictEqual(withEvidence.status, 'completed');
  assert.strictEqual(withEvidence.evidenceHash, 'ev-1');

  const blankEvidence = normalizeUnitResult({ taskId: 'unit-1', status: 'completed', evidenceHash: '   ' });
  assert.strictEqual(blankEvidence.status, 'partial');

  const failed = normalizeUnitResult({ taskId: 'unit-1', status: 'failed', summary: 'build broken' });
  assert.strictEqual(failed.status, 'failed');
  assert.strictEqual(failed.summary, 'build broken');
});
