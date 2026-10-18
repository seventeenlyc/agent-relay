import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function endpointPath() {
  return path.join(os.homedir(), '.dsh', 'agent-relay', 'endpoint.json');
}

function originOf(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('DSH endpoint must use HTTP or HTTPS');
  return url.origin;
}

/** The host publishes its bound origin; no browser tokens are persisted. */
export function publishDshEndpoint(origin) {
  const file = endpointPath();
  const record = JSON.stringify({ origin: originOf(origin), pid: process.pid });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(temp, record, { mode: 0o600 });
  fs.renameSync(temp, file);
  return () => {
    try {
      if (fs.readFileSync(file, 'utf8') === record) fs.unlinkSync(file);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  };
}

export function resolveDshUrl(customUrl) {
  const explicit = customUrl ?? process.env.DSH_WEB_URL;
  if (explicit) return originOf(explicit);
  try {
    const entry = JSON.parse(fs.readFileSync(endpointPath(), 'utf8'));
    if (!Number.isSafeInteger(entry.pid) || entry.pid <= 0) throw new Error('Invalid host PID');
    process.kill(entry.pid, 0);
    const url = new URL(entry.origin);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Discovery requires a loopback address');
    return originOf(entry.origin);
  } catch {
    throw new Error('Cannot discover a running DSH Desktop. Enable agent-relay-dsh in Desktop or set DSH_WEB_URL to its current origin.');
  }
}
