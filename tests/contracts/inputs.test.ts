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

test('supersedes: extracts Chinese forbidden items without whitespace and preserves combined goals', () => {
  const ledger = new InputLedger();
  ledger.appendUserMessage('构建计算器模块。不要使用eval，禁止修改全局状态');
  const contract = deriveContractFromLedger(ledger);

  assert.ok(contract.forbiddenItems.includes('使用eval'));
  assert.ok(contract.forbiddenItems.includes('修改全局状态'));
  assert.ok(contract.goals.includes('构建计算器模块'));
});

test('ledger: stored records are frozen against mutation', () => {
  const ledger = new InputLedger();
  const record = ledger.appendUserMessage('Immutable requirement');
  assert.throws(() => {
    (record as any).rawContent = 'Tampered content';
  }, /TypeError/);
});

test('ledger: restoreFrom reproduces the exact head hash and rejects tampered records', () => {
  const original = new InputLedger();
  original.appendUserMessage('Build the pipeline with a read-only handoff');
  original.appendUserMessage('Also do not change the public API', original.getAllRecords()[0].inputId);
  original.appendSystemHandoff('generated handoff material must not become human authority');

  const snapshot = original.getAllRecords();
  const expectedHead = original.getHeadHash();

  const restored = new InputLedger();
  restored.restoreFrom(snapshot);

  assert.strictEqual(restored.getHeadHash(), expectedHead, 'head hash must survive a restore verbatim');
  assert.deepStrictEqual(
    restored.getAllRecords().map((r) => r.inputId),
    snapshot.map((r) => r.inputId),
    'input ids must not be regenerated'
  );
  assert.deepStrictEqual(
    restored.getAllRecords().map((r) => r.timestamp),
    snapshot.map((r) => r.timestamp),
    'timestamps must not be regenerated'
  );
  assert.strictEqual(restored.getHumanInputs().length, 2);
  assert.strictEqual(restored.getAllRecords().length, 3);

  // Tampered content must be rejected outright
  const tampered = snapshot.map((r) => ({ ...r, rawContent: `${r.rawContent} (edited)` }));
  const victim = new InputLedger();
  assert.throws(() => victim.restoreFrom(tampered), /hash mismatch/);
  assert.strictEqual(victim.getAllRecords().length, 0, 'a rejected restore must leave the ledger untouched');

  // Restoring twice must not duplicate records
  restored.restoreFrom(snapshot);
  assert.strictEqual(restored.getAllRecords().length, 3);
  assert.strictEqual(restored.getHeadHash(), expectedHead);
});
