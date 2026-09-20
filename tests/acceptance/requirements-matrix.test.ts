import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

interface RequirementEvidence {
  id: string;
  name: string;
  evidenceFiles: string[];
}

const REQUIREMENTS_MATRIX: RequirementEvidence[] = [
  {
    id: 'R1',
    name: 'Original Intent & Immutability',
    evidenceFiles: ['tests/contracts/inputs.test.ts', 'tests/eval/long-chain.test.ts']
  },
  {
    id: 'R2',
    name: 'Progress Checkpoints & Artifacts',
    evidenceFiles: ['tests/workspace/checkpoint.test.ts', 'tests/run/engine.test.ts']
  },
  {
    id: 'R3',
    name: 'Cross-Session Authoritative Memory',
    evidenceFiles: ['tests/contracts/inputs.test.ts', 'tests/contracts/tasks.test.ts']
  },
  {
    id: 'R4',
    name: 'Fresh Sessions (Not Fork/Resume)',
    evidenceFiles: ['tests/acceptance/claude-e2e.test.ts', 'tests/acceptance/codex-e2e.test.ts', 'tests/acceptance/dsh-e2e.test.ts']
  },
  {
    id: 'R5',
    name: 'Model & Effort Consistency',
    evidenceFiles: ['tests/scenarios/relay-run.test.ts', 'tests/acceptance/claude-e2e.test.ts']
  },
  {
    id: 'R6',
    name: 'Autonomous Progression & Anti-Loop',
    evidenceFiles: ['tests/policy/policy.test.ts', 'tests/eval/long-chain.test.ts']
  },
  {
    id: 'R7',
    name: 'Pause, Stop, Resume & Exit',
    evidenceFiles: ['tests/run/intent.test.ts', 'tests/acceptance/control-pause-resume.test.ts']
  },
  {
    id: 'R8',
    name: 'Three-Target Adapters',
    evidenceFiles: ['tests/adapters/claude-adapter.test.ts', 'tests/adapters/codex-adapter.test.ts', 'tests/adapters/dsh-adapter.test.ts']
  },
  {
    id: 'R9',
    name: 'Visible Progress & Zero Popups',
    evidenceFiles: ['tests/run/status.test.ts', 'tests/eval/long-chain.test.ts']
  },
  {
    id: 'R10',
    name: 'Crash & Fault Recovery',
    evidenceFiles: ['tests/recovery/snapshot-crash.test.ts', 'tests/recovery/outbox-reconcile.test.ts', 'tests/run/reconciler-phase1-phase2.test.ts']
  },
  {
    id: 'R11',
    name: 'Zero NPM Dependency & Clean Microkernel',
    evidenceFiles: ['packages/protocol/package.json', 'packages/controller/package.json', 'packages/installer/package.json']
  }
];

test('acceptance: Requirements Matrix (R1~R11) has 100% test evidence mapping', () => {
  assert.strictEqual(REQUIREMENTS_MATRIX.length, 11);

  for (const req of REQUIREMENTS_MATRIX) {
    assert.ok(req.evidenceFiles.length > 0, `Requirement ${req.id} must have evidence files`);
    for (const file of req.evidenceFiles) {
      const fullPath = path.resolve(file);
      assert.strictEqual(
        fs.existsSync(fullPath),
        true,
        `Evidence file for ${req.id} (${file}) must exist on disk`
      );
    }
  }
});
