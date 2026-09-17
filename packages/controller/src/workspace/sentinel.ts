import { execSync } from 'node:child_process';
import { computeSha256 } from '../../../protocol/src/index.ts';
import type { WorkspaceFingerprint } from '../../../protocol/src/types.ts';

export class WorkspaceSentinel {
  private workingDir: string;

  constructor(workingDir: string) {
    this.workingDir = workingDir;
  }

  public captureFingerprint(): WorkspaceFingerprint {
    let commitHash = 'UNKNOWN_COMMIT';
    try {
      commitHash = execSync('git rev-parse HEAD', {
        cwd: this.workingDir,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore']
      }).trim();
    } catch {
      // Non-git directory fallback
    }

    const untrackedFiles: string[] = [];
    const dirtyFiles: string[] = [];
    try {
      const statusOutput = execSync('git status --porcelain', {
        cwd: this.workingDir,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore']
      });

      const statusLines = statusOutput
        .split(/\r?\n/)
        .filter((l) => l.length >= 3);

      for (const line of statusLines) {
        const code = line.slice(0, 2);
        let file = line.slice(3).trim();
        if (file.startsWith('"') && file.endsWith('"')) {
          file = file.slice(1, -1);
        }
        if (code === '??') {
          untrackedFiles.push(file);
        } else {
          dirtyFiles.push(file);
        }
      }
    } catch {
      // Fallback
    }

    dirtyFiles.sort();
    untrackedFiles.sort();

    const treeHash = computeSha256(`${commitHash}|${dirtyFiles.join(',')}|${untrackedFiles.join(',')}`);
    return {
      commitHash,
      untrackedFiles,
      dirtyFiles,
      treeHash
    };
  }

  public captureBaseline(): WorkspaceFingerprint {
    return this.captureFingerprint();
  }

  public verifyIntegrity(expectedTreeHash: string): boolean {
    const current = this.captureFingerprint();
    return current.treeHash === expectedTreeHash;
  }

  public protectUntrackedChanges(baselineUntracked: string[] | WorkspaceFingerprint): boolean {
    const baseline = Array.isArray(baselineUntracked)
      ? baselineUntracked
      : baselineUntracked.untrackedFiles;
    const current = this.captureFingerprint();
    const currentSet = new Set(current.untrackedFiles);
    return baseline.every((file) => currentSet.has(file));
  }
}
