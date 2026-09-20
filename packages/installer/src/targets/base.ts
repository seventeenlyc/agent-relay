import type { InstallOptions, InstallResult } from '../types.ts';
import { ConfigMerger } from '../merger.ts';

export abstract class BaseTarget {
  protected merger = new ConfigMerger();
  abstract readonly name: string;
  abstract install(options: InstallOptions): Promise<InstallResult[]>;
}
