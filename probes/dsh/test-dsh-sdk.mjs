import { spawn } from 'node:child_process';
import readline from 'node:readline';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

// Helper to resolve direct Node and DSH entrypoint
function getDshLaunchConfig() {
  const localAppData = process.env.LOCALAPPDATA || '';
  const currentJsonPath = path.join(localAppData, 'DSH Desktop', 'runtime', 'current.json');

  if (fs.existsSync(currentJsonPath)) {
    try {
      const state = JSON.parse(fs.readFileSync(currentJsonPath, 'utf8'));
      const runtimeDir = path.join(localAppData, 'DSH Desktop', 'runtime', state.relativeDir);
      const nodeExe = path.join(runtimeDir, 'node', 'node.exe');
      const binJs = path.join(runtimeDir, state.entryRelativePath);
      if (fs.existsSync(nodeExe) && fs.existsSync(binJs)) {
        return {
          command: nodeExe,
          args: [binJs, '--profile', 'sdk'],
          directNode: true,
          runtimeDir
        };
      }
    } catch (err) {
      console.warn('[DSH Probe] Could not resolve direct node runtime:', err.message);
    }
  }

  return {
    command: process.platform === 'win32' ? 'dsh.cmd' : 'dsh',
    args: ['--profile', 'sdk'],
    directNode: false
  };
}

async function runDshProbe({ timeoutMs = 45000 } = {}) {
  const launchConfig = getDshLaunchConfig();
  console.log(`[DSH Probe] Launching DSH SDK server: ${launchConfig.command} ${launchConfig.args.join(' ')}`);

  const proc = spawn(launchConfig.command, launchConfig.args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: !launchConfig.directNode,
    env: {
      ...process.env,
      DSH_PERMISSION_MODE: 'workspace-write'
    }
  });

  const stdoutRl = readline.createInterface({ input: proc.stdout });
  const stderrRl = readline.createInterface({ input: proc.stderr });

  const pending = new Map();
  const notifications = [];
  const stderrLines = [];
  let reqId = 1;

  stdoutRl.on('line', (line) => {
    if (!line.trim()) return;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id).resolve(msg);
        pending.delete(msg.id);
      } else {
        notifications.push(msg);
        console.log(`[DSH Notification] ${msg.method}:`, JSON.stringify(msg.params || {}).slice(0, 150));
      }
    } catch (e) {
      console.log(`[DSH Raw Stdout] ${line}`);
    }
  });

  stderrRl.on('line', (line) => {
    stderrLines.push(line);
    console.log(`[DSH Stderr] ${line}`);
  });

  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = reqId++;
      pending.set(id, { resolve, reject });
      const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
      try {
        proc.stdin.write(payload);
      } catch (err) {
        pending.delete(id);
        reject(err);
      }
    });
  }

  // Timeout guard
  const timer = setTimeout(() => {
    console.warn(`[DSH Probe] Timed out after ${timeoutMs}ms, terminating process...`);
    proc.kill('SIGTERM');
  }, timeoutMs);

  try {
    // 1. Initialize with valid provider and model
    console.log('[DSH Probe] Step 1: Sending initialize (provider: deepseek-official, model: deepseek-chat)...');
    const initRes = await send('initialize', {
      cwd: process.cwd(),
      provider: 'deepseek-official',
      model: 'deepseek-chat'
    });
    console.log('[DSH Probe] Initialize response:', JSON.stringify(initRes, null, 2));

    // 2. Test session/prompt
    const testSessionId = `relay-probe-${randomUUID()}`;
    console.log(`[DSH Probe] Step 2: Sending session/prompt with fresh sessionId: ${testSessionId}...`);
    const promptRes = await send('session/prompt', {
      sessionId: testSessionId,
      contentBlocks: [
        { type: 'text', text: 'Hello, this is an automated probe test from Agent Relay.' }
      ]
    }).catch(err => ({ error: err.message || err }));
    console.log('[DSH Probe] session/prompt response:', JSON.stringify(promptRes, null, 2));

    // Wait 2 seconds to observe any immediate event streams
    await new Promise(r => setTimeout(r, 2000));

    // 3. Test shutdown
    console.log('[DSH Probe] Step 3: Sending shutdown...');
    const shutdownRes = await send('shutdown', {});
    console.log('[DSH Probe] Shutdown response:', JSON.stringify(shutdownRes));

    // Wait for process close
    const exitCode = await new Promise((resolve) => {
      proc.on('close', (code) => resolve(code));
    });

    clearTimeout(timer);
    console.log(`[DSH Probe] DSH exited cleanly with code: ${exitCode}`);

    return {
      success: true,
      launchConfig,
      initRes,
      testSessionId,
      promptRes,
      shutdownRes,
      exitCode,
      notificationsCount: notifications.length,
      notifications: notifications.slice(0, 5),
      stderrLinesCount: stderrLines.length
    };
  } catch (error) {
    clearTimeout(timer);
    proc.kill('SIGKILL');
    throw error;
  }
}

runDshProbe()
  .then((result) => {
    console.log('[DSH Probe] Full Suite Completed:', JSON.stringify(result, null, 2));
    process.exit(0);
  })
  .catch((err) => {
    console.error('[DSH Probe] Failed:', err);
    process.exit(1);
  });
