import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, createHmac, randomUUID } from 'node:crypto';

function decodeBase64Url(str) {
  let b64 = str.replaceAll('-', '+').replaceAll('_', '/');
  while (b64.length % 4) b64 += '=';
  return Buffer.from(b64, 'base64');
}

function encodeBase64Url(buf) {
  return buf.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

/** Resolve DSH home directory (~/.dsh) */
function getDshHome() {
  return path.join(os.homedir(), '.dsh');
}

/** Extract secret from ~/.dsh/.credentials.yaml */
function getAuthSecret() {
  const credPath = path.join(getDshHome(), '.credentials.yaml');
  if (!fs.existsSync(credPath)) return null;
  const content = fs.readFileSync(credPath, 'utf8');
  const match = content.match(/client-connection\/browser-session:[\s\S]*?secret:\s*([^\s\r\n]+)/);
  if (!match) return null;
  return decodeBase64Url(match[1]);
}

/** Resolve workspace ID from ~/.dsh/storages/workspace.json */
export function resolveWorkspaceId(workspacePath) {
  const wsJsonPath = path.join(getDshHome(), 'storages', 'workspace.json');
  if (!fs.existsSync(wsJsonPath)) return null;

  try {
    const data = JSON.parse(fs.readFileSync(wsJsonPath, 'utf8'));
    const workspaces = data?.tables?.workspaces ?? {};
    const targetNorm = path.resolve(workspacePath).toLowerCase();

    for (const [id, ws] of Object.entries(workspaces)) {
      if (typeof ws?.path === 'string' && path.resolve(ws.path).toLowerCase() === targetNorm) {
        return id;
      }
    }
    const ids = data?.global?.workspaceIds;
    if (Array.isArray(ids) && ids.length > 0) return ids[0];
  } catch {
    // Ignore storage read error
  }
  return null;
}

/** Mint signed DSH cookie header for given host authority */
export function createAuthCookie(authority) {
  const secretBytes = getAuthSecret();
  if (!secretBytes) return null;

  const cName = 'dsh-auth-' + encodeBase64Url(createHash('sha256').update(authority).digest());
  const now = Date.now();
  const payload = {
    version: 1,
    authority,
    issuedAt: now,
    expiresAt: now + 86400000
  };

  const body = encodeBase64Url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const sig = encodeBase64Url(createHmac('sha256', secretBytes).update(body).digest());
  return `${cName}=v1.${body}.${sig}`;
}

export class DshSessionMaterializer {
  constructor(customUrl) {
    const raw = customUrl ?? process.env.DSH_WEB_URL ?? 'http://127.0.0.1:19387';
    const parsed = new URL(raw);
    this.baseUrl = `${parsed.protocol}//${parsed.host}`;
    this.authority = parsed.host;
  }

  /**
   * Materialize a real DSH Desktop session:
   * 1. Calls session/create via DSH HTTP RPC (attaching it to the active workspace)
   * 2. Calls session/rename to set the display title in the left sidebar
   * 3. Sends prompt via session/prompt RPC so DSH's native persistence handles session logs
   *    (prevents "refusing to materialize: a log already exists on disk" collision)
   */
  async materializeSession(options) {
    const cookie = createAuthCookie(this.authority);
    if (!cookie) throw new Error('Cannot authenticate with DSH Desktop: missing signing secret in ~/.dsh/.credentials.yaml');

    const workspaceId = resolveWorkspaceId(options.workspacePath);
    if (!workspaceId) throw new Error(`Cannot find DSH workspace for path: ${options.workspacePath}`);

    // 1. Create Session in DSH Host
    const createRes = await fetch(`${this.baseUrl}/api/session/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': cookie,
        'Host': this.authority,
        'Origin': this.baseUrl
      },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'rpc-mat-create-' + Date.now(),
        method: 'session/create',
        payload: {
          args: {
            request: {
              workspaceId
            }
          }
        }
      })
    });

    const createJson = await createRes.json();
    if (!createJson.result?.ok) {
      throw new Error(`session/create failed: ${createJson.result?.error?.message ?? JSON.stringify(createJson)}`);
    }

    const sessionId = createJson.result.value.sessionId;

    // 2. Set Session Title
    await fetch(`${this.baseUrl}/api/session/rename`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': cookie,
        'Host': this.authority,
        'Origin': this.baseUrl
      },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'rpc-mat-rename-' + Date.now(),
        method: 'session/rename',
        payload: {
          args: {
            request: {
              sessionId,
              title: options.title
            }
          }
        }
      })
    });

    // 3. Send Prompt via official session/prompt API
    const promptText =
      options.userMessage ??
      `【Agent Relay 任务执行】\n运行 ID: ${options.runId}\n当前 Epoch: ${options.epoch}\n交接目标: ${options.title}\n\n${
        options.handoffInfo ? '交接信息:\n```json\n' + JSON.stringify(options.handoffInfo, null, 2) + '\n```' : ''
      }`;

    await fetch(`${this.baseUrl}/api/session/prompt`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': cookie,
        'Host': this.authority,
        'Origin': this.baseUrl
      },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'rpc-mat-prompt-' + Date.now(),
        method: 'session/prompt',
        payload: {
          args: {
            request: {
              sessionId,
              requestId: 'req-' + Date.now() + '-' + randomUUID(),
              mode: 'queue',
              content: [{ type: 'text', text: promptText }]
            }
          }
        }
      })
    });

    return {
      sessionId,
      title: options.title,
      url: `${this.baseUrl}/#/${sessionId}`
    };
  }
}
