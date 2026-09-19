import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { TestContext } from 'node:test';
import { RelayDatabase } from '../../packages/controller/src/run/db.ts';
import { RunStore } from '../../packages/controller/src/run/store.ts';
import { RunController, type FaultHook } from '../../packages/controller/src/run/engine.ts';
import { RecordingNotifier } from '../../packages/controller/src/run/notifier.ts';
import { TwoPhaseHandshakeCoordinator } from '../../packages/adapters/claude/src/handshake.ts';
import type { WorkspaceLeaseManager } from '../../packages/controller/src/handoff/lease.ts';
import { ScriptedAdapter } from './scripted-adapter.ts';

/** Reopen the actual SQLite file, while modelling workers that survive the controller. */
export function recoveryHarness(t: TestContext, adapter = new ScriptedAdapter(), faultHook?: FaultHook) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-recovery-'));
  const workspace = path.join(root, 'workspace');
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(workspace);
  const userFile = path.join(workspace, '用户已有修改.txt');
  fs.writeFileSync(userFile, 'Keep my unfinished changes.\n');
  const dbPath = path.join(dataDir, 'relay.db');
  let db = new RelayDatabase({ dbPath });
  let store = new RunStore(db);
  const makeController = (hook?: FaultHook) => new RunController({
    store, dataDir, adapter, adapterName: 'claude', faultHook: hook,
    notifier: new RecordingNotifier(), quiescenceTimeoutMs: 10,
    createCoordinator: ({ stateMachine, leaseManager, workspaceKey }) =>
      new TwoPhaseHandshakeCoordinator(stateMachine, leaseManager as unknown as WorkspaceLeaseManager, workspaceKey)
  });
  let controller = makeController(faultHook);
  controller.startRun({
    runId: 'recovery', goal: 'Finish two units without losing user changes', workspacePath: workspace,
    initialUserMessage: 'Keep the public API and my unfinished changes; diagnose failed verification before retrying.',
    model: { provider: 'anthropic', model: 'test-model', effort: 'high' },
    tasks: [
      { taskId: 'u1', requirementId: 'req-root', title: 'First unit', dependencies: [] },
      { taskId: 'u2', requirementId: 'req-root', title: 'Second unit', dependencies: ['u1'] }
    ]
  });
  t.after(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const inputs = store.listInputs('recovery');
  return {
    adapter, workspace, userFile,
    get store() { return store; },
    get db() { return db; },
    get controller() { return controller; },
    reboot() {
      db.close();
      db = new RelayDatabase({ dbPath });
      store = new RunStore(db);
      controller = makeController();
      controller.rehydrate('recovery');
      return controller;
    },
    tasks() { return JSON.parse(store.getLatestTaskSnapshot('recovery')!.snapshotJson); },
    assertInvariants(expectedState: string) {
      // Single live writer, complete published checkpoints, intact user input,
      // no duplicate completed units/side effects, and persistent stop/pause state.
      const writers = [...adapter.sessions.values()].filter(s => s.active && s.executionAuthorized);
      assert.ok(writers.length <= 1, 'at most one live writer');
      for (const row of db.prepare("SELECT manifest_path, manifest_hash FROM handoffs WHERE state NOT IN ('REQUESTED', 'ABANDONED') AND manifest_path IS NOT NULL").all()) {
        const contents = fs.readFileSync(row.manifest_path as string, 'utf8');
        assert.doesNotThrow(() => JSON.parse(contents));
        assert.equal(createHash('sha256').update(contents).digest('hex'), row.manifest_hash);
      }
      assert.deepEqual(store.listInputs('recovery'), inputs, 'human input survives recovery unchanged');
      assert.equal(fs.readFileSync(userFile, 'utf8'), 'Keep my unfinished changes.\n');
      const completed = store.listEvents('recovery').filter(e => e.type === 'unit_completed').map(e => e.payload?.taskId);
      assert.equal(new Set(completed).size, completed.length, 'completed units are not duplicated');
      assert.equal(store.getRun('recovery')!.state, expectedState);
    }
  };
}
