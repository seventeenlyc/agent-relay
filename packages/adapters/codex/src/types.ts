export interface JsonRpcRequest<T = unknown> {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: T;
}

export interface JsonRpcResponse<T = unknown> {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: T;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface JsonRpcNotification<T = unknown> {
  jsonrpc: '2.0';
  method: string;
  params?: T;
}

export interface InitializeParams {
  clientInfo?: {
    name: string;
    version: string;
    title?: string;
  };
  capabilities?: Record<string, unknown>;
}

export interface InitializeResponse {
  userAgent: string;
  codexHome: string;
  platformFamily: string;
  platformOs: string;
}

export interface ThreadStartParams {
  cwd?: string;
  model?: string;
  ephemeral?: boolean;
  approvalPolicy?: string;
  baseInstructions?: string;
  developerInstructions?: string;
}

export interface ThreadStartResponse {
  thread: {
    id: string;
    sessionId: string;
    source?: string;
    ephemeral?: boolean;
    cwd?: string;
    [key: string]: unknown;
  };
  model: string;
  modelProvider: string;
  reasoningEffort?: string;
  cwd: string;
  [key: string]: unknown;
}

export interface TurnStartParams {
  threadId: string;
  input: Array<{
    type: 'text';
    text: string;
    text_elements?: unknown[];
    [key: string]: unknown;
  }>;
}

export interface TurnStartResponse {
  turn: {
    id: string;
    items: unknown[];
    status: 'inProgress' | 'completed' | 'interrupted' | 'failed';
    error?: unknown;
    durationMs?: number | null;
  };
}

export interface TurnInterruptParams {
  threadId: string;
  turnId: string;
}

export interface ThreadReadParams {
  threadId: string;
  includeTurns?: boolean;
}

export interface ThreadStatusChangedParams {
  threadId: string;
  status: {
    type: 'active' | 'idle';
  };
}

export interface ItemDeltaParams {
  threadId: string;
  turnId: string;
  delta: string;
  itemId?: string;
}

export interface TurnCompletedParams {
  threadId: string;
  turn: {
    id: string;
    status: 'completed' | 'interrupted' | 'failed';
    durationMs?: number;
    error?: unknown;
  };
}

export type ServerNotification =
  | JsonRpcNotification<ThreadStatusChangedParams>
  | JsonRpcNotification<ItemDeltaParams>
  | JsonRpcNotification<TurnCompletedParams>
  | JsonRpcNotification<unknown>;

