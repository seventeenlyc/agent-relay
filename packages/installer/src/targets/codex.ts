import path from 'node:path';
import os from 'node:os';
import { BaseTarget } from './base.ts';
import type { InstallOptions, InstallResult } from '../types.ts';

export class CodexTarget extends BaseTarget {
  readonly name = 'codex';

  async install(options: InstallOptions): Promise<InstallResult[]> {
    const results: InstallResult[] = [];

    // 1. Workspace scope: AGENTS.md
    if (options.workspacePath) {
      const agentsPath = path.join(options.workspacePath, 'AGENTS.md');
      const instructions = `## Agent Relay Integration
- Use \`agent-relay\` CLI to orchestrate long tasks.
- Keep verbatim input intact and adhere to immutable task graph constraints.`;

      const { backupPath } = this.merger.mergeMarkdownBlock(agentsPath, instructions);
      results.push({
        target: 'codex',
        scope: 'workspace',
        filePath: agentsPath,
        backupPath,
        status: 'installed'
      });
    }

    // 2. Global scope: ~/.codex/config.json
    if (options.global) {
      const globalConfig = path.join(os.homedir(), '.codex', 'config.json');
      const { backupPath } = this.merger.mergeJsonFile(globalConfig, (existing) => {
        existing.agentRelay = { enabled: true, managedBy: 'agent-relay' };
        return existing;
      });
      results.push({
        target: 'codex',
        scope: 'global',
        filePath: globalConfig,
        backupPath,
        status: 'installed'
      });
    }

    return results;
  }
}
