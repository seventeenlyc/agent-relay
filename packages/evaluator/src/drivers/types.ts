export interface ExecutedUnitRecord {
  taskId: string;
  prompt: string;
  output: string;
  contextTokens: number;
  durationMs: number;
  violations: string[];
}

export interface ConditionRunRecord {
  conditionId: 'native_long' | 'summary_only' | 'agent_relay';
  executedUnits: ExecutedUnitRecord[];
  handoffsCount: number;
  finalPromptContext: string;
  originalHashPreserved: boolean;
  successfulHandoffs: number;
  totalHandoffs: number;
}
