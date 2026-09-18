export interface DshJsonRpcRequest<T = any> {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: T;
}

export interface DshJsonRpcResponse<T = any> {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: T;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

export interface DshJsonRpcNotification<T = any> {
  jsonrpc: '2.0';
  method: string;
  params?: T;
}

export interface DshInitializeParams {
  cwd: string;
  provider: string;
  model: string;
  reasoningEffort?: string;
  maxTokens?: number;
}

export interface DshInitializeResult {
  serverInfo: {
    name: string;
    version: string;
  };
}

export interface DshSessionPromptContentBlock {
  type: 'text';
  text: string;
}

export interface DshSessionPromptParams {
  sessionId: string;
  contentBlocks: DshSessionPromptContentBlock[];
}

export interface DshSessionPromptResult {
  messageId: string;
}

export interface DshSessionStatusParams {
  sessionId: string;
  status: 'running' | 'idle';
}

export interface DshSessionEventParams {
  sessionId: string;
  event: string;
  data?: any;
  text?: string;
}
