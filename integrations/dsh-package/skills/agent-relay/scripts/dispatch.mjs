#!/usr/bin/env node
/**
 * Agent Relay DSH Multi-Session Dispatcher
 *
 * 自动在 DSH 桌面端创建、重命名、打开新会话，并通过 session/prompt 派发任务。
 * 彻底避免单窗口包揽多阶段任务，实现真正的跨会话物理隔离与自动化接力。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { RelayDatabase } from '../../../lib/relay-db.js';
import { normalizeWorkspaceKey } from '../../../lib/workspace-key.js';
import { pathToFileURL } from 'node:url';
import { resolveDshUrl } from '../../../lib/connection.js';
import { createAuthCookie, resolveWorkspaceId as findWorkspaceId } from '../../../lib/materializer.js';


export class RelayDispatcher {
  constructor(workspacePath = process.cwd(), options = {}) {
    this.workspacePath = path.resolve(workspacePath);
    this.workspaceId = findWorkspaceId(this.workspacePath);
    if (!this.workspaceId) throw new Error(`未在 DSH 中找到工作区: ${this.workspacePath}`);
    this.baseUrl = resolveDshUrl(options.webUrl);
    this.authority = new URL(this.baseUrl).host;
    this.cookie = createAuthCookie(this.authority);
    if (!this.cookie) throw new Error('Cannot authenticate with DSH: missing browser-session secret');
    this.maxWaitMs = options.maxWaitMs ?? 120000;
    this.pollIntervalMs = options.pollIntervalMs ?? 1200;
  }

  async rpc(method, payload) {
    const res = await fetch(`${this.baseUrl}/api/${method}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': this.cookie,
        'Host': this.authority,
        'Origin': this.baseUrl
      },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'rpc-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
        method,
        payload
      }),
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) throw new Error(`${method} failed (HTTP ${res.status})`);
    const response = await res.json();
    if (!res.ok || !response.result?.ok) {
      throw new Error(`${method} failed (HTTP ${res.status}): ${response.result?.error?.message ?? 'RPC rejected'}`);
    }
    return response;
  }

  async createSession(title) {
    const cRes = await this.rpc('session/create', { args: { request: { workspaceId: this.workspaceId } } });
    const sessionId = cRes.result?.value?.sessionId;
    if (!sessionId) throw new Error('创建会话失败: ' + JSON.stringify(cRes));
    await this.rpc('session/rename', { args: { request: { sessionId, title } } });
    return sessionId;
  }

  async sendPrompt(sessionId, text) {
    return await this.rpc('session/prompt', {
      args: {
        request: {
          sessionId,
          requestId: 'req-' + Date.now() + '-' + randomUUID(),
          mode: 'queue',
          content: [{ type: 'text', text }]
        }
      }
    });
  }

  async waitSettled(sessionId, maxWaitMs = this.maxWaitMs ?? 120000) {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      await new Promise((r) => setTimeout(r, this.pollIntervalMs ?? 1200));
      const listRes = await this.rpc('session/list', { args: { _request: { workspaceId: this.workspaceId } } });
      const item = listRes.result?.value?.items?.find((x) => x.sessionId === sessionId);
      if (!item) continue;
      if (!item.running) {
        const throughSeq = item.projections?.asOfSeq;
        if (!Number.isSafeInteger(throughSeq)) throw new Error(`DSH session ${sessionId} has no durable history cursor`);
        const page = await this.rpc('session/page', { args: { request: {
          address: { kind: 'session', sessionId }, throughSeq, maxMessages: 10,
        } } });
        const events = (page.result?.value?.records ?? []).filter(r => r.type === 'event').map(r => r.event);
        const lastStart = events.findLastIndex(e => e.type === 'turn/start');
        const lastEnd = events.findLastIndex(e => e.type === 'turn/end');
        if (lastEnd < 0 || lastEnd < lastStart) continue;
        const reason = events[lastEnd].data?.reason?.kind;
        if (reason !== 'completed') throw new Error(`DSH session ${sessionId} ended with ${reason ?? 'unknown reason'}`);
        return item;
      }
    }
    return null;
  }

  /**
   * 顺序执行多阶段接力派发
   * @param {Array<{ title: string, prompt: string, wait?: boolean }>} stages
   */
  async runPipeline(stages, runId = 'relay-run-' + Date.now()) {
    if (!Array.isArray(stages) || !stages.length || stages.some(s => !s || typeof s.title !== 'string' || typeof s.prompt !== 'string')) {
      throw new TypeError('stages must be a non-empty array of title/prompt objects');
    }
    if (stages.slice(0, -1).some(s => s.wait === false)) {
      throw new Error('Only the final stage may run in background; handoffs require completion');
    }
    console.log(`\n🚀 [Agent Relay Dispatcher] 启动多会话接力流水线 (Run: ${runId})`);
    const results = [];
    let prevSessionId = null;

    // 打开 relay.db 记录链
    const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
    const dataDir = process.env.AGENT_RELAY_DATA_DIR ?? path.join(localAppData, 'agent-relay');
    fs.mkdirSync(dataDir, { recursive: true });
    const db = new RelayDatabase({ dbPath: path.join(dataDir, 'relay.db') });
    let inserted = false;

    try {
      db.prepare(`
        INSERT INTO runs (
          run_id, workspace_key, workspace_path, goal, state,
          provider, model, effort, current_session_id, current_epoch,
          handoff_count, unit_count, current_session_unit_count, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        runId, normalizeWorkspaceKey(this.workspacePath), this.workspacePath, stages[0]?.title ?? 'Relay Pipeline',
        'RUNNING', 'antigravity', 'gemini-3.8-flash-high', 'high', 'pending',
        1, 0, stages.length, 1, Date.now(), Date.now()
      );

      inserted = true;

      for (let i = 0; i < stages.length; i++) {
        const stage = stages[i];
        const epoch = i + 1;
        console.log(`\n▶ [阶段 ${epoch}/${stages.length}] 在 DSH 侧边栏创建独立会话: "${stage.title}"`);

        const sessionId = await this.createSession(stage.title);
        const url = `${this.baseUrl}/#/${sessionId}`;
        db.prepare('UPDATE runs SET current_session_id = ?, current_epoch = ?, handoff_count = ?, updated_at = ? WHERE run_id = ?')
          .run(sessionId, epoch, i, Date.now(), runId);
        console.log(`  -> 会话 ID: ${sessionId} (已在左侧边栏静默挂载，不自动弹外置浏览器网页)`);

        // 注入前驱交接指纹信息
        let fullPrompt = stage.prompt;
        if (prevSessionId) {
          fullPrompt = `【Agent Relay 接力信号】已承接来自前序会话 (${prevSessionId}) 的 CAS 租约。\n\n${fullPrompt}`;
        }

        console.log(`  -> 正在将任务派发至该独立会话中执行...`);
        await this.sendPrompt(sessionId, fullPrompt);

        // 记录 session_chain
        db.prepare(`
          INSERT INTO session_chain (
            link_id, run_id, sequence, prev_session_id, next_session_id,
            adapter, provider, model, effort, epoch, handoff_id, reason, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          randomUUID(), runId, epoch, prevSessionId, sessionId,
          'dsh', 'antigravity', 'gemini-3.8-flash-high', 'high', epoch,
          `handoff-${runId}-ep${epoch}`, prevSessionId ? 'unit_completed' : 'initial_spawn', Date.now()
        );

        if (stage.wait !== false) {
          console.log(`  -> 正在等待该会话独立 Agent 执行完毕...`);
          const settled = await this.waitSettled(sessionId);
          if (!settled) throw new Error(`DSH stage ${epoch} timeout: ${sessionId}; later stages were not dispatched`);
          console.log(`  ✅ 阶段 ${epoch} 执行完成！`);
        } else {
          console.log(`  ⚡ 已在后台持续执行（非阻塞模式）`);
        }

        results.push({ epoch, sessionId, title: stage.title, url });
        prevSessionId = sessionId;

        db.prepare(`
          UPDATE runs SET current_session_id = ?, current_epoch = ?, handoff_count = ?, updated_at = ? WHERE run_id = ?
        `).run(sessionId, epoch, i, Date.now(), runId);
      }

      const state = stages.at(-1).wait === false ? 'RUNNING' : 'COMPLETED';
      db.prepare('UPDATE runs SET state = ?, updated_at = ? WHERE run_id = ?').run(state, Date.now(), runId);
      console.log(state === 'COMPLETED' ? '\nAgent Relay pipeline completed.' : '\nAgent Relay final stage is running in background.');
      return { runId, state, stages: results };
    } catch (error) {
      if (inserted) db.prepare("UPDATE runs SET state = 'RECOVERY_REQUIRED', updated_at = ? WHERE run_id = ?").run(Date.now(), runId);
      throw error;
    } finally {
      db.close();
    }
  }
}

// CLI 执行入口
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const rawInput = process.argv[2];
  if (!rawInput) {
    console.log('Usage: node dispatch.mjs \'<stages_json_or_file>\'');
    process.exit(1);
  }

  let stages;
  if (fs.existsSync(rawInput)) {
    stages = JSON.parse(fs.readFileSync(rawInput, 'utf8'));
  } else {
    stages = JSON.parse(rawInput);
  }

  const dispatcher = new RelayDispatcher();
  await dispatcher.runPipeline(stages);
}
