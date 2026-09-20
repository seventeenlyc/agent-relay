import type { InstallOptions, InstallResult } from './types.ts';
import { ClaudeTarget } from './targets/claude.ts';
import { CodexTarget } from './targets/codex.ts';
import { DshTarget } from './targets/dsh.ts';
import type { BaseTarget } from './targets/base.ts';

export class Installer {
  private targets: Map<string, BaseTarget> = new Map();

  constructor() {
    this.targets.set('claude', new ClaudeTarget());
    this.targets.set('codex', new CodexTarget());
    this.targets.set('dsh', new DshTarget());
  }

  async install(options: InstallOptions = {}): Promise<InstallResult[]> {
    const targetName = options.target || 'all';
    const results: InstallResult[] = [];

    if (targetName === 'all') {
      for (const target of this.targets.values()) {
        const res = await target.install(options);
        results.push(...res);
      }
    } else {
      const target = this.targets.get(targetName);
      if (!target) {
        throw new Error(`Unknown install target: ${targetName}`);
      }
      const res = await target.install(options);
      results.push(...res);
    }

    return results;
  }
}
