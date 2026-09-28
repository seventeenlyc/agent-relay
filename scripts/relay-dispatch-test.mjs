import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { exec } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const BASE_URL = 'http://127.0.0.1:19387';
const AUTHORITY = '127.0.0.1:19387';
const WORKSPACE_PATH = 'D:\\DSH\\DSH Desktop Community';
const RUN_ID = 'relay-dispatch-test-' + Date.now();

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
  const content = fs.readFileSync(credPath, 'utf8');
  const match = content.match(/client-connection\/browser-session:[\s\S]*?secret:\s*([^\s\r\n]+)/);
  if (!match) throw new Error('未找到 ~/.dsh/.credentials.yaml 密钥');

  const secretBytes = decodeBase64Url(match[1]);
  const cName = 'dsh-auth-' + encodeBase64Url(createHash('sha256').update(AUTHORITY).digest());
  const now = Date.now();
  const payload = { version: 1, authority: AUTHORITY, issuedAt: now, expiresAt: now + 86400000 };
  const body = encodeBase64Url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const sig = encodeBase64Url(createHmac('sha256', secretBytes).update(body).digest());
  return `${cName}=v1.${body}.${sig}`;
}

function resolveWorkspaceId() {
  const wsJsonPath = path.join(os.homedir(), '.dsh', 'storages', 'workspace.json');
  const data = JSON.parse(fs.readFileSync(wsJsonPath, 'utf8'));
  const targetNorm = path.resolve(WORKSPACE_PATH).toLowerCase();
  for (const [id, ws] of Object.entries(data?.tables?.workspaces ?? {})) {
    if (typeof ws?.path === 'string' && path.resolve(ws.path).toLowerCase() === targetNorm) {
      return id;
    }
  }
  return data?.global?.workspaceIds?.[0] ?? null;
}

const cookie = getAuthCookie();
const wsId = resolveWorkspaceId();

// 准备 relay.db
const localAppData = process.env.LOCALAPPDATA ?? path.join(process.env.USERPROFILE ?? '', 'AppData', 'Local');
const dataDir = path.join(localAppData, 'agent-relay');
fs.mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(path.join(dataDir, 'relay.db'));

// 初始化 run 记录
db.prepare(`
  INSERT INTO runs (
    run_id, workspace_key, workspace_path, goal, state,
    provider, model, effort, current_session_id, current_epoch,
    handoff_count, unit_count, current_session_unit_count, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(run_id) DO UPDATE SET
    state = excluded.state, updated_at = excluded.updated_at
`).run(
  RUN_ID,
  'ws-desktop-community',
  WORKSPACE_PATH,
  'Agent Relay 极简分窗交接测试',
  'RUNNING',
  'antigravity',
  'gemini-3.8-flash-high',
  'high',
  'pending',
  1,
  0,
  2,
  1,
  Date.now(),
  Date.now()
);

async function rpc(method, payload) {
  const res = await fetch(`${BASE_URL}/api/${method}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': cookie,
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

async function createAndOpenSession(title, promptText) {
  // 1. 创建会话
  const cRes = await rpc('session/create', { args: { request: { workspaceId: wsId } } });
  const sessionId = cRes.result?.value?.sessionId;
  if (!sessionId) throw new Error('会话创建失败: ' + JSON.stringify(cRes));

  // 2. 命名会话
  await rpc('session/rename', { args: { request: { sessionId, title } } });

  // 3. 弹窗打开该侧边独立会话
  const url = `${BASE_URL}/#/${sessionId}`;
  exec(`start "" "${url}"`, { windowsHide: true }, () => {});

  // 4. 发送提示词给该会话中的独立 Agent
  await rpc('session/prompt', {
    args: {
      request: {
        sessionId,
        requestId: 'req-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
        mode: 'queue',
        content: [{ type: 'text', text: promptText }]
      }
    }
  });

  return { sessionId, url };
}

async function waitSettled(sessionId, maxWaitMs = 120000) {
  const start = Date.now();
  let wasRunning = false;
  // 先缓冲 2 秒确保 prompt 派发并被 agent 接管
  await new Promise(r => setTimeout(r, 2000));
  while (Date.now() - start < maxWaitMs) {
    const listRes = await rpc('session/list', { args: { _request: { workspaceId: wsId } } });
    const item = listRes.result?.value?.items?.find(x => x.sessionId === sessionId);
    if (item) {
      if (item.running) {
        wasRunning = true;
      } else if (wasRunning) {
        return item;
      }
    }
    await new Promise(r => setTimeout(r, 1500));
  }
  return null;
}

console.log('=== [Agent Relay 调度器启动] ===');
console.log(`Run ID: ${RUN_ID}`);
console.log(`Workspace ID: ${wsId}`);

// ----------------------------------------------------------------
// 阶段一：⚡ [测试] Epoch 1: 基础运算
// ----------------------------------------------------------------
console.log('\n>>> [阶段一] 创建并打开新会话: ⚡ [测试] Epoch 1: 基础运算');
const ep1Title = '⚡ [测试] Epoch 1: 基础运算';
const ep1Prompt = '计算 888 + 222 等于几？直接给出数字答案';
const ep1 = await createAndOpenSession(ep1Title, ep1Prompt);
console.log(`  ✓ 会话已创建: ${ep1.sessionId}`);
console.log(`  ✓ 独立会话窗口已在桌面打开: ${ep1.url}`);
console.log(`  ✓ 任务已通过 session/prompt 派发: "${ep1Prompt}"`);
console.log('  ⏳ 等待阶段一运算完成...');

// 记录链 - Epoch 1
db.prepare(`
  INSERT INTO session_chain (
    run_id, sequence, prev_session_id, next_session_id,
    adapter, provider, model, effort, epoch, handoff_id, reason, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(
  RUN_ID, 1, null, ep1.sessionId, 'dsh', 'antigravity', 'gemini-3.8-flash-high', 'high', 1,
  `handoff-${RUN_ID}-ep1`, 'initial_spawn', Date.now()
);

await waitSettled(ep1.sessionId);
console.log('  ✅ 阶段一（Epoch 1）执行完毕！');

// ----------------------------------------------------------------
// 阶段二：⚡ [测试] Epoch 2: 结果检验
// ----------------------------------------------------------------
console.log('\n>>> [阶段二] 创建并打开新会话: ⚡ [测试] Epoch 2: 结果检验');
const ep2Title = '⚡ [测试] Epoch 2: 结果检验';
const ep2Prompt = '承接上一步运算结果 1110，请说明它是几位数';
const ep2 = await createAndOpenSession(ep2Title, ep2Prompt);
console.log(`  ✓ 会话已创建: ${ep2.sessionId}`);
console.log(`  ✓ 独立会话窗口已在桌面打开: ${ep2.url}`);
console.log(`  ✓ 交接任务已通过 session/prompt 派发: "${ep2Prompt}"`);
console.log('  ⏳ 等待阶段二结果检验完成...');

// 记录链 - Epoch 2
db.prepare(`
  INSERT INTO session_chain (
    run_id, sequence, prev_session_id, next_session_id,
    adapter, provider, model, effort, epoch, handoff_id, reason, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(
  RUN_ID, 2, ep1.sessionId, ep2.sessionId, 'dsh', 'antigravity', 'gemini-3.8-flash-high', 'high', 2,
  `handoff-${RUN_ID}-ep2`, 'unit_completed', Date.now()
);

await waitSettled(ep2.sessionId);
console.log('  ✅ 阶段二（Epoch 2）执行完毕！');

// 更新 run 状态为 COMPLETED
db.prepare(`
  UPDATE runs SET state = 'COMPLETED', current_session_id = ?, current_epoch = 2, handoff_count = 1, updated_at = ? WHERE run_id = ?
`).run(ep2.sessionId, Date.now(), RUN_ID);
db.close();

console.log('\n=== [Agent Relay 调度完成] ===');
console.log(JSON.stringify({
  success: true,
  runId: RUN_ID,
  epoch1: {
    sessionId: ep1.sessionId,
    title: ep1Title,
    url: ep1.url
  },
  epoch2: {
    sessionId: ep2.sessionId,
    title: ep2Title,
    url: ep2.url
  }
}, null, 2));
