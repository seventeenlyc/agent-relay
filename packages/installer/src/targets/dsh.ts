import path from 'node:path';
import os from 'node:os';
import { BaseTarget } from './base.ts';
import type { InstallOptions, InstallResult } from '../types.ts';

export class DshTarget extends BaseTarget {
  readonly name = 'dsh';

  async install(options: InstallOptions): Promise<InstallResult[]> {
    const results: InstallResult[] = [];

    // 1. Workspace scope: .dsh/config.json
    if (options.workspacePath) {
      const dshPath = path.join(options.workspacePath, '.dsh', 'config.json');
      const { backupPath } = this.merger.mergeJsonFile(dshPath, (existing) => {
        const plugins = Array.isArray(existing.plugins) ? existing.plugins : [];
        const idx = plugins.findIndex((p: any) => p.id === 'agent-relay');
        const relayPlugin = { id: 'agent-relay', enabled: true, managedBy: 'agent-relay' };
        if (idx >= 0) {
          plugins[idx] = relayPlugin;
        } else {
          plugins.push(relayPlugin);
        }
        existing.plugins = plugins;
        return existing;
      });

      results.push({
        target: 'dsh',
        scope: 'workspace',
        filePath: dshPath,
        backupPath,
        status: 'installed'
      });
    }

    // 2. Global scope: ~/.dsh/plugins/agent-relay/plugin.json
    if (options.global) {
      const globalPlugin = path.join(os.homedir(), '.dsh', 'plugins', 'agent-relay', 'plugin.json');
      const { backupPath } = this.merger.mergeJsonFile(globalPlugin, (existing) => {
        existing.name = 'agent-relay';
        existing.version = '0.1.0';
        existing.managedBy = 'agent-relay';
        return existing;
      });
      results.push({
        target: 'dsh',
        scope: 'global',
        filePath: globalPlugin,
        backupPath,
        status: 'installed'
      });
    }

    return results;
  }
}
