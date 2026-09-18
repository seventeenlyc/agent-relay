// tests/adapters/claude-runner.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { ClaudeProcessRunner } from '../../packages/adapters/claude/src/runner.ts';
import type { ClaudeStreamEvent } from '../../packages/adapters/claude/src/types.ts';

const MOCK_CLI_PATH = fileURLToPath(new URL('../fixtures/mock-claude-cli.mjs', import.meta.url));

test('claude-runner: executes mock CLI and collects structured stream-json events', async () => {
  const runner = new ClaudeProcessRunner({
    binPath: process.execPath, // node
    extraArgsPrefix: [MOCK_CLI_PATH]
  });

  const capturedEvents: ClaudeStreamEvent[] = [];
  const sessionId = 'test-uuid-runner-1';

  const result = await runner.runSession({
    sessionId,
    runId: 'run-1',
    model: { provider: 'anthropic', model: 'claude-3-7-sonnet', effort: 'high' },
    bare: true,
    includeHookEvents: true,
    initialPrompt: 'Respond with PROBE_OK',
    onEvent: (ev) => {
      capturedEvents.push(ev);
    }
  });

  assert.strictEqual(result.sessionId, sessionId);
  assert.strictEqual(result.code, 0);
  assert.strictEqual(result.timedOut, false);

  // Verify system:init event
  const init = capturedEvents.find((e) => e.type === 'system' && (e as any).subtype === 'init');
  assert.ok(init);
  assert.strictEqual((init as any).session_id, sessionId);
  assert.strictEqual((init as any).model, 'claude-3-7-sonnet');

  // Verify assistant event
  const assistant = capturedEvents.find((e) => e.type === 'assistant');
  assert.ok(assistant);
  assert.strictEqual((assistant as any).message?.content?.[0]?.text, 'PROBE_OK');

  // Verify result event
  const resEv = capturedEvents.find((e) => e.type === 'result');
  assert.ok(resEv);
  assert.strictEqual((resEv as any).subtype, 'success');
  assert.strictEqual((resEv as any).result, 'PROBE_OK');
});

test('claude-runner: terminates safely on timeout and sets timedOut flag', async () => {
  const runner = new ClaudeProcessRunner({
    binPath: process.execPath,
    extraArgsPrefix: [MOCK_CLI_PATH, '--sleep', '2000']
  });

  const result = await runner.runSession({
    sessionId: 'test-uuid-timeout',
    runId: 'run-1',
    initialPrompt: 'Hang',
    timeoutMs: 150
  });

  assert.strictEqual(result.timedOut, true);
  assert.strictEqual(result.sessionId, 'test-uuid-timeout');
});

test('claude-runner: supports manual termination and input rejection on inactive session', async () => {
  const runner = new ClaudeProcessRunner({
    binPath: process.execPath,
    extraArgsPrefix: [MOCK_CLI_PATH, '--sleep', '3000']
  });

  // Test input rejection on nonexistent session
  assert.strictEqual(runner.sendInput('nonexistent-session', 'hello'), false);
  assert.strictEqual(runner.terminateSession('nonexistent-session'), false);

  const sessionPromise = runner.runSession({
    sessionId: 'test-uuid-manual-term',
    runId: 'run-term',
    initialPrompt: 'Wait'
  });

  // Allow process to spawn
  await new Promise((resolve) => setTimeout(resolve, 80));

  const termResult = runner.terminateSession('test-uuid-manual-term');
  assert.strictEqual(termResult, true);

  const result = await sessionPromise;
  assert.strictEqual(result.sessionId, 'test-uuid-manual-term');
  assert.strictEqual(result.timedOut, false);
});

test('claude-runner: captures stderr lines and raw non-json output gracefully', async () => {
  const runner = new ClaudeProcessRunner({
    binPath: process.execPath,
    extraArgsPrefix: [
      MOCK_CLI_PATH,
      '--stderr-line',
      'STDERR_SAMPLE_WARNING',
      '--raw-line',
      'NON_JSON_RAW_LINE'
    ]
  });

  const capturedStderr: string[] = [];

  const result = await runner.runSession({
    sessionId: 'test-uuid-raw-stderr',
    runId: 'run-raw',
    initialPrompt: 'PROBE_OK',
    onStderr: (line) => capturedStderr.push(line)
  });

  assert.ok(result.rawLines.includes('NON_JSON_RAW_LINE'));
  assert.ok(result.stderrLines.includes('STDERR_SAMPLE_WARNING'));
  assert.ok(capturedStderr.includes('STDERR_SAMPLE_WARNING'));
});

test('claude-runner: supports resume session flag', async () => {
  const runner = new ClaudeProcessRunner({
    binPath: process.execPath,
    extraArgsPrefix: [MOCK_CLI_PATH]
  });

  const result = await runner.runSession({
    sessionId: 'test-uuid-resumed',
    runId: 'run-resume',
    resume: true,
    initialPrompt: 'PROBE_OK'
  });

  assert.strictEqual(result.sessionId, 'test-uuid-resumed');
  assert.strictEqual(result.code, 0);
});

