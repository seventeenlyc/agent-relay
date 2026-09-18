// tests/run/fault-hook.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RelayDatabase } from '../../packages/controller/src/run/db.ts';
import { RunStore } from '../../packages/controller/src/run/store.ts';
import {
  RunController,
  type StartRunConfig,
  type FaultInjectionPoint,
  type FaultHook,
  type FaultContext
} from '../../packages/controller/src/run/engine.ts';
import { RecordingNotifier } from '../../packages/controller/src/run/notifier.ts';
import { HandoffStateMachine } from '../../packages/controller/src/handoff/state-machine.ts';
import { WorkspaceLeaseManager } from '../../packages/controller/src/handoff/lease.ts';
import { TwoPhaseHandshakeCoordinator } from '../../packages/adapters/claude/src/handshake.ts';
import { ScriptedAdapter } from '../helpers/scripted-adapter.ts';

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('engine: faultHook collects injection points in correct order during handoff and outbox reaches ACKED', async () => {
  const dataDir = makeTempDir('agent-relay-faulthook-');
  const dbPath = path.join(dataDir, 'relay.db');
  const db = new RelayDatabase({ dbPath });
  const store = new RunStore(db);
  const adapter = new ScriptedAdapter();
  const notifier = new RecordingNotifier();

  const faultPoints: Array<{ point: FaultInjectionPoint; ctx: FaultContext }> = [];
  const faultHook: FaultHook = (point, ctx) => {
    faultPoints.push({ point, ctx: { ...ctx } });
  };

  const controller = new RunController({
    store,
    dataDir,
    adapter,
    adapterName: 'claude',
    notifier,
    faultHook,
    createCoordinator: (deps) =>
      new TwoPhaseHandshakeCoordinator(
        deps.stateMachine as HandoffStateMachine,
        deps.leaseManager as unknown as WorkspaceLeaseManager,
        deps.workspaceKey
      )
  });

  const config: StartRunConfig = {
    runId: 'run-fh-1',
    goal: 'Test fault hooks and outbox integration',
    workspacePath: dataDir,
    tasks: [
      { taskId: 'u1', requirementId: 'req-root', title: 'First Unit', dependencies: [] as string[] },
      { taskId: 'u2', requirementId: 'req-root', title: 'Second Unit', dependencies: ['u1'] }
    ],
    model: { provider: 'anthropic', model: 'claude-3-7-sonnet', effort: 'high' },
    initialUserMessage: 'Build the fault-hook test pipeline.'
  };

  controller.startRun(config);

  // Tick 1: execute unit u1 (triggers during_first_write)
  const first = await controller.tick();
  assert.strictEqual(first.kind, 'unit_executed');
  assert.strictEqual((first as { taskId: string }).taskId, 'u1');

  // Tick 2: handoff (triggers the snapshot/session/ack/cas/token hooks)
  const second = await controller.tick();
  assert.strictEqual(second.kind, 'handoff_performed');

  // Tick 3: execute unit u2 (triggers during_first_write again)
  const third = await controller.tick();
  assert.strictEqual(third.kind, 'unit_executed');
  assert.strictEqual((third as { taskId: string }).taskId, 'u2');

  // Assert the full ordered sequence of injection points
  const points = faultPoints.map((f) => f.point);
  const expectedOrder: FaultInjectionPoint[] = [
    // Unit 1 execution
    'during_first_write',
    // Handoff steps 3-8
    'during_snapshot_write',
    'after_snapshot_file_written',
    'after_db_publish',
    'before_session_create_call',
    'session_create_response_lost',
    'during_readonly_prep',
    'after_ack_received',
    'after_owner_cas',
    'after_token_dispatch',
    // Unit 2 execution
    'during_first_write'
  ];
  assert.deepStrictEqual(points, expectedOrder,
    'fault hooks must fire in the expected order across unit execution and handoff');

  // Every hook context includes the runId
  for (const f of faultPoints) {
    assert.strictEqual(f.ctx.runId, 'run-fh-1', 'every fault context must carry runId');
  }

  // The before_session_create_call hook must carry handoffId and sessionId
  const beforeCreate = faultPoints.find((f) => f.point === 'before_session_create_call')!;
  assert.ok(beforeCreate.ctx.handoffId, 'before_session_create_call must carry handoffId');
  assert.ok(beforeCreate.ctx.sessionId, 'before_session_create_call must carry sessionId');

  // The after_owner_cas hook must carry the new epoch
  const afterCas = faultPoints.find((f) => f.point === 'after_owner_cas')!;
  assert.ok(afterCas.ctx.epoch !== undefined, 'after_owner_cas must carry epoch');

  // The after_token_dispatch hook must carry epoch
  const afterToken = faultPoints.find((f) => f.point === 'after_token_dispatch')!;
  assert.ok(afterToken.ctx.epoch !== undefined, 'after_token_dispatch must carry epoch');

  // Outbox: the create_session message for the handoff must be in ACKED state
  const outboxMsg = store.findOutboxByHandoff('h-run-fh-1-1', 'create_session');
  assert.ok(outboxMsg, 'outbox message for create_session must exist');
  assert.strictEqual(outboxMsg!.state, 'ACKED',
    'create_session outbox message must be ACKED after handoff completes');
  assert.strictEqual(outboxMsg!.targetSessionId, 'run-fh-1-s2',
    'outbox message must reference the target session');

  // No pending outbox messages remain
  const pending = store.listPendingOutbox('run-fh-1');
  assert.strictEqual(pending.length, 0,
    'listPendingOutbox must return 0 pending messages after successful handoff');

  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('engine: faultHook async hooks are awaited before proceeding', async () => {
  const dataDir = makeTempDir('agent-relay-faulthook-async-');
  const dbPath = path.join(dataDir, 'relay.db');
  const db = new RelayDatabase({ dbPath });
  const store = new RunStore(db);
  const adapter = new ScriptedAdapter();

  const timeline: string[] = [];
  const faultHook: FaultHook = async (point) => {
    timeline.push(`hook:${point}:start`);
    await new Promise((resolve) => setTimeout(resolve, 5));
    timeline.push(`hook:${point}:end`);
  };

  const controller = new RunController({
    store,
    dataDir,
    adapter,
    adapterName: 'claude',
    faultHook,
    createCoordinator: (deps) =>
      new TwoPhaseHandshakeCoordinator(
        deps.stateMachine as HandoffStateMachine,
        deps.leaseManager as unknown as WorkspaceLeaseManager,
        deps.workspaceKey
      )
  });

  const config: StartRunConfig = {
    runId: 'run-fh-async',
    goal: 'Test async fault hooks',
    workspacePath: dataDir,
    tasks: [
      { taskId: 'u1', requirementId: 'req-root', title: 'First', dependencies: [] as string[] },
      { taskId: 'u2', requirementId: 'req-root', title: 'Second', dependencies: ['u1'] }
    ],
    model: { provider: 'anthropic', model: 'claude-3-7-sonnet' },
    initialUserMessage: 'Build it.'
  };

  controller.startRun(config);
  await controller.tick(); // unit u1
  await controller.tick(); // handoff

  // Every async hook must complete (end) before the next hook starts
  for (let i = 0; i < timeline.length - 1; i += 2) {
    assert.ok(timeline[i].endsWith(':start'), `entry ${i} should be a start`);
    assert.ok(timeline[i + 1].endsWith(':end'), `entry ${i + 1} should be an end`);
    const startPoint = timeline[i].replace(':start', '');
    const endPoint = timeline[i + 1].replace(':end', '');
    assert.strictEqual(startPoint, endPoint,
      `hook ${startPoint} must complete before the next hook begins`);
  }

  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
