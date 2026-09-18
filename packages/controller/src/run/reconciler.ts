import fs from 'node:fs';
import path from 'node:path';
import { computeSha256 } from '../../../protocol/src/index.ts';
import type { WorkspaceFingerprint } from '../../../protocol/src/types.ts';
import { WorkspaceSentinel } from '../workspace/sentinel.ts';
import type { RunStore, RunState, RunRecord, HandoffRecord } from './store.ts';
import type { ControlIntentLog } from './intent.ts';
import type { RunEventLog } from './events.ts';

export interface ReconcileResult {
  recoveredState: RunState;
  healedActions: string[];
  requiresManualIntervention: boolean;
  reason?: string;
  discrepancyDetails?: Record<string, unknown>;
}

export interface RunReconcilerOptions {
  store: RunStore;
  dataDir: string;
  sentinel?: WorkspaceSentinel;
  intents?: ControlIntentLog;
  events?: RunEventLog;
}

export class RunReconciler {
  private readonly options: RunReconcilerOptions;

  constructor(options: RunReconcilerOptions) {
    this.options = options;
  }

  public async reconcile(runId: string): Promise<ReconcileResult> {
    const run = this.options.store.getRun(runId);
    if (!run) {
      throw new Error(`RunReconciler: run ${runId} not found`);
    }

    const healedActions: string[] = [];

    // =========================================================================
    // Phase 1: 静态不变量核对与孤立快照清理 (V16, V21)
    // =========================================================================

    // 1.1 快照孤立文件与损坏清理 (V16)
    // 检查快照存放路径：既支持 <dataDir>/relay-data/<runId>/handoffs 也支持 <dataDir>/<runId>/handoffs
    const potentialDirs = [
      path.join(this.options.dataDir, 'relay-data', runId, 'handoffs'),
      path.join(this.options.dataDir, runId, 'handoffs')
    ];

    for (const handoffsDir of potentialDirs) {
      if (!fs.existsSync(handoffsDir)) continue;

      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(handoffsDir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const handoffId = entry.name;
        const handoffDir = path.join(handoffsDir, handoffId);
        const manifestPath = path.join(handoffDir, 'manifest.json');
        const tmpManifestPath = `${manifestPath}.tmp`;

        // 清理残存的 .tmp 文件
        if (fs.existsSync(tmpManifestPath)) {
          fs.rmSync(tmpManifestPath, { force: true });
          const action = `purged_corrupted_snapshot:${handoffId}`;
          if (!healedActions.includes(action)) {
            healedActions.push(action);
          }
        }

        if (fs.existsSync(manifestPath)) {
          let content = '';
          let hash = '';
          let parseFailed = false;
          try {
            content = fs.readFileSync(manifestPath, 'utf8');
            hash = computeSha256(content);
          } catch {
            parseFailed = true;
          }

          const handoff = this.options.store.getHandoff(handoffId);
          // 若 handoff 不存在，或者 handoff.state 处于尚未发布完成状态（如 REQUESTED / ABANDONED），
          // 或者实际哈希与 handoff.manifest_hash 不一致，或者读取解析失败
          const isCorruptedOrOrphan =
            parseFailed ||
            !handoff ||
            handoff.state === 'REQUESTED' ||
            handoff.state === 'ABANDONED' ||
            !handoff.manifestHash ||
            handoff.manifestHash !== hash;

          if (isCorruptedOrOrphan) {
            fs.rmSync(manifestPath, { force: true });
            if (handoff && handoff.state !== 'ABANDONED') {
              this.options.store.updateHandoff(handoffId, { state: 'ABANDONED' });
            }
            const action = `purged_corrupted_snapshot:${handoffId}`;
            if (!healedActions.includes(action)) {
              healedActions.push(action);
            }
          }
        }
      }
    }

    // 1.2 意图守卫 (V21)
    if (this.options.intents) {
      const pending = this.options.intents.resolve(runId);
      if (pending && pending.kind === 'stop_now') {
        this.options.intents.consume(pending.intentId);
        this.options.store.updateRunState(runId, 'CANCELLED', {
          pauseReason: null,
          blockedReason: null
        });
        healedActions.push('honoured_stop_intent');
        if (this.options.events) {
          this.options.events.record({
            runId,
            type: 'run_cancelled',
            payload: { intentId: pending.intentId, reason: 'reconciler_honoured_stop_intent' }
          });
        }
        return {
          recoveredState: 'CANCELLED',
          healedActions,
          requiresManualIntervention: false
        };
      }
    }

    const refreshedRunAfterPhase1 = this.options.store.getRun(runId) ?? run;
    if (refreshedRunAfterPhase1.state === 'PAUSED') {
      const pendingWhilePaused = this.options.intents?.resolve(runId);
      if (!pendingWhilePaused || pendingWhilePaused.kind !== 'resume') {
        return {
          recoveredState: 'PAUSED',
          healedActions,
          requiresManualIntervention: false,
          reason: refreshedRunAfterPhase1.pauseReason ?? 'paused'
        };
      }
    }

    // =========================================================================
    // Phase 2: 工作区指纹核验与严格防御 (V25)
    // =========================================================================

    const sentinel = this.options.sentinel ?? new WorkspaceSentinel(refreshedRunAfterPhase1.workspacePath);

    // 获取基线指纹 baselineFp
    let baselineFp: WorkspaceFingerprint | undefined;

    // A. 从 store 中已完成或 SNAPSHOTTED 的 handoff 获取
    const latestHandoff = this.getLatestPublishedHandoff(runId);
    if (latestHandoff?.manifestPath && fs.existsSync(latestHandoff.manifestPath)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(latestHandoff.manifestPath, 'utf8')) as {
          workspaceFingerprint?: WorkspaceFingerprint;
        };
        if (manifest.workspaceFingerprint) {
          baselineFp = manifest.workspaceFingerprint;
        }
      } catch {
        // Fallback
      }
    }

    // B. 若无已发布 handoff，从 run_started 事件的 payload 中获取首个基线
    if (!baselineFp) {
      const events = this.options.events
        ? this.options.events.list(runId)
        : this.options.store.listEvents(runId);
      const startEvent = events.find((e) => e.type === 'run_started');
      if (startEvent?.payload?.baselineFingerprint) {
        baselineFp = startEvent.payload.baselineFingerprint as WorkspaceFingerprint;
      }
    }

    if (baselineFp) {
      const currentFp = sentinel.captureFingerprint();
      const commitMismatch = currentFp.commitHash !== baselineFp.commitHash;
      const treeMismatch = currentFp.treeHash !== baselineFp.treeHash;

      if (commitMismatch || treeMismatch) {
        const newUntracked = currentFp.untrackedFiles.filter((f) => !baselineFp.untrackedFiles.includes(f));
        const newDirty = currentFp.dirtyFiles.filter((f) => !baselineFp.dirtyFiles.includes(f));

        const discrepancyDetails: Record<string, unknown> = {
          expectedCommit: baselineFp.commitHash,
          actualCommit: currentFp.commitHash,
          expectedTreeHash: baselineFp.treeHash,
          actualTreeHash: currentFp.treeHash,
          newUntrackedFiles: newUntracked,
          newDirtyFiles: newDirty
        };

        this.options.store.updateRunState(runId, 'RECOVERY_REQUIRED', {
          blockedReason: 'workspace_fingerprint_mismatch'
        });

        if (this.options.events) {
          this.options.events.record({
            runId,
            type: 'workspace_mismatch_detected',
            payload: discrepancyDetails
          });
        }

        return {
          recoveredState: 'RECOVERY_REQUIRED',
          healedActions,
          requiresManualIntervention: true,
          reason: 'workspace_fingerprint_mismatch',
          discrepancyDetails
        };
      }
    }

    const finalRun = this.options.store.getRun(runId) ?? refreshedRunAfterPhase1;
    const requiresManualIntervention = finalRun.state === 'RECOVERY_REQUIRED';

    return {
      recoveredState: finalRun.state,
      healedActions,
      requiresManualIntervention,
      reason: requiresManualIntervention ? finalRun.blockedReason ?? 'recovery_required' : undefined
    };
  }

  private getLatestPublishedHandoff(runId: string): HandoffRecord | undefined {
    if (typeof (this.options.store as any).getLatestHandoff === 'function') {
      return (this.options.store as any).getLatestHandoff(runId);
    }
    const db = (this.options.store as any).db;
    if (db) {
      const row = db
        .prepare(
          `SELECT * FROM handoffs
             WHERE run_id = ?
               AND state NOT IN ('REQUESTED', 'ABANDONED')
               AND manifest_path IS NOT NULL
             ORDER BY created_at DESC, rowid DESC LIMIT 1`
        )
        .get(runId) as Record<string, unknown> | undefined;
      if (row) {
        return {
          handoffId: row.handoff_id as string,
          runId: row.run_id as string,
          epoch: row.epoch as number,
          sourceSessionId: row.source_session_id as string,
          targetSessionId: row.target_session_id as string | undefined,
          state: row.state as string,
          manifestPath: row.manifest_path as string | undefined,
          manifestHash: row.manifest_hash as string | undefined,
          createdAt: row.created_at as number,
          updatedAt: row.updated_at as number
        };
      }
    }
    return undefined;
  }
}
