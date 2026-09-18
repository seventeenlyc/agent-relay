// packages/controller/src/run/store.ts
import { randomUUID } from 'node:crypto';
import type { InputRecord } from '../../../protocol/src/types.ts';
import type { AgentRelayEvent } from '../../../protocol/src/events.ts';
import type { RelayDatabase } from './db.ts';

export type RunState =
  | 'INITIALIZING'
  | 'RUNNING'
  | 'DRAINING'
  | 'CHECKPOINTED'
  | 'STARTING'
  | 'PREPARING'
  | 'READY'
  | 'PAUSED'
  | 'CANCELLED'
  | 'DISABLED'
  | 'COMPLETED'
  | 'RECOVERY_REQUIRED'
  | 'BLOCKED';

export const TERMINAL_RUN_STATES: RunState[] = ['CANCELLED', 'COMPLETED', 'DISABLED'];

export interface RunRecord {
  runId: string;
  workspaceKey: string;
  workspacePath: string;
  goal: string;
  model: { provider: string; model: string; effort?: string };
  state: RunState;
  currentSessionId?: string;
  currentEpoch: number;
  handoffCount: number;
  unitCount: number;
  currentSessionUnitCount: number;
  authorizedInputHash?: string;
  authorizedContractVersion?: number;
  authorizedIntentWatermark?: number;
  pauseReason?: string;
  blockedReason?: string;
  createdAt: number;
  updatedAt: number;
}

export interface InsertRunParams {
  runId: string;
  workspaceKey: string;
  workspacePath: string;
  goal: string;
  /** 缺省记录为 unknown——绝不猜测模型，状态卡会如实显示「未知」 */
  model?: { provider: string; model: string; effort?: string };
  state: RunState;
  unitCount: number;
  currentEpoch?: number;
}

export interface RunStatePatch {
  currentSessionId?: string | null;
  currentEpoch?: number;
  handoffCount?: number;
  currentSessionUnitCount?: number;
  pauseReason?: string | null;
  blockedReason?: string | null;
}

export type ControlIntentKind = 'pause_next_node' | 'stop_now' | 'resume' | 'disable';

export interface ControlIntentRecord {
  intentId: string;
  runId: string;
  kind: ControlIntentKind;
  payload: Record<string, unknown>;
  watermark: number;
  createdAt: number;
  consumedAt?: number;
}

export interface SessionChainLink {
  linkId: string;
  runId: string;
  sequence: number;
  prevSessionId?: string;
  nextSessionId: string;
  adapter: string;
  provider: string;
  model: string;
  effort?: string;
  epoch: number;
  handoffId?: string;
  reason: string;
  createdAt: number;
  supersededAt?: number;
}

export interface InsertChainLinkParams {
  runId: string;
  sequence: number;
  prevSessionId?: string;
  nextSessionId: string;
  adapter: string;
  provider: string;
  model: string;
  effort?: string;
  epoch: number;
  handoffId?: string;
  reason: string;
}

export interface HandoffRecord {
  handoffId: string;
  runId: string;
  epoch: number;
  sourceSessionId: string;
  targetSessionId?: string;
  state: string;
  manifestPath?: string;
  manifestHash?: string;
  createdAt: number;
  updatedAt: number;
}

export interface InsertHandoffParams {
  handoffId: string;
  runId: string;
  epoch: number;
  sourceSessionId: string;
  targetSessionId?: string;
  state: string;
  manifestPath?: string;
  manifestHash?: string;
}

export interface HandoffPatch {
  targetSessionId?: string;
  state?: string;
  manifestPath?: string;
  manifestHash?: string;
}

export type RunEventSeverity = 'record' | 'notify';

export interface RunEventRecord {
  eventId: number;
  runId: string;
  type: string;
  severity: RunEventSeverity;
  sessionId?: string;
  payload: Record<string, unknown>;
  createdAt: number;
}

export interface LeaseRow {
  workspaceKey: string;
  currentOwner: string;
  epoch: number;
  acquiredAt: number;
}

export interface TaskSnapshotRow {
  runId: string;
  seq: number;
  snapshotJson: string;
  snapshotHash: string;
  createdAt: number;
}

export interface InputLedgerRow {
  seq: number;
  record: InputRecord;
}

export interface OutboxRow {
  msgId: string;
  runId: string;
  handoffId: string | null;
  topic: string;
  targetSessionId: string | null;
  payload: string;
  state: 'PENDING' | 'DISPATCHED' | 'ACKED' | 'FAILED';
  attempts: number;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface EnqueueOutboxInput {
  msgId?: string;
  runId: string;
  handoffId?: string;
  topic: string;
  targetSessionId?: string;
  payload?: Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

/**
 * 权威状态访问器。所有方法假定调用方已在需要原子性的场景下用
 * RelayDatabase.transaction() 包裹。
 */
export class RunStore {
  private readonly db: RelayDatabase;
  private readonly now: () => number;

  constructor(db: RelayDatabase, clock: () => number = () => Date.now()) {
    this.db = db;
    this.now = clock;
  }

  public transaction<T>(fn: () => T): T {
    return this.db.transaction(fn);
  }

  // ─── runs ───

  public insertRun(params: InsertRunParams): void {
    const ts = this.now();
    const model = params.model ?? { provider: 'unknown', model: 'unknown' };
    this.db
      .prepare(
        `INSERT INTO runs (
           run_id, workspace_key, workspace_path, goal, provider, model, effort, state,
           current_epoch, handoff_count, unit_count, current_session_unit_count,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 0, ?, ?)`
      )
      .run(
        params.runId,
        params.workspaceKey,
        params.workspacePath,
        params.goal,
        model.provider,
        model.model,
        model.effort ?? null,
        params.state,
        params.currentEpoch ?? 1,
        params.unitCount,
        ts,
        ts
      );
  }

  public getRun(runId: string): RunRecord | undefined {
    const row = this.db.prepare('SELECT * FROM runs WHERE run_id = ?').get(runId) as
      | Record<string, unknown>
      | undefined;
    return row ? this.mapRun(row) : undefined;
  }

  public getActiveRunByWorkspace(workspaceKey: string): RunRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM runs
          WHERE workspace_key = ?
            AND state NOT IN ('CANCELLED', 'COMPLETED', 'DISABLED')
          ORDER BY created_at ASC LIMIT 1`
      )
      .get(workspaceKey) as Record<string, unknown> | undefined;
    return row ? this.mapRun(row) : undefined;
  }

  public listRuns(): RunRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM runs ORDER BY created_at ASC')
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapRun(row));
  }

  public updateRunState(runId: string, state: RunState, patch: RunStatePatch = {}): void {
    const existing = this.getRun(runId);
    if (!existing) {
      throw new Error(`RunStore: run ${runId} not found`);
    }
    this.db
      .prepare(
        `UPDATE runs SET
           state = ?,
           current_session_id = ?,
           current_epoch = ?,
           handoff_count = ?,
           current_session_unit_count = ?,
           pause_reason = ?,
           blocked_reason = ?,
           updated_at = ?
         WHERE run_id = ?`
      )
      .run(
        state,
        patch.currentSessionId === undefined ? existing.currentSessionId ?? null : patch.currentSessionId,
        patch.currentEpoch ?? existing.currentEpoch,
        patch.handoffCount ?? existing.handoffCount,
        patch.currentSessionUnitCount ?? existing.currentSessionUnitCount,
        patch.pauseReason === undefined ? existing.pauseReason ?? null : patch.pauseReason,
        patch.blockedReason === undefined ? existing.blockedReason ?? null : patch.blockedReason,
        this.now(),
        runId
      );
  }

  public setAuthorization(
    runId: string,
    params: { inputHeadHash: string; contractVersion: number; intentWatermark: number }
  ): void {
    this.db
      .prepare(
        `UPDATE runs SET
           authorized_input_hash = ?,
           authorized_contract_version = ?,
           authorized_intent_watermark = ?,
           updated_at = ?
         WHERE run_id = ?`
      )
      .run(params.inputHeadHash, params.contractVersion, params.intentWatermark, this.now(), runId);
  }

  // ─── control intents ───

  public getLatestIntentWatermark(runId: string): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(watermark), 0) AS w FROM control_intents WHERE run_id = ?')
      .get(runId) as { w: number } | undefined;
    return row ? row.w : 0;
  }

  public appendIntent(
    runId: string,
    kind: ControlIntentKind,
    payload: Record<string, unknown> = {}
  ): ControlIntentRecord {
    const watermark = this.getLatestIntentWatermark(runId) + 1;
    const record: ControlIntentRecord = {
      intentId: randomUUID(),
      runId,
      kind,
      payload,
      watermark,
      createdAt: this.now()
    };
    this.db
      .prepare(
        `INSERT INTO control_intents (intent_id, run_id, kind, payload, watermark, created_at, consumed_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`
      )
      .run(record.intentId, runId, kind, JSON.stringify(payload), watermark, record.createdAt);
    return record;
  }

  public listIntents(runId: string, afterWatermark = 0): ControlIntentRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM control_intents
          WHERE run_id = ? AND watermark > ?
          ORDER BY watermark ASC`
      )
      .all(runId, afterWatermark) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapIntent(row));
  }

  public listPendingIntents(runId: string): ControlIntentRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM control_intents
          WHERE run_id = ? AND consumed_at IS NULL
          ORDER BY watermark ASC`
      )
      .all(runId) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapIntent(row));
  }

  public markIntentConsumed(intentId: string, at?: number): void {
    this.db
      .prepare('UPDATE control_intents SET consumed_at = ? WHERE intent_id = ? AND consumed_at IS NULL')
      .run(at ?? this.now(), intentId);
  }

  // ─── session chain ───

  public nextChainSequence(runId: string): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(sequence), 0) AS s FROM session_chain WHERE run_id = ?')
      .get(runId) as { s: number } | undefined;
    return (row ? row.s : 0) + 1;
  }

  public insertChainLink(params: InsertChainLinkParams): SessionChainLink {
    const link: SessionChainLink = {
      linkId: randomUUID(),
      runId: params.runId,
      sequence: params.sequence,
      prevSessionId: params.prevSessionId,
      nextSessionId: params.nextSessionId,
      adapter: params.adapter,
      provider: params.provider,
      model: params.model,
      effort: params.effort,
      epoch: params.epoch,
      handoffId: params.handoffId,
      reason: params.reason,
      createdAt: this.now()
    };
    this.db
      .prepare(
        `INSERT INTO session_chain (
           link_id, run_id, sequence, prev_session_id, next_session_id,
           adapter, provider, model, effort, epoch, handoff_id, reason, created_at, superseded_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
      )
      .run(
        link.linkId,
        link.runId,
        link.sequence,
        link.prevSessionId ?? null,
        link.nextSessionId,
        link.adapter,
        link.provider,
        link.model,
        link.effort ?? null,
        link.epoch,
        link.handoffId ?? null,
        link.reason,
        link.createdAt
      );
    return link;
  }

  public listChain(runId: string): SessionChainLink[] {
    const rows = this.db
      .prepare('SELECT * FROM session_chain WHERE run_id = ? ORDER BY sequence ASC')
      .all(runId) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapChainLink(row));
  }

  public getLatestChainLink(runId: string): SessionChainLink | undefined {
    const links = this.listChain(runId);
    return links.length > 0 ? links[links.length - 1] : undefined;
  }

  public markSessionSuperseded(sessionId: string, at?: number): void {
    this.db
      .prepare('UPDATE session_chain SET superseded_at = ? WHERE next_session_id = ? AND superseded_at IS NULL')
      .run(at ?? this.now(), sessionId);
  }

  public findChainLinksBySession(sessionId: string): SessionChainLink[] {
    const rows = this.db
      .prepare('SELECT * FROM session_chain WHERE next_session_id = ? ORDER BY sequence ASC')
      .all(sessionId) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapChainLink(row));
  }

  // ─── handoffs ───

  public insertHandoff(params: InsertHandoffParams): boolean {
    const ts = this.now();
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO handoffs (
           handoff_id, run_id, epoch, source_session_id, target_session_id,
           state, manifest_path, manifest_hash, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        params.handoffId,
        params.runId,
        params.epoch,
        params.sourceSessionId,
        params.targetSessionId ?? null,
        params.state,
        params.manifestPath ?? null,
        params.manifestHash ?? null,
        ts,
        ts
      );
    return Number(result.changes) > 0;
  }

  public getHandoff(handoffId: string): HandoffRecord | undefined {
    const row = this.db.prepare('SELECT * FROM handoffs WHERE handoff_id = ?').get(handoffId) as
      | Record<string, unknown>
      | undefined;
    return row ? this.mapHandoff(row) : undefined;
  }

  public updateHandoff(handoffId: string, patch: HandoffPatch): void {
    const existing = this.getHandoff(handoffId);
    if (!existing) {
      throw new Error(`RunStore: handoff ${handoffId} not found`);
    }
    this.db
      .prepare(
        `UPDATE handoffs SET
           target_session_id = ?, state = ?, manifest_path = ?, manifest_hash = ?, updated_at = ?
         WHERE handoff_id = ?`
      )
      .run(
        patch.targetSessionId ?? existing.targetSessionId ?? null,
        patch.state ?? existing.state,
        patch.manifestPath ?? existing.manifestPath ?? null,
        patch.manifestHash ?? existing.manifestHash ?? null,
        this.now(),
        handoffId
      );
  }

  // ─── run events ───

  public insertEvent(params: {
    runId: string;
    type: string;
    severity: RunEventSeverity;
    sessionId?: string;
    payload?: Record<string, unknown>;
  }): RunEventRecord {
    const createdAt = this.now();
    const payload = params.payload ?? {};
    const result = this.db
      .prepare(
        `INSERT INTO run_events (run_id, type, severity, session_id, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(params.runId, params.type, params.severity, params.sessionId ?? null, JSON.stringify(payload), createdAt);
    return {
      eventId: Number(result.lastInsertRowid),
      runId: params.runId,
      type: params.type,
      severity: params.severity,
      sessionId: params.sessionId,
      payload,
      createdAt
    };
  }

  public listEvents(runId: string, afterEventId = 0): RunEventRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM run_events WHERE run_id = ? AND event_id > ? ORDER BY event_id ASC')
      .all(runId, afterEventId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      eventId: row.event_id as number,
      runId: row.run_id as string,
      type: row.type as string,
      severity: row.severity as RunEventSeverity,
      sessionId: asString(row.session_id),
      payload: JSON.parse(row.payload as string) as Record<string, unknown>,
      createdAt: row.created_at as number
    }));
  }

  // ─── lease registry（全局，跨 run） ───

  public getLeaseRow(workspaceKey: string): LeaseRow | undefined {
    const row = this.db.prepare('SELECT * FROM lease_state WHERE workspace_key = ?').get(workspaceKey) as
      | Record<string, unknown>
      | undefined;
    if (!row) return undefined;
    return {
      workspaceKey: row.workspace_key as string,
      currentOwner: row.current_owner as string,
      epoch: row.epoch as number,
      acquiredAt: row.acquired_at as number
    };
  }

  public tryInsertLease(workspaceKey: string, owner: string, epoch: number): boolean {
    const result = this.db
      .prepare('INSERT OR IGNORE INTO lease_state (workspace_key, current_owner, epoch, acquired_at) VALUES (?, ?, ?, ?)')
      .run(workspaceKey, owner, epoch, this.now());
    return Number(result.changes) > 0;
  }

  public casLeaseRow(
    workspaceKey: string,
    expectedOwner: string,
    newOwner: string,
    expectedEpoch: number,
    newEpoch: number
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE lease_state
            SET current_owner = ?, epoch = ?, acquired_at = ?
          WHERE workspace_key = ? AND current_owner = ? AND epoch = ? AND ? > ?`
      )
      .run(newOwner, newEpoch, this.now(), workspaceKey, expectedOwner, expectedEpoch, newEpoch, expectedEpoch);
    return Number(result.changes) > 0;
  }

  public deleteLease(workspaceKey: string, owner: string): boolean {
    const result = this.db
      .prepare('DELETE FROM lease_state WHERE workspace_key = ? AND current_owner = ?')
      .run(workspaceKey, owner);
    return Number(result.changes) > 0;
  }

  // ─── input ledger（不可变原话镜像） ───

  public nextInputSeq(runId: string): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM input_ledger WHERE run_id = ?')
      .get(runId) as { s: number } | undefined;
    return (row ? row.s : 0) + 1;
  }

  public appendInputRow(runId: string, seq: number, record: InputRecord): void {
    this.db
      .prepare(
        `INSERT INTO input_ledger (
           run_id, seq, input_id, source, raw_content, sha256_hash, supersedes_id, metadata, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        runId,
        seq,
        record.inputId,
        record.source,
        record.rawContent,
        record.sha256Hash,
        record.supersedesId ?? null,
        record.metadata ? JSON.stringify(record.metadata) : null,
        record.timestamp
      );
  }

  public listInputs(runId: string): InputLedgerRow[] {
    const rows = this.db
      .prepare('SELECT * FROM input_ledger WHERE run_id = ? ORDER BY seq ASC')
      .all(runId) as Array<Record<string, unknown>>;
    return rows.map((row) => {
      const metadataRaw = asString(row.metadata);
      const record: InputRecord = {
        inputId: row.input_id as string,
        source: row.source as InputRecord['source'],
        timestamp: row.created_at as number,
        rawContent: row.raw_content as string,
        sha256Hash: row.sha256_hash as string,
        supersedesId: asString(row.supersedes_id),
        metadata: metadataRaw ? (JSON.parse(metadataRaw) as Record<string, unknown>) : undefined
      };
      return { seq: row.seq as number, record };
    });
  }

  // ─── task snapshots ───

  public nextTaskSnapshotSeq(runId: string): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM task_snapshots WHERE run_id = ?')
      .get(runId) as { s: number } | undefined;
    return (row ? row.s : 0) + 1;
  }

  public appendTaskSnapshot(runId: string, seq: number, snapshotJson: string, snapshotHash: string): void {
    this.db
      .prepare(
        `INSERT INTO task_snapshots (run_id, seq, snapshot_json, snapshot_hash, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(runId, seq, snapshotJson, snapshotHash, this.now());
  }

  public getLatestTaskSnapshot(runId: string): TaskSnapshotRow | undefined {
    const row = this.db
      .prepare('SELECT * FROM task_snapshots WHERE run_id = ? ORDER BY seq DESC LIMIT 1')
      .get(runId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      runId: row.run_id as string,
      seq: row.seq as number,
      snapshotJson: row.snapshot_json as string,
      snapshotHash: row.snapshot_hash as string,
      createdAt: row.created_at as number
    };
  }

  // ─── AgentRelayEvent 追加式持久化 ───

  public nextLedgerEventSeq(runId: string): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM ledger_events WHERE run_id = ?')
      .get(runId) as { s: number } | undefined;
    return (row ? row.s : 0) + 1;
  }

  public appendLedgerEvent(runId: string, seq: number, event: AgentRelayEvent): void {
    this.db
      .prepare(
        `INSERT INTO ledger_events (run_id, seq, event_id, type, session_id, timestamp, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(runId, seq, event.eventId, event.type, event.sessionId, event.timestamp, JSON.stringify(event.payload));
  }

  public listLedgerEvents(runId: string): AgentRelayEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM ledger_events WHERE run_id = ? ORDER BY seq ASC')
      .all(runId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      eventId: row.event_id as string,
      type: row.type as AgentRelayEvent['type'],
      runId,
      sessionId: row.session_id as string,
      timestamp: row.timestamp as number,
      payload: JSON.parse(row.payload as string) as Record<string, unknown>
    }));
  }

  // ─── outbox ───

  public enqueueOutbox(input: EnqueueOutboxInput): OutboxRow {
    const ts = this.now();
    const msgId = input.msgId ?? randomUUID();
    const payload = input.payload ? JSON.stringify(input.payload) : '{}';
    const row: OutboxRow = {
      msgId,
      runId: input.runId,
      handoffId: input.handoffId ?? null,
      topic: input.topic,
      targetSessionId: input.targetSessionId ?? null,
      payload,
      state: 'PENDING',
      attempts: 0,
      lastError: null,
      createdAt: ts,
      updatedAt: ts
    };
    this.db
      .prepare(
        `INSERT INTO run_outbox (
           msg_id, run_id, handoff_id, topic, target_session_id,
           payload, state, attempts, last_error, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        row.msgId,
        row.runId,
        row.handoffId,
        row.topic,
        row.targetSessionId,
        row.payload,
        row.state,
        row.attempts,
        row.lastError,
        row.createdAt,
        row.updatedAt
      );
    return row;
  }

  public updateOutboxState(
    msgId: string,
    state: OutboxRow['state'],
    options?: { lastError?: string; incrementAttempts?: boolean }
  ): void {
    if (options?.incrementAttempts) {
      if (options.lastError !== undefined) {
        this.db
          .prepare(
            `UPDATE run_outbox SET state = ?, attempts = attempts + 1, last_error = ?, updated_at = ? WHERE msg_id = ?`
          )
          .run(state, options.lastError, this.now(), msgId);
      } else {
        this.db
          .prepare(
            `UPDATE run_outbox SET state = ?, attempts = attempts + 1, updated_at = ? WHERE msg_id = ?`
          )
          .run(state, this.now(), msgId);
      }
    } else {
      if (options?.lastError !== undefined) {
        this.db
          .prepare(
            `UPDATE run_outbox SET state = ?, last_error = ?, updated_at = ? WHERE msg_id = ?`
          )
          .run(state, options.lastError, this.now(), msgId);
      } else {
        this.db
          .prepare(
            `UPDATE run_outbox SET state = ?, updated_at = ? WHERE msg_id = ?`
          )
          .run(state, this.now(), msgId);
      }
    }
  }

  public getOutbox(msgId: string): OutboxRow | undefined {
    const row = this.db.prepare('SELECT * FROM run_outbox WHERE msg_id = ?').get(msgId) as
      | Record<string, unknown>
      | undefined;
    return row ? this.mapOutbox(row) : undefined;
  }

  public findOutboxByHandoff(handoffId: string, topic: string): OutboxRow | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM run_outbox WHERE handoff_id = ? AND topic = ? ORDER BY created_at DESC LIMIT 1`
      )
      .get(handoffId, topic) as Record<string, unknown> | undefined;
    return row ? this.mapOutbox(row) : undefined;
  }

  public listPendingOutbox(runId: string): OutboxRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM run_outbox WHERE run_id = ? AND state IN ('PENDING', 'DISPATCHED') ORDER BY created_at ASC`
      )
      .all(runId) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapOutbox(row));
  }

  // ─── mappers ───

  private mapOutbox(row: Record<string, unknown>): OutboxRow {
    return {
      msgId: row.msg_id as string,
      runId: row.run_id as string,
      handoffId: asString(row.handoff_id) ?? null,
      topic: row.topic as string,
      targetSessionId: asString(row.target_session_id) ?? null,
      payload: row.payload as string,
      state: row.state as OutboxRow['state'],
      attempts: row.attempts as number,
      lastError: asString(row.last_error) ?? null,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number
    };
  }

  private mapRun(row: Record<string, unknown>): RunRecord {
    return {
      runId: row.run_id as string,
      workspaceKey: row.workspace_key as string,
      workspacePath: row.workspace_path as string,
      goal: row.goal as string,
      model: {
        provider: row.provider as string,
        model: row.model as string,
        effort: asString(row.effort)
      },
      state: row.state as RunState,
      currentSessionId: asString(row.current_session_id),
      currentEpoch: row.current_epoch as number,
      handoffCount: row.handoff_count as number,
      unitCount: row.unit_count as number,
      currentSessionUnitCount: row.current_session_unit_count as number,
      authorizedInputHash: asString(row.authorized_input_hash),
      authorizedContractVersion: asNumber(row.authorized_contract_version),
      authorizedIntentWatermark: asNumber(row.authorized_intent_watermark),
      pauseReason: asString(row.pause_reason),
      blockedReason: asString(row.blocked_reason),
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number
    };
  }

  private mapIntent(row: Record<string, unknown>): ControlIntentRecord {
    return {
      intentId: row.intent_id as string,
      runId: row.run_id as string,
      kind: row.kind as ControlIntentKind,
      payload: JSON.parse(row.payload as string) as Record<string, unknown>,
      watermark: row.watermark as number,
      createdAt: row.created_at as number,
      consumedAt: asNumber(row.consumed_at)
    };
  }

  private mapChainLink(row: Record<string, unknown>): SessionChainLink {
    return {
      linkId: row.link_id as string,
      runId: row.run_id as string,
      sequence: row.sequence as number,
      prevSessionId: asString(row.prev_session_id),
      nextSessionId: row.next_session_id as string,
      adapter: row.adapter as string,
      provider: row.provider as string,
      model: row.model as string,
      effort: asString(row.effort),
      epoch: row.epoch as number,
      handoffId: asString(row.handoff_id),
      reason: row.reason as string,
      createdAt: row.created_at as number,
      supersededAt: asNumber(row.superseded_at)
    };
  }

  private mapHandoff(row: Record<string, unknown>): HandoffRecord {
    return {
      handoffId: row.handoff_id as string,
      runId: row.run_id as string,
      epoch: row.epoch as number,
      sourceSessionId: row.source_session_id as string,
      targetSessionId: asString(row.target_session_id),
      state: row.state as string,
      manifestPath: asString(row.manifest_path),
      manifestHash: asString(row.manifest_hash),
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number
    };
  }
}
