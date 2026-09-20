export interface InstallOptions {
  target?: 'claude' | 'codex' | 'dsh' | 'all';
  global?: boolean;
  workspacePath?: string;
  cliScriptPath?: string;
}

export interface UninstallOptions {
  target?: 'claude' | 'codex' | 'dsh' | 'all';
  global?: boolean;
  workspacePath?: string;
  purgeAll?: boolean;
}

export interface InstallResult {
  target: string;
  scope: 'global' | 'workspace';
  filePath: string;
  backupPath: string | null;
  status: 'installed' | 'updated' | 'skipped';
}
