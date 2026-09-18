// packages/controller/src/run/engine.ts
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { computeSha256 } from '../../../protocol/src/index.ts';
import type { AgentRelayAdapter } from '../../../protocol/src/adapter.ts';
import type { HandshakeCoordinator } from '../../../protocol/src/coordinator.ts';
import type { HandoffPackManifest, TaskItem } from '../../../protocol/src/types.ts';
import { InputLedger } from '../inputs/ledger.ts';
import { deriveContractFromLedger } from '../inputs/supersedes.ts';
import { TaskGraph } from '../tasks/graph.ts';
import { TriggerPolicy } from '../policy/trigger.ts';
import { LoopDetector } from '../policy/loop-detector.ts';
import { WorkspaceSentinel } from '../workspace/sentinel.ts';
import { normalizeWorkspaceKey } from '../workspace/key.ts';
import { HandoffPackager } from '../workspace/checkpoint.ts';
import { HandoffStateMachine } from '../handoff/state-machine.ts';
import { DurableLeaseManager } from '../handoff/durable-lease.ts';
import { RunStore, type RunRecord, type RunState } from './store.ts';
import { ControlIntentLog, type PendingControl } from './intent.ts';
import { SessionChainLedger } from './chain.ts';
import { RunEventLog } from './events.ts';
import { ConsoleNotifier, type Notifier } from './notifier.ts';
import {
  buildRunBriefing,
  buildUnitPrompt,
  normalizeUnitResult,
  parseUnitResult,
  type UnitResult,
  type UnitResultStatus
} from './prompt.ts';
import { buildRunStatus, writeStateProjection } from './status.ts';
import { RunReconciler, type ReconcileResult } from './reconciler.ts';

export type { ReconcileResult };

export type FaultInjectionPoint =
  | 'before_intent_record'
  | 'after_intent_record'
  | 'before_old_drain'
  | 'after_old_quiescence'
  | 'during_snapshot_write'          // 模拟快照写到一半断电产生损坏文件 (V16)
  | 'after_snapshot_file_written'    // 模拟快照已落盘但数据库事务未提交 (孤立文件 V16)
  | 'after_db_publish'
  | 'before_session_create_call'     // outbox 记录已落盘，但未调用适配器 (V14)
  | 'session_create_response_lost'   // 适配器会话已创建，但主控未收到响应即崩溃 (V14)
  | 'during_readonly_prep'           // 只读准备中崩溃
  | 'after_ack_received'             // ACK 已收到，但 CAS 事务前崩溃
  | 'after_owner_cas'                // CAS 已转让，但继续令牌投递前崩溃 (V17)
  | 'after_token_dispatch'           // 令牌已投递，首个写操作前崩溃
  | 'during_first_write';

export interface FaultContext {
  runId: string;
  handoffId?: string;
  sessionId?: string;
  epoch?: number;
  stage?: string;
  metadata?: Record<string, unknown>;
}

export type FaultHook = (point: FaultInjectionPoint, context: FaultContext) => Promise<void> | void;

export interface StartRunConfig {
  runId: string;
  goal: string;
  /** 物理工作区路径；引擎内部规范化为 workspaceKey */
  workspacePath: string;
  tasks: Array<{
    taskId: string;
    requirementId: string;
    title: string;
    description?: string;
    dependencies?: string[];
    allowedPaths?: string[];
    expectedArtifacts?: string[];
  }>;
  model: { provider: string; model: string; effort?: string };
  /** 原始人类输入，原样写入不可变账本 */
  initialUserMessage: string;
}

export interface CoordinatorDeps {
  adapter: AgentRelayAdapter;
  leaseManager: DurableLeaseManager;
  stateMachine: HandoffStateMachine;
  workspaceKey: string;
  runId: string;
}

export interface RunControllerOptions {
  store: RunStore;
  dataDir: string;
  adapter: AgentRelayAdapter;
  adapterName: 'codex' | 'claude' | 'dsh';
  createCoordinator: (deps: CoordinatorDeps) => HandshakeCoordinator;
  notifier?: Notifier;
  clock?: () => number;
  quiescenceTimeoutMs?: number;
  settleTimeoutMs?: number;
  maxActiveDurationMs?: number;
  faultHook?: FaultHook;
}

export type RunTickOutcome =
  | { kind: 'unit_executed'; taskId: string; status: UnitResultStatus }
  | { kind: 'handoff_performed'; handoffId: string; fromSessionId: string; toSessionId: string; epoch: number }
  | { kind: 'paused'; intentId?: string; reason?: string }
  | { kind: 'stopped'; intentId?: string }
  | { kind: 'disabled'; intentId?: string }
  | { kind: 'completed' }
  | { kind: 'blocked'; reason: string }
  | { kind: 'recovery_required'; reason: string };

interface ResolvedSession {
  sessionId: string;
}

export class RunController {
  private readonly store: RunStore;
  private readonly dataDir: string;
  private readonly adapter: AgentRelayAdapter;
  private readonly adapterName: 'codex' | 'claude' | 'dsh';
  private readonly createCoordinator: (deps: CoordinatorDeps) => HandshakeCoordinator;
  private readonly notifier: Notifier;
  private readonly clock: () => number;
  private readonly quiescenceTimeoutMs: number;
  private readonly settleTimeoutMs: number;
  private readonly maxActiveDurationMs: number;
  private readonly packager = new HandoffPackager();
  private readonly faultHook?: FaultHook;

  private readonly events: RunEventLog;
  private readonly intents: ControlIntentLog;
  private readonly chain: SessionChainLedger;
  private readonly leaseManager: DurableLeaseManager;
  private reconciler: RunReconciler;

  private runId = '';
  private ledger = new InputLedger();
  private graph = new TaskGraph();
  private sentinel: WorkspaceSentinel | null = null;
  private stateMachine: HandoffStateMachine | null = null;
  private triggerPolicy: TriggerPolicy;
  private loopDetector = new LoopDetector();

  constructor(options: RunControllerOptions) {
    this.store = options.store;
    this.dataDir = options.dataDir;
    this.adapter = options.adapter;
    this.adapterName = options.adapterName;
    this.createCoordinator = options.createCoordinator;
    this.notifier = options.notifier ?? new ConsoleNotifier();
    this.clock = options.clock ?? (() => Date.now());
    this.quiescenceTimeoutMs = options.quiescenceTimeoutMs ?? 30_000;
    this.settleTimeoutMs = options.settleTimeoutMs ?? 2000;
    this.maxActiveDurationMs = options.maxActiveDurationMs ?? 45 * 60 * 1000;

    this.events = new RunEventLog(this.store, this.notifier);
    this.intents = new ControlIntentLog(this.store);
    this.chain = new SessionChainLedger(this.store);
    this.leaseManager = new DurableLeaseManager(this.store);
    this.triggerPolicy = new TriggerPolicy({ maxActiveDurationMs: this.maxActiveDurationMs });
    this.faultHook = options.faultHook;
    this.reconciler = new RunReconciler({
      store: this.store,
      dataDir: this.dataDir,
      sentinel: this.sentinel ?? undefined,
      intents: this.intents,
      events: this.events
    });
  }

  private async triggerFaultHook(point: FaultInjectionPoint, ctx: FaultContext = {} as FaultContext): Promise<void> {
    if (this.faultHook) {
      await this.faultHook(point, { runId: this.runId, ...ctx });
    }
  }

  // ─── 生命周期 ───

  public startRun(config: StartRunConfig): RunRecord {
    const workspaceKey = normalizeWorkspaceKey(config.workspacePath);
    const existing = this.store.getActiveRunByWorkspace(workspaceKey);
    if (existing) {
      this.loadRun(existing.runId);
      this.events.record({
        runId: existing.runId,
        type: 'duplicate_activation_ignored',
        payload: { requestedRunId: config.runId }
      });
      return existing;
    }

    this.store.transaction(() => {
      this.store.insertRun({
        runId: config.runId,
        workspaceKey,
        workspacePath: path.resolve(config.workspacePath),
        goal: config.goal,
        model: config.model,
        state: 'INITIALIZING',
        unitCount: config.tasks.length
      });

      // 人类原始输入：追加式账本 + 落库镜像
      const bootstrapLedger = new InputLedger();
      const record = bootstrapLedger.appendUserMessage(config.initialUserMessage);
      this.store.appendInputRow(config.runId, this.store.nextInputSeq(config.runId), record);

      // 权威任务图：落库初始快照
      const bootstrapGraph = new TaskGraph();
      for (const task of config.tasks) {
        bootstrapGraph.addTask(task);
      }
      this.store.appendTaskSnapshot(
        config.runId,
        this.store.nextTaskSnapshotSeq(config.runId),
        JSON.stringify(bootstrapGraph.getAllTasks()),
        bootstrapGraph.computeSnapshotHash()
      );
    });

    this.loadRun(config.runId);
    this.persistStatusProjection();
    const baselineFingerprint = this.sentinel ? this.sentinel.captureFingerprint() : undefined;
    this.events.record({
      runId: config.runId,
      type: 'run_started',
      payload: {
        goal: config.goal,
        workspaceKey,
        unitCount: config.tasks.length,
        ...(baselineFingerprint ? { baselineFingerprint } : {})
      }
    });
    return this.store.getRun(config.runId)!;
  }

  public async reconcile(): Promise<ReconcileResult> {
    if (!this.runId) {
      throw new Error('RunController: cannot reconcile without an active or loaded run');
    }
    return this.reconciler.reconcile(this.runId);
  }

  public rehydrate(runId: string): RunRecord | undefined {
    const run = this.store.getRun(runId);
    if (!run) return undefined;
    this.loadRun(runId);
    return run;
  }

  public getCurrentSessionId(): string | undefined {
    return this.runId ? this.store.getRun(this.runId)?.currentSessionId : undefined;
  }

  /** 跨重启必须稳定一致的两个不变量哈希（账本与任务图）。 */
  public getInvariantHashes(): { inputLedgerHeadHash: string; taskSnapshotHash: string } {
    return {
      inputLedgerHeadHash: this.ledger.getHeadHash(),
      taskSnapshotHash: this.graph.computeSnapshotHash()
    };
  }

  // ─── 编排循环 ───

  public async tick(): Promise<RunTickOutcome> {
    const run = this.requireRun();

    if (run.state === 'COMPLETED') return { kind: 'completed' };
    if (run.state === 'CANCELLED') return { kind: 'stopped' };
    if (run.state === 'DISABLED') return { kind: 'disabled' };
    if (run.state === 'BLOCKED') return { kind: 'blocked', reason: run.blockedReason ?? 'blocked' };
    if (run.state === 'RECOVERY_REQUIRED') {
      return { kind: 'recovery_required', reason: run.blockedReason ?? 'recovery_required' };
    }

    // 交接中间态只有重启后才可能被看到：活着的交接在同一次 tick 内设置并清除它们，
    // 因此在这里看到这些状态意味着控制器死在交接中途，旧会话是否已封存、租约归谁都无法推断。
    // 此时绝不能推进单元——那会让一个不属于本会话的写入发生。
    if (
      run.state === 'DRAINING' ||
      run.state === 'CHECKPOINTED' ||
      run.state === 'STARTING' ||
      run.state === 'PREPARING' ||
      run.state === 'READY'
    ) {
      const reason = `run_found_mid_handoff:${run.state}`;
      this.store.updateRunState(this.runId, 'RECOVERY_REQUIRED', { blockedReason: reason });
      this.events.record({
        runId: this.runId,
        type: 'recovery_required',
        payload: { reason }
      });
      this.persistStatusProjection();
      return { kind: 'recovery_required', reason };
    }

    // PAUSED 是静止态：只有 resume（继续）或停止类意图（stop_now / disable）才能离开，
    // 否则必须原地停住——暂停期间绝不发起交接（V20）。
    if (run.state === 'PAUSED') {
      const pendingWhilePaused = this.intents.resolve(this.runId);
      const canProceed =
        pendingWhilePaused !== null &&
        (pendingWhilePaused.kind === 'resume' ||
          pendingWhilePaused.kind === 'stop_now' ||
          pendingWhilePaused.kind === 'disable');
      if (!canProceed) {
        return { kind: 'paused', reason: run.pauseReason ?? 'paused' };
      }
    }

    // 3. 控制意图（停止类优先）
    const pending = this.intents.resolve(this.runId);
    if (pending) {
      const outcome = await this.applyControlIntent(pending, run);
      if (outcome) return outcome;
    }

    const refreshed = this.requireRun();

    // 4. 确保存在存活的当前会话
    const sessionResult = await this.ensureSession(refreshed);
    if ('kind' in sessionResult) return sessionResult;

    const current = this.requireRun();

    // 5. 下一可执行单元
    const task = this.graph.getNextActionableTask();
    if (!task) {
      this.store.transaction(() => {
        this.store.updateRunState(this.runId, 'COMPLETED', {
          pauseReason: null,
          blockedReason: null
        });
        this.releaseWorkspaceLease(current);
        this.events.record({
          runId: this.runId,
          type: 'run_completed',
          payload: {
            completedUnits: this.graph.getAllTasks().filter((t) => t.status === 'completed').length,
            totalUnits: current.unitCount
          }
        });
        this.persistTaskSnapshot();
      });
      this.persistStatusProjection();
      return { kind: 'completed' };
    }

    // 6. 交接 or 原地执行
    if (current.currentSessionUnitCount > 0 && this.triggerPolicySaysHandoff()) {
      return this.performHandoff(task, current);
    }
    return this.executeUnit(task, current);
  }

  public async executeUntilSettled(maxTicks = 100): Promise<RunTickOutcome[]> {
    const outcomes: RunTickOutcome[] = [];
    for (let i = 0; i < maxTicks; i++) {
      const outcome = await this.tick();
      outcomes.push(outcome);
      if (outcome.kind !== 'unit_executed' && outcome.kind !== 'handoff_performed') {
        break;
      }
    }
    return outcomes;
  }

  // ─── 控制意图 ───

  /** 处理一个控制意图。返回 null 表示已处理完但本 tick 应继续推进。 */
  private async applyControlIntent(
    pending: PendingControl,
    run: RunRecord
  ): Promise<RunTickOutcome | null> {
    switch (pending.kind) {
      case 'stop_now': {
        this.events.record({
          runId: this.runId,
          type: 'control_stop_received',
          payload: { intentId: pending.intentId, watermark: pending.watermark }
        });

        const sessionId = run.currentSessionId;
        if (sessionId) {
          await this.adapter.interruptOwned(sessionId);
          const quiescence = await this.adapter.awaitQuiescence(sessionId, this.quiescenceTimeoutMs);
          if (quiescence !== 'quiescent') {
            // 无法确认静止则 RECOVERY_REQUIRED 但保留取消意图（§5.1 / 设计 §7）：
            // 意图在下面的 consume 之前保持未消费，恢复流程才看得见这次取消，
            // 否则恢复之后会把一个用户已经取消的 run 继续跑下去。
            this.store.updateRunState(this.runId, 'RECOVERY_REQUIRED', {
              blockedReason: 'stop_quiescence_unconfirmed',
              pauseReason: null
            });
            this.events.record({
              runId: this.runId,
              type: 'recovery_required',
              payload: { reason: 'stop_quiescence_unconfirmed' }
            });
            this.persistStatusProjection();
            return { kind: 'recovery_required', reason: 'stop_quiescence_unconfirmed' };
          }
        }

        // 消费放在静止确认之后：等待期间未消费的意图无害（引擎串行执行，无人读它），
        // 而上面那条恢复早退必须让意图原样留存。
        this.intents.consume(pending.intentId);
        this.store.updateRunState(this.runId, 'CANCELLED', { pauseReason: null, blockedReason: null });
        this.releaseWorkspaceLease(run);
        this.events.record({ runId: this.runId, type: 'run_cancelled', payload: { intentId: pending.intentId } });
        this.persistStatusProjection();
        return { kind: 'stopped', intentId: pending.intentId };
      }

      case 'disable': {
        this.intents.consume(pending.intentId);
        this.store.updateRunState(this.runId, 'DISABLED', { pauseReason: null });
        this.releaseWorkspaceLease(run);
        this.events.record({ runId: this.runId, type: 'run_disabled', payload: { intentId: pending.intentId } });
        this.persistStatusProjection();
        return { kind: 'disabled', intentId: pending.intentId };
      }

      case 'pause_next_node': {
        this.intents.consume(pending.intentId);
        this.store.updateRunState(this.runId, 'PAUSED', { pauseReason: 'user_pause_next_node' });
        this.events.record({ runId: this.runId, type: 'run_paused', payload: { intentId: pending.intentId } });
        this.persistStatusProjection();
        return { kind: 'paused', intentId: pending.intentId, reason: 'user_pause_next_node' };
      }

      case 'resume': {
        this.intents.consume(pending.intentId);
        if (this.stateMachine && this.stateMachine.getState() === 'PAUSED') {
          this.stateMachine.resume();
        }
        this.store.updateRunState(this.runId, 'RUNNING', { pauseReason: null });
        this.events.record({ runId: this.runId, type: 'run_resumed', payload: { intentId: pending.intentId } });
        this.persistStatusProjection();
        return null;
      }
    }
  }

  // ─── 会话 ───

  private async ensureSession(run: RunRecord): Promise<ResolvedSession | RunTickOutcome> {
    const currentSessionId = run.currentSessionId;
    if (currentSessionId) {
      const inspect = await this.adapter.inspectSession(currentSessionId);
      if (inspect?.active) {
        return { sessionId: currentSessionId };
      }
      // 旧进程的会话已不可用：P2-04 到此为止，交由 P3-01 处理恢复细节。
      this.store.updateRunState(this.runId, 'RECOVERY_REQUIRED', {
        blockedReason: `current_session_lost:${currentSessionId}`
      });
      this.events.record({
        runId: this.runId,
        type: 'recovery_required',
        payload: { reason: `current_session_lost:${currentSessionId}` }
      });
      this.persistStatusProjection();
      return { kind: 'recovery_required', reason: `current_session_lost:${currentSessionId}` };
    }

    const sequence = this.store.nextChainSequence(this.runId);
    const sessionId = `${this.runId}-s${sequence}`;
    const contract = deriveContractFromLedger(this.ledger);

    await this.adapter.createFresh({
      sessionId,
      runId: this.runId,
      cwd: run.workspacePath,
      model: run.model ?? { provider: 'unknown', model: 'unknown' },
      readOnly: false,
      initialPrompt: buildRunBriefing({ goal: run.goal, contract, runId: this.runId })
    });

    this.store.transaction(() => {
      this.chain.append({
        runId: this.runId,
        nextSessionId: sessionId,
        adapter: this.adapterName,
        provider: run.model.provider,
        model: run.model.model,
        effort: run.model.effort,
        epoch: run.currentEpoch,
        reason: 'run_started'
      });
      this.leaseManager.acquireInitialLease(run.workspaceKey, sessionId, run.currentEpoch);
      this.store.updateRunState(this.runId, 'RUNNING', {
        currentSessionId: sessionId,
        currentSessionUnitCount: 0
      });
    });

    // 首会话没有前驱，不经过两阶段握手，但执行权仍必须显式授予——
    // 这样"任何写入者都经过一次授权"在首个会话上也成立，并且适配器侧可观测（§6.2）。
    // 令牌格式与 state machine 的 issueExecutionToken 一致，epoch 即该会话刚获得的租约 epoch。
    const initialToken = `EXEC_TOKEN_${randomUUID()}`;
    const authorized = await this.adapter.authorizeExecution(sessionId, run.currentEpoch, initialToken);
    if (!authorized) {
      this.store.updateRunState(this.runId, 'RECOVERY_REQUIRED', {
        blockedReason: 'first_session_authorize_failed'
      });
      this.events.record({
        runId: this.runId,
        type: 'recovery_required',
        sessionId,
        payload: { reason: 'first_session_authorize_failed' }
      });
      this.persistStatusProjection();
      return { kind: 'recovery_required', reason: 'first_session_authorize_failed' };
    }

    this.events.record({
      runId: this.runId,
      type: 'session_created',
      sessionId,
      payload: { reason: 'run_started' }
    });
    this.persistStatusProjection();
    return { sessionId };
  }

  // ─── 单元执行 ───

  private async executeUnit(task: TaskItem, run: RunRecord): Promise<RunTickOutcome> {
    const sessionId = run.currentSessionId;
    if (!sessionId) {
      throw new Error('RunController: executeUnit requires a current session');
    }

    const contract = deriveContractFromLedger(this.ledger);
    const prompt = buildUnitPrompt({ task, contract, runId: this.runId });

    this.graph.updateTaskStatus(task.taskId, 'in_progress');
    this.events.record({
      runId: this.runId,
      type: 'unit_started',
      sessionId,
      payload: { taskId: task.taskId }
    });

    await this.triggerFaultHook('during_first_write', { sessionId, metadata: { taskId: task.taskId } });
    await this.adapter.submit(sessionId, `unit-${task.taskId}-${randomUUID()}`, prompt, run.currentEpoch);

    const quiescence = await this.adapter.awaitQuiescence(sessionId, this.quiescenceTimeoutMs);
    if (quiescence !== 'quiescent') {
      this.store.transaction(() => {
        this.store.updateRunState(this.runId, 'BLOCKED', {
          blockedReason: `quiescence_${quiescence}`
        });
        this.events.record({
          runId: this.runId,
          type: 'run_blocked',
          sessionId,
          payload: { reason: `quiescence_${quiescence}`, taskId: task.taskId }
        });
        this.persistTaskSnapshot();
      });
      this.persistStatusProjection();
      return { kind: 'blocked', reason: `quiescence_${quiescence}` };
    }

    const raw = await this.settleUnitResult(sessionId, task.taskId);
    const result = raw && raw.taskId === task.taskId ? normalizeUnitResult(raw) : null;
    const nextUnitCount = run.currentSessionUnitCount + 1;

    if (result && result.status === 'completed') {
      const evidenceHash = result.evidenceHash!;
      this.store.transaction(() => {
        this.graph.completeTaskWithEvidence(task.taskId, evidenceHash);
        this.store.updateRunState(this.runId, 'RUNNING', { currentSessionUnitCount: nextUnitCount });
        this.events.record({
          runId: this.runId,
          type: 'unit_completed',
          sessionId,
          payload: { taskId: task.taskId, evidenceHash }
        });
        this.persistTaskSnapshot();
      });
      this.persistStatusProjection();
      return { kind: 'unit_executed', taskId: task.taskId, status: 'completed' };
    }

    const status: UnitResultStatus = result?.status ?? 'failed';
    const failureSignature = result
      ? `unit_${result.status}:${task.taskId}:${result.summary ?? ''}`
      : `unit_result_missing:${task.taskId}`;
    this.loopDetector.recordFailure(failureSignature);
    const blocked = this.loopDetector.isLoopBlocked();

    this.store.transaction(() => {
      this.events.record({
        runId: this.runId,
        type: 'unit_failed',
        sessionId,
        payload: {
          taskId: task.taskId,
          status,
          summary: result?.summary ?? 'no UNIT_RESULT block found in session output',
          signature: failureSignature
        }
      });
      this.store.updateRunState(this.runId, blocked ? 'BLOCKED' : 'RUNNING', {
        currentSessionUnitCount: nextUnitCount,
        blockedReason: blocked ? `loop_detected_${task.taskId}` : null
      });
      if (blocked) {
        this.events.record({
          runId: this.runId,
          type: 'run_blocked',
          sessionId,
          payload: { reason: `loop_detected_${task.taskId}`, taskId: task.taskId }
        });
      }
      this.persistTaskSnapshot();
    });
    this.persistStatusProjection();

    // 一个 tick 只做一件事：这一 tick 执行了单元（结果可以是失败）。
    // 无进展触发的 BLOCKED 是运行级终态，由下一个 tick 在终态分支里报告。
    // 这样事件日志里的 unit_failed 次数与 outcome 流里的执行次数才一致。
    return { kind: 'unit_executed', taskId: task.taskId, status };
  }

  /**
   * 有界地等待本单元的结果块出现。
   * 静止判定只说明会话此刻没有在跑：适配器可能在上一轮遗留的 idle 上立即返回，
   * 而本次提示的输出仍在管道里。直接判定"没有结果"会把一次正常完成误记成失败，
   * 并把它计入无进展计数，因此在截止时间内反复重读会话输出。
   */
  private async settleUnitResult(sessionId: string, taskId: string): Promise<UnitResult | null> {
    const deadline = this.clock() + this.settleTimeoutMs;
    for (;;) {
      const parsed = parseUnitResult(this.adapter.getSessionOutput(sessionId));
      if (parsed && parsed.taskId === taskId) {
        return parsed;
      }
      if (this.clock() >= deadline) {
        return parsed;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  // ─── 交接八步 ───

  private async performHandoff(task: TaskItem, run: RunRecord): Promise<RunTickOutcome> {
    const fromSessionId = run.currentSessionId;
    if (!fromSessionId) {
      throw new Error('RunController: performHandoff requires a current session');
    }

    const handoffId = `h-${this.runId}-${run.handoffCount + 1}`;

    // 步骤 1：记录交接意图（handoffId 为主键，天然去重，V13）
    const inserted = this.store.transaction(() =>
      this.store.insertHandoff({
        handoffId,
        runId: this.runId,
        epoch: run.currentEpoch,
        sourceSessionId: fromSessionId,
        state: 'REQUESTED'
      })
    );
    if (!inserted) {
      const existing = this.store.getHandoff(handoffId);
      // 只有被放弃的同一次交接可以重试；已请求/已授权/已完成的交接重复出现才是真正的重复回调（V13）。
      if (!existing || existing.state !== 'ABANDONED') {
        this.store.updateRunState(this.runId, 'BLOCKED', { blockedReason: 'duplicate_handoff_id' });
        this.events.record({
          runId: this.runId,
          type: 'run_blocked',
          payload: { reason: 'duplicate_handoff_id', handoffId }
        });
        this.persistStatusProjection();
        return { kind: 'blocked', reason: 'duplicate_handoff_id' };
      }
      this.events.record({
        runId: this.runId,
        type: 'handoff_retried',
        sessionId: fromSessionId,
        payload: { handoffId, taskId: task.taskId, epoch: run.currentEpoch }
      });
    } else {
      this.events.record({
        runId: this.runId,
        type: 'handoff_requested',
        sessionId: fromSessionId,
        payload: { handoffId, taskId: task.taskId, epoch: run.currentEpoch }
      });
    }

    // 步骤 2：旧 worker 收尾并确认静止
    this.stateMachine = new HandoffStateMachine(this.runId, fromSessionId, run.currentEpoch);
    this.stateMachine.requestHandoff('unit_completed');
    this.store.updateRunState(this.runId, 'DRAINING');

    await this.adapter.requestDrain(fromSessionId, handoffId);
    const oldQuiescence = await this.adapter.awaitQuiescence(fromSessionId, this.quiescenceTimeoutMs);
    if (oldQuiescence !== 'quiescent') {
      this.stateMachine.markRecoveryRequired();
      this.abandonHandoff(handoffId);
      this.store.updateRunState(this.runId, 'RECOVERY_REQUIRED', {
        blockedReason: `old_session_quiescence_${oldQuiescence}`
      });
      this.events.record({
        runId: this.runId,
        type: 'recovery_required',
        payload: { reason: `old_session_quiescence_${oldQuiescence}` }
      });
      this.persistStatusProjection();
      return { kind: 'recovery_required', reason: `old_session_quiescence_${oldQuiescence}` };
    }

    this.stateMachine.checkpointCompleted(handoffId);
    this.store.updateRunState(this.runId, 'CHECKPOINTED');

    // 步骤 3：先完整写快照文件，再在事务内发布引用（V16）
    await this.triggerFaultHook('during_snapshot_write', { handoffId, sessionId: fromSessionId, epoch: run.currentEpoch });
    const manifest = this.packager.createManifest({
      handoffId,
      runId: this.runId,
      epoch: run.currentEpoch,
      sourceSessionId: fromSessionId,
      targetModel: run.model,
      ledger: this.ledger,
      taskGraph: this.graph,
      sentinel: this.sentinel ?? undefined
    });
    const published = this.publishManifestFile(handoffId, manifest);
    await this.triggerFaultHook('after_snapshot_file_written', { handoffId, sessionId: fromSessionId, epoch: run.currentEpoch });
    this.store.transaction(() => {
      this.store.updateHandoff(handoffId, {
        state: 'SNAPSHOTTED',
        manifestPath: published.filePath,
        manifestHash: published.hash
      });
    });
    this.events.record({
      runId: this.runId,
      type: 'handoff_snapshot_published',
      payload: { handoffId, manifestPath: published.filePath, manifestHash: published.hash }
    });
    await this.triggerFaultHook('after_db_publish', { handoffId, sessionId: fromSessionId, epoch: run.currentEpoch });

    // 步骤 4：创建意图已持久化在 handoffs 行上，去重后创建只读接手会话
    const sequence = this.store.nextChainSequence(this.runId);
    const toSessionId = `${this.runId}-s${sequence}`;

    this.stateMachine.beginStarting();
    this.store.updateRunState(this.runId, 'STARTING');
    let outboxMsgId = '';
    this.store.transaction(() => {
      this.store.updateHandoff(handoffId, { state: 'CREATING', targetSessionId: toSessionId });
      const outbox = this.store.enqueueOutbox({
        runId: this.runId,
        handoffId,
        topic: 'create_session',
        targetSessionId: toSessionId,
        payload: { readOnly: true }
      });
      outboxMsgId = outbox.msgId;
    });
    this.events.record({
      runId: this.runId,
      type: 'session_create_requested',
      sessionId: toSessionId,
      payload: { handoffId, readOnly: true }
    });

    const coordinator = this.createCoordinator({
      adapter: this.adapter,
      leaseManager: this.leaseManager,
      stateMachine: this.stateMachine,
      workspaceKey: run.workspaceKey,
      runId: this.runId
    });
    coordinator.startNewSession(toSessionId);
    this.store.updateRunState(this.runId, 'PREPARING');

    await this.triggerFaultHook('before_session_create_call', { handoffId, sessionId: toSessionId });

    // 步骤 5：只读门控启动，记录返回的会话 ID
    await this.adapter.createFresh({
      sessionId: toSessionId,
      runId: this.runId,
      cwd: run.workspacePath,
      model: run.model,
      readOnly: true,
      initialPrompt: coordinator.buildPreparationPrompt(manifest)
    });

    if (outboxMsgId) {
      this.store.updateOutboxState(outboxMsgId, 'DISPATCHED');
    }
    await this.triggerFaultHook('session_create_response_lost', { handoffId, sessionId: toSessionId });

    await this.triggerFaultHook('during_readonly_prep', { handoffId, sessionId: toSessionId });
    const newQuiescence = await this.adapter.awaitQuiescence(toSessionId, this.quiescenceTimeoutMs);
    if (newQuiescence !== 'quiescent') {
      this.stateMachine.markRecoveryRequired();
      this.abandonHandoff(handoffId);
      this.store.updateRunState(this.runId, 'RECOVERY_REQUIRED', {
        blockedReason: `new_session_quiescence_${newQuiescence}`
      });
      this.events.record({
        runId: this.runId,
        type: 'recovery_required',
        payload: { reason: `new_session_quiescence_${newQuiescence}` }
      });
      this.persistStatusProjection();
      return { kind: 'recovery_required', reason: `new_session_quiescence_${newQuiescence}` };
    }

    // 步骤 6：解析并核对 ACK
    const ack = coordinator.parseAckFromOutput(this.adapter.getSessionOutput(toSessionId));
    if (!ack) {
      this.stateMachine.markRecoveryRequired();
      this.abandonHandoff(handoffId);
      this.store.updateRunState(this.runId, 'RECOVERY_REQUIRED', { blockedReason: 'ack_not_received' });
      this.events.record({
        runId: this.runId,
        type: 'recovery_required',
        payload: { reason: 'ack_not_received', handoffId }
      });
      this.persistStatusProjection();
      return { kind: 'recovery_required', reason: 'ack_not_received' };
    }

    await this.triggerFaultHook('after_ack_received', { handoffId, sessionId: toSessionId });

    // 步骤 7：同一事务内先核对未消费意图，再做 CAS 与状态更新（§5.3 / §6.3）
    const transactionResult = this.store.transaction(() => {
      const stillPending = this.intents.resolve(this.runId);
      if (stillPending) {
        return { blockedBy: stillPending } as const;
      }

      const authResult = coordinator.verifyAckAndAuthorize(manifest, ack);
      if (authResult.success) {
        this.store.updateRunState(this.runId, 'RUNNING', {
          currentSessionId: toSessionId,
          currentEpoch: authResult.epoch!,
          handoffCount: run.handoffCount + 1,
          currentSessionUnitCount: 0,
          pauseReason: null,
          blockedReason: null
        });
        this.store.setAuthorization(this.runId, {
          inputHeadHash: this.ledger.getHeadHash(),
          contractVersion: deriveContractFromLedger(this.ledger).version,
          intentWatermark: this.intents.getWatermark(this.runId)
        });
        this.store.updateHandoff(handoffId, { state: 'AUTHORIZED', targetSessionId: toSessionId });
      }
      return { authResult } as const;
    });

    if ('blockedBy' in transactionResult) {
      const blocker = transactionResult.blockedBy;
      // 暂停已经生效，触发阻塞的 pause_next_node 已被满足，必须消费掉——
      // 否则它会在 PAUSED 守卫里长期压过 resume，把 run 永久卡住。
      if (blocker.kind === 'pause_next_node') {
        this.intents.consume(blocker.intentId);
      }
      // 这次交接没有完成：标记为放弃，使同一 handoff id 的重试不再被误判为重复回调（V13）。
      this.abandonHandoff(handoffId);
      await this.adapter.interruptOwned(toSessionId);
      this.store.updateRunState(this.runId, 'PAUSED', {
        pauseReason: `control_intent_${blocker.kind}`
      });
      this.events.record({
        runId: this.runId,
        type: 'handoff_blocked_by_control_intent',
        sessionId: toSessionId,
        payload: { handoffId, intentId: blocker.intentId }
      });
      this.persistStatusProjection();
      return {
        kind: 'paused',
        intentId: blocker.intentId,
        reason: 'control_intent_arrived_during_handoff'
      };
    }

    const authResult = transactionResult.authResult;
    if (!authResult.success) {
      this.stateMachine.markRecoveryRequired();
      this.abandonHandoff(handoffId);
      this.store.updateRunState(this.runId, 'RECOVERY_REQUIRED', {
        blockedReason: authResult.error ?? 'handshake_failed'
      });
      this.events.record({
        runId: this.runId,
        type: 'recovery_required',
        payload: { reason: authResult.error ?? 'handshake_failed', handoffId }
      });
      this.persistStatusProjection();
      return { kind: 'recovery_required', reason: authResult.error ?? 'handshake_failed' };
    }

    await this.triggerFaultHook('after_owner_cas', { handoffId, sessionId: toSessionId, epoch: authResult.epoch });

    // 防御性复核：交接包含 await，意图可能在事务提交后、授权前到达
    const lateIntent = this.intents.resolve(this.runId);
    if (lateIntent) {
      if (lateIntent.kind === 'pause_next_node') {
        this.intents.consume(lateIntent.intentId);
      }
      await this.adapter.interruptOwned(toSessionId);
      this.store.updateRunState(this.runId, 'PAUSED', {
        pauseReason: `control_intent_${lateIntent.kind}`
      });
      this.events.record({
        runId: this.runId,
        type: 'handoff_blocked_by_control_intent',
        sessionId: toSessionId,
        payload: { handoffId, intentId: lateIntent.intentId, stage: 'pre_authorize' }
      });
      this.persistStatusProjection();
      return {
        kind: 'paused',
        intentId: lateIntent.intentId,
        reason: 'control_intent_arrived_before_authorize'
      };
    }

    // 步骤 8：送达执行令牌，旧会话封存并回收
    const authorized = await this.adapter.authorizeExecution(toSessionId, authResult.epoch!, authResult.executionToken!);
    if (!authorized) {
      this.stateMachine.markRecoveryRequired();
      this.store.updateRunState(this.runId, 'RECOVERY_REQUIRED', {
        blockedReason: 'authorize_execution_failed'
      });
      this.events.record({
        runId: this.runId,
        type: 'recovery_required',
        payload: { reason: 'authorize_execution_failed', handoffId }
      });
      this.persistStatusProjection();
      return { kind: 'recovery_required', reason: 'authorize_execution_failed' };
    }

    await this.triggerFaultHook('after_token_dispatch', { handoffId, sessionId: toSessionId, epoch: authResult.epoch });

    this.store.transaction(() => {
      this.chain.append({
        runId: this.runId,
        prevSessionId: fromSessionId,
        nextSessionId: toSessionId,
        adapter: this.adapterName,
        provider: run.model.provider,
        model: run.model.model,
        effort: run.model.effort,
        epoch: authResult.epoch!,
        handoffId,
        reason: 'unit_completed'
      });
      this.chain.supersede(fromSessionId);
      this.store.updateHandoff(handoffId, { state: 'COMPLETED', targetSessionId: toSessionId });
      if (outboxMsgId) {
        this.store.updateOutboxState(outboxMsgId, 'ACKED');
      }
      this.events.record({
        runId: this.runId,
        type: 'handoff_completed',
        sessionId: toSessionId,
        payload: {
          handoffId,
          fromSessionId,
          toSessionId,
          epoch: authResult.epoch
        }
      });
      this.persistTaskSnapshot();
    });

    await this.adapter.interruptOwned(fromSessionId);
    this.persistStatusProjection();

    return {
      kind: 'handoff_performed',
      handoffId,
      fromSessionId,
      toSessionId,
      epoch: authResult.epoch!
    };
  }

  // ─── 内部工具 ───

  private requireRun(): RunRecord {
    const run = this.store.getRun(this.runId);
    if (!run) {
      throw new Error(`RunController: run ${this.runId} not found`);
    }
    return run;
  }

  /**
   * 终态 run 释放工作区租约，使同一工作区可被重新启用。
   * 租约是锁而不是历史：会话链与事件日志才是历史，它们不被删除。
   */
  private releaseWorkspaceLease(run: RunRecord): void {
    const sessionId = run.currentSessionId;
    this.store.transaction(() => {
      if (sessionId) {
        this.leaseManager.releaseLease(run.workspaceKey, sessionId);
      } else {
        const lease = this.leaseManager.getLease(run.workspaceKey);
        if (lease) {
          this.leaseManager.releaseLease(run.workspaceKey, lease.currentOwner);
        }
      }
    });
  }

  private triggerPolicySaysHandoff(): boolean {
    const run = this.requireRun();
    const decision = this.triggerPolicy.evaluate({
      unitCompleted: run.currentSessionUnitCount > 0,
      hasMoreUnits: this.graph.getNextActionableTask() !== undefined,
      // 压缩事件尚未接入（P2-04 范围外）：显式传 0 并在状态卡显示「未知」（V09）
      compactionCount: 0,
      activeDurationMs: this.clock() - run.updatedAt,
      maxActiveDurationMs: this.maxActiveDurationMs
    });
    return decision.shouldHandoff;
  }

  /** 交接未完成即放弃：同一 handoff id 的重试才不会在步骤 1 被误判为重复回调（V13）。 */
  private abandonHandoff(handoffId: string): void {
    this.store.transaction(() => {
      this.store.updateHandoff(handoffId, { state: 'ABANDONED' });
    });
  }

  private publishManifestFile(
    handoffId: string,
    manifest: HandoffPackManifest
  ): { filePath: string; hash: string } {
    const dir = path.join(this.dataDir, this.runId, 'handoffs', handoffId);
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, 'manifest.json');
    const staging = `${target}.tmp`;
    // 同一份字节既写盘又算哈希：记录的哈希必须描述磁盘上的文件，而不是内存里的字符串（§6.3 步骤 3）。
    const json = JSON.stringify(manifest, null, 2);
    const hash = computeSha256(json);
    fs.writeFileSync(staging, json, 'utf8');

    // 先 fsync 再 rename：改名只保证原子性，落盘顺序要显式要求，否则断电后可能得到空快照。
    // 用 'r+' 打开是因为 Windows 上对只读句柄调用 fsync 会 EPERM。
    const fd = fs.openSync(staging, 'r+');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(staging, target);

    // 发布后回读校验：数据库绝不指向一个无法验证的快照。
    const published = fs.readFileSync(target, 'utf8');
    if (computeSha256(published) !== hash) {
      throw new Error(`RunController: published manifest for handoff ${handoffId} failed hash verification`);
    }

    return { filePath: target, hash };
  }

  private persistTaskSnapshot(): void {
    this.store.appendTaskSnapshot(
      this.runId,
      this.store.nextTaskSnapshotSeq(this.runId),
      JSON.stringify(this.graph.getAllTasks()),
      this.graph.computeSnapshotHash()
    );
  }

  private persistStatusProjection(): void {
    if (!this.runId) return;
    try {
      writeStateProjection(this.dataDir, buildRunStatus(this.store, this.runId));
    } catch {
      // 投影失败不影响权威状态
    }
  }

  private loadRun(runId: string): void {
    const run = this.store.getRun(runId);
    if (!run) {
      throw new Error(`RunController: run ${runId} not found`);
    }

    this.runId = runId;
    this.sentinel = new WorkspaceSentinel(run.workspacePath);
    this.reconciler = new RunReconciler({
      store: this.store,
      dataDir: this.dataDir,
      sentinel: this.sentinel,
      intents: this.intents,
      events: this.events
    });
    this.stateMachine = null;
    this.triggerPolicy = new TriggerPolicy({ maxActiveDurationMs: this.maxActiveDurationMs });

    this.ledger = new InputLedger();
    this.ledger.restoreFrom(this.store.listInputs(runId).map((row) => row.record));

    this.graph = new TaskGraph();
    const snapshot = this.store.getLatestTaskSnapshot(runId);
    if (snapshot) {
      this.graph.restoreFrom(JSON.parse(snapshot.snapshotJson) as TaskItem[]);
    }

    // 无进展计数必须跨会话与重启继承（V23）：从事件日志重放失败签名
    this.loopDetector = new LoopDetector();
    for (const event of this.events.list(runId)) {
      if (event.type === 'unit_failed' && typeof event.payload.signature === 'string') {
        this.loopDetector.recordFailure(event.payload.signature);
      }
    }
  }
}
