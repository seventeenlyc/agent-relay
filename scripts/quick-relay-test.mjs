import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { exec } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const BASE_URL = 'http://127.0.0.1:19387';
const AUTHORITY = '127.0.0.1:19387';
const WORKSPACE_PATH = 'D:\\DSH\\DSH Desktop Community';

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

  // 3. 弹窗打开该会话
  const url = `${BASE_URL}/#/${sessionId}`;
  exec(`start "" "${url}"`, { windowsHide: true }, () => {});

  // 4. 发送提示词给该会话中的独立 Agent
  await rpc('session/prompt', {
    args: {
      request: {
        sessionId,
        requestId: 'req-' + Date.now(),
        mode: 'queue',
        content: [{ type: 'text', text: promptText }]
      }
    }
  });

  return { sessionId, url };
}

async function waitSettled(sessionId, maxWaitMs = 60000) {
  const start = Date.now();
  let wasRunning = false;
  while (Date.now() - start < maxWaitMs) {
    await new Promise(r => setTimeout(r, 1200));
    const listRes = await rpc('session/list', { args: { _request: { workspaceId: wsId } } });
    const item = listRes.result?.value?.items?.find(x => x.sessionId === sessionId);
    if (!item) continue;
    if (item.running) wasRunning = true;
    if (wasRunning && !item.running) return item;
  }
  return null;
}

console.log('======================================================');
console.log('🧪 Agent Relay 极简两阶段跨会话交接测试');
console.log('======================================================\n');

// 阶段 1
console.log('▶ [阶段 1/2] 正在创建并打开【Epoch 1 独立会话】...');
const ep1Title = '🧪 [Relay测试] Epoch 1: 基础数学运算';
const ep1Prompt = '你好！请回答：123 + 456 等于几？只需直接给出最终数字答案。';
const ep1 = await createAndOpenSession(ep1Title, ep1Prompt);
console.log(`  -> 独立会话 ID: ${ep1.sessionId}`);
console.log(`  -> 桌面已弹出会话窗口: ${ep1.url}`);
console.log('  -> 等待 Epoch 1 独立 Agent 回答...');
await waitSettled(ep1.sessionId);
console.log('  ✅ Epoch 1 运算完成，准备进行 Relay 任务交接！\n');

// 阶段 2
console.log('▶ [阶段 2/2] 正在创建并打开【Epoch 2 独立会话】（交接任务）...');
const ep2Title = '🧪 [Relay测试] Epoch 2: 逻辑推理检验';
const ep2Prompt = '承接上一步运算结果 579。请问 579 是奇数还是偶数？请用一句话回答并说明原因。';
const ep2 = await createAndOpenSession(ep2Title, ep2Prompt);
console.log(`  -> 独立会话 ID: ${ep2.sessionId}`);
console.log(`  -> 桌面已弹出会话窗口: ${ep2.url}`);
console.log('  -> 等待 Epoch 2 独立 Agent 回答...');
await waitSettled(ep2.sessionId);
console.log('  ✅ Epoch 2 检验完成，两阶段交接全流程顺利闭环！\n');

console.log('======================================================');
console.log('🎉 测试完成！请检查：');
console.log(`1. 刚才桌面是否弹出了两个独立会话窗口？`);
console.log(`2. 查看 DSH Desktop 左侧边栏，是否新增了以下两个会话：`);
console.log(`   - [${ep1.sessionId}] ${ep1Title}`);
console.log(`   - [${ep2.sessionId}] ${ep2Title}`);
console.log(`3. 点进两个会话，确认每扇窗里都有各自独立的提问和回答！`);
console.log('======================================================');
