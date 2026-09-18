import { randomUUID } from 'node:crypto';
import { computeSha256, serializeCanonicalJson, validateInputRecord } from '../../../protocol/src/index.ts';
import type { InputRecord } from '../../../protocol/src/types.ts';

export class InputLedger {
  private records: InputRecord[] = [];

  public appendUserMessage(content: string, supersedesId?: string, metadata?: Record<string, unknown>): InputRecord {
    if (!content || content.trim() === '') {
      throw new Error('InputLedger: User content cannot be empty');
    }
    const record: InputRecord = {
      inputId: randomUUID(),
      source: 'human',
      timestamp: Date.now(),
      rawContent: content,
      sha256Hash: computeSha256(content),
      supersedesId,
      metadata
    };
    validateInputRecord(record);
    Object.freeze(record);
    this.records.push(record);
    return record;
  }

  public appendSystemHandoff(content: string, metadata?: Record<string, unknown>): InputRecord {
    const record: InputRecord = {
      inputId: randomUUID(),
      source: 'generated_handoff',
      timestamp: Date.now(),
      rawContent: content,
      sha256Hash: computeSha256(content),
      metadata
    };
    validateInputRecord(record);
    Object.freeze(record);
    this.records.push(record);
    return record;
  }

  /**
   * 从持久化记录逐字重建账本（重启恢复用）。
   * 每条记录都经过 validateInputRecord（含 sha256 完整性校验）；任何一条被篡改即整体拒绝，
   * 不留下半还原状态。原始 inputId / timestamp / sha256Hash 一律保留，因此 getHeadHash() 可稳定复现。
   */
  public restoreFrom(records: InputRecord[]): void {
    if (records.length === 0) {
      return;
    }
    const staged: InputRecord[] = [];
    for (const record of records) {
      const copy: InputRecord = {
        inputId: record.inputId,
        source: record.source,
        timestamp: record.timestamp,
        rawContent: record.rawContent,
        sha256Hash: record.sha256Hash,
        supersedesId: record.supersedesId,
        metadata: record.metadata
      };
      validateInputRecord(copy);
      Object.freeze(copy);
      if (this.records.some((existing) => existing.inputId === copy.inputId)) {
        continue; // 幂等：已存在的记录不重复追加
      }
      staged.push(copy);
    }
    this.records.push(...staged);
  }

  public getHumanInputs(): InputRecord[] {
    return this.records.filter((r) => r.source === 'human');
  }

  public getAllRecords(): InputRecord[] {
    return [...this.records];
  }

  public getRecordById(id: string): InputRecord | undefined {
    return this.records.find((r) => r.inputId === id);
  }

  public getHeadHash(): string {
    if (this.records.length === 0) {
      return computeSha256('EMPTY_LEDGER');
    }
    return computeSha256(serializeCanonicalJson(this.records));
  }
}
