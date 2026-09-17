import { createHash } from 'node:crypto';
import type { InputRecord } from './types.ts';

export function computeSha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export function serializeCanonicalJson(obj: unknown): string {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return '[' + obj.map(serializeCanonicalJson).join(',') + ']';
  }
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  const pairs = keys.map((k) => JSON.stringify(k) + ':' + serializeCanonicalJson((obj as Record<string, unknown>)[k]));
  return '{' + pairs.join(',') + '}';
}

export function validateInputRecord(record: Partial<InputRecord>): asserts record is InputRecord {
  if (!record.inputId || typeof record.inputId !== 'string') {
    throw new Error('validateInputRecord: inputId is required');
  }
  if (!record.rawContent || typeof record.rawContent !== 'string' || record.rawContent.trim() === '') {
    throw new Error('validateInputRecord: rawContent cannot be empty');
  }
  if (!record.source || !['human', 'generated_handoff', 'system_injection'].includes(record.source)) {
    throw new Error('validateInputRecord: invalid source');
  }
  const expectedHash = computeSha256(record.rawContent);
  if (record.sha256Hash && record.sha256Hash !== expectedHash) {
    throw new Error(`validateInputRecord: hash mismatch. expected ${expectedHash}, got ${record.sha256Hash}`);
  }
}
