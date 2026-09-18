export interface SystemInitEvent {
  type: 'system';
  subtype: 'init';
  session_id: string;
  model: string;
  tools: string[];
  mcp_servers?: unknown[];
  capabilities?: string[];
  cwd: string;
  [key: string]: unknown;
}

export interface SystemThinkingEvent {
  type: 'system';
  subtype: 'thinking_tokens';
  session_id: string;
  estimated_tokens: number;
  estimated_tokens_delta?: number;
  [key: string]: unknown;
}

export interface SystemHookEvent {
  type: 'system';
  subtype: 'hook_started' | 'hook_response';
  session_id: string;
  hook_id?: string;
  hook_name: string;
  hook_event: string;
  exit_code?: number;
  output?: string;
  outcome?: string;
  [key: string]: unknown;
}

export interface AssistantEvent {
  type: 'assistant';
  session_id: string;
  message: {
    id: string;
    role: 'assistant';
    content: Array<{ type: string; text?: string; [key: string]: unknown }>;
    usage?: {
      input_tokens: number;
      output_tokens: number;
    };
  };
  [key: string]: unknown;
}

export interface ResultEvent {
  type: 'result';
  subtype: 'success' | 'error';
  session_id: string;
  result: string;
  is_error?: boolean;
  duration_ms?: number;
  total_cost_usd?: number;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
  modelUsage?: Record<string, unknown>;
  [key: string]: unknown;
}

export type ClaudeStreamEvent =
  | SystemInitEvent
  | SystemThinkingEvent
  | SystemHookEvent
  | AssistantEvent
  | ResultEvent
  | { type: string; [key: string]: unknown };

export interface ProcessRunOptions {
  sessionId: string;
  runId: string;
  resume?: boolean;
  initialPrompt?: string;
  keepStdinOpen?: boolean;
  model?: {
    provider: string;
    model: string;
    effort?: string;
  };
  bare?: boolean;
  noPersistence?: boolean;
  includeHookEvents?: boolean;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  onEvent?: (event: ClaudeStreamEvent) => void;
  onStderr?: (line: string) => void;
}

export interface ProcessRunResult {
  sessionId: string;
  code: number | null;
  durationMs: number;
  timedOut: boolean;
  events: ClaudeStreamEvent[];
  rawLines: string[];
  stderrLines: string[];
}
