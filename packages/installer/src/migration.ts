import type { RelayDatabase } from '../../controller/src/run/db.ts';

export const MAX_SUPPORTED_SCHEMA = 1;

export interface CompatibilityCheckResult {
  compatible: boolean;
  readOnlyRequired: boolean;
  reason?: string;
  currentVersion: string;
  maxSupportedVersion: string;
}

export class MigrationEngine {
  public getCurrentVersion(db: RelayDatabase): string {
    const row = db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as { value?: string } | undefined;
    return row?.value ?? '0';
  }

  public checkCompatibility(db: RelayDatabase): CompatibilityCheckResult {
    const currentVersionStr = this.getCurrentVersion(db);
    const currentVersion = parseInt(currentVersionStr, 10);

    if (isNaN(currentVersion) || currentVersion > MAX_SUPPORTED_SCHEMA) {
      return {
        compatible: false,
        readOnlyRequired: true,
        reason: `Database schema version (${currentVersionStr}) is higher than supported (${MAX_SUPPORTED_SCHEMA}). Read-only mode required.`,
        currentVersion: currentVersionStr,
        maxSupportedVersion: String(MAX_SUPPORTED_SCHEMA)
      };
    }

    return {
      compatible: true,
      readOnlyRequired: false,
      currentVersion: currentVersionStr,
      maxSupportedVersion: String(MAX_SUPPORTED_SCHEMA)
    };
  }

  public migrate(
    db: RelayDatabase,
    targetVersion = String(MAX_SUPPORTED_SCHEMA)
  ): { from: string; to: string } {
    const comp = this.checkCompatibility(db);
    if (comp.readOnlyRequired) {
      throw new Error(`Cannot migrate: ${comp.reason}`);
    }

    const fromVersion = comp.currentVersion;
    // Current is v1, which is base schema. If target > current,
    // sequential migration steps would run here in a transaction.
    return {
      from: fromVersion,
      to: targetVersion
    };
  }
}
