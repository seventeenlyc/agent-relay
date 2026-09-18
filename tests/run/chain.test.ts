// tests/run/chain.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { RelayDatabase } from '../../packages/controller/src/run/db.ts';
import { RunStore } from '../../packages/controller/src/run/store.ts';
import { SessionChainLedger } from '../../packages/controller/src/run/chain.ts';

function setup(runId = 'run-chain') {
  const db = new RelayDatabase({ dbPath: ':memory:' });
  const store = new RunStore(db);
  store.insertRun({
    runId,
    workspaceKey: `ws-${runId}`,
    workspacePath: `C:/tmp/${runId}`,
    goal: 'chain test',
    state: 'RUNNING',
    unitCount: 4
  });
  return { db, store, chain: new SessionChainLedger(store), runId };
}

test('chain: first link is the run-started session with no predecessor', () => {
  const { db, chain, runId } = setup();
  const link = chain.append({
    runId,
    nextSessionId: 'worker-A',
    adapter: 'dsh',
    provider: 'deepseek-official',
    model: 'deepseek-chat',
    effort: 'high',
    epoch: 1,
    reason: 'run_started'
  });

  assert.strictEqual(link.sequence, 1);
  assert.strictEqual(link.prevSessionId, undefined);
  assert.strictEqual(chain.currentSessionId(runId), 'worker-A');
  db.close();
});

test('chain: handoff links form a contiguous sequence and preserve the old session (R4)', () => {
  const { db, chain, runId } = setup();
  chain.append({
    runId,
    nextSessionId: 'worker-A',
    adapter: 'dsh',
    provider: 'deepseek-official',
    model: 'deepseek-chat',
    epoch: 1,
    reason: 'run_started'
  });
  chain.append({
    runId,
    prevSessionId: 'worker-A',
    nextSessionId: 'worker-B',
    adapter: 'dsh',
    provider: 'deepseek-official',
    model: 'deepseek-chat',
    epoch: 2,
    handoffId: 'h-1',
    reason: 'unit_completed'
  });
  chain.append({
    runId,
    prevSessionId: 'worker-B',
    nextSessionId: 'worker-C',
    adapter: 'dsh',
    provider: 'deepseek-official',
    model: 'deepseek-reasoner',
    epoch: 3,
    handoffId: 'h-2',
    reason: 'unit_completed'
  });

  const links = chain.list(runId);
  assert.deepStrictEqual(
    links.map((l) => l.sequence),
    [1, 2, 3]
  );
  assert.deepStrictEqual(
    links.map((l) => l.nextSessionId),
    ['worker-A', 'worker-B', 'worker-C']
  );
  assert.strictEqual(chain.currentSessionId(runId), 'worker-C');
  assert.strictEqual(links[1].handoffId, 'h-1');
  assert.strictEqual(links[2].model, 'deepseek-reasoner');
  db.close();
});

test('chain: superseding marks the previous session without deleting history', () => {
  const { db, chain, runId } = setup();
  chain.append({
    runId,
    nextSessionId: 'worker-A',
    adapter: 'claude',
    provider: 'anthropic',
    model: 'claude-3-7-sonnet',
    epoch: 1,
    reason: 'run_started'
  });
  chain.append({
    runId,
    prevSessionId: 'worker-A',
    nextSessionId: 'worker-B',
    adapter: 'claude',
    provider: 'anthropic',
    model: 'claude-3-7-sonnet',
    epoch: 2,
    handoffId: 'h-1',
    reason: 'unit_completed'
  });

  chain.supersede('worker-A');
  const links = chain.list(runId);
  assert.strictEqual(links.length, 2, 'history must never be deleted');
  assert.ok(typeof links[0].supersededAt === 'number');
  assert.strictEqual(links[1].supersededAt, undefined);
  assert.strictEqual(chain.getActiveSessionId(runId), 'worker-B');
  db.close();
});

test('chain: markSuperseded is idempotent and rejects unknown sessions', () => {
  const { db, chain, runId } = setup();
  chain.append({
    runId,
    nextSessionId: 'worker-A',
    adapter: 'codex',
    provider: 'openai',
    model: 'gpt-5.6-luna',
    epoch: 1,
    reason: 'run_started'
  });

  chain.supersede('worker-A');
  const firstStamp = chain.list(runId)[0].supersededAt;
  chain.supersede('worker-A');
  assert.strictEqual(chain.list(runId)[0].supersededAt, firstStamp, 'second supersede must not change the timestamp');

  assert.throws(() => chain.supersede('nonexistent'), /unknown session/i);
  db.close();
});

test('chain: two runs keep independent chain sequences', () => {
  const db = new RelayDatabase({ dbPath: ':memory:' });
  const store = new RunStore(db);
  for (const runId of ['run-x', 'run-y']) {
    store.insertRun({
      runId,
      workspaceKey: `ws-${runId}`,
      workspacePath: `C:/tmp/${runId}`,
      goal: 'multi-run chain',
      state: 'RUNNING',
      unitCount: 1
    });
  }
  const chain = new SessionChainLedger(store);

  chain.append({
    runId: 'run-x',
    nextSessionId: 'x-1',
    adapter: 'dsh',
    provider: 'deepseek-official',
    model: 'deepseek-chat',
    epoch: 1,
    reason: 'run_started'
  });
  const link = chain.append({
    runId: 'run-y',
    nextSessionId: 'y-1',
    adapter: 'dsh',
    provider: 'deepseek-official',
    model: 'deepseek-chat',
    epoch: 1,
    reason: 'run_started'
  });

  assert.strictEqual(link.sequence, 1, 'sequence must be per-run, not global');
  db.close();
});
