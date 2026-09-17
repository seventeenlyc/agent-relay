import test from 'node:test';
import assert from 'node:assert/strict';
import { computeSha256, serializeCanonicalJson, validateInputRecord, validateTaskItem, validateHandoffManifest } from '../../packages/protocol/src/index.ts';
import type { InputRecord, TaskItem, HandoffPackManifest } from '../../packages/protocol/src/types.ts';

test('protocol: canonical JSON serialization and SHA-256 hashing', () => {
  const objA = { b: 2, a: 1 };
  const objB = { a: 1, b: 2 };
  assert.strictEqual(serializeCanonicalJson(objA), serializeCanonicalJson(objB));
  assert.strictEqual(computeSha256(serializeCanonicalJson(objA)), computeSha256(serializeCanonicalJson(objB)));
});

test('protocol: input record validation rejects missing hash or empty content', () => {
  const invalidRecord: Partial<InputRecord> = {
    inputId: 'in-1',
    source: 'human',
    timestamp: Date.now(),
    rawContent: ''
  };
  assert.throws(() => validateInputRecord(invalidRecord), /rawContent cannot be empty/);

  const validRecord: InputRecord = {
    inputId: 'in-1',
    source: 'human',
    timestamp: Date.now(),
    rawContent: 'Do not modify public API',
    sha256Hash: computeSha256('Do not modify public API')
  };
  assert.doesNotThrow(() => validateInputRecord(validRecord));
});

test('protocol: task item requires requirementId reference', () => {
  const orphanTask: Partial<TaskItem> = {
    taskId: 'task-1',
    title: 'Random task',
    status: 'pending'
  };
  assert.throws(() => validateTaskItem(orphanTask), /requirementId is required/);
});

test('protocol: handoff manifest validation requires handoffId, runId, epoch, and workspaceFingerprint', () => {
  const invalidManifest: Partial<HandoffPackManifest> = {
    handoffId: 'h-1'
  };
  assert.throws(() => validateHandoffManifest(invalidManifest), /handoffId and runId are required/);

  const validManifest: HandoffPackManifest = {
    handoffId: 'h-1',
    runId: 'r-1',
    epoch: 0,
    sourceSessionId: 's-1',
    targetModel: { provider: 'anthropic', model: 'claude-3-7-sonnet' },
    inputLedgerHeadHash: 'hash1',
    requirementVersion: 1,
    taskSnapshotHash: 'hash2',
    workspaceFingerprint: {
      commitHash: 'commit1',
      untrackedFiles: [],
      dirtyFiles: [],
      treeHash: 'tree1'
    },
    timestamp: Date.now()
  };
  assert.doesNotThrow(() => validateHandoffManifest(validManifest));
});
