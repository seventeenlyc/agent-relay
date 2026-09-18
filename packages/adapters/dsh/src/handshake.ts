import type { HandoffPackManifest, HandoffAckPacket } from '../../../protocol/src/types.ts';
import type { HandoffStateMachine } from '../../../controller/src/handoff/state-machine.ts';
import type { WorkspaceLeaseManager } from '../../../controller/src/handoff/lease.ts';
import type { DshAdapter } from './dsh-adapter.ts';
import type { HandshakeCoordinator } from '../../../protocol/src/coordinator.ts';

export interface DshHandshakeCoordinatorOptions {
  adapter?: DshAdapter;
  leaseManager: WorkspaceLeaseManager;
  stateMachine: HandoffStateMachine;
  workspaceKey: string;
}

export interface HandshakeResult {
  success: boolean;
  executionToken?: string;
  epoch?: number;
  error?: string;
}

export class DshHandshakeCoordinator implements HandshakeCoordinator {
  private readonly adapter?: DshAdapter;
  private readonly leaseManager: WorkspaceLeaseManager;
  private readonly stateMachine: HandoffStateMachine;
  private readonly workspaceKey: string;

  constructor(
    optionsOrStateMachine: DshHandshakeCoordinatorOptions | HandoffStateMachine,
    leaseManager?: WorkspaceLeaseManager,
    workspaceKey?: string,
    adapter?: DshAdapter
  ) {
    if ('stateMachine' in optionsOrStateMachine) {
      this.adapter = optionsOrStateMachine.adapter;
      this.leaseManager = optionsOrStateMachine.leaseManager;
      this.stateMachine = optionsOrStateMachine.stateMachine;
      this.workspaceKey = optionsOrStateMachine.workspaceKey;
    } else {
      this.stateMachine = optionsOrStateMachine;
      this.leaseManager = leaseManager!;
      this.workspaceKey = workspaceKey!;
      this.adapter = adapter;
    }
  }

  public buildPreparationPrompt(manifest: HandoffPackManifest): string {
    return [
      '<<<AGENT_RELAY_HANDOFF_PREPARATION>>>',
      'PREPARATION_MODE: READ_ONLY',
      `HANDOFF_ID: ${manifest.handoffId}`,
      `RUN_ID: ${manifest.runId}`,
      `SOURCE_SESSION_ID: ${manifest.sourceSessionId}`,
      `EPOCH: ${manifest.epoch}`,
      `INPUT_HEAD_HASH: ${manifest.inputLedgerHeadHash}`,
      `TASK_SNAPSHOT_HASH: ${manifest.taskSnapshotHash}`,
      `WORKSPACE_TREE_HASH: ${manifest.workspaceFingerprint.treeHash}`,
      'INSTRUCTION: Verify workspace hashes and reply strictly with HANDOFF_ACK_START and HANDOFF_ACK_END block.',
      '<<<END_AGENT_RELAY_HANDOFF_PREPARATION>>>'
    ].join('\n');
  }

  public generatePreparationPrompt(manifest: HandoffPackManifest): string {
    return this.buildPreparationPrompt(manifest);
  }

  public startNewSession(newSessionId: string): void {
    this.stateMachine.startNewSession(newSessionId);
  }

  public parseAckFromOutput(output: string): HandoffAckPacket | null {
    // 1. Check for explicit HANDOFF_ACK_START ... HANDOFF_ACK_END markers
    const markerRegex = /HANDOFF_ACK_START\s*([\s\S]*?)\s*HANDOFF_ACK_END/g;
    let match: RegExpExecArray | null;
    let lastValidAck: HandoffAckPacket | null = null;
    while ((match = markerRegex.exec(output)) !== null) {
      const candidate = match[1].trim();
      try {
        const parsed = JSON.parse(candidate) as HandoffAckPacket;
        if (parsed && typeof parsed === 'object' && parsed.handoffId) {
          lastValidAck = parsed;
        }
      } catch {
        // Not valid JSON, continue scanning
      }
    }
    if (lastValidAck) {
      return lastValidAck;
    }

    // 2. Fallback to extracting from markdown code blocks or discrete JSON
    return this.extractAckFromText(output) || null;
  }

  public extractAckFromText(text: string): HandoffAckPacket | undefined {
    // 1. Check markdown code blocks first
    const codeBlockRegex = /```(?:json)?\s*([\s\S]*?)```/g;
    let match: RegExpExecArray | null;
    while ((match = codeBlockRegex.exec(text)) !== null) {
      const block = match[1].trim();
      if (block.includes('"handoffId"') && (block.includes('"verifiedInputHeadHash"') || block.includes('"status"'))) {
        try {
          const parsed = JSON.parse(block) as HandoffAckPacket;
          if (parsed && typeof parsed === 'object' && parsed.handoffId) {
            return parsed;
          }
        } catch {
          // Not valid JSON, continue scanning
        }
      }
    }

    // 2. Scan for discrete balanced JSON objects
    let depth = 0;
    let inString = false;
    let escape = false;
    let startIndex = -1;

    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (inString) {
        if (escape) {
          escape = false;
        } else if (char === '\\') {
          escape = true;
        } else if (char === '"') {
          inString = false;
        }
      } else {
        if (char === '"') {
          inString = true;
        } else if (char === '{') {
          if (depth === 0) {
            startIndex = i;
          }
          depth++;
        } else if (char === '}') {
          if (depth > 0) {
            depth--;
            if (depth === 0 && startIndex !== -1) {
              const candidate = text.slice(startIndex, i + 1);
              startIndex = -1;
              if (candidate.includes('"handoffId"') && (candidate.includes('"verifiedInputHeadHash"') || candidate.includes('"status"'))) {
                try {
                  const parsed = JSON.parse(candidate) as HandoffAckPacket;
                  if (parsed && typeof parsed === 'object' && parsed.handoffId) {
                    return parsed;
                  }
                } catch {
                  // Not valid JSON, continue scanning
                }
              }
            }
          }
        }
      }
    }

    return undefined;
  }

  public verifyAckAndAuthorize(manifest: HandoffPackManifest, ack: HandoffAckPacket): HandshakeResult {
    // 1. Verify handoff ID match
    if (ack.handoffId !== manifest.handoffId) {
      return { success: false, error: `Handoff ID mismatch: expected ${manifest.handoffId}, got ${ack.handoffId}` };
    }

    // 2. Verify hash matching
    if (ack.verifiedInputHeadHash !== manifest.inputLedgerHeadHash) {
      return {
        success: false,
        error: `Input ledger head hash mismatch: expected ${manifest.inputLedgerHeadHash}, got ${ack.verifiedInputHeadHash}`
      };
    }
    if (ack.verifiedTaskSnapshotHash !== manifest.taskSnapshotHash) {
      return {
        success: false,
        error: `Task snapshot hash mismatch: expected ${manifest.taskSnapshotHash}, got ${ack.verifiedTaskSnapshotHash}`
      };
    }
    if (ack.verifiedWorkspaceHash !== manifest.workspaceFingerprint.treeHash) {
      return {
        success: false,
        error: `Workspace hash mismatch: expected ${manifest.workspaceFingerprint.treeHash}, got ${ack.verifiedWorkspaceHash}`
      };
    }

    // 3. Verify target provider and model match
    if (manifest.targetModel.provider && ack.effectiveModel?.provider && ack.effectiveModel.provider !== manifest.targetModel.provider) {
      return {
        success: false,
        error: `Provider mismatch: expected ${manifest.targetModel.provider}, got ${ack.effectiveModel.provider}`
      };
    }
    if (ack.effectiveModel?.model !== manifest.targetModel.model) {
      return {
        success: false,
        error: `Model mismatch: expected ${manifest.targetModel.model}, got ${ack.effectiveModel?.model}`
      };
    }

    // 4. Check state machine state BEFORE attempting CAS lease transfer
    if (this.stateMachine.getState() !== 'PREPARING') {
      return {
        success: false,
        error: `Cannot receive ACK in state ${this.stateMachine.getState()}`
      };
    }

    // 5. Check lease preconditions BEFORE modifying state machine
    const currentLease = this.leaseManager.getLease(this.workspaceKey);
    if (!currentLease) {
      return { success: false, error: `No active lease for workspace ${this.workspaceKey}` };
    }
    if (currentLease.currentOwner !== manifest.sourceSessionId) {
      return {
        success: false,
        error: `Lease owner mismatch: expected ${manifest.sourceSessionId}, got ${currentLease.currentOwner}`
      };
    }
    if (currentLease.epoch !== manifest.epoch) {
      return {
        success: false,
        error: `Lease epoch mismatch: expected ${manifest.epoch}, got ${currentLease.epoch}`
      };
    }

    // 6. Perform CAS lease transfer
    const newEpoch = manifest.epoch + 1;
    const casSuccess = this.leaseManager.compareAndSetOwner(
      this.workspaceKey,
      manifest.sourceSessionId,
      ack.newSessionId,
      manifest.epoch,
      newEpoch
    );
    if (!casSuccess) {
      return { success: false, error: 'CAS lease acquisition failed' };
    }

    // 7. Advance state machine and issue execution token
    try {
      this.stateMachine.receiveAck(ack);
      const token = this.stateMachine.issueExecutionToken();
      return {
        success: true,
        executionToken: token.token,
        epoch: token.epoch
      };
    } catch (err: unknown) {
      // Revert CAS lease on state machine failure with monotonically increasing epoch
      this.leaseManager.compareAndSetOwner(
        this.workspaceKey,
        ack.newSessionId,
        manifest.sourceSessionId,
        newEpoch,
        newEpoch + 1
      );
      return { success: false, error: (err as Error).message };
    }
  }
}
