import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { formatHandoffRedirectionNotice } from './handoff-notice.js';
import { judgeTopicShift } from './topic-judge.js';

function resolveClaudeProjectSlug(workspacePath) {
  const resolved = path.resolve(workspacePath);
  return resolved.replace(/[^a-zA-Z0-9]/g, '-');
}

function resolveClaudeSessionFilePath(workspacePath, sessionId) {
  const slug = resolveClaudeProjectSlug(workspacePath);
  return path.join(os.homedir(), '.claude', 'projects', slug, `${sessionId}.jsonl`);
}

function resolveClaudeExecutable() {
  if (process.env.CLAUDE_BIN_PATH) return process.env.CLAUDE_BIN_PATH;
  if (process.platform === 'win32') {
    const localBin = path.join(os.homedir(), '.local', 'bin', 'claude.exe');
    if (fs.existsSync(localBin)) return localBin;
    return 'claude.exe';
  }
  return 'claude';
}

/**
 * WindowsApps\wt.exe is an AppX execution alias (reparse point IO_REPARSE_TAG_APPEXECCLINK).
 * Node's fs.existsSync() returns false on AppX aliases, whereas fs.lstatSync() succeeds!
 */
function hasWtExecutable(wtBinPath) {
  try {
    fs.lstatSync(wtBinPath);
    return true;
  } catch {
    return false;
  }
}

async function waitForTarget(readyPath) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      const result = JSON.parse(fs.readFileSync(readyPath, 'utf8'));
      if (result.type === 'started' || result.type === 'failed') return result.type;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return 'timeout';
}

function sanitizeNestedClaudeEnv(baseEnv = process.env) {
  const clean = { ...baseEnv };
  const keys = [
    'NO_COLOR',
    'NODE_DISABLE_COLORS',
    'CLAUDECODE',
    'CLAUDE_CODE_SESSION_ID',
    'CLAUDE_CODE_MESSAGING_SOCKET',
    'CLAUDE_CODE_MESSAGING_TOKEN',
    'CLAUDE_CODE_CHILD_SESSION',
    'CLAUDE_CODE_SESSION_ATTENDED',
    'CLAUDE_PID'
  ];
  for (const k of keys) delete clean[k];
  clean.COLORTERM = 'truecolor';
  clean.FORCE_COLOR = '3';
  return clean;
}

function extractConversationContext(lines) {
  const prompts = [];
  const assistantContext = [];
  const artifacts = [];
  for (const l of lines) {
    try {
      const obj = JSON.parse(l);
      if (obj.isMeta || obj.isSidechain) continue;
      if (obj.type === 'assistant' && obj.message?.role === 'assistant') {
        const parts = obj.message.content;
        if (typeof parts === 'string') assistantContext.push(parts);
        else if (Array.isArray(parts)) {
          const text = parts.filter((p) => p.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('\n');
          if (text) assistantContext.push(text);
          for (const part of parts) {
            const file = part.type === 'tool_use' && (part.input?.file_path || part.input?.path);
            if (typeof file === 'string') artifacts.push(path.basename(file.replace(/\\/g, '/')));
          }
        }
        continue;
      }
      if (obj.type !== 'user' || obj.message?.role !== 'user') continue;
      const content = obj.message.content;
      if (Array.isArray(content) && content.some((item) => item.type === 'tool_result')) continue;
      const text = typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.filter((item) => item.type === 'text' && typeof item.text === 'string').map((item) => item.text).join('\n')
          : '';
      if (text.trim()) {
        prompts.push(text.trim());
      }
    } catch {}
  }
  return { userPrompts: prompts, assistantContext, artifacts };
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) {
    raw += chunk;
  }
  if (!raw.trim()) {
    process.exit(0);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const { prompt, transcript_path, cwd } = data;
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    process.exit(0);
  }

  if (/^\/\w+(?:\s|$)/.test(prompt.trim())) {
    process.exit(0);
  }

  const workspacePath = cwd || process.cwd();

  // If there is no transcript or file doesn't exist, this is a brand new session; no domain to shift from
  if (!transcript_path || !fs.existsSync(transcript_path)) {
    process.exit(0);
  }

  let context;
  try {
    const content = fs.readFileSync(transcript_path, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    context = extractConversationContext(lines);
    // Some hosts append the submitted prompt before running the hook.
    if (context.userPrompts.at(-1) === prompt.trim()) context.userPrompts.pop();
  } catch {
    process.exit(0);
  }

  if (!context.userPrompts.length) {
    process.exit(0);
  }

  const shift = await judgeTopicShift({ ...context, prompt: prompt.trim() });
  if (!shift.isShift) {
    process.exit(0);
  }

  // Domain shift detected!
  const newSessionId = randomUUID();
  const title = `🚀 [Relay] ${prompt.trim().slice(0, 28)}`;
  const newSessionFile = resolveClaudeSessionFilePath(workspacePath, newSessionId);
  const sessionDir = path.dirname(newSessionFile);
  const libDir = path.dirname(fileURLToPath(import.meta.url));

  const wtBin = path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'WindowsApps', 'wt.exe');
  const canAutoJumpWt =
    process.platform === 'win32' &&
    process.env.AGENT_RELAY_HEADLESS !== '1' &&
    hasWtExecutable(wtBin);

  let jumpedToNewTab = false;
  if (canAutoJumpWt) {
    const configFile = path.join(os.tmpdir(), `relay-launch-${newSessionId}.json`);
    const readyPath = `${configFile}.ready`;
    const cancelPath = `${configFile}.cancel`;
    try {
      fs.writeFileSync(
        configFile,
        JSON.stringify({
          workspacePath,
          sessionId: newSessionId,
          title,
          prompt: prompt.trim(),
          claudeBin: resolveClaudeExecutable(),
          sessionDir,
          readyPath,
          cancelPath
        }),
        { encoding: 'utf8', mode: 0o600 }
      );

      const launchInteractiveScript = path.join(libDir, 'launch-interactive.mjs');
      const wtChild = spawn(
        wtBin,
        [
          '-w',
          '0',
          'new-tab',
          '--title',
          title,
          '-d',
          workspacePath,
          process.execPath,
          launchInteractiveScript,
          configFile
        ],
        {
          cwd: workspacePath,
          detached: true,
          stdio: 'ignore',
          windowsHide: false
        }
      );
      const accepted = await new Promise((resolve) => {
        wtChild.once('spawn', () => resolve(true));
        wtChild.once('error', () => resolve(false));
      });
      wtChild.unref();
      if (accepted) {
        const state = await waitForTarget(readyPath);
        if (state === 'timeout') {
          fs.writeFileSync(cancelPath, '', { mode: 0o600 });
          // An unconfirmed launch must not suppress or duplicate the request.
          process.exitCode = 0;
          return;
        }
        jumpedToNewTab = state === 'started';
      }
    } catch {
      jumpedToNewTab = false;
    } finally {
      fs.rmSync(configFile, { force: true });
      fs.rmSync(readyPath, { force: true });
    }
  }

  if (!jumpedToNewTab) {
    // Fallback: Spawn autonomous headless background worker
    const workerScript = path.join(libDir, 'run-worker.mjs');
    try {
      const worker = spawn(
        process.execPath,
        [workerScript, workspacePath, newSessionId, title, prompt.trim()],
        {
          cwd: workspacePath,
          detached: true,
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
          windowsHide: true
        }
      );
      const started = await new Promise((resolve) => {
        const timer = setTimeout(() => { worker.kill(); finish(false); }, 3000);
        const finish = (ok) => {
          clearTimeout(timer);
          worker.removeAllListeners('message');
          if (worker.connected) worker.disconnect();
          worker.unref();
          resolve(ok);
        };
        worker.once('message', (message) => finish(message?.type === 'started'));
        worker.once('error', () => finish(false));
        worker.once('exit', () => finish(false));
      });
      if (!started) process.exit(0);
    } catch {
      process.exit(0);
    }
  }

  const notice = formatHandoffRedirectionNotice({
    target: 'claude',
    epoch: 1,
    reason: 'domain_shift',
    reasonDetails: jumpedToNewTab
      ? `domain_shift (${shift.previousDomain} -> ${shift.detectedDomain}) [${shift.source}: ${shift.reason || '独立任务'}] [已自动弹出并跳转至 Windows Terminal 新标签页]`
      : `domain_shift (${shift.previousDomain} -> ${shift.detectedDomain}) [${shift.source}: ${shift.reason || '独立任务'}]`,
    previousDomain: shift.previousDomain,
    detectedDomain: shift.detectedDomain,
    title,
    sessionId: newSessionId
  });

  // Output blocking decision to Claude Code
  console.log(
    JSON.stringify({
      decision: 'block',
      reason: '\n' + notice + '\n',
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        suppressOriginalPrompt: true
      }
    })
  );

  process.exit(0);
}

main().catch(() => process.exit(0));
