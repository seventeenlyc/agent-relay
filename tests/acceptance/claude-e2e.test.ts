import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RelayDatabase } from '../../packages/controller/src/run/db.ts';
import { RunStore } from '../../packages/controller/src/run/store.ts';
import { RunController, type StartRunConfig } from '../../packages/controller/src/run/engine.ts';
import { RecordingNotifier } from '../../packages/controller/src/run/notifier.ts';
import { TwoPhaseHandshakeCoordinator } from '../../packages/adapters/claude/src/handshake.ts';
import { ScriptedAdapter } from '../helpers/scripted-adapter.ts';

const FOUR_UNITS = [
  { taskId: 'u1', requirementId: 'req-root', title: 'Data Ingestion Skeleton', dependencies: [] as string[] },
  { taskId: 'u2', requirementId: 'req-root', title: 'Transformer Core', dependencies: ['u1'] },
  { taskId: 'u3', requirementId: 'req-root', title: 'Unit Tests & Validation', dependencies: ['u2'] },
  { taskId: 'u4', requirementId: 'req-root', title: 'Release Package & Artifacts', dependencies: ['u3'] }
];

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('acceptance: Claude Code - four units complete through three automatic handoffs (V32, R4, R5, R6)', async () => {
  const dataDir = tempDir('claude-e2e-');
  const db = new RelayDatabase({ dbPath: path.join(dataDir, 'relay.db') });
  const store = new RunStore(db);
  const adapter = new ScriptedAdapter();
  const notifier = new RecordingNotifier();

  try {
    const controller = new RunController({
      store,
      dataDir,
      adapter,
      adapterName: 'claude',
      notifier,
      createCoordinator: (deps) =>
        new TwoPhaseHandshakeCoordinator(
          deps.stateMachine as any,
          deps.leaseManager as any,
          deps.workspaceKey
        )
    });

    const config: StartRunConfig = {
      runId: 'claude-e2e-demo',
      goal: 'Deliver neural pipeline across 4 units in Claude Code',
      workspacePath: dataDir,
      tasks: FOUR_UNITS,
      model: { provider: 'anthropic', model: 'claude-3-7-sonnet', effort: 'high' },
      initialUserMessage: 'Build pipeline. DO NOT ALTER PUBLIC API SIGNATURES.'
    };

    controller.startRun(config);
    const outcomes = await controller.executeUntilSettled(100);

    // 1. 结果与交接计数验证
    assert.strictEqual(outcomes.filter((o) => o.kind === 'unit_executed').length, 4);
    assert.strictEqual(outcomes.filter((o) => o.kind === 'handoff_performed').length, 3);
    assert.strictEqual(outcomes[outcomes.length - 1].kind, 'completed');

    const run = store.getRun('claude-e2e-demo')!;
    assert.strictEqual(run.state, 'COMPLETED');
    assert.strictEqual(run.handoffCount, 3);

    // 2. R4: 4 个全新的物理会话，无历史复用
    const chain = store.listChain('claude-e2e-demo');
    assert.strictEqual(chain.length, 4);
    assert.strictEqual(new Set(chain.map((l) => l.nextSessionId)).size, 4);

    // 3. R5: 同模型与 effort 配置 100% 严格继承
    assert.strictEqual(chain.every((l) => l.provider === 'anthropic'), true);
    assert.strictEqual(chain.every((l) => l.model === 'claude-3-7-sonnet'), true);
    assert.strictEqual(chain.every((l) => l.effort === 'high'), true);

    // 4. R1/R3: 原话账本头哈希与初始人类输入严格保持
    const hashes = controller.getInvariantHashes();
    assert.ok(hashes.inputLedgerHeadHash);
    assert.ok(hashes.taskSnapshotHash);
  } finally {
    db.close();
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // Windows cleanup
    }
  }
});
