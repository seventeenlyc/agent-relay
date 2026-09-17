import { computeSha256 } from '../../../protocol/src/index.ts';

export class LoopDetector {
  private failureHashes: string[] = [];
  private readonly threshold: number;

  constructor(threshold = 3) {
    this.threshold = threshold;
  }

  public recordFailure(failureSignature: string): void {
    const hash = computeSha256(failureSignature.trim());
    this.failureHashes.push(hash);
  }

  public isLoopBlocked(): boolean {
    if (this.failureHashes.length < this.threshold) {
      return false;
    }
    const recent = this.failureHashes.slice(-this.threshold);
    const first = recent[0];
    return recent.every((h) => h === first);
  }

  public reset(): void {
    this.failureHashes = [];
  }
}
