// tests/helpers/scripted-adapter.ts
import type {
  AgentRelayAdapter,
  SessionCapabilities,
  SessionInspectResult,
  SpawnSessionConfig
} from '../../packages/protocol/src/adapter.ts';
import type { HandoffAckPacket, HandoffPackManifest } from '../../packages/protocol/src/types.ts';
import {
  UNIT_RESULT_START,
  UNIT_RESULT_END,
  type UnitResultStatus
} from '../../packages/controller/src/run/prompt.ts';

export interface ScriptedUnitReply {
  status: UnitResultStatus;
  evidenceHash?: string;
  summary?: string;
}

export interface ScriptedAdapterOptions {
  /** 覆盖某个会话上报的有效模型（测 V10 模型不一致） */
  modelOverrides?: Record<string, { provider: string; model: string; effort?: string }>;
  /** 覆盖某个 taskId 的单元执行结果；缺省为 completed + 自动证据哈希 */
  unitReplies?: Record<string, ScriptedUnitReply>;
  /** 在 createFresh 之后调用，用于在交接窗口中途注入控制意图（V33） */
  onCreateFresh?: (sessionId: string, config: SpawnSessionConfig) => void;
  /** 在 authorizeExecution 之后调用，用于在令牌送达后注入控制意图（V33 令牌消费之后） */
  onAuthorize?: (sessionId: string) => void;
  /** 覆盖某个会话的静止态判定结果，用于驱动恢复路径 */
  quiescenceOverrides?: Record<string, 'quiescent' | 'timeout' | 'error'>;
}

interface ScriptedSession {
  sessionId: string;
  model: { provider: string; model: string; effort?: string };
  active: boolean;
  readOnly: boolean;
  cwd: string;
  output: string[];
  executionAuthorized: boolean;
  epoch?: number;
  executionToken?: string;
  draining: boolean;
}

interface ManifestFields {
  handoffId: string;
  inputHeadHash: string;
  taskHash: string;
  treeHash: string;
  runId: string;
}

function markerValue(prompt: string, key: string): string | null {
  const match = new RegExp(`^${key}:\\s*(\\S+)\\s*$`, 'm').exec(prompt);
  return match ? match[1] : null;
}

/** 同时支持 DSH 的 `KEY: value` 方言与 Codex/Claude 的 manifest JSON 方言。 */
function extractManifestFields(prompt: string): ManifestFields | null {
  const handoffId = markerValue(prompt, 'HANDOFF_ID');
  const inputHeadHash = markerValue(prompt, 'INPUT_HEAD_HASH');
  const taskHash = markerValue(prompt, 'TASK_SNAPSHOT_HASH');
  const treeHash = markerValue(prompt, 'WORKSPACE_TREE_HASH');
  const runId = markerValue(prompt, 'RUN_ID');
  if (handoffId && inputHeadHash && taskHash && treeHash && runId) {
    return { handoffId, inputHeadHash, taskHash, treeHash, runId };
  }

  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(prompt);
  if (fenced) {
    try {
      const manifest = JSON.parse(fenced[1].trim()) as HandoffPackManifest;
      if (manifest.handoffId && manifest.inputLedgerHeadHash && manifest.workspaceFingerprint) {
        return {
          handoffId: manifest.handoffId,
          inputHeadHash: manifest.inputLedgerHeadHash,
          taskHash: manifest.taskSnapshotHash,
          treeHash: manifest.workspaceFingerprint.treeHash,
          runId: manifest.runId
        };
      }
    } catch {
      // 方言不匹配，交给调用方判定为无法应答
    }
  }
  return null;
}

function isPreparationPrompt(prompt: string): boolean {
  return /READ-?ONLY/i.test(prompt) && /HANDOFF/i.test(prompt);
}

export class ScriptedAdapter implements AgentRelayAdapter {
  public readonly sessions = new Map<string, ScriptedSession>();
  public readonly submitted: Array<{ sessionId: string; content: string; epoch?: number }> = [];
  public readonly authorizations: Array<{ sessionId: string; epoch: number; token: string }> = [];
  public readonly interrupted: string[] = [];
  public readonly created: string[] = [];
  private readonly options: ScriptedAdapterOptions;

  constructor(options: ScriptedAdapterOptions = {}) {
    this.options = options;
  }

  public capabilities(): SessionCapabilities {
    return {
      level: 'L3',
      streamJsonSupported: true,
      modelEffortPreservation: true,
      nativeRevealSupported: false,
      headlessSupported: true,
      cancellationSupported: true
    };
  }

  public createFresh(config: SpawnSessionConfig): SessionInspectResult {
    const sessionId = config.sessionId!;
    const override = this.options.modelOverrides?.[sessionId];
    const model = override ?? config.model ?? { provider: 'scripted', model: 'scripted-model' };

    const session: ScriptedSession = {
      sessionId,
      model,
      active: true,
      readOnly: config.readOnly === true,
      cwd: config.cwd ?? process.cwd(),
      output: [],
      executionAuthorized: config.readOnly !== true,
      draining: false
    };
    this.sessions.set(sessionId, session);
    this.created.push(sessionId);

    if (config.initialPrompt) {
      this.respond(session, config.initialPrompt);
    }

    this.options.onCreateFresh?.(sessionId, config);

    return {
      sessionId,
      active: true,
      effectiveModel: model,
      cwd: session.cwd,
      exitCode: null
    };
  }

  public inspectSession(sessionId: string): SessionInspectResult | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    return {
      sessionId: session.sessionId,
      active: session.active,
      effectiveModel: session.model,
      cwd: session.cwd,
      exitCode: session.active ? null : 0
    };
  }

  public submit(sessionId: string, _messageId: string, content: string, epoch?: number): void {
    const session = this.sessions.get(sessionId);
    if (!session || !session.active) {
      throw new Error(`Cannot submit to inactive or nonexistent session ${sessionId}`);
    }
    this.submitted.push({ sessionId, content, epoch });
    this.respond(session, content);
  }

  public requestDrain(sessionId: string, _handoffId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.draining = true;
    return true;
  }

  public awaitQuiescence(sessionId: string, _timeoutMs?: number): Promise<'quiescent' | 'timeout' | 'error'> {
    const session = this.sessions.get(sessionId);
    if (!session) return Promise.resolve('error');
    return Promise.resolve(this.options.quiescenceOverrides?.[sessionId] ?? 'quiescent');
  }

  public authorizeExecution(sessionId: string, epoch: number, executionToken: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.executionAuthorized = true;
    session.readOnly = false;
    session.epoch = epoch;
    session.executionToken = executionToken;
    this.authorizations.push({ sessionId, epoch, token: executionToken });
    this.options.onAuthorize?.(sessionId);
    return true;
  }

  public interruptOwned(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.active = false;
    this.interrupted.push(sessionId);
    return true;
  }

  public getSessionOutput(sessionId: string): string {
    const session = this.sessions.get(sessionId);
    return session ? session.output.join('\n') : '';
  }

  /** 会话是否曾获得执行权（用于断言「未授权不得写入」）。 */
  public wasAuthorized(sessionId: string): boolean {
    return this.authorizations.some((a) => a.sessionId === sessionId);
  }

  private respond(session: ScriptedSession, prompt: string): void {
    if (isPreparationPrompt(prompt)) {
      const fields = extractManifestFields(prompt);
      if (fields) {
        const ack: HandoffAckPacket = {
          handoffId: fields.handoffId,
          runId: fields.runId,
          newSessionId: session.sessionId,
          effectiveModel: { ...session.model },
          verifiedInputHeadHash: fields.inputHeadHash,
          verifiedTaskSnapshotHash: fields.taskHash,
          verifiedWorkspaceHash: fields.treeHash,
          ackTimestamp: Date.now()
        };
        session.output.push(`Verification complete.\nHANDOFF_ACK_START\n${JSON.stringify(ack)}\nHANDOFF_ACK_END`);
      } else {
        session.output.push('Preparation material could not be parsed; no ACK emitted.');
      }
      return;
    }

    const taskId = markerValue(prompt, 'TASK_ID');
    if (taskId) {
      const reply = this.options.unitReplies?.[taskId] ?? {
        status: 'completed' as UnitResultStatus,
        evidenceHash: `evidence-${taskId}`,
        summary: `unit ${taskId} finished`
      };
      const result = {
        taskId,
        status: reply.status,
        evidenceHash: reply.evidenceHash,
        summary: reply.summary
      };
      session.output.push(`${UNIT_RESULT_START}\n${JSON.stringify(result)}\n${UNIT_RESULT_END}`);
      return;
    }

    session.output.push('Acknowledged.');
  }
}
