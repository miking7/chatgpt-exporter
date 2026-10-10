import fs from 'node:fs/promises';
import path from 'node:path';
import { writeAtomic } from './storage-service.js';

/** Conversations that fail this many runs in a row (at the same update_time) are skipped until --retry-failed. */
export const MAX_FAILED_RUNS = 3;

export interface FailureRecord {
  count: number;
  lastError: string;
  lastAttemptAt: string;
  /** update_time when it failed; a newer version gets retried automatically. */
  updateTime: number | null;
  /** 404: deleted since it was listed. */
  gone?: boolean;
}

export interface SyncState {
  version: 1;
  /** When the whole conversation list was last read (rather than stopping at the first unchanged page). */
  lastFullListingAt?: string;
  failures: Record<string, FailureRecord>;
}

/** Per-output-folder state, stored in <output>/.sync-state.json. */
export class SyncStateStore {
  readonly filePath: string;
  state: SyncState;

  private constructor(filePath: string, state: SyncState) {
    this.filePath = filePath;
    this.state = state;
  }

  static async load(outputDir: string): Promise<SyncStateStore> {
    const filePath = path.join(outputDir, '.sync-state.json');
    let state: SyncState = { version: 1, failures: {} };
    try {
      const parsed = JSON.parse(await fs.readFile(filePath, 'utf-8')) as Partial<SyncState>;
      state = { version: 1, lastFullListingAt: parsed.lastFullListingAt, failures: parsed.failures ?? {} };
    } catch {
      // No state yet.
    }
    return new SyncStateStore(filePath, state);
  }

  shouldSkip(id: string, updateTime: number | null, retryFailed: boolean): boolean {
    const record = this.state.failures[id];
    if (!record || retryFailed || record.updateTime !== updateTime) return false;
    return Boolean(record.gone) || record.count >= MAX_FAILED_RUNS;
  }

  recordFailure(id: string, error: string, updateTime: number | null, gone: boolean): void {
    const previous = this.state.failures[id];
    const sameVersion = previous?.updateTime === updateTime;
    this.state.failures[id] = {
      count: sameVersion ? previous.count + 1 : 1,
      lastError: error,
      lastAttemptAt: new Date().toISOString(),
      updateTime,
      ...(gone ? { gone: true } : {}),
    };
  }

  clearFailure(id: string): void {
    delete this.state.failures[id];
  }

  parkedCount(): number {
    return Object.values(this.state.failures).filter((r) => r.gone || r.count >= MAX_FAILED_RUNS).length;
  }

  async save(): Promise<void> {
    await writeAtomic(this.filePath, JSON.stringify(this.state, null, 2));
  }
}
