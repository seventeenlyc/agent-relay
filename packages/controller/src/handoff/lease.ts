export interface WorkspaceLease {
  workspaceKey: string;
  currentOwner: string;
  epoch: number;
  acquiredAt: number;
}

export class WorkspaceLeaseManager {
  private leases: Map<string, WorkspaceLease> = new Map();

  public acquireInitialLease(workspaceKey: string, owner: string, epoch = 1): boolean {
    if (this.leases.has(workspaceKey)) {
      return false;
    }
    this.leases.set(workspaceKey, {
      workspaceKey,
      currentOwner: owner,
      epoch,
      acquiredAt: Date.now()
    });
    return true;
  }

  public compareAndSetOwner(
    workspaceKey: string,
    expectedOwner: string,
    newOwner: string,
    expectedEpoch: number,
    newEpoch: number
  ): boolean {
    const current = this.leases.get(workspaceKey);
    if (!current) return false;
    if (
      current.currentOwner !== expectedOwner ||
      current.epoch !== expectedEpoch ||
      newEpoch <= expectedEpoch
    ) {
      return false;
    }
    current.currentOwner = newOwner;
    current.epoch = newEpoch;
    current.acquiredAt = Date.now();
    return true;
  }

  public getLease(workspaceKey: string): WorkspaceLease | undefined {
    const lease = this.leases.get(workspaceKey);
    if (!lease) return undefined;
    return { ...lease };
  }

  public releaseLease(workspaceKey: string, owner: string): boolean {
    const current = this.leases.get(workspaceKey);
    if (current && current.currentOwner === owner) {
      this.leases.delete(workspaceKey);
      return true;
    }
    return false;
  }
}
