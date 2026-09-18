import { computeSha256 } from '../../../protocol/src/index.ts';
import type { ClaudeStreamEvent, SystemHookEvent } from './types.ts';

export class HookDeduplicator {
  private readonly maxEntries: number;
  private eventHashes: string[] = [];
  private eventSet: Set<string> = new Set();

  constructor(maxEntries = 200) {
    this.maxEntries = maxEntries;
  }

  public shouldProcess(sessionId: string, hookEvent: string, hookId?: string): boolean {
    const key = `${sessionId}:${hookEvent}:${hookId || 'default'}`;
    const hash = computeSha256(key);
    if (this.eventSet.has(hash)) {
      return false;
    }
    this.eventSet.add(hash);
    this.eventHashes.push(hash);

    if (this.eventHashes.length > this.maxEntries) {
      const oldest = this.eventHashes.shift();
      if (oldest) {
        this.eventSet.delete(oldest);
      }
    }
    return true;
  }

  public clear(): void {
    this.eventHashes = [];
    this.eventSet.clear();
  }
}

export type HandoffTriggerCallback = (sessionId: string, reason: string) => void;

export class ClaudeHookHandler {
  private readonly deduplicator: HookDeduplicator;
  private readonly triggerCallbacks: HandoffTriggerCallback[] = [];

  constructor(deduplicator = new HookDeduplicator()) {
    this.deduplicator = deduplicator;
  }

  public onHandoffTrigger(cb: HandoffTriggerCallback): void {
    this.triggerCallbacks.push(cb);
  }

  public processEvent(event: ClaudeStreamEvent): boolean {
    if (!event || event.type !== 'system') return false;
    const subtype = (event as Record<string, unknown>).subtype;
    if (subtype !== 'hook_started' && subtype !== 'hook_response') return false;

    const hookEvent = event as SystemHookEvent;
    const isResponse = subtype === 'hook_response';
    const isStop = hookEvent.hook_event === 'Stop';
    const isPreCompact = hookEvent.hook_event === 'PreCompact';

    // We trigger handoff primarily on Stop or PreCompact response
    if (isResponse && (isStop || isPreCompact)) {
      const should = this.deduplicator.shouldProcess(
        hookEvent.session_id,
        hookEvent.hook_event,
        hookEvent.hook_id
      );
      if (should) {
        const reason = isStop ? 'hook_stop' : 'hook_pre_compact';
        for (const cb of this.triggerCallbacks) {
          try {
            cb(hookEvent.session_id, reason);
          } catch {
            // Isolate callback errors
          }
        }
        return true;
      }
    }
    return false;
  }
}
