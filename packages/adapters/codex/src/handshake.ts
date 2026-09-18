import type { HandoffPackManifest, HandoffAckPacket } from '../../../protocol/src/types.ts';
import type { HandoffStateMachine } from '../../../controller/src/handoff/state-machine.ts';
import type { WorkspaceLeaseManager } from '../../../controller/src/handoff/lease.ts';
import type { HandshakeCoordinator } from '../../../protocol/src/coordinator.ts';

export interface HandshakeResult {
  success: boolean;
  executionToken?: string;
  epoch?: number;
  error?: string;
}

export class CodexHandshakeCoordinator implements HandshakeCoordinator {
  private readonly stateMachine: HandoffStateMachine;
  private readonly leaseManager: WorkspaceLeaseManager;
  private readonly workspaceKey: string;

  constructor(stateMachine: HandoffStateMachine, leaseManager: WorkspaceLeaseManager, workspaceKey: string) {
    this.stateMachine = stateMachine;
    this.leaseManager = leaseManager;
    this.workspaceKey = workspaceKey;
  }

  public generatePreparationPrompt(manifest: HandoffPackManifest): string {
    return [
      '### AGENT RELAY: READ-ONLY PREPARATION MODE ###',
      'You have been spawned as a fresh relay worker. You are in READ-ONLY mode.',
      'DO NOT execute any write tools (Edit, Write, Bash with mutations) until execution is authorized.',
      'Inspect the following Handoff Pack Manifest and verify hashes against the current workspace:',
      '```json',
      JSON.stringify(manifest, null, 2),
      '```',
      'Output your structured HandoffAckPacket verifying verifiedInputHeadHash, verifiedTaskSnapshotHash, and verifiedWorkspaceHash.',
      'Once verified and approved, you will receive your EXECUTION_TOKEN to begin writing.'
    ].join('\n');
  }

  /** 契约别名：引擎只依赖规范方法名，方言差异由各适配器自行决定。 */
  public buildPreparationPrompt(manifest: HandoffPackManifest): string {
    return this.generatePreparationPrompt(manifest);
  }

  public startNewSession(newSessionId: string): void {
    this.stateMachine.startNewSession(newSessionId);
  }

  public verifyAckAndAuthorize(manifest: HandoffPackManifest, ack: HandoffAckPacket): HandshakeResult {
    // 1. Verify handoff ID match
    if (ack.handoffId !== manifest.handoffId) {
      return { success: false, error: 'Handoff ID mismatch' };
    }

    // 2. Verify hash matching
    if (ack.verifiedInputHeadHash !== manifest.inputLedgerHeadHash) {
      return { success: false, error: 'Input ledger head hash mismatch' };
    }
    if (ack.verifiedTaskSnapshotHash !== manifest.taskSnapshotHash) {
      return { success: false, error: 'Task snapshot hash mismatch' };
    }
    if (ack.verifiedWorkspaceHash !== manifest.workspaceFingerprint.treeHash) {
      return { success: false, error: 'Workspace hash mismatch' };
    }

    // 3. Verify target model match
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

    // 7. Only AFTER successful CAS transfer, advance the state machine
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

  public extractAckFromText(text: string): HandoffAckPacket | undefined {
    // 1. Check markdown code blocks first
    const codeBlockRegex = /```(?:json)?\s*([\s\S]*?)```/g;
    let match: RegExpExecArray | null;
    while ((match = codeBlockRegex.exec(text)) !== null) {
      const block = match[1].trim();
      if (block.includes('"handoffId"') && block.includes('"verifiedInputHeadHash"')) {
        try {
          const parsed = JSON.parse(block) as HandoffAckPacket;
          if (parsed && typeof parsed === 'object' && parsed.handoffId && parsed.verifiedInputHeadHash) {
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
              if (candidate.includes('"handoffId"') && candidate.includes('"verifiedInputHeadHash"')) {
                try {
                  const parsed = JSON.parse(candidate) as HandoffAckPacket;
                  if (parsed && typeof parsed === 'object' && parsed.handoffId && parsed.verifiedInputHeadHash) {
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

  public parseAckFromOutput(text: string): HandoffAckPacket | null {
    return this.extractAckFromText(text) ?? null;
  }
}
