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
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const BASE_URL = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:19387';
const AUTHORITY = new URL(BASE_URL).host;

function decodeBase64Url(str) {
  let b64 = str.replaceAll('-', '+').replaceAll('_', '/');
  while (b64.length % 4) b64 += '=';
  return Buffer.from(b64, 'base64');
}

function encodeBase64Url(buf) {
  return buf.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function getAuthCookie() {
  const credPath = path.join(os.homedir(), '.dsh', '.credentials.yaml');
  if (!fs.existsSync(credPath)) throw new Error('未找到 ~/.dsh/.credentials.yaml 密钥文件');
  const content = fs.readFileSync(credPath, 'utf8');
  const match = content.match(/client-connection\/browser-session:[\s\S]*?secret:\s*([^\s\r\n]+)/);
  if (!match) throw new Error('~/.dsh/.credentials.yaml 中缺少 browser-session 密钥');

  const secretBytes = decodeBase64Url(match[1]);
  const cName = 'dsh-auth-' + encodeBase64Url(createHash('sha256').update(AUTHORITY).digest());
  const now = Date.now();
  const payload = { version: 1, authority: AUTHORITY, issuedAt: now, expiresAt: now + 86400000 };
  const body = encodeBase64Url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const sig = encodeBase64Url(createHmac('sha256', secretBytes).update(body).digest());
  return `${cName}=v1.${body}.${sig}`;
}

function resolveWorkspaceId(workspacePath = process.cwd()) {
  const wsJsonPath = path.join(os.homedir(), '.dsh', 'storages', 'workspace.json');
  if (!fs.existsSync(wsJsonPath)) return null;
  const data = JSON.parse(fs.readFileSync(wsJsonPath, 'utf8'));
  const targetNorm = path.resolve(workspacePath).toLowerCase();
  for (const [id, ws] of Object.entries(data?.tables?.workspaces ?? {})) {
    if (typeof ws?.path === 'string' && path.resolve(ws.path).toLowerCase() === targetNorm) {
      return id;
    }
  }
  return data?.global?.workspaceIds?.[0] ?? null;
}

export class RelayDispatcher {
  constructor(workspacePath = process.cwd()) {
    this.workspacePath = path.resolve(workspacePath);
    this.workspaceId = resolveWorkspaceId(this.workspacePath);
    if (!this.workspaceId) throw new Error(`未在 DSH 中找到工作区: ${this.workspacePath}`);
    this.cookie = getAuthCookie();
  }

  async rpc(method, payload) {
    const res = await fetch(`${BASE_URL}/api/${method}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': this.cookie,
        'Host': AUTHORITY,
        'Origin': BASE_URL
      },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'rpc-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
        method,
        payload
      })
    });
    return await res.json();
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

  async waitSettled(sessionId, maxWaitMs = 120000) {
    const start = Date.now();
    let wasRunning = false;
    while (Date.now() - start < maxWaitMs) {
      await new Promise((r) => setTimeout(r, 1200));
      const listRes = await this.rpc('session/list', { args: { _request: { workspaceId: this.workspaceId } } });
      const item = listRes.result?.value?.items?.find((x) => x.sessionId === sessionId);
      if (!item) continue;
      if (item.running) wasRunning = true;
      if (wasRunning && !item.running) return item;
    }
    return null;
  }

  /**
   * 顺序执行多阶段接力派发
   * @param {Array<{ title: string, prompt: string, wait?: boolean }>} stages
   */
  async runPipeline(stages, runId = 'relay-run-' + Date.now()) {
    console.log(`\n🚀 [Agent Relay Dispatcher] 启动多会话接力流水线 (Run: ${runId})`);
    const results = [];
    let prevSessionId = null;

    // 打开 relay.db 记录链
    const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
    const dataDir = path.join(localAppData, 'agent-relay');
    fs.mkdirSync(dataDir, { recursive: true });
    const db = new DatabaseSync(path.join(dataDir, 'relay.db'));

    try {
      db.prepare(`
        INSERT INTO runs (
          run_id, workspace_key, workspace_path, goal, state,
          provider, model, effort, current_session_id, current_epoch,
          handoff_count, unit_count, current_session_unit_count, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET updated_at = excluded.updated_at
      `).run(
        runId, 'ws-relay', this.workspacePath, stages[0]?.title ?? 'Relay Pipeline',
        'RUNNING', 'antigravity', 'gemini-3.8-flash-high', 'high', 'pending',
        1, 0, stages.length, 1, Date.now(), Date.now()
      );

      for (let i = 0; i < stages.length; i++) {
        const stage = stages[i];
        const epoch = i + 1;
        console.log(`\n▶ [阶段 ${epoch}/${stages.length}] 在 DSH 侧边栏创建独立会话: "${stage.title}"`);

        const sessionId = await this.createSession(stage.title);
        const url = `${BASE_URL}/#/${sessionId}`;
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
            run_id, sequence, prev_session_id, next_session_id,
            adapter, provider, model, effort, epoch, handoff_id, reason, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          runId, epoch, prevSessionId, sessionId,
          'dsh', 'antigravity', 'gemini-3.8-flash-high', 'high', epoch,
          `handoff-${runId}-ep${epoch}`, prevSessionId ? 'unit_completed' : 'initial_spawn', Date.now()
        );

        if (stage.wait !== false) {
          console.log(`  -> 正在等待该会话独立 Agent 执行完毕...`);
          await this.waitSettled(sessionId);
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

      db.prepare(`UPDATE runs SET state = 'COMPLETED', updated_at = ? WHERE run_id = ?`).run(Date.now(), runId);
      console.log(`\n🎉 [Agent Relay Dispatcher] 全流程多会话接力全部顺利达成！`);
      return { runId, stages: results };
    } finally {
      db.close();
    }
  }
}

// CLI 执行入口
if (import.meta.url === `file://${process.argv[1]}`) {
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
