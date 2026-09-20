import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { UninstallOptions } from './types.ts';
import { ConfigMerger } from './merger.ts';

export interface UninstallResult {
  target: string;
  cleanedFiles: string[];
}

export class Uninstaller {
  private merger = new ConfigMerger();

  async uninstall(options: UninstallOptions = {}): Promise<UninstallResult[]> {
    const targetName = options.target || 'all';
    const results: UninstallResult[] = [];

    if (targetName === 'all' || targetName === 'claude') {
      results.push(await this.uninstallClaude(options));
    }
    if (targetName === 'all' || targetName === 'codex') {
      results.push(await this.uninstallCodex(options));
    }
    if (targetName === 'all' || targetName === 'dsh') {
      results.push(await this.uninstallDsh(options));
    }

    // purgeAll: remove relay.db and its WAL/SHM files
    if (options.purgeAll && options.workspacePath) {
      const dbFiles = ['relay.db', 'relay.db-wal', 'relay.db-shm'];
      for (const dbFile of dbFiles) {
        const dbPath = path.join(options.workspacePath, dbFile);
        if (fs.existsSync(dbPath)) {
          fs.unlinkSync(dbPath);
        }
      }
    }

    return results;
  }

  private async uninstallClaude(options: UninstallOptions): Promise<UninstallResult> {
    const cleanedFiles: string[] = [];

    // Workspace scope
    if (options.workspacePath) {
      const settingsPath = path.join(options.workspacePath, '.claude', 'settings.json');
      const changed = this.merger.removeJsonManagedEntries(
        settingsPath,
        (item: any) => item.managedBy === 'agent-relay'
      );
      if (changed) {
        cleanedFiles.push(settingsPath);
      }
    }

    // Global scope
    if (options.global) {
      const globalSettings = path.join(os.homedir(), '.claude', 'settings.json');
      if (fs.existsSync(globalSettings)) {
        try {
          const raw = fs.readFileSync(globalSettings, 'utf8');
          const json = JSON.parse(raw);
          let changed = false;

          if (json.agentRelayEnabled !== undefined) {
            delete json.agentRelayEnabled;
            changed = true;
          }
          if (json.managedBy === 'agent-relay') {
            delete json.managedBy;
            changed = true;
          }

          if (changed) {
            this.merger.backupFile(globalSettings);
            const tmpPath = `${globalSettings}.tmp`;
            fs.writeFileSync(tmpPath, JSON.stringify(json, null, 2), 'utf8');
            fs.renameSync(tmpPath, globalSettings);
            cleanedFiles.push(globalSettings);
          }
        } catch {
          // File unreadable or invalid JSON; skip
        }
      }
    }

    return { target: 'claude', cleanedFiles };
  }

  private async uninstallCodex(options: UninstallOptions): Promise<UninstallResult> {
    const cleanedFiles: string[] = [];

    // Workspace scope: remove AGENT_RELAY block from AGENTS.md
    if (options.workspacePath) {
      const agentsPath = path.join(options.workspacePath, 'AGENTS.md');
      const changed = this.merger.removeMarkdownBlock(agentsPath);
      if (changed) {
        cleanedFiles.push(agentsPath);
      }
    }

    // Global scope: remove agentRelay from ~/.codex/config.json
    if (options.global) {
      const globalConfig = path.join(os.homedir(), '.codex', 'config.json');
      if (fs.existsSync(globalConfig)) {
        try {
          const raw = fs.readFileSync(globalConfig, 'utf8');
          const json = JSON.parse(raw);
          if (json.agentRelay) {
            delete json.agentRelay;
            this.merger.backupFile(globalConfig);
            const tmpPath = `${globalConfig}.tmp`;
            fs.writeFileSync(tmpPath, JSON.stringify(json, null, 2), 'utf8');
            fs.renameSync(tmpPath, globalConfig);
            cleanedFiles.push(globalConfig);
          }
        } catch {
          // Skip
        }
      }
    }

    return { target: 'codex', cleanedFiles };
  }

  private async uninstallDsh(options: UninstallOptions): Promise<UninstallResult> {
    const cleanedFiles: string[] = [];

    // Workspace scope: remove agent-relay plugin from .dsh/config.json
    if (options.workspacePath) {
      const dshConfigPath = path.join(options.workspacePath, '.dsh', 'config.json');
      if (fs.existsSync(dshConfigPath)) {
        try {
          const raw = fs.readFileSync(dshConfigPath, 'utf8');
          const json = JSON.parse(raw);
          if (Array.isArray(json.plugins)) {
            const origLen = json.plugins.length;
            json.plugins = json.plugins.filter((p: any) => p.id !== 'agent-relay');
            if (json.plugins.length !== origLen) {
              this.merger.backupFile(dshConfigPath);
              const tmpPath = `${dshConfigPath}.tmp`;
              fs.writeFileSync(tmpPath, JSON.stringify(json, null, 2), 'utf8');
              fs.renameSync(tmpPath, dshConfigPath);
              cleanedFiles.push(dshConfigPath);
            }
          }
        } catch {
          // Skip
        }
      }
    }

    // Global scope: remove ~/.dsh/plugins/agent-relay/ directory
    if (options.global) {
      const globalPluginDir = path.join(os.homedir(), '.dsh', 'plugins', 'agent-relay');
      if (fs.existsSync(globalPluginDir)) {
        fs.rmSync(globalPluginDir, { recursive: true, force: true });
        cleanedFiles.push(globalPluginDir);
      }
    }

    return { target: 'dsh', cleanedFiles };
  }
}
