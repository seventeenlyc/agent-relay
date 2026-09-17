export type EventType =
  | 'session:start'
  | 'session:progress'
  | 'session:compaction'
  | 'unit:completed'
  | 'handoff:requested'
  | 'handoff:ack'
  | 'handoff:token_issued'
  | 'user:pause'
  | 'user:cancel';

export interface AgentRelayEvent {
  eventId: string;
  type: EventType;
  runId: string;
  sessionId: string;
  timestamp: number;
  payload: Record<string, unknown>;
}
