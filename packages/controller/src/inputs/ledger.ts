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
    this.records.push(record);
    return record;
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
