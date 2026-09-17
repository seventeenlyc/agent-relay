import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { WorkspaceSentinel } from '../../packages/controller/src/workspace/sentinel.ts';
import { HandoffPackager } from '../../packages/controller/src/workspace/checkpoint.ts';
import { InputLedger } from '../../packages/controller/src/inputs/ledger.ts';
import { TaskGraph } from '../../packages/controller/src/tasks/graph.ts';
import * as WorkspaceExports from '../../packages/controller/src/workspace/index.ts';
import * as ControllerExports from '../../packages/controller/src/index.ts';

test('sentinel: captures clean git baseline and flags dirty changes (V05)', () => {
  const sentinel = new WorkspaceSentinel(process.cwd());
  const fp = sentinel.captureFingerprint();
  assert.ok(typeof fp.commitHash === 'string');
  assert.ok(Array.isArray(fp.untrackedFiles));
  assert.ok(Array.isArray(fp.dirtyFiles));
  assert.ok(typeof fp.treeHash === 'string' && fp.treeHash.length === 64);
});

test('sentinel: verifyIntegrity accurately matches treeHash', () => {
  const sentinel = new WorkspaceSentinel(process.cwd());
  const fp = sentinel.captureFingerprint();
  assert.strictEqual(sentinel.verifyIntegrity(fp.treeHash), true);
  assert.strictEqual(sentinel.verifyIntegrity('0000000000000000000000000000000000000000000000000000000000000000'), false);
});

test('sentinel: protectUntrackedChanges guards baseline files from removal', () => {
  const sentinel = new WorkspaceSentinel(process.cwd());
  const fp = sentinel.captureFingerprint();
  assert.strictEqual(sentinel.protectUntrackedChanges(fp), true);
  assert.strictEqual(sentinel.protectUntrackedChanges(['non_existent_untracked_file_12345.xyz']), false);
});

test('sentinel: fallback gracefully for non-git directory', () => {
  const nonGitDir = os.tmpdir();
  const sentinel = new WorkspaceSentinel(nonGitDir);
  const fp = sentinel.captureFingerprint();
  assert.strictEqual(fp.commitHash, 'UNKNOWN_COMMIT');
  assert.deepStrictEqual(fp.untrackedFiles, []);
  assert.deepStrictEqual(fp.dirtyFiles, []);
  assert.ok(typeof fp.treeHash === 'string' && fp.treeHash.length === 64);
});

test('packager: packages immutable inputs, tasks, and fingerprint into verifiable manifest (V16)', () => {
  const sentinel = new WorkspaceSentinel(process.cwd());
  const packager = new HandoffPackager();
  const ledger = new InputLedger();
  ledger.appendUserMessage('Do not touch build.gradle');
  const graph = new TaskGraph();
  graph.addTask({ taskId: 't1', requirementId: 'req-1', title: 'Task 1' });

  const manifest = packager.createManifest({
    runId: 'run-test-1',
    epoch: 1,
    sourceSessionId: 'sess-old',
    targetModel: { provider: 'openai', model: 'gpt-5.6-luna' },
    ledger,
    taskGraph: graph,
    sentinel
  });

  assert.strictEqual(manifest.epoch, 1);
  assert.strictEqual(manifest.targetModel.model, 'gpt-5.6-luna');
  assert.ok(manifest.inputLedgerHeadHash.length === 64);
  assert.doesNotThrow(() => packager.verifyManifest(manifest));
});

test('packager: verifyManifest rejects corrupted or invalid manifests', () => {
  const sentinel = new WorkspaceSentinel(process.cwd());
  const packager = new HandoffPackager();
  const ledger = new InputLedger();
  ledger.appendUserMessage('Task test message');
  const graph = new TaskGraph();

  const manifest = packager.createManifest({
    runId: 'run-test-2',
    epoch: 0,
    sourceSessionId: 'sess-test',
    targetModel: { provider: 'anthropic', model: 'claude-3-7-sonnet' },
    ledger,
    taskGraph: graph,
    sentinel
  });

  // Corrupted runId
  assert.throws(
    () => packager.verifyManifest({ ...manifest, runId: '' }),
    /runId are required/
  );

  // Corrupted treeHash
  assert.throws(
    () => packager.verifyManifest({ ...manifest, workspaceFingerprint: { ...manifest.workspaceFingerprint, treeHash: '' } }),
    /valid workspaceFingerprint is required/
  );

  // Corrupted epoch
  assert.throws(
    () => packager.verifyManifest({ ...manifest, epoch: -1 }),
    /valid epoch is required/
  );
});

test('packager: task snapshot hash changes when task graph is modified', () => {
  const sentinel = new WorkspaceSentinel(process.cwd());
  const packager = new HandoffPackager();
  const ledger = new InputLedger();
  ledger.appendUserMessage('Sample input');

  const graph1 = new TaskGraph();
  graph1.addTask({ taskId: 't1', requirementId: 'req-1', title: 'Task 1' });
  const manifest1 = packager.createManifest({
    runId: 'run-diff-1',
    epoch: 1,
    sourceSessionId: 'sess-1',
    targetModel: { provider: 'openai', model: 'gpt-5' },
    ledger,
    taskGraph: graph1,
    sentinel
  });

  const graph2 = new TaskGraph();
  graph2.addTask({ taskId: 't1', requirementId: 'req-1', title: 'Task 1' });
  graph2.addTask({ taskId: 't2', requirementId: 'req-1', title: 'Task 2' });
  const manifest2 = packager.createManifest({
    runId: 'run-diff-2',
    epoch: 1,
    sourceSessionId: 'sess-1',
    targetModel: { provider: 'openai', model: 'gpt-5' },
    ledger,
    taskGraph: graph2,
    sentinel
  });

  assert.notStrictEqual(manifest1.taskSnapshotHash, manifest2.taskSnapshotHash);
});

test('workspace: re-exports Sentinel and Packager classes', () => {
  assert.ok(typeof WorkspaceExports.WorkspaceSentinel === 'function');
  assert.ok(typeof WorkspaceExports.HandoffPackager === 'function');
  assert.ok(typeof (ControllerExports as any).WorkspaceSentinel === 'function');
  assert.ok(typeof (ControllerExports as any).HandoffPackager === 'function');
});
