import type { HandoffPackManifest, HandoffAckPacket } from '../../../protocol/src/types.ts';
import type { HandoffStateMachine } from '../../../controller/src/handoff/state-machine.ts';
import type { WorkspaceLeaseManager } from '../../../controller/src/handoff/lease.ts';

export interface HandshakeResult {
  success: boolean;
  executionToken?: string;
  epoch?: number;
  error?: string;
}

export class TwoPhaseHandshakeCoordinator {
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

  public startNewSession(newSessionId: string): void {
    this.stateMachine.startNewSession(newSessionId);
  }

  public verifyAckAndAuthorize(manifest: HandoffPackManifest, ack: HandoffAckPacket): HandshakeResult {
    // 1. Verify hash matching
    if (ack.verifiedInputHeadHash !== manifest.inputLedgerHeadHash) {
      return { success: false, error: 'Input ledger head hash mismatch' };
    }
    if (ack.verifiedTaskSnapshotHash !== manifest.taskSnapshotHash) {
      return { success: false, error: 'Task snapshot hash mismatch' };
    }
    if (ack.verifiedWorkspaceHash !== manifest.workspaceFingerprint.treeHash) {
      return { success: false, error: 'Workspace hash mismatch' };
    }

    try {
      // 2. Advance state machine to READY
      this.stateMachine.receiveAck(ack);

      // 3. Atomically transfer CAS lease to new session
      const currentLease = this.leaseManager.getLease(this.workspaceKey);
      if (!currentLease) {
        return { success: false, error: `No active lease for workspace ${this.workspaceKey}` };
      }
      const newEpoch = currentLease.epoch + 1;
      const casSuccess = this.leaseManager.compareAndSetOwner(
        this.workspaceKey,
        currentLease.currentOwner,
        ack.newSessionId,
        currentLease.epoch,
        newEpoch
      );
      if (!casSuccess) {
        return { success: false, error: 'CAS lease acquisition failed' };
      }

      // 4. Issue execution token and advance state machine to RUNNING
      const token = this.stateMachine.issueExecutionToken();
      return {
        success: true,
        executionToken: token.token,
        epoch: token.epoch
      };
    } catch (err: unknown) {
      return { success: false, error: (err as Error).message };
    }
  }

  public extractAckFromText(text: string): HandoffAckPacket | undefined {
    const jsonMatch = text.match(/\{[\s\S]*"handoffId"[\s\S]*"verifiedInputHeadHash"[\s\S]*\}/);
    if (!jsonMatch) return undefined;
    try {
      return JSON.parse(jsonMatch[0]) as HandoffAckPacket;
    } catch {
      return undefined;
    }
  }
}
