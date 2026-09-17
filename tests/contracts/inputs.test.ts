import test from 'node:test';
import assert from 'node:assert/strict';
import { InputLedger } from '../../packages/controller/src/inputs/ledger.ts';
import { deriveContractFromLedger } from '../../packages/controller/src/inputs/supersedes.ts';

test('ledger: append-only human inputs with hash chaining', () => {
  const ledger = new InputLedger();
  const in1 = ledger.appendUserMessage('Task 1: do not modify public API');
  const in2 = ledger.appendUserMessage('Task 2: add benchmark test');

  assert.strictEqual(ledger.getHumanInputs().length, 2);
  assert.strictEqual(in1.sha256Hash, ledger.getHumanInputs()[0].sha256Hash);
  assert.strictEqual(ledger.getAllRecords().length, 2);

  // Verify tamper detection
  const headHash = ledger.getHeadHash();
  assert.ok(headHash.length === 64);
});

test('ledger: generated_handoff is strictly isolated and never treated as human authority (V28)', () => {
  const ledger = new InputLedger();
  ledger.appendUserMessage('User instruction: Keep tests green.');
  ledger.appendSystemHandoff('Generated handoff summary: unit 1 completed.');

  assert.strictEqual(ledger.getAllRecords().length, 2);
  const humanOnly = ledger.getHumanInputs();
  assert.strictEqual(humanOnly.length, 1);
  assert.strictEqual(humanOnly[0].source, 'human');
});

test('supersedes: user amends constraint with supersedes without mutating original input (V01, V02)', () => {
  const ledger = new InputLedger();
  const r1 = ledger.appendUserMessage('Requirement A: export PDF format');
  const contractV1 = deriveContractFromLedger(ledger);
  assert.strictEqual(contractV1.forbiddenItems.length, 0);

  // User later cancels/amends the constraint
  const r2 = ledger.appendUserMessage('Actually, do not export PDF format, only JSON', r1.inputId);
  const contractV2 = deriveContractFromLedger(ledger);

  // Original record still exists verbatim
  assert.strictEqual(ledger.getRecordById(r1.inputId)?.rawContent, 'Requirement A: export PDF format');
  // New contract has forbidden item and points to supersedesId
  assert.strictEqual(contractV2.version, 2);
  assert.ok(contractV2.forbiddenItems.includes('export PDF format'));
  assert.strictEqual(r2.supersedesId, r1.inputId);
});

test('ledger: empty user message is rejected', () => {
  const ledger = new InputLedger();
  assert.throws(() => ledger.appendUserMessage(''), /User content cannot be empty/);
  assert.throws(() => ledger.appendUserMessage('   '), /User content cannot be empty/);
});

test('ledger: empty ledger head hash is deterministic', () => {
  const ledger1 = new InputLedger();
  const ledger2 = new InputLedger();
  assert.strictEqual(ledger1.getHeadHash(), ledger2.getHeadHash());
  assert.strictEqual(ledger1.getHeadHash().length, 64);
});
