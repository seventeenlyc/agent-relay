// tests/fixtures/mock-claude-cli.mjs
// Emulates `claude -p --output-format stream-json --verbose`
import readline from 'node:readline';

const args = process.argv.slice(2);
let sessionId = 'unknown-session';
let model = 'gemini-3.8-flash-high';
let prompt = '';
let sleepMs = 0;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--session-id' && args[i + 1]) {
    sessionId = args[++i];
  } else if (args[i] === '--resume' && args[i + 1]) {
    sessionId = args[++i];
  } else if (args[i] === '--model' && args[i + 1]) {
    model = args[++i];
  } else if (args[i] === '--sleep' && args[i + 1]) {
    sleepMs = parseInt(args[++i], 10);
  } else if (args[i] === '--stderr-line' && args[i + 1]) {
    process.stderr.write(args[++i] + '\n');
  } else if (args[i] === '--raw-line' && args[i + 1]) {
    process.stdout.write(args[++i] + '\n');
  }
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

async function run() {
  if (sleepMs > 0) {
    await new Promise((r) => setTimeout(r, sleepMs));
  }

  // 1. system:init
  emit({
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    model,
    tools: ['Bash', 'Edit', 'PowerShell', 'Read'],
    mcp_servers: [],
    capabilities: ['interrupt_receipt_v1'],
    cwd: process.cwd()
  });

  // Read stdin if stream-json
  const rl = readline.createInterface({ input: process.stdin });
  let userText = '';

  for await (const line of rl) {
    try {
      const parsed = JSON.parse(line);
      if (parsed.type === 'user' && parsed.message?.content) {
        userText = parsed.message.content;
        break;
      }
    } catch {}
  }

  const replyText = userText.includes('PROBE_OK') ? 'PROBE_OK' : 'MOCK_OUTPUT_DEFAULT';

  // 2. assistant
  emit({
    type: 'assistant',
    session_id: sessionId,
    message: {
      id: 'msg-1',
      role: 'assistant',
      content: [{ type: 'text', text: replyText }]
    }
  });

  // 3. result
  emit({
    type: 'result',
    subtype: 'success',
    session_id: sessionId,
    result: replyText,
    duration_ms: 50,
    total_cost_usd: 0.0001,
    usage: { input_tokens: 100, output_tokens: 10 }
  });
}

run().catch((err) => {
  process.stderr.write(String(err) + '\n');
  process.exit(1);
});
