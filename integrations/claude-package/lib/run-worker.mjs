import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [, , workspacePath, sessionId, title, prompt] = process.argv;
if (!workspacePath || !sessionId || !prompt) process.exit(1);

const env = { ...process.env };
for (const key of [
  'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_PID'
]) delete env[key];

const localBin = path.join(os.homedir(), '.local', 'bin', 'claude.exe');
const bin = process.env.CLAUDE_BIN_PATH || (process.platform === 'win32'
  ? fs.existsSync(localBin) ? localBin : 'claude.exe'
  : 'claude');

// Claude owns session persistence. Do not synthesize or overwrite its JSONL.
const child = spawn(bin, [
  '-p', '--session-id', sessionId, '--name', title,
  '--append-system-prompt',
  'This is the first turn of an independent Agent Relay target session. Execute the supplied user task directly; do not relay this first turn again.',
  '--', prompt
], { cwd: workspacePath, env, stdio: 'ignore', windowsHide: true });

function notify(type, callback) {
  if (process.send && process.connected) process.send({ type }, callback);
  else callback?.();
}
child.once('spawn', () => notify('started', () => {
  if (process.connected) process.disconnect();
}));
child.once('error', () => notify('failed', () => process.exit(1)));
child.once('close', (code) => process.exit(code ?? 1));
