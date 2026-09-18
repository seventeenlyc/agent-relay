// packages/controller/src/handoff/durable-lease.ts
import type { RunStore } from '../run/store.ts';
import type { WorkspaceLease } from './lease.ts';

/**
 * 落库版单写入者 CAS 租约。方法签名与内存版 WorkspaceLeaseManager 逐一对齐，
 * 因此可以直接注入三个适配器的 handshake coordinator，使内存与磁盘租约不再可能分叉。
 *
 * 与内存版一致的不变量：owner 不符、epoch 不符、或 newEpoch <= expectedEpoch 时 CAS 失败。
 */
export class DurableLeaseManager {
  private readonly store: RunStore;

  constructor(store: RunStore) {
    this.store = store;
  }

  public acquireInitialLease(workspaceKey: string, owner: string, epoch = 1): boolean {
    return this.store.transaction(() => {
      if (this.store.getLeaseRow(workspaceKey)) {
        return false;
      }
      return this.store.tryInsertLease(workspaceKey, owner, epoch);
    });
  }

  public compareAndSetOwner(
    workspaceKey: string,
    expectedOwner: string,
    newOwner: string,
    expectedEpoch: number,
    newEpoch: number
  ): boolean {
    if (newEpoch <= expectedEpoch) {
      return false;
    }
    return this.store.transaction(() =>
      this.store.casLeaseRow(workspaceKey, expectedOwner, newOwner, expectedEpoch, newEpoch)
    );
  }

  public getLease(workspaceKey: string): WorkspaceLease | undefined {
    const row = this.store.getLeaseRow(workspaceKey);
    if (!row) return undefined;
    return {
      workspaceKey: row.workspaceKey,
      currentOwner: row.currentOwner,
      epoch: row.epoch,
      acquiredAt: row.acquiredAt
    };
  }

  public releaseLease(workspaceKey: string, owner: string): boolean {
    return this.store.transaction(() => this.store.deleteLease(workspaceKey, owner));
  }
}
