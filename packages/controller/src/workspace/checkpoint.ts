import { randomUUID } from 'node:crypto';
import { computeSha256, serializeCanonicalJson, validateHandoffManifest } from '../../../protocol/src/index.ts';
import type { HandoffPackManifest, WorkspaceFingerprint } from '../../../protocol/src/types.ts';
import type { InputLedger } from '../inputs/ledger.ts';
import { deriveContractFromLedger } from '../inputs/supersedes.ts';
import type { TaskGraph } from '../tasks/graph.ts';
import type { WorkspaceSentinel } from './sentinel.ts';

export interface CreateManifestParams {
  handoffId?: string;
  runId: string;
  epoch: number;
  sourceSessionId: string;
  targetModel: { provider: string; model: string; effort?: string };
  ledger?: InputLedger;
  taskGraph?: TaskGraph;
  sentinel?: WorkspaceSentinel;
  inputLedgerHeadHash?: string;
  requirementVersion?: number;
  taskSnapshotHash?: string;
  workspaceFingerprint?: WorkspaceFingerprint;
  timestamp?: number;
}

export class HandoffPackager {
  public createManifest(params: CreateManifestParams): HandoffPackManifest {
    const fp = params.workspaceFingerprint ?? params.sentinel?.captureFingerprint();
    if (!fp) {
      throw new Error('HandoffPackager: workspaceFingerprint is required (provide sentinel or workspaceFingerprint)');
    }

    let taskSnapshotHash = params.taskSnapshotHash;
    if (!taskSnapshotHash) {
      if (params.taskGraph) {
        taskSnapshotHash = params.taskGraph.computeSnapshotHash();
      } else {
        taskSnapshotHash = computeSha256(serializeCanonicalJson([]));
      }
    }

    const requirementVersion =
      params.requirementVersion ??
      (params.ledger ? deriveContractFromLedger(params.ledger).version : 1);

    const inputLedgerHeadHash =
      params.inputLedgerHeadHash ??
      (params.ledger ? params.ledger.getHeadHash() : computeSha256(''));

    const manifest: HandoffPackManifest = {
      handoffId: params.handoffId ?? randomUUID(),
      runId: params.runId,
      epoch: params.epoch,
      sourceSessionId: params.sourceSessionId,
      targetModel: params.targetModel,
      inputLedgerHeadHash,
      requirementVersion,
      taskSnapshotHash,
      workspaceFingerprint: fp,
      timestamp: params.timestamp ?? Date.now()
    };

    validateHandoffManifest(manifest);
    return manifest;
  }

  public verifyManifest(manifest: HandoffPackManifest): void {
    validateHandoffManifest(manifest);
  }

  public createHandoffPack(params: CreateManifestParams): HandoffPackManifest {
    return this.createManifest(params);
  }

  public verifyHandoffPack(manifest: HandoffPackManifest): void {
    this.verifyManifest(manifest);
  }
}
