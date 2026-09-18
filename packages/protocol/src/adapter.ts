export interface SessionCapabilities {
  level: 'L1' | 'L2' | 'L3' | 'L4';
  streamJsonSupported: boolean;
  modelEffortPreservation: boolean;
  nativeRevealSupported: boolean;
  headlessSupported: boolean;
  cancellationSupported: boolean;
}

export interface SessionInspectResult {
  sessionId: string;
  active: boolean;
  effectiveModel?: {
    provider: string;
    model: string;
    effort?: string;
  };
  cwd: string;
  exitCode?: number | null;
}

export interface SpawnSessionConfig {
  sessionId?: string;
  runId: string;
  cwd?: string;
  model?: {
    provider: string;
    model: string;
    effort?: string;
  };
  bare?: boolean;
  noPersistence?: boolean;
  includeHookEvents?: boolean;
  env?: Record<string, string>;
  initialPrompt?: string;
  readOnly?: boolean;
}

export interface AgentRelayAdapter {
  capabilities(): SessionCapabilities;
  createFresh(config: SpawnSessionConfig): Promise<SessionInspectResult> | SessionInspectResult;
  inspectSession(sessionId: string): Promise<SessionInspectResult | undefined> | SessionInspectResult | undefined;
  submit(sessionId: string, messageId: string, content: string, epoch?: number): Promise<void> | void;
  requestDrain(sessionId: string, handoffId: string): Promise<boolean> | boolean;
  awaitQuiescence(sessionId: string, timeoutMs?: number): Promise<'quiescent' | 'timeout' | 'error'>;
  authorizeExecution(sessionId: string, epoch: number, executionToken: string): Promise<boolean> | boolean;
  interruptOwned(sessionId: string): Promise<boolean> | boolean;
  /** 会话累计的可读输出；交接 ACK 与单元结果都从这里解析。未知会话返回空字符串。 */
  getSessionOutput(sessionId: string): string;
}
