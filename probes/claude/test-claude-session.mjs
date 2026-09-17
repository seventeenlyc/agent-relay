import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import readline from 'node:readline';

/**
 * Executes a claude CLI session and collects structured stream-json events.
 *
 * @param {Object} options
 * @param {string} [options.sessionId] - Explicit UUIDv4 session ID
 * @param {boolean} [options.resume] - Whether to resume an existing session
 * @param {string} options.prompt - Prompt string to pass
 * @param {string} [options.inputFormat] - 'text' (default) or 'stream-json'
 * @param {string} [options.model] - Model alias or name
 * @param {string} [options.effort] - Effort level (low, medium, high, xhigh, max)
 * @param {boolean} [options.bare] - Use minimal --bare mode
 * @param {boolean} [options.includeHookEvents] - Include hook lifecycle events
 * @param {boolean} [options.noPersistence] - Disable session persistence
 * @param {string[]} [options.extraArgs] - Additional CLI arguments
 * @returns {Promise<{ sessionId: string, code: number, durationMs: number, events: any[], rawLines: string[], stderrLines: string[] }>}
 */
export function runClaudeSession({
  sessionId,
  resume = false,
  prompt,
  inputFormat = 'text',
  model,
  effort,
  bare = false,
  includeHookEvents = false,
  noPersistence = false,
  extraArgs = []
}) {
  const startTime = Date.now();
  const effectiveSessionId = sessionId || randomUUID();

  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose' // Required when using -p with --output-format=stream-json
  ];

  if (inputFormat === 'stream-json') {
    args.push('--input-format', 'stream-json');
  }

  if (resume) {
    args.push('--resume', effectiveSessionId);
  } else if (effectiveSessionId) {
    args.push('--session-id', effectiveSessionId);
  }

  if (noPersistence) {
    args.push('--no-session-persistence');
  }

  if (bare) {
    args.push('--bare');
  }

  if (includeHookEvents) {
    args.push('--include-hook-events');
  }

  if (model) {
    args.push('--model', model);
  }

  if (effort) {
    args.push('--effort', effort);
  }

  if (extraArgs && extraArgs.length > 0) {
    args.push(...extraArgs);
  }

  if (inputFormat !== 'stream-json') {
    args.push(prompt);
  }

  console.log(`\n------------------------------------------------------------`);
  console.log(`[Spawn] claude ${args.map(a => a.includes(' ') ? `"${a}"` : a).join(' ')}`);

  const proc = spawn('claude', args, {
    stdio: [inputFormat === 'stream-json' ? 'pipe' : 'ignore', 'pipe', 'pipe']
  });

  const rlStdout = readline.createInterface({ input: proc.stdout });
  const rlStderr = readline.createInterface({ input: proc.stderr });

  const events = [];
  const rawLines = [];
  const stderrLines = [];

  rlStdout.on('line', (line) => {
    rawLines.push(line);
    try {
      const ev = JSON.parse(line);
      events.push(ev);
      const desc = ev.type === 'system'
        ? `system:${ev.subtype}${ev.hook_name ? ` (${ev.hook_name})` : ''}`
        : ev.type === 'assistant'
        ? `assistant (${ev.message?.content?.map(c => c.type).join(', ') || 'unknown'})`
        : ev.type === 'result'
        ? `result (cost=$${ev.total_cost_usd}, dur=${ev.duration_ms}ms, subtype=${ev.subtype})`
        : ev.type;
      console.log(`  [stdout:event] ${desc}`);
    } catch {
      console.log(`  [stdout:raw] ${line.slice(0, 100)}`);
    }
  });

  rlStderr.on('line', (line) => {
    stderrLines.push(line);
    console.log(`  [stderr] ${line}`);
  });

  if (inputFormat === 'stream-json') {
    const payload = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: prompt
      }
    }) + '\n';
    proc.stdin.write(payload);
    proc.stdin.end();
  }

  return new Promise((resolve, reject) => {
    proc.on('close', (code) => {
      const durationMs = Date.now() - startTime;
      console.log(`[Exit] Process exited with code ${code} (${durationMs}ms)`);
      resolve({
        sessionId: effectiveSessionId,
        code,
        durationMs,
        events,
        rawLines,
        stderrLines
      });
    });
    proc.on('error', (err) => {
      console.error('[Error] Spawn failed:', err);
      reject(err);
    });
  });
}

/**
 * Main test suite execution
 */
async function runSuite() {
  console.log(`============================================================`);
  console.log(`Claude Code Headless/Session Probe (CLI 2.1.274)`);
  console.log(`============================================================`);

  const suiteResults = {
    timestamp: new Date().toISOString(),
    tests: []
  };

  // Test 1: Basic stream-json with custom UUID and --include-hook-events
  console.log(`\n>>> TEST 1: Basic stream-json event capture & UUID verification`);
  const test1SessionId = randomUUID();
  const res1 = await runClaudeSession({
    sessionId: test1SessionId,
    noPersistence: true,
    includeHookEvents: true,
    prompt: 'Respond with exactly "PROBE_BASIC_OK" and nothing else.'
  });

  const initEvent1 = res1.events.find(e => e.type === 'system' && e.subtype === 'init');
  const resultEvent1 = res1.events.find(e => e.type === 'result');
  const hookEvents1 = res1.events.filter(e => e.type === 'system' && (e.subtype === 'hook_started' || e.subtype === 'hook_response'));

  const test1Passed =
    res1.code === 0 &&
    initEvent1?.session_id === test1SessionId &&
    resultEvent1?.session_id === test1SessionId &&
    resultEvent1?.result?.includes('PROBE_BASIC_OK');

  console.log(`[Test 1 Verdict] ${test1Passed ? 'PASSED' : 'FAILED'}`);
  console.log(`  - Injected UUID: ${test1SessionId}`);
  console.log(`  - Init Event UUID: ${initEvent1?.session_id}`);
  console.log(`  - Result Event UUID: ${resultEvent1?.session_id}`);
  console.log(`  - Hook events captured: ${hookEvents1.length}`);
  console.log(`  - Result text: "${resultEvent1?.result}"`);

  suiteResults.tests.push({
    id: 'test_1_basic_stream_json',
    passed: test1Passed,
    sessionId: test1SessionId,
    durationMs: res1.durationMs,
    eventCount: res1.events.length,
    hookEventCount: hookEvents1.length,
    modelReported: initEvent1?.model,
    toolsProvided: initEvent1?.tools?.length
  });

  // Test 2: Parameter Variations (--model and --effort)
  console.log(`\n>>> TEST 2: Parameter variations (--effort low and --model)`);
  const test2SessionId = randomUUID();
  const res2 = await runClaudeSession({
    sessionId: test2SessionId,
    noPersistence: true,
    effort: 'low',
    model: 'gemini-3.8-flash-high',
    prompt: 'Respond with exactly "PROBE_EFFORT_LOW_OK" and nothing else.'
  });

  const resultEvent2 = res2.events.find(e => e.type === 'result');
  const thinkingEvent2 = res2.events.find(e => e.type === 'system' && e.subtype === 'thinking_tokens');
  const test2Passed = res2.code === 0 && resultEvent2?.result?.includes('PROBE_EFFORT_LOW_OK');

  console.log(`[Test 2 Verdict] ${test2Passed ? 'PASSED' : 'FAILED'}`);
  console.log(`  - Thinking tokens (effort=low): ${thinkingEvent2?.estimated_tokens ?? 'none'}`);
  console.log(`  - Result text: "${resultEvent2?.result}"`);

  suiteResults.tests.push({
    id: 'test_2_parameter_variations',
    passed: test2Passed,
    sessionId: test2SessionId,
    durationMs: res2.durationMs,
    thinkingTokens: thinkingEvent2?.estimated_tokens
  });

  // Test 3: Session Isolation (Zero History Leakage) and Resumption Proof
  console.log(`\n>>> TEST 3: Session Isolation Proof (Zero History Leakage)`);
  const secretCodeword = `SECRET_TOKEN_${Math.floor(Math.random() * 900000 + 100000)}`;
  const sessionA_Id = randomUUID();
  const sessionB_Id = randomUUID();

  console.log(`  Secret codeword generated: ${secretCodeword}`);
  console.log(`  Session A (Writer): ${sessionA_Id}`);
  console.log(`  Session B (Isolated Reader): ${sessionB_Id}`);

  // Step 3a: Store in Session A (persistent conversation context)
  console.log(`\n  Step 3a: Store secret in Session A conversation`);
  const res3a = await runClaudeSession({
    sessionId: sessionA_Id,
    noPersistence: false, // allow saving to disk
    prompt: `Here is my secret codeword: ${secretCodeword}. Do not call any tools or save anything to files/memory. Acknowledge with exactly "STORED" and nothing else.`
  });
  const res3aText = res3a.events.find(e => e.type === 'result')?.result || '';
  const step3aOk = res3a.code === 0 && res3aText.includes('STORED');
  console.log(`  Session A Store result: "${res3aText}" (ok=${step3aOk})`);

  // Step 3b: Query Session B with different fresh UUID (verify zero conversation leakage)
  console.log(`\n  Step 3b: Probe Session B (fresh UUID) for secret codeword`);
  const res3b = await runClaudeSession({
    sessionId: sessionB_Id,
    noPersistence: false,
    prompt: `What is the secret codeword from our conversation history? Do not call any tools. If you do not have any secret codeword in your conversation history, reply with exactly "NO_SECRET_FOUND". Output nothing else.`
  });
  const res3bText = res3b.events.find(e => e.type === 'result')?.result || '';
  const leakDetected = res3bText.includes(secretCodeword);
  const step3bOk = res3b.code === 0 && !leakDetected && (res3bText.includes('NO_SECRET_FOUND') || res3bText.includes('UNKNOWN'));
  console.log(`  Session B Query result: "${res3bText}"`);
  console.log(`  Leak detected: ${leakDetected}`);
  console.log(`  Session B Isolation verified: ${step3bOk}`);

  // Step 3c: Resume Session A (verify resumption works under same UUID)
  console.log(`\n  Step 3c: Resume Session A to verify persistence and recall`);
  const res3c = await runClaudeSession({
    sessionId: sessionA_Id,
    resume: true,
    prompt: `What was the secret codeword from this conversation? Do not call any tools. Reply with only the codeword and nothing else.`
  });
  const res3cText = res3c.events.find(e => e.type === 'result')?.result || '';
  const recallSuccess = res3c.code === 0 && res3cText.includes(secretCodeword);
  console.log(`  Session A Resume result: "${res3cText}"`);
  console.log(`  Session A Recall verified: ${recallSuccess}`);

  const test3Passed = step3aOk && step3bOk && recallSuccess;
  console.log(`[Test 3 Verdict] ${test3Passed ? 'PASSED (Zero history leakage + Resume verified)' : 'FAILED'}`);

  suiteResults.tests.push({
    id: 'test_3_session_isolation_and_resume',
    passed: test3Passed,
    sessionA: sessionA_Id,
    sessionB: sessionB_Id,
    leakDetected,
    recallSuccess,
    secretCodeword
  });

  // Test 4: Headless Optimization Comparison (--bare mode)
  console.log(`\n>>> TEST 4: Performance & Tool Isolation (--bare mode)`);
  const test4SessionId = randomUUID();
  const res4 = await runClaudeSession({
    sessionId: test4SessionId,
    bare: true,
    noPersistence: true,
    prompt: 'Respond with exactly "BARE_PROBE_OK" and nothing else.'
  });

  const initEvent4 = res4.events.find(e => e.type === 'system' && e.subtype === 'init');
  const resultEvent4 = res4.events.find(e => e.type === 'result');
  const test4Passed = res4.code === 0 && resultEvent4?.result?.includes('BARE_PROBE_OK');

  console.log(`[Test 4 Verdict] ${test4Passed ? 'PASSED' : 'FAILED'}`);
  console.log(`  - Bare tools count: ${initEvent4?.tools?.length} (${initEvent4?.tools?.join(', ')})`);
  console.log(`  - Bare MCP servers count: ${initEvent4?.mcp_servers?.length}`);
  console.log(`  - Bare input tokens: ${resultEvent4?.usage?.input_tokens} (vs ${resultEvent1?.usage?.input_tokens} standard)`);
  console.log(`  - Bare duration: ${res4.durationMs}ms (vs ${res1.durationMs}ms standard)`);

  suiteResults.tests.push({
    id: 'test_4_bare_mode',
    passed: test4Passed,
    durationMs: res4.durationMs,
    inputTokens: resultEvent4?.usage?.input_tokens,
    tools: initEvent4?.tools
  });

  // Test 5: Bidirectional stream-json (stdin streaming input + stdout streaming output)
  console.log(`\n>>> TEST 5: Bidirectional stream-json (stdin input + stdout output)`);
  const test5SessionId = randomUUID();
  const res5 = await runClaudeSession({
    sessionId: test5SessionId,
    inputFormat: 'stream-json',
    bare: true,
    noPersistence: true,
    prompt: 'Respond with exactly "BIDIRECTIONAL_STREAM_OK" and nothing else.'
  });

  const resultEvent5 = res5.events.find(e => e.type === 'result');
  const test5Passed = res5.code === 0 && resultEvent5?.result?.includes('BIDIRECTIONAL_STREAM_OK');

  console.log(`[Test 5 Verdict] ${test5Passed ? 'PASSED' : 'FAILED'}`);
  console.log(`  - Result text: "${resultEvent5?.result}"`);

  suiteResults.tests.push({
    id: 'test_5_bidirectional_stream_json',
    passed: test5Passed,
    durationMs: res5.durationMs,
    result: resultEvent5?.result
  });

  console.log(`\n============================================================`);
  console.log(`SUITE COMPLETE: ${suiteResults.tests.filter(t => t.passed).length}/${suiteResults.tests.length} tests passed`);
  console.log(`============================================================\n`);

  return suiteResults;
}

// Execute suite
runSuite()
  .then((results) => {
    const allPassed = results.tests.every(t => t.passed);
    process.exit(allPassed ? 0 : 1);
  })
  .catch((err) => {
    console.error('Test suite uncaught error:', err);
    process.exit(1);
  });
