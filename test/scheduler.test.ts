import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RequestScheduler, type SchedulerConfig } from '../src/api/scheduler.js';
import type { Clock } from '../src/utils/time.js';

function fakeClock(start = 1_000_000) {
  let now = start;
  const clock: Clock = {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
  };
  return { clock, advance: (ms: number) => (now += ms), now: () => now };
}

function config(clock: Clock, overrides: Partial<SchedulerConfig> = {}): SchedulerConfig {
  return {
    conversation: { intervalMs: 90_000, burst: 3 },
    list: { intervalMs: 2_000, burst: 3 },
    file: { intervalMs: 5_000, burst: 5 },
    minGapMs: 1_000,
    throttleCooldownMs: 30 * 60_000,
    maxThrottleCooldownMs: 2 * 3600_000,
    maxConsecutiveThrottles: 3,
    clock,
    ...overrides,
  };
}

test('allows a burst, then one request per interval', async () => {
  const { clock, now } = fakeClock();
  const scheduler = await RequestScheduler.create(config(clock));
  const start = now();
  const times: number[] = [];
  for (let i = 0; i < 6; i++) {
    await scheduler.acquire('conversation');
    times.push(now() - start);
  }
  // Burst of 3 spaced by the 1 s minimum gap, then the 90 s pace.
  const expected = [0, 1_000, 2_000, 90_000, 180_000, 270_000];
  times.forEach((t, i) => assert.ok(Math.abs(t - expected[i]) <= 2, `request ${i} at ${t}, expected ${expected[i]}`));
});

test('average rate never exceeds the configured pace over a long run', async () => {
  const { clock, now } = fakeClock();
  const scheduler = await RequestScheduler.create(config(clock, { conversation: { intervalMs: 90_000, burst: 30 } }));
  const start = now();
  for (let i = 0; i < 200; i++) await scheduler.acquire('conversation');
  const hours = (now() - start) / 3600_000;
  // 30 burst + 170 paced at 90 s ≈ 4.25 h: well under ChatGPT's ~60/hour refill.
  assert.ok(200 / hours <= 47.1, `rate was ${(200 / hours).toFixed(1)}/hour`);
});

test('the allowance is remembered between runs (no fresh burst on restart)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sched-'));
  const statePath = path.join(dir, 'rate-limit.json');
  const { clock, advance } = fakeClock();
  const first = await RequestScheduler.create(config(clock, { statePath }));
  for (let i = 0; i < 3; i++) await first.acquire('conversation');
  assert.ok(first.snapshot().tokens < 0.1);

  advance(2 * 90_000); // two intervals later, a new run starts
  const second = await RequestScheduler.create(config(clock, { statePath }));
  assert.equal(Math.floor(second.snapshot().tokens), 2);

  advance(24 * 3600_000); // after a long break the burst is back, but capped
  const third = await RequestScheduler.create(config(clock, { statePath }));
  assert.equal(third.snapshot().tokens, 3);
});

test('a 429 pauses every request kind, doubles on repeats, and gives up after the limit', async () => {
  const { clock, now } = fakeClock();
  const scheduler = await RequestScheduler.create(config(clock));

  const first = await scheduler.reportThrottle();
  assert.equal(first.pauseMs, 30 * 60_000);
  assert.equal(first.giveUp, false);

  const before = now();
  await scheduler.acquire('list');
  assert.ok(now() - before >= 30 * 60_000, 'list requests wait out the cooldown too');

  assert.equal((await scheduler.reportThrottle()).pauseMs, 60 * 60_000);
  assert.equal((await scheduler.reportThrottle()).pauseMs, 120 * 60_000);
  const fourth = await scheduler.reportThrottle();
  assert.equal(fourth.pauseMs, 120 * 60_000, 'capped');
  assert.equal(fourth.giveUp, true);

  await scheduler.reportSuccess();
  assert.equal(scheduler.snapshot().consecutiveThrottles, 0);
});

test('Retry-After longer than the cooldown is honoured', async () => {
  const { clock } = fakeClock();
  const scheduler = await RequestScheduler.create(config(clock, { throttleCooldownMs: 1_000 }));
  const decision = await scheduler.reportThrottle(45 * 60_000);
  assert.equal(decision.pauseMs, 45 * 60_000);
});

test('after a 429 the rest of the run is slower', async () => {
  const { clock, now } = fakeClock();
  const scheduler = await RequestScheduler.create(config(clock, { throttleCooldownMs: 1_000 }));
  await scheduler.reportThrottle();
  await scheduler.acquire('conversation'); // waits out the cooldown, then the emptied bucket refills
  const start = now();
  await scheduler.acquire('conversation');
  assert.ok(Math.abs(now() - start - 180_000) <= 2, 'interval doubled from 90 s to 180 s');
});

test('a cooldown persisted by one run delays the next run', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sched-'));
  const statePath = path.join(dir, 'rate-limit.json');
  const { clock, now } = fakeClock();
  const first = await RequestScheduler.create(config(clock, { statePath }));
  const { resumeAt } = await first.reportThrottle();

  const second = await RequestScheduler.create(config(clock, { statePath }));
  const waits: string[] = [];
  second.onWait = (_kind, info) => info && waits.push(info.reason);
  await second.acquire('conversation');
  assert.ok(now() >= resumeAt);
  assert.ok(waits.includes('throttle'));
});

test('waiting can be cancelled', async () => {
  const scheduler = await RequestScheduler.create(
    config(undefined as unknown as Clock, { clock: undefined, conversation: { intervalMs: 60_000, burst: 1 } })
  );
  await scheduler.acquire('conversation');
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(scheduler.acquire('conversation', controller.signal), { name: 'AbortError' });
});
