export type InputSource = 'human' | 'generated_handoff' | 'system_injection';

export interface InputRecord {
  inputId: string;
  source: InputSource;
  timestamp: number;
  rawContent: string;
  sha256Hash: string;
  supersedesId?: string;
  metadata?: Record<string, unknown>;
}

export type RequirementStatus = 'active' | 'amended' | 'cancelled';

export interface RequirementContract {
  requirementId: string;
  version: number;
  goals: string[];
  scopePaths: string[];
  forbiddenItems: string[];
  acceptanceCriteria: string[];
  sourceInputIds: string[];
  supersedesRequirementId?: string;
  status: RequirementStatus;
}

export type TaskStatus = 'pending' | 'in_progress' | 'verifying' | 'completed' | 'cancelled' | 'blocked';

export interface TaskItem {
  taskId: string;
  requirementId: string;
  title: string;
  description: string;
  dependencies: string[];
  status: TaskStatus;
  allowedPaths: string[];
  expectedArtifacts: string[];
  testEvidenceHash?: string;
  completedAt?: number;
}

export interface WorkspaceFingerprint {
  commitHash: string;
  untrackedFiles: string[];
  dirtyFiles: string[];
  treeHash: string;
}

export interface HandoffPackManifest {
  failedUnits?: Array<{ taskId: string; summary: string; evidenceHash?: string }>;
  handoffId: string;
  runId: string;
  epoch: number;
  sourceSessionId: string;
  targetModel: {
    provider: string;
    model: string;
    effort?: string;
  };
  inputLedgerHeadHash: string;
  requirementVersion: number;
  taskSnapshotHash: string;
  workspaceFingerprint: WorkspaceFingerprint;
  timestamp: number;
}

export interface HandoffAckPacket {
  handoffId: string;
  runId: string;
  newSessionId: string;
  effectiveModel: {
    provider: string;
    model: string;
    effort?: string;
  };
  verifiedInputHeadHash: string;
  verifiedTaskSnapshotHash: string;
  verifiedWorkspaceHash: string;
  ackTimestamp: number;
}
