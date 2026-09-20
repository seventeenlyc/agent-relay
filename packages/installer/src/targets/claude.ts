import path from 'node:path';
import os from 'node:os';
import { BaseTarget } from './base.ts';
import type { InstallOptions, InstallResult } from '../types.ts';
import { buildNodeCommand } from '../sanitizer.ts';

export class ClaudeTarget extends BaseTarget {
  readonly name = 'claude';

  async install(options: InstallOptions): Promise<InstallResult[]> {
    const results: InstallResult[] = [];
    const cliScript = options.cliScriptPath || path.resolve('packages/cli/dist/index.js');

    // 1. Workspace scope
    if (options.workspacePath) {
      const settingsPath = path.join(options.workspacePath, '.claude', 'settings.json');
      const hookCmd = (hookName: string) => buildNodeCommand(cliScript, ['hook', hookName, '--workspace', options.workspacePath!]);

      const relayHooks = [
        { event: 'SessionStart', command: hookCmd('session_start'), managedBy: 'agent-relay' },
        { event: 'PreCompact', command: hookCmd('pre_compact'), managedBy: 'agent-relay' },
        { event: 'Stop', command: hookCmd('stop'), managedBy: 'agent-relay' }
      ];

      const { backupPath } = this.merger.mergeJsonFile(settingsPath, (existing) => {
        const hooks = Array.isArray(existing.hooks) ? existing.hooks : [];
        for (const rh of relayHooks) {
          const idx = hooks.findIndex((h: any) => h.event === rh.event && h.managedBy === 'agent-relay');
          if (idx >= 0) {
            hooks[idx] = rh;
          } else {
            hooks.push(rh);
          }
        }
        existing.hooks = hooks;
        return existing;
      });

      results.push({
        target: 'claude',
        scope: 'workspace',
        filePath: settingsPath,
        backupPath,
        status: 'installed'
      });
    }

    // 2. Global scope (if requested)
    if (options.global) {
      const globalSettings = path.join(os.homedir(), '.claude', 'settings.json');
      const { backupPath } = this.merger.mergeJsonFile(globalSettings, (existing) => {
        existing.agentRelayEnabled = true;
        existing.managedBy = 'agent-relay';
        return existing;
      });
      results.push({
        target: 'claude',
        scope: 'global',
        filePath: globalSettings,
        backupPath,
        status: 'installed'
      });
    }

    return results;
  }
}
