import { randomUUID } from 'node:crypto';
import { computeSha256, serializeCanonicalJson, validateHandoffManifest } from '../../../protocol/src/index.ts';
import type { HandoffPackManifest } from '../../../protocol/src/types.ts';
import type { InputLedger } from '../inputs/ledger.ts';
import type { TaskGraph } from '../tasks/graph.ts';
import type { WorkspaceSentinel } from './sentinel.ts';

export interface CreateManifestParams {
  runId: string;
  epoch: number;
  sourceSessionId: string;
  targetModel: { provider: string; model: string; effort?: string };
  ledger: InputLedger;
  taskGraph: TaskGraph;
  sentinel: WorkspaceSentinel;
}

export class HandoffPackager {
  public createManifest(params: CreateManifestParams): HandoffPackManifest {
    const fp = params.sentinel.captureFingerprint();
    const taskSnapshotHash = computeSha256(serializeCanonicalJson(params.taskGraph.getAllTasks()));

    const manifest: HandoffPackManifest = {
      handoffId: randomUUID(),
      runId: params.runId,
      epoch: params.epoch,
      sourceSessionId: params.sourceSessionId,
      targetModel: params.targetModel,
      inputLedgerHeadHash: params.ledger.getHeadHash(),
      requirementVersion: 1,
      taskSnapshotHash,
      workspaceFingerprint: fp,
      timestamp: Date.now()
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
