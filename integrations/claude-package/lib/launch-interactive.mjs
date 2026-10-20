import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const configFile = process.argv[2];
if (!configFile || !fs.existsSync(configFile)) {
  process.exit(1);
}

let cfg;
try {
  cfg = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  fs.unlinkSync(configFile);
} catch (err) {
  process.exit(1);
}

const { workspacePath, sessionId, title, prompt, claudeBin, sessionDir, readyPath, cancelPath } = cfg;
if (!readyPath || !cancelPath) process.exit(1);
if (fs.existsSync(cancelPath)) {
  fs.rmSync(cancelPath, { force: true });
  process.exit(1);
}

function notify(type) {
  fs.writeFileSync(readyPath, JSON.stringify({ type }), { mode: 0o600 });
}

// Set console title
process.stdout.write(`\x1b]0;${title}\x07`);

// Pre-create custom-title.json so /resume picker also shows the title
try {
  const titleDir = path.join(sessionDir, sessionId);
  fs.mkdirSync(titleDir, { recursive: true });
  fs.writeFileSync(
    path.join(titleDir, 'custom-title.json'),
    JSON.stringify({ customTitle: title }),
    'utf8'
  );
} catch {}

// Build clean interactive TTY environment with full 24-bit TrueColor support
// Strip NO_COLOR injected by hook runners so Clawd renders in vibrant coral-orange rgb(215,119,87)
const launchEnv = {
  ...process.env
};
for (const k of [
  'NO_COLOR',
  'NODE_DISABLE_COLORS',
  'CLAUDECODE',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_PID'
]) {
  delete launchEnv[k];
}
launchEnv.COLORTERM = 'truecolor';
launchEnv.FORCE_COLOR = '3';

console.log('\x1b[36m═══════════════════════════════════════════════════════════════════════════════\x1b[0m');
console.log(`\x1b[1;32m🚀 【Agent Relay 跨领域隔离新会话已就绪】\x1b[0m`);
console.log(`\x1b[90m• 会话 ID: ${sessionId}\x1b[0m`);
console.log(`\x1b[90m• 任务标题: ${title}\x1b[0m`);
console.log(`\x1b[90m• 状态: 正在启动独立 Claude 会话...\x1b[0m`);
console.log('\x1b[36m═══════════════════════════════════════════════════════════════════════════════\x1b[0m\n');

if (fs.existsSync(cancelPath)) {
  fs.rmSync(cancelPath, { force: true });
  process.exit(1);
}
const child = spawn(
  claudeBin,
  [
    '--session-id',
    sessionId,
    '--name',
    title,
    '--append-system-prompt',
    'This is the first turn of an independent Agent Relay target session. Execute the supplied user task directly; do not relay this first turn again.',
    '--',
    prompt
  ],
  {
    cwd: workspacePath,
    stdio: 'inherit',
    env: launchEnv
  }
);

child.once('spawn', () => {
  if (fs.existsSync(cancelPath)) {
    child.kill();
    fs.rmSync(cancelPath, { force: true });
    process.exit(1);
  }
  notify('started');
});
child.once('error', () => { notify('failed'); process.exit(1); });
child.once('close', (code) => process.exit(code ?? 1));
