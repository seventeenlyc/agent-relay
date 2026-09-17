import type { HandoffPackManifest } from './types.ts';

export function validateHandoffManifest(manifest: Partial<HandoffPackManifest>): asserts manifest is HandoffPackManifest {
  if (!manifest.handoffId || !manifest.runId) {
    throw new Error('validateHandoffManifest: handoffId and runId are required');
  }
  if (!manifest.workspaceFingerprint || !manifest.workspaceFingerprint.treeHash) {
    throw new Error('validateHandoffManifest: valid workspaceFingerprint is required');
  }
  if (manifest.epoch === undefined || manifest.epoch < 0) {
    throw new Error('validateHandoffManifest: valid epoch is required');
  }
}
