# Claude Code task-switch hook

`lib/prompt-hook.js` receives Claude Code `UserPromptSubmit` input on stdin. It keeps corrections and natural next steps in the current session while automatically handing independent tasks to a new Claude session, without requiring a topic-switch phrase.

- Promotional video → “the HTML is blank”: continue.
- SQLite API → “write a science-fiction novel”: independent task.
- Couple's React gallery → cafe reservation website: independent task, even within the same technical domain.
- Backend → frontend for the same API: continue.

## Configuration

Requires Node 20+ and Claude Code on PATH, or an explicit `CLAUDE_BIN_PATH`. Merge this entry into existing Claude settings; use the absolute hook path on your machine:

```json
{
  "hooks": {
    "UserPromptSubmit": [{
      "hooks": [{
        "type": "command",
        "command": "node \"/absolute/path/to/agent-relay/integrations/claude-package/lib/prompt-hook.js\"",
        "timeout": 30
      }]
    }]
  }
}
```

The hook reuses the Claude process's `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY`. Model selection: `AGENT_RELAY_TOPIC_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL`, `ANTHROPIC_DEFAULT_HAIKU_MODEL`, then `ANTHROPIC_MODEL`. Set the topic model in your own settings if needed; no provider or model is bundled.

| Variable | Meaning |
| --- | --- |
| `AGENT_RELAY_TOPIC_MODEL` | Classification model; does not change the main conversation model |
| `AGENT_RELAY_TOPIC_BASE_URL` | Override the classification API base |
| `AGENT_RELAY_TOPIC_TIMEOUT_MS` | Request timeout, 6000ms by default, capped at 15000ms |
| `AGENT_RELAY_HEADLESS=1` | Always start the target session in the background |
| `CLAUDE_BIN_PATH` | Override the target Claude executable |

Allow up to 3 seconds for each target-start confirmation (Windows Terminal and background fallback). The outer hook timeout must cover the classifier timeout plus up to 6 seconds of startup checks; the example uses 30 seconds. An unconfirmed terminal launch is cancelled and leaves the original input in place.

Clear corrections, the first user turn and slash commands including `/btw` bypass the model. Other messages may make one API request using a bounded selection of the initial goal, recent user messages, short assistant output and artifact filenames. Tool results, meta records and sidechains are excluded. The classifier compares goals and deliverables, not merely technical keywords. A valid `switch` response with self-reported confidence at least 0.9 requests a handoff; that confidence is not a measured accuracy guarantee.

Low-confidence, unsure, truncated or malformed responses leave the input in the original session. Missing credentials, HTTP errors and timeouts use a conservative local fallback: explicit cross-domain switches and unmistakable standalone fiction/poetry requests can still hand off. Other messages stay in the current session. Semantic detection is therefore narrower while the provider is unavailable.

On Windows, Windows Terminal can open the new session; otherwise a background Claude process executes the prompt and persists its native session for `claude --resume`. The hook does not implement or claim a controller CAS lease transfer. It does not install a local model or modify the main model configuration.

## Verification

From the repository root:

```sh
node --experimental-strip-types --test tests/integrations/claude-prompt-hook.test.ts
npm test
```

Command-hook tests replace outbound inference and child launches at the process boundary. They cannot open terminals or start real Claude jobs, and do not send requests to a developer's configured provider. Runtime/provider availability and real-device latency require separate validation.
