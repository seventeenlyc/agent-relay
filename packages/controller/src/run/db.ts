// packages/controller/src/run/db.ts
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const SCHEMA_VERSION = '1';

export interface RelayDatabaseOptions {
  /** 绝对路径，或 ':memory:' 用于测试 */
  dbPath: string;
  busyTimeoutMs?: number;
}

const SCHEMA_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS schema_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS runs (
    run_id                      TEXT PRIMARY KEY,
    workspace_key               TEXT NOT NULL,
    workspace_path              TEXT NOT NULL,
    goal                        TEXT NOT NULL,
    provider                    TEXT NOT NULL DEFAULT 'unknown',
    model                       TEXT NOT NULL DEFAULT 'unknown',
    effort                      TEXT,
    state                       TEXT NOT NULL,
    current_session_id          TEXT,
    current_epoch               INTEGER NOT NULL DEFAULT 1,
    handoff_count               INTEGER NOT NULL DEFAULT 0,
    unit_count                  INTEGER NOT NULL,
    current_session_unit_count  INTEGER NOT NULL DEFAULT 0,
    authorized_input_hash       TEXT,
    authorized_contract_version INTEGER,
    authorized_intent_watermark INTEGER,
    pause_reason                TEXT,
    blocked_reason              TEXT,
    created_at                  INTEGER NOT NULL,
    updated_at                  INTEGER NOT NULL
  )`,

  // 同一物理工作区同时最多一个活动 run（终态 run 不占用该唯一索引）
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_active_workspace
     ON runs(workspace_key)
     WHERE state NOT IN ('CANCELLED', 'COMPLETED', 'DISABLED')`,

  `CREATE TABLE IF NOT EXISTS control_intents (
    intent_id   TEXT PRIMARY KEY,
    run_id      TEXT NOT NULL,
    kind        TEXT NOT NULL,
    payload     TEXT NOT NULL DEFAULT '{}',
    watermark   INTEGER NOT NULL,
    created_at  INTEGER NOT NULL,
    consumed_at INTEGER,
    UNIQUE(run_id, watermark)
  )`,

  `CREATE TABLE IF NOT EXISTS session_chain (
    link_id         TEXT PRIMARY KEY,
    run_id          TEXT NOT NULL,
    sequence        INTEGER NOT NULL,
    prev_session_id TEXT,
    next_session_id TEXT NOT NULL,
    adapter         TEXT NOT NULL,
    provider        TEXT NOT NULL,
    model           TEXT NOT NULL,
    effort          TEXT,
    epoch           INTEGER NOT NULL,
    handoff_id      TEXT,
    reason          TEXT NOT NULL,
    created_at      INTEGER NOT NULL,
    superseded_at   INTEGER
  )`,

  `CREATE INDEX IF NOT EXISTS idx_chain_run ON session_chain(run_id, sequence)`,

  `CREATE TABLE IF NOT EXISTS handoffs (
    handoff_id        TEXT PRIMARY KEY,
    run_id            TEXT NOT NULL,
    epoch             INTEGER NOT NULL,
    source_session_id TEXT NOT NULL,
    target_session_id TEXT,
    state             TEXT NOT NULL,
    manifest_path     TEXT,
    manifest_hash     TEXT,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS run_events (
    event_id   INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id     TEXT NOT NULL,
    type       TEXT NOT NULL,
    severity   TEXT NOT NULL,
    session_id TEXT,
    payload    TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS idx_events_run ON run_events(run_id, event_id)`,

  `CREATE TABLE IF NOT EXISTS lease_state (
    workspace_key TEXT PRIMARY KEY,
    current_owner TEXT NOT NULL,
    epoch         INTEGER NOT NULL,
    acquired_at   INTEGER NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS input_ledger (
    run_id        TEXT NOT NULL,
    seq           INTEGER NOT NULL,
    input_id      TEXT NOT NULL,
    source        TEXT NOT NULL,
    raw_content   TEXT NOT NULL,
    sha256_hash   TEXT NOT NULL,
    supersedes_id TEXT,
    metadata      TEXT,
    created_at    INTEGER NOT NULL,
    PRIMARY KEY (run_id, seq)
  )`,

  `CREATE TABLE IF NOT EXISTS task_snapshots (
    run_id        TEXT NOT NULL,
    seq           INTEGER NOT NULL,
    snapshot_json TEXT NOT NULL,
    snapshot_hash TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    PRIMARY KEY (run_id, seq)
  )`,

  `CREATE TABLE IF NOT EXISTS ledger_events (
    run_id     TEXT NOT NULL,
    seq        INTEGER NOT NULL,
    event_id   TEXT NOT NULL,
    type       TEXT NOT NULL,
    session_id TEXT,
    timestamp  INTEGER NOT NULL,
    payload    TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (run_id, seq)
  )`,

  `CREATE TABLE IF NOT EXISTS run_outbox (
    msg_id            TEXT PRIMARY KEY,
    run_id            TEXT NOT NULL,
    handoff_id        TEXT,
    topic             TEXT NOT NULL,
    target_session_id TEXT,
    payload           TEXT NOT NULL DEFAULT '{}',
    state             TEXT NOT NULL,
    attempts          INTEGER NOT NULL DEFAULT 0,
    last_error        TEXT,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_outbox_run ON run_outbox(run_id, state)`,
  `CREATE INDEX IF NOT EXISTS idx_outbox_handoff ON run_outbox(handoff_id)`
];

/**
 * 权威库。负责连接生命周期、pragma、schema 迁移与可重入事务。
 * 所有写操作必须经由 transaction() 包裹以保证原子性。
 */
export class RelayDatabase {
  private readonly handle: DatabaseSync;
  private readonly dbPath: string;
  private depth = 0;
  private closed = false;

  constructor(options: RelayDatabaseOptions) {
    this.dbPath = options.dbPath;
    if (options.dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(options.dbPath), { recursive: true });
    }
    this.handle = new DatabaseSync(options.dbPath);
    try {
      this.handle.exec('PRAGMA journal_mode = WAL');
      this.handle.exec(`PRAGMA busy_timeout = ${options.busyTimeoutMs ?? 3000}`);
      this.handle.exec('PRAGMA foreign_keys = ON');
      this.migrate();
    } catch (err) {
      // 构造失败也必须释放原生句柄：Windows 上未关闭的句柄会锁住文件
      try { this.handle.close(); } catch { /* 保留原始错误 */ }
      throw err;
    }
  }

  public migrate(): void {
    for (const statement of SCHEMA_STATEMENTS) {
      this.handle.exec(statement);
    }
    this.handle
      .prepare('INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)')
      .run('schema_version', SCHEMA_VERSION);
  }

  public prepare(sql: string) {
    return this.handle.prepare(sql);
  }

  public exec(sql: string): void {
    this.handle.exec(sql);
  }

  /**
   * 可重入事务：最外层用 BEGIN IMMEDIATE / COMMIT，内层用 SAVEPOINT / RELEASE。
   * 回调抛错时回滚到对应层并原样重抛。
   */
  public transaction<T>(fn: () => T): T {
    const isOuter = this.depth === 0;
    const entryDepth = this.depth;
    if (isOuter) {
      this.handle.exec('BEGIN IMMEDIATE');
    } else {
      this.handle.exec(`SAVEPOINT relay_sp_${entryDepth}`);
    }
    this.depth = entryDepth + 1;
    try {
      const result = fn();
      if (isOuter) {
        this.handle.exec('COMMIT');
      } else {
        this.handle.exec(`RELEASE relay_sp_${entryDepth}`);
      }
      return result;
    } catch (err) {
      try {
        if (isOuter) {
          this.handle.exec('ROLLBACK');
        } else {
          this.handle.exec(`ROLLBACK TO relay_sp_${entryDepth}`);
          this.handle.exec(`RELEASE relay_sp_${entryDepth}`);
        }
      } catch {
        // 回滚失败时保留原始错误，交由上层处理
      }
      throw err;
    } finally {
      // 必须在所有退出路径上恰好恢复一次：COMMIT/RELEASE 失败也不能让 depth 偏移，
      // 否则后续事务会生成非法 savepoint 名（relay_sp_-1）并让连接永久不可用
      this.depth = entryDepth;
    }
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.handle.close();
    } catch {
      // 关闭失败不影响调用方
    }
  }

  public getPath(): string {
    return this.dbPath;
  }
}
