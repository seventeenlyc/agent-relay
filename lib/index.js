import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const name = 'agent-relay';
export const inject = ['sessions'];

export const pluginManifest = Object.freeze({
  id: 'agent-relay-dsh',
  version: '0.1.0',
  protocolVersion: 1,
  target: 'dsh'
});

const TERMINAL_STATES = new Set(['CANCELLED', 'COMPLETED', 'DISABLED']);

const INTENT_KINDS = {
  pause: 'pause_next_node',
  resume: 'resume',
  stop: 'stop_now'
};

const INTENT_META = {
  pause: {
    name: 'relay_pause',
    desc: 'Request a pause at the next safe node on the current agent-relay run. Persists a durable control intent (the run pauses at its next safe boundary). Use when the user asks to pause or interrupt the relay.'
  },
  resume: {
    name: 'relay_resume',
    desc: 'Request resumption of a paused agent-relay run. Persists a durable resume control intent so the relay continues from the paused state.'
  },
  stop: {
    name: 'relay_stop',
    desc: 'Request an immediate stop of the current agent-relay run. Persists a durable stop intent. Prefer relay_pause when the run can safely stop at the next node.'
  }
};

/** Resolve the agent-relay data directory, mirroring the CLI resolveDataDir. */
function resolveDataDir() {
  if (typeof process.env.AGENT_RELAY_DATA_DIR === 'string' && process.env.AGENT_RELAY_DATA_DIR !== '') {
    return path.resolve(process.env.AGENT_RELAY_DATA_DIR);
  }
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
    return path.join(local, 'agent-relay');
  }
  const state = process.env.XDG_STATE_HOME ?? path.join(os.homedir(), '.local', 'state');
  return path.join(state, 'agent-relay');
}

/** Open the relay database when it exists; null otherwise. */
function openRelayDb(readOnly = true) {
  const dbPath = path.join(resolveDataDir(), 'relay.db');
  if (!fs.existsSync(dbPath)) return null;
  try {
    return new DatabaseSync(dbPath, { readOnly });
  } catch {
    return null;
  }
}

/** Pick the run to operate on: the requested run_id, else the single active run, else the latest. */
function pickRun(db, requested = null) {
  const rowFor = (id) => (id ? db.prepare('SELECT * FROM runs WHERE run_id = ?').get(id) ?? null : null);
  if (requested) return rowFor(requested);
  const active = db.prepare(
    "SELECT * FROM runs WHERE state NOT IN ('CANCELLED','COMPLETED','DISABLED') ORDER BY updated_at DESC LIMIT 1"
  ).all()[0];
  if (active) return active;
  return db.prepare('SELECT * FROM runs ORDER BY updated_at DESC LIMIT 1').get() ?? null;
}

function s(v) {
  return v === null || v === undefined ? null : v;
}

function runCard(run, totalRunCount) {
  return {
    runId: run.run_id,
    workspacePath: s(run.workspace_path),
    goal: s(run.goal),
    state: s(run.state),
    provider: s(run.provider),
    model: s(run.model),
    effort: s(run.effort),
    currentSessionId: s(run.current_session_id),
    currentEpoch: s(run.current_epoch),
    handoffCount: s(run.handoff_count),
    unitCount: s(run.unit_count),
    currentSessionUnitCount: s(run.current_session_unit_count),
    pauseReason: s(run.pause_reason),
    totalRuns: s(totalRunCount)
  };
}

function runParamSchema() {
  return {
    type: 'object',
    properties: {
      run_id: {
        type: 'string',
        description: 'Optional run id. Defaults to the active run, or the latest run when none is active.'
      }
    },
    additionalProperties: false
  };
}

function textOutput(schema) {
  return {
    schema,
    render(_args, value) {
      return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
    }
  };
}

function statusTool() {
  return {
    name: 'relay_status',
    description:
      'Query the Agent Relay controller state. Reports the requested run (or the active/latest run) with its state, session id, handoff count, and progress. Use this before pausing, resuming, or stopping to learn the current run state.',
    parameters: runParamSchema(),
    output: textOutput({
      type: 'object',
      properties: {
        found: { type: 'boolean' },
        runId: { type: 'string' },
        run: { type: 'object', additionalProperties: true },
        error: { type: 'string' }
      },
      required: ['found'],
      additionalProperties: false
    }),
    async execute(args = {}) {
      const db = openRelayDb();
      if (db === null) {
        return {
          found: false,
          ...(typeof args.run_id === 'string' ? { runId: args.run_id } : {}),
          error: 'no relay.db found; start an agent-relay run first'
        };
      }
      try {
        const run = pickRun(db, args.run_id);
        const count = db.prepare('SELECT COUNT(*) AS n FROM runs').get().n;
        if (!run) {
          return {
            found: false,
            ...(typeof args.run_id === 'string' ? { runId: args.run_id } : {}),
            error: 'no run found'
          };
        }
        return { found: true, runId: run.run_id, run: runCard(run, count) };
      } finally {
        db.close();
      }
    }
  };
}

function makeIntentTool(kind) {
  const meta = INTENT_META[kind];
  const kindVal = INTENT_KINDS[kind];
  return {
    name: meta.name,
    description: meta.desc,
    parameters: runParamSchema(),
    output: textOutput({
      type: 'object',
      properties: {
        applied: { type: 'boolean' },
        runId: { type: 'string' },
        state: { type: 'string' },
        intentId: { type: 'string' },
        watermark: { type: 'integer' },
        error: { type: 'string' }
      },
      required: ['applied'],
      additionalProperties: false
    }),
    async execute(args = {}) {
      const db = openRelayDb(false);
      if (db === null) return { applied: false, error: 'no relay.db found; run an agent-relay run first' };
      try {
        const run = pickRun(db, args.run_id);
        if (!run) return { applied: false, error: 'no run found to ' + kind };
        if (TERMINAL_STATES.has(run.state)) {
          return {
            applied: false,
            runId: run.run_id,
            state: run.state,
            error: 'cannot ' + kind + ' a run in terminal state (' + run.state + ')'
          };
        }
        if (kind === 'resume' && run.state !== 'PAUSED') {
          return {
            applied: false,
            runId: run.run_id,
            state: run.state,
            error: 'cannot resume a run not in state PAUSED'
          };
        }
        const watermark = db
          .prepare('SELECT COALESCE(MAX(watermark),0)+1 AS w FROM control_intents WHERE run_id = ?')
          .get(run.run_id).w;
        const intentId = 'relay-' + randomUUID();
        db.prepare(
          'INSERT INTO control_intents (intent_id, run_id, kind, payload, watermark, created_at) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(intentId, run.run_id, kindVal, '{}', watermark, Date.now());
        return { applied: true, runId: run.run_id, state: run.state, intentId, watermark };
      } finally {
        db.close();
      }
    }
  };
}

function chainTool() {
  return {
    name: 'relay_chain',
    description:
      'List the old→new session chain for an agent-relay run: each node/session link in sequence with its adapter, provider, model, epoch, and reason.',
    parameters: runParamSchema(),
    output: textOutput({
      type: 'object',
      properties: {
        found: { type: 'boolean' },
        runId: { type: 'string' },
        links: { type: 'array', items: { type: 'object', additionalProperties: true } },
        error: { type: 'string' }
      },
      additionalProperties: false
    }),
    async execute(args = {}) {
      const db = openRelayDb();
      if (db === null) {
        return {
          found: false,
          ...(typeof args.run_id === 'string' ? { runId: args.run_id } : {}),
          links: [],
          error: 'no relay.db found; run an agent-relay run first'
        };
      }
      try {
        const run = pickRun(db, args.run_id);
        if (!run) {
          return {
            found: false,
            ...(typeof args.run_id === 'string' ? { runId: args.run_id } : {}),
            links: [],
            error: 'no run found'
          };
        }
        const rows = db.prepare('SELECT * FROM session_chain WHERE run_id = ? ORDER BY sequence ASC').all(run.run_id);
        const links = rows.map((r) => ({
          sequence: r.sequence,
          prevSessionId: s(r.prev_session_id),
          nextSessionId: s(r.next_session_id),
          adapter: s(r.adapter),
          provider: s(r.provider),
          model: s(r.model),
          effort: s(r.effort),
          epoch: s(r.epoch),
          handoffId: s(r.handoff_id),
          reason: s(r.reason),
          createdAt: s(r.created_at)
        }));
        return { found: true, runId: run.run_id, links };
      } finally {
        db.close();
      }
    }
  };
}

async function loadMaterializer() {
  const localMat = path.join(path.dirname(fileURLToPath(import.meta.url)), 'materializer.js');
  if (fs.existsSync(localMat)) {
    return await import(pathToFileURL(localMat).href);
  }
  const adapterDir = resolveDshAdapterDir();
  return await import(pathToFileURL(path.join(adapterDir, 'materializer.ts')).href);
}

function materializeTool() {
  return {
    name: 'relay_materialize',
    description:
      'Materialize an Agent Relay run and its cross-session handoff chain into the active DSH Desktop workspace. Creates real, navigable sessions in the DSH left sidebar with complete handoff evidence and task progress. Use ONLY for macro epoch handoffs requiring clean context resets and CAS lease transfers; do NOT use for lightweight subagent tasks.',
    parameters: {
      type: 'object',
      properties: {
        run_id: {
          type: 'string',
          description: 'Optional run id. Defaults to the active run, or the latest run when none is active.'
        },
        workspace_path: {
          type: 'string',
          description: 'Optional workspace path. Defaults to D:\\DSH\\DSH Desktop Community or the current directory.'
        }
      },
      additionalProperties: false
    },
    output: textOutput({
      type: 'object',
      properties: {
        applied: { type: 'boolean' },
        runId: { type: 'string' },
        workspacePath: { type: 'string' },
        createdSessions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              epoch: { type: 'integer' },
              sessionId: { type: 'string' },
              title: { type: 'string' }
            },
            required: ['epoch', 'sessionId', 'title'],
            additionalProperties: false
          }
        },
        error: { type: 'string' }
      },
      required: ['applied'],
      additionalProperties: false
    }),
    async execute(args = {}) {
      const db = openRelayDb();
      if (db === null) return { applied: false, error: 'no relay.db found; run an agent-relay run first' };
      try {
        const run = pickRun(db, args.run_id);
        if (!run) return { applied: false, error: 'no run found to materialize' };

        const wsPath = args.workspace_path ?? run.workspace_path ?? process.cwd();
        const chain = db.prepare('SELECT * FROM session_chain WHERE run_id = ? ORDER BY sequence ASC').all(run.run_id);
        if (chain.length === 0) return { applied: false, error: 'no session chain found for run ' + run.run_id };

        const { DshSessionMaterializer } = await loadMaterializer();
        const materializer = new DshSessionMaterializer();
        const createdSessions = [];

        for (const link of chain) {
          const title = `🚀 [Relay] Epoch ${link.epoch}: ${run.goal || '任务执行'} (第 ${link.sequence} 阶段)`;
          const handoffInfo = {
            sequence: link.sequence,
            epoch: link.epoch,
            prevSessionId: link.prev_session_id,
            nextSessionId: link.next_session_id,
            model: `${link.provider}/${link.model}`,
            reason: link.reason,
            handoffId: link.handoff_id
          };
          const mat = await materializer.materializeSession({
            workspacePath: wsPath,
            title,
            epoch: link.epoch,
            runId: run.run_id,
            handoffInfo
          });
          createdSessions.push({
            epoch: link.epoch,
            sessionId: mat.sessionId,
            title: mat.title
          });
        }

        return {
          applied: true,
          runId: run.run_id,
          workspacePath: wsPath,
          createdSessions
        };
      } catch (err) {
        return { applied: false, error: 'materialization failed: ' + String(err) };
      } finally {
        db.close();
      }
    }
  };
}

function registerRelayTools(toolsService) {
  if (typeof toolsService?.register !== 'function') return;
  const tools = [
    statusTool(),
    makeIntentTool('pause'),
    makeIntentTool('resume'),
    makeIntentTool('stop'),
    chainTool(),
    materializeTool()
  ];
  for (const tool of tools) {
    toolsService.register(tool);
  }
}

export class DshHandoffHook {
  constructor(ctx, options = {}) {
    this.ctx = ctx;
    this.options = options;
    this.processedEvents = new Set();
    this.triggerCallbacks = [];
  }

  onTrigger(cb) {
    this.triggerCallbacks.push(cb);
  }

  install() {
    if (typeof this.ctx?.on !== 'function') return;
    this.ctx.on('session/event', async (session, event) => {
      try {
        await this.processEvent(session, event);
      } catch (err) {
        console.error('[agent-relay-hook] Error in event hook:', err);
      }
    });
  }

  async processEvent(session, event) {
    if (!event || !event.type) return false;
    const sessionId = session?.id ?? session?.sessionId;
    if (!sessionId) return false;

    // 1. Hook A: Marker Trigger Hook (assistant/message containing HANDOFF_ACK_START)
    if (event.type === 'assistant/message') {
      const parts = event.data?.message?.content ?? [];
      const fullText = Array.isArray(parts) ? parts.map((p) => p.text || '').join('\n') : '';
      if (
        fullText.includes('HANDOFF_ACK_START') ||
        fullText.includes('<<<AGENT_RELAY_HANDOFF>>>') ||
        fullText.includes('【触发下一阶段交接】')
      ) {
        const key = `${sessionId}:marker:${event.seq ?? Date.now()}`;
        if (this.processedEvents.has(key)) return false;
        this.processedEvents.add(key);

        console.log(`[agent-relay-hook] 🔔 观察到会话 ${sessionId} 发出交接标记，自动触发下一阶段接力！`);
        await this.dispatchAutoHandoff({
          sourceSessionId: sessionId,
          reason: 'marker_trigger',
          rawText: fullText
        });
        return true;
      }
    }

    // 2. Hook B: PreCompact Hook (compaction/start before destructive summarization)
    if (event.type === 'compaction/start') {
      const key = `${sessionId}:compaction:${event.seq ?? Date.now()}`;
      if (this.processedEvents.has(key)) return false;
      this.processedEvents.add(key);

      console.log(`[agent-relay-hook] ⚠️ 会话 ${sessionId} 即将进入上下文压缩，自动触发 PreCompact 跨会话续接！`);
      await this.dispatchAutoHandoff({
        sourceSessionId: sessionId,
        reason: 'hook_pre_compact',
        compaction: true
      });
      return true;
    }

    return false;
  }

  async dispatchAutoHandoff({ sourceSessionId, reason, rawText, compaction }) {
    for (const cb of this.triggerCallbacks) {
      try {
        await cb({ sourceSessionId, reason, rawText, compaction });
      } catch {}
    }

    let DshSessionMaterializer;
    try {
      const mod = await loadMaterializer();
      DshSessionMaterializer = mod.DshSessionMaterializer;
    } catch {
      return;
    }

    const db = openRelayDb(false);
    if (!db) return;

    try {
      const chainLink = db.prepare(
        'SELECT * FROM session_chain WHERE next_session_id = ? ORDER BY sequence DESC LIMIT 1'
      ).get(sourceSessionId);

      const run = chainLink ? pickRun(db, chainLink.run_id) : pickRun(db);
      if (!run || TERMINAL_STATES.has(run.state)) return;

      const nextEpoch = (chainLink ? chainLink.epoch : run.current_epoch) + 1;
      const nextSequence = (chainLink ? chainLink.sequence : 1) + 1;

      const title = `🚀 [Relay自动交接] Epoch ${nextEpoch}: ${compaction ? '上下文无损续接' : run.goal || '阶段接力'}`;
      const materializer = new DshSessionMaterializer();
      const wsPath = run.workspace_path ?? process.cwd();

      const nextPrompt = compaction
        ? `【Agent Relay 自动续接】前序会话 (${sourceSessionId}) 上下文已达上限，已由 PreCompact 钩子无缝移交至本会话。请继续执行前序未竟任务。`
        : `【Agent Relay 自动接力】已承接来自前序会话 (${sourceSessionId}) 的交接成果。请开始执行 Epoch ${nextEpoch} 阶段任务。`;

      const result = await materializer.materializeSession({
        workspacePath: wsPath,
        title,
        epoch: nextEpoch,
        runId: run.run_id,
        userMessage: nextPrompt
      });

      const handoffId = `handoff-${run.run_id}-ep${nextEpoch}-${Date.now()}`;
      db.prepare(`
        INSERT INTO session_chain (
          run_id, sequence, prev_session_id, next_session_id,
          adapter, provider, model, effort, epoch, handoff_id, reason, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        run.run_id, nextSequence, sourceSessionId, result.sessionId,
        'dsh', run.provider ?? 'antigravity', run.model ?? 'gemini-3.8-flash-high', 'high',
        nextEpoch, handoffId, reason, Date.now()
      );

      db.prepare(`
        UPDATE runs SET current_session_id = ?, current_epoch = ?, handoff_count = handoff_count + 1, updated_at = ? WHERE run_id = ?
      `).run(result.sessionId, nextEpoch, Date.now(), run.run_id);

      console.log(`[agent-relay-hook] ✅ 自动交接成功：新会话已在侧边栏静默物化并启动 -> [${result.sessionId}] ${title}`);
    } catch (e) {
      console.error('[agent-relay-hook] 自动交接失败:', e);
    } finally {
      db.close();
    }
  }
}

/**
 * DSH host entry point. The host bridge observes session events (when opted in)
 * and registers the 6 native `relay_*` control tools on `ctx.tools` when a tool
 * registry is available; the Relay supervisor owns task state and worker lifecycle.
 */
export function apply(ctx) {
  const hasOn = typeof ctx?.on === 'function';
  const hasInject = typeof ctx?.inject === 'function';
  const hasDirectTools = !hasInject && typeof ctx?.tools?.register === 'function';

  if (!ctx || (!hasOn && !hasInject && !hasDirectTools)) {
    throw new TypeError('agent-relay-dsh plugin requires a DSH context with on()');
  }

  if (hasOn) {
    const hook = new DshHandoffHook(ctx);
    hook.install();

    ctx.on('session/event', (session, event) => {
      const destination = process.env.AGENT_RELAY_EVENT_LOG;
      if (!destination) return;

      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.appendFileSync(
        destination,
        JSON.stringify({
          source: 'dsh_event',
          sessionId: session?.id ?? session?.sessionId ?? null,
          event
        }) + '\n',
        'utf8'
      );
    });
  }

  if (hasInject) {
    ctx.inject(['tools'], (c) => {
      registerRelayTools(c.tools);
    });
  } else if (hasDirectTools) {
    registerRelayTools(ctx.tools);
  }
}

function resolveDshAdapterDir() {
  const candidates = [];
  if (typeof process.env.AGENT_RELAY_REPO_ROOT === 'string' && process.env.AGENT_RELAY_REPO_ROOT !== '') {
    candidates.push(path.resolve(process.env.AGENT_RELAY_REPO_ROOT, 'packages', 'adapters', 'dsh', 'src'));
  }
  const selfDir = path.dirname(fileURLToPath(import.meta.url));
  candidates.push(
    path.resolve(selfDir, '..', 'packages', 'adapters', 'dsh', 'src'),
    path.resolve(selfDir, '..', '..', '..', 'packages', 'adapters', 'dsh', 'src')
  );
  try {
    const globalPluginJson = path.join(os.homedir(), '.dsh', 'plugins', 'agent-relay', 'plugin.json');
    if (fs.existsSync(globalPluginJson)) {
      const meta = JSON.parse(fs.readFileSync(globalPluginJson, 'utf8'));
      if (typeof meta?.entry === 'string' && meta.entry !== '') {
        candidates.push(path.resolve(path.dirname(meta.entry), '..', 'packages', 'adapters', 'dsh', 'src'));
      }
    }
  } catch {
    // Ignore unreadable global plugin metadata
  }
  candidates.push('G:/杂项/工具开发/packages/adapters/dsh/src');

  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'dsh-adapter.ts')) && fs.existsSync(path.join(dir, 'handshake.ts'))) {
      return dir;
    }
  }
  return path.resolve(selfDir, '..', 'packages', 'adapters', 'dsh', 'src');
}

/**
 * Agent Relay CLI entry point. DSH-specific implementation stays behind the
 * plugin boundary while the controller consumes the shared adapter contract.
 */
export async function createRuntime({ cwd, dataDir, runnerOptions = {} }) {
  if (typeof cwd !== 'string' || !cwd) throw new TypeError('cwd is required');
  if (typeof dataDir !== 'string' || !dataDir) throw new TypeError('dataDir is required');

  const adapterDir = resolveDshAdapterDir();
  const [{ DshAdapter }, { DshHandshakeCoordinator }] = await Promise.all([
    import(pathToFileURL(path.join(adapterDir, 'dsh-adapter.ts')).href),
    import(pathToFileURL(path.join(adapterDir, 'handshake.ts')).href)
  ]);

  const adapter = new DshAdapter({
    runnerOptions: {
      ...runnerOptions,
      cwd: runnerOptions.cwd ?? cwd
    }
  });

  return {
    adapter,
    adapterName: 'dsh',
    createCoordinator: (deps) =>
      new DshHandshakeCoordinator({
        adapter,
        leaseManager: deps.leaseManager,
        stateMachine: deps.stateMachine,
        workspaceKey: deps.workspaceKey
      }),
    shutdown: () => adapter.shutdown()
  };
}
