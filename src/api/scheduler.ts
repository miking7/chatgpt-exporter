import fs from 'node:fs/promises';
import path from 'node:path';
import { abortError, systemClock, type Clock } from '../utils/time.js';

/**
 * Client-side pacing that stays under ChatGPT's own limits.
 *
 * Measured on a Team account (Sep 2026): conversation downloads (/backend-api/conversation/{id}) are
 * limited by a bucket of ~200 that refills at ~1 per minute, shared with the web app opening chats.
 * Each request kind here gets its own smaller bucket (burst + steady interval). The conversation bucket
 * is persisted, so separate or scheduled runs can't add up to more than the configured rate.
 *
 * A 429 pauses every kind of request for a cooldown (honouring Retry-After when longer). The cooldown
 * doubles on each further 429 in a row, and the run gives up once that streak passes the limit.
 */

export type RequestKind = 'conversation' | 'list' | 'file';

export interface BucketConfig {
  /** Average spacing once the burst is used up (the refill period of one request). */
  intervalMs: number;
  /** Requests that may go back-to-back after an idle period. */
  burst: number;
}

export interface SchedulerConfig {
  conversation: BucketConfig;
  list: BucketConfig;
  file: BucketConfig;
  /** Minimum spacing between any two requests, even within a burst. */
  minGapMs: number;
  /** Pause after a 429; doubles for each further 429 in a row, up to maxThrottleCooldownMs. */
  throttleCooldownMs: number;
  maxThrottleCooldownMs: number;
  /** Stop (ThrottledError) on the 429 that makes the streak longer than this. */
  maxConsecutiveThrottles: number;
  /** Persists the conversation bucket and any active cooldown between runs. */
  statePath?: string;
  clock?: Clock;
}

export interface WaitInfo {
  kind: RequestKind;
  reason: 'pace' | 'throttle';
  until: number;
}

export interface ThrottleDecision {
  pauseMs: number;
  resumeAt: number;
  consecutive: number;
  giveUp: boolean;
}

export interface SchedulerSnapshot {
  tokens: number;
  burst: number;
  intervalMs: number;
  throttledUntil: number;
  consecutiveThrottles: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

interface PersistedState {
  version: 1;
  conversation: Bucket;
  throttledUntil: number;
  /** Longest current streak (shown by `status`). */
  consecutiveThrottles: number;
  throttleStreaks?: Partial<Record<RequestKind, number>>;
}

const KINDS: RequestKind[] = ['conversation', 'list', 'file'];
const MAX_SLOWDOWN = 4;
/** Re-check the wall clock at least this often while waiting: timers stall while a Mac sleeps. */
const MAX_SLEEP_SLICE_MS = 30_000;
const TOKEN_EPSILON = 1e-9;

export class RequestScheduler {
  private readonly config: SchedulerConfig;
  private readonly clock: Clock;
  private readonly buckets: Record<RequestKind, Bucket>;
  private throttledUntil = 0;
  /**
   * 429s in a row, per kind of request. The pause applies to everything, but the streak is per kind:
   * list pages succeeding alongside must not reset a streak of refused conversation downloads.
   */
  private readonly throttleStreaks: Record<RequestKind, number> = { conversation: 0, list: 0, file: 0 };
  /** Interval multiplier for the rest of this run after a 429. */
  private slowdown = 1;
  private lastRequestAt = Number.NEGATIVE_INFINITY;
  /** Told when a request of `kind` starts waiting (reason, end time) and when it goes ahead (null). */
  onWait?: (kind: RequestKind, info: WaitInfo | null) => void;

  private constructor(config: SchedulerConfig) {
    this.config = config;
    this.clock = config.clock ?? systemClock;
    const now = this.clock.now();
    this.buckets = {
      conversation: { tokens: config.conversation.burst, updatedAt: now },
      list: { tokens: config.list.burst, updatedAt: now },
      file: { tokens: config.file.burst, updatedAt: now },
    };
  }

  static async create(config: SchedulerConfig): Promise<RequestScheduler> {
    const scheduler = new RequestScheduler(config);
    await scheduler.restore();
    return scheduler;
  }

  /** Resolves when a request of this kind may be sent, waiting out pacing and cooldowns. */
  async acquire(kind: RequestKind, signal?: AbortSignal): Promise<void> {
    for (;;) {
      if (signal?.aborted) throw abortError(signal);
      const now = this.clock.now();

      if (now < this.throttledUntil) {
        await this.waitUntil({ kind, reason: 'throttle', until: this.throttledUntil }, signal);
        continue;
      }

      this.refill(kind, now);
      const bucket = this.buckets[kind];
      const gapReadyAt = this.lastRequestAt + this.config.minGapMs;
      if (bucket.tokens >= 1 - TOKEN_EPSILON && now >= gapReadyAt) {
        bucket.tokens = Math.max(0, bucket.tokens - 1);
        this.lastRequestAt = now;
        this.onWait?.(kind, null);
        if (kind === 'conversation') await this.persist();
        return;
      }

      const tokenReadyAt =
        bucket.tokens >= 1 - TOKEN_EPSILON ? now : now + Math.ceil((1 - bucket.tokens) * this.interval(kind));
      await this.waitUntil({ kind, reason: 'pace', until: Math.max(tokenReadyAt, gapReadyAt) }, signal);
    }
  }

  /** Records a 429 (or a bot-protection block) on `kind` and decides how long everything pauses. */
  async reportThrottle(retryAfterMs?: number, kind: RequestKind = 'conversation'): Promise<ThrottleDecision> {
    const now = this.clock.now();
    const streak = (this.throttleStreaks[kind] += 1);
    for (const k of KINDS) this.buckets[k] = { tokens: 0, updatedAt: now };

    const backoff = Math.min(this.config.maxThrottleCooldownMs, this.config.throttleCooldownMs * 2 ** (streak - 1));
    const pauseMs = Math.max(backoff, retryAfterMs ?? 0);
    this.throttledUntil = Math.max(this.throttledUntil, now + pauseMs);
    this.slowdown = Math.min(MAX_SLOWDOWN, this.slowdown * 2);
    await this.persist();

    return {
      pauseMs,
      resumeAt: this.throttledUntil,
      consecutive: streak,
      giveUp: streak > this.config.maxConsecutiveThrottles,
    };
  }

  async reportSuccess(kind: RequestKind = 'conversation'): Promise<void> {
    if (this.throttleStreaks[kind] === 0) return;
    this.throttleStreaks[kind] = 0;
    await this.persist();
  }

  snapshot(kind: RequestKind = 'conversation'): SchedulerSnapshot {
    this.refill(kind, this.clock.now());
    return {
      tokens: this.buckets[kind].tokens,
      burst: this.config[kind].burst,
      intervalMs: this.interval(kind),
      throttledUntil: this.throttledUntil,
      consecutiveThrottles: this.longestStreak(),
    };
  }

  private longestStreak(): number {
    return Math.max(...KINDS.map((k) => this.throttleStreaks[k]));
  }

  /** Rough time to send `count` more requests of this kind at the current pace. */
  estimateMs(count: number, kind: RequestKind = 'conversation'): number {
    const { tokens, intervalMs, throttledUntil } = this.snapshot(kind);
    const waitForCooldown = Math.max(0, throttledUntil - this.clock.now());
    return waitForCooldown + Math.max(0, count - Math.floor(tokens)) * intervalMs;
  }

  private interval(kind: RequestKind): number {
    return this.config[kind].intervalMs * this.slowdown;
  }

  private refill(kind: RequestKind, now: number): void {
    const bucket = this.buckets[kind];
    if (now <= bucket.updatedAt) return;
    bucket.tokens = Math.min(this.config[kind].burst, bucket.tokens + (now - bucket.updatedAt) / this.interval(kind));
    bucket.updatedAt = now;
  }

  private async waitUntil(info: WaitInfo, signal?: AbortSignal): Promise<void> {
    this.onWait?.(info.kind, info);
    const remaining = info.until - this.clock.now();
    if (remaining > 0) await this.clock.sleep(Math.min(remaining, MAX_SLEEP_SLICE_MS), signal);
  }

  private async restore(): Promise<void> {
    if (!this.config.statePath) return;
    let raw: string;
    try {
      raw = await fs.readFile(this.config.statePath, 'utf-8');
    } catch {
      return;
    }
    try {
      const state = JSON.parse(raw) as Partial<PersistedState>;
      const now = this.clock.now();
      const saved = state.conversation;
      if (saved && Number.isFinite(saved.tokens) && Number.isFinite(saved.updatedAt)) {
        this.buckets.conversation = {
          tokens: Math.min(Math.max(saved.tokens, 0), this.config.conversation.burst),
          updatedAt: Math.min(saved.updatedAt, now),
        };
      }
      if (Number.isFinite(state.throttledUntil)) this.throttledUntil = state.throttledUntil!;
      if (state.throttleStreaks) {
        for (const kind of KINDS) {
          const streak = state.throttleStreaks[kind];
          if (Number.isFinite(streak)) this.throttleStreaks[kind] = streak!;
        }
      } else if (Number.isFinite(state.consecutiveThrottles)) {
        // State written before streaks were tracked per kind.
        this.throttleStreaks.conversation = state.consecutiveThrottles!;
      }
    } catch {
      // Corrupt state: start fresh with a full allowance.
    }
  }

  private async persist(): Promise<void> {
    const statePath = this.config.statePath;
    if (!statePath) return;
    const state: PersistedState = {
      version: 1,
      conversation: this.buckets.conversation,
      throttledUntil: this.throttledUntil,
      consecutiveThrottles: this.longestStreak(),
      throttleStreaks: { ...this.throttleStreaks },
    };
    try {
      await fs.mkdir(path.dirname(statePath), { recursive: true });
      const tmp = `${statePath}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(state, null, 2));
      await fs.rename(tmp, statePath);
    } catch {
      // Pacing still works in-process; only cross-run memory is lost.
    }
  }
}
