import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { computeSha256 } from '../../../protocol/src/index.ts';
import type { WorkspaceFingerprint } from '../../../protocol/src/types.ts';
import type { AgentRelayAdapter } from '../../../protocol/src/adapter.ts';
import { WorkspaceSentinel } from '../workspace/sentinel.ts';
import type { RunStore, RunState, RunRecord, HandoffRecord } from './store.ts';
import type { ControlIntentLog } from './intent.ts';
import type { RunEventLog } from './events.ts';
import { SessionChainLedger } from './chain.ts';
import type { DurableLeaseManager } from '../handoff/durable-lease.ts';

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
  adapter?: AgentRelayAdapter;
  chain?: SessionChainLedger;
  leaseManager?: DurableLeaseManager;
  adapterName?: string;
  quiescenceTimeoutMs?: number;
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
          const handoff = this.options.store.getHandoff(handoffId);
          if (handoff && handoff.state !== 'ABANDONED') {
            this.options.store.updateHandoff(handoffId, { state: 'ABANDONED' });
          }
          const currentRun = this.options.store.getRun(runId);
          if (currentRun && (currentRun.state === 'CHECKPOINTED' || currentRun.state === 'DRAINING')) {
            this.options.store.updateRunState(runId, 'RUNNING');
          }
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
            JSON.parse(content);
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
            const currentRun = this.options.store.getRun(runId);
            if (currentRun && (currentRun.state === 'CHECKPOINTED' || currentRun.state === 'DRAINING')) {
              this.options.store.updateRunState(runId, 'RUNNING');
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
        if (this.options.leaseManager) {
          const lease = this.options.leaseManager.getLease(run.workspaceKey);
          if (lease) {
            this.options.leaseManager.releaseLease(run.workspaceKey, lease.currentOwner);
          }
        }
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

    // =========================================================================
    // Phase 3: 外部会话与发信箱对账 (V14, V17, V18)
    // =========================================================================

    const runBeforePhase3 = this.options.store.getRun(runId) ?? refreshedRunAfterPhase1;

    // -------------------------------------------------------------------------
    // 3.1 V14 Outbox 创建会话对账
    // -------------------------------------------------------------------------
    const pendingOutbox = this.options.store.listPendingOutbox(runId);
    const createSessionMsgs = pendingOutbox.filter((m) => m.topic === 'create_session');

    for (const msg of createSessionMsgs) {
      if (!msg.targetSessionId) continue;
      const handoff = msg.handoffId ? this.options.store.getHandoff(msg.handoffId) : undefined;
      const isTargetHandoffOrRunMatching =
        (handoff && ['CREATING', 'STARTING', 'PREPARING'].includes(handoff.state)) ||
        (!handoff && ['CREATING', 'STARTING', 'PREPARING'].includes(runBeforePhase3.state)) ||
        ['CREATING', 'STARTING', 'PREPARING'].includes(runBeforePhase3.state);

      if (isTargetHandoffOrRunMatching) {
        if (this.options.adapter) {
          let inspected;
          let inspectError = false;
          try {
            inspected = await this.options.adapter.inspectSession(msg.targetSessionId);
          } catch {
            inspectError = true;
          }

          if (!inspectError && inspected && inspected.active !== false) {
            this.options.store.updateOutboxState(msg.msgId, 'DISPATCHED');
            if (handoff && handoff.state === 'CREATING') {
              this.options.store.updateHandoff(handoff.handoffId, { state: 'PREPARING' });
            }
            if (runBeforePhase3.state === 'STARTING') {
              this.options.store.updateRunState(runId, 'PREPARING');
            }
            healedActions.push('rebound_session:' + msg.targetSessionId);
          } else {
            this.options.store.updateRunState(runId, 'RECOVERY_REQUIRED', {
              blockedReason: 'session_creation_ambiguous'
            });
            if (this.options.events) {
              this.options.events.record({
                runId,
                type: 'recovery_required',
                payload: { reason: 'session_creation_ambiguous', targetSessionId: msg.targetSessionId }
              });
            }
            return {
              recoveredState: 'RECOVERY_REQUIRED',
              healedActions,
              requiresManualIntervention: true,
              reason: 'session_creation_ambiguous'
            };
          }
        } else {
          this.options.store.updateRunState(runId, 'RECOVERY_REQUIRED', {
            blockedReason: 'session_creation_ambiguous'
          });
          if (this.options.events) {
            this.options.events.record({
              runId,
              type: 'recovery_required',
              payload: { reason: 'session_creation_ambiguous', targetSessionId: msg.targetSessionId }
            });
          }
          return {
            recoveredState: 'RECOVERY_REQUIRED',
            healedActions,
            requiresManualIntervention: true,
            reason: 'session_creation_ambiguous'
          };
        }
      }
    }

    // -------------------------------------------------------------------------
    // 3.2 V17 幂等执行令牌重发
    // -------------------------------------------------------------------------
    const authorizedHandoff = this.findAuthorizedHandoff(runId);
    if (authorizedHandoff && authorizedHandoff.targetSessionId) {
      const latestRun = this.options.store.getRun(runId) ?? runBeforePhase3;
      const epoch = latestRun.currentEpoch || authorizedHandoff.epoch || 1;
      const targetSessionId = authorizedHandoff.targetSessionId;

      const chain = this.options.chain ?? new SessionChainLedger(this.options.store);
      const chainLinks = chain.list(runId);
      const alreadyInChain = chainLinks.some((link) => link.nextSessionId === targetSessionId);

      if (this.options.adapter) {
        const token = `EXEC_TOKEN_${randomUUID()}`;
        let authOk = false;
        try {
          authOk = Boolean(await this.options.adapter.authorizeExecution(targetSessionId, epoch, token));
        } catch {
          authOk = false;
        }

        if (authOk) {
          this.options.store.transaction(() => {
            if (!alreadyInChain) {
              chain.append({
                runId,
                prevSessionId: authorizedHandoff.sourceSessionId,
                nextSessionId: targetSessionId,
                adapter: this.options.adapterName ?? 'unknown',
                provider: latestRun.model.provider,
                model: latestRun.model.model,
                effort: latestRun.model.effort,
                epoch,
                handoffId: authorizedHandoff.handoffId,
                reason: 'unit_completed'
              });
              try {
                chain.supersede(authorizedHandoff.sourceSessionId);
              } catch {
                // Ignore if sourceSessionId not in chain
              }
            }

            this.options.store.updateHandoff(authorizedHandoff.handoffId, { state: 'COMPLETED' });

            const outbox = this.options.store.findOutboxByHandoff(authorizedHandoff.handoffId, 'create_session');
            if (outbox) {
              this.options.store.updateOutboxState(outbox.msgId, 'ACKED');
            }
            const currentPending = this.options.store.listPendingOutbox(runId);
            for (const m of currentPending) {
              if (m.topic === 'create_session' && m.targetSessionId === targetSessionId) {
                this.options.store.updateOutboxState(m.msgId, 'ACKED');
              }
            }

            this.options.store.updateRunState(runId, 'RUNNING', {
              currentSessionId: targetSessionId,
              currentEpoch: epoch,
              blockedReason: null,
              pauseReason: null
            });
          });

          healedActions.push('replayed_execution_token:' + targetSessionId);

          try {
            await this.options.adapter.interruptOwned(authorizedHandoff.sourceSessionId);
          } catch {
            // Ignore interrupt failure on previous session
          }

          if (this.options.events) {
            this.options.events.record({
              runId,
              type: 'reconcile_token_replayed',
              sessionId: targetSessionId,
              payload: { handoffId: authorizedHandoff.handoffId }
            });
          }

          return {
            recoveredState: 'RUNNING',
            requiresManualIntervention: false,
            healedActions
          };
        } else {
          this.options.store.updateRunState(runId, 'RECOVERY_REQUIRED', {
            blockedReason: 'execution_authorization_failed'
          });
          if (this.options.events) {
            this.options.events.record({
              runId,
              type: 'recovery_required',
              payload: { reason: 'execution_authorization_failed', targetSessionId }
            });
          }
          return {
            recoveredState: 'RECOVERY_REQUIRED',
            healedActions,
            requiresManualIntervention: true,
            reason: 'execution_authorization_failed'
          };
        }
      } else {
        this.options.store.updateRunState(runId, 'RECOVERY_REQUIRED', {
          blockedReason: 'execution_authorization_failed'
        });
        if (this.options.events) {
          this.options.events.record({
            runId,
            type: 'recovery_required',
            payload: { reason: 'execution_authorization_failed', targetSessionId }
          });
        }
        return {
          recoveredState: 'RECOVERY_REQUIRED',
          healedActions,
          requiresManualIntervention: true,
          reason: 'execution_authorization_failed'
        };
      }
    }

    // -------------------------------------------------------------------------
    // 3.3 V18 旧会话静止与退避
    // -------------------------------------------------------------------------
    const runForQuiescence = this.options.store.getRun(runId) ?? runBeforePhase3;
    if (runForQuiescence.state === 'DRAINING') {
      const fromSessionId = runForQuiescence.currentSessionId;
      if (!fromSessionId || !this.options.adapter) {
        this.options.store.updateRunState(runId, 'RECOVERY_REQUIRED', {
          blockedReason: 'old_session_quiescence_unconfirmed'
        });
        if (this.options.events) {
          this.options.events.record({
            runId,
            type: 'recovery_required',
            payload: { reason: 'old_session_quiescence_unconfirmed' }
          });
        }
        return {
          recoveredState: 'RECOVERY_REQUIRED',
          healedActions,
          requiresManualIntervention: true,
          reason: 'old_session_quiescence_unconfirmed'
        };
      }

      let q: string | undefined;
      try {
        await this.options.adapter.interruptOwned(fromSessionId);
        q = await this.options.adapter.awaitQuiescence(
          fromSessionId,
          this.options.quiescenceTimeoutMs ?? 5000
        );
      } catch {
        q = 'error';
      }

      if (q !== 'quiescent') {
        this.options.store.updateRunState(runId, 'RECOVERY_REQUIRED', {
          blockedReason: 'old_session_quiescence_unconfirmed'
        });
        if (this.options.events) {
          this.options.events.record({
            runId,
            type: 'recovery_required',
            payload: { reason: 'old_session_quiescence_unconfirmed', sessionId: fromSessionId }
          });
        }
        return {
          recoveredState: 'RECOVERY_REQUIRED',
          healedActions,
          requiresManualIntervention: true,
          reason: 'old_session_quiescence_unconfirmed'
        };
      }

      this.options.store.updateRunState(runId, 'CHECKPOINTED');
      const drainingHandoff = this.findHandoffInState(runId, 'DRAINING');
      if (drainingHandoff) {
        this.options.store.updateHandoff(drainingHandoff.handoffId, { state: 'CHECKPOINTED' });
      }

      healedActions.push('quiesced_draining_session:' + fromSessionId);
      return {
        recoveredState: 'CHECKPOINTED',
        requiresManualIntervention: false,
        healedActions
      };
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

  private findAuthorizedHandoff(runId: string): HandoffRecord | undefined {
    return this.findHandoffInState(runId, 'AUTHORIZED');
  }

  private findHandoffInState(runId: string, state: string): HandoffRecord | undefined {
    return this.options.store.findHandoffInState(runId, state);
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
