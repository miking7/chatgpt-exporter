import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ChatGPTClient, type ClientOptions } from '../src/api/client.js';
import { RequestScheduler, type SchedulerConfig } from '../src/api/scheduler.js';
import { BackupService, type BackupEvents, type BackupOptions, type BackupResult } from '../src/services/backup-service.js';
import { StorageService } from '../src/services/storage-service.js';
import { SyncStateStore } from '../src/services/sync-state.js';
import {
  fakeJwt,
  makeConversations,
  startMockServer,
  type MockOptions,
  type MockServer,
  type RequestRecord,
} from './helpers/mock-chatgpt.js';

const TOKEN = fakeJwt();
const isDetail = (r: RequestRecord) => r.path.startsWith('/backend-api/conversation/');
const isMainList = (r: RequestRecord) => r.path.startsWith('/backend-api/conversations?') && !r.path.includes('is_archived');
const detailId = (r: RequestRecord) => r.path.split('/').pop()!;

interface Harness {
  server: MockServer;
  out: string;
  statePath: string;
  run(options?: Partial<BackupOptions>, events?: BackupEvents): Promise<BackupResult>;
  cleanup(): Promise<void>;
}

async function harness(
  mock: Omit<MockOptions, 'token'>,
  pacing: Partial<SchedulerConfig> = {},
  clientOptions: Partial<ClientOptions> = {}
): Promise<Harness> {
  const server = await startMockServer({ token: TOKEN, ...mock });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'backup-'));
  const statePath = path.join(dir, 'state', 'rate-limit.json');
  const scheduler = await RequestScheduler.create({
    conversation: { intervalMs: 1, burst: 1000 },
    list: { intervalMs: 1, burst: 100 },
    file: { intervalMs: 1, burst: 100 },
    minGapMs: 0,
    throttleCooldownMs: 100,
    maxThrottleCooldownMs: 400,
    maxConsecutiveThrottles: 3,
    statePath,
    ...pacing,
  });
  const client = new ChatGPTClient(TOKEN, { scheduler, baseUrl: server.url, ...clientOptions });
  const out = path.join(dir, 'out');
  const storage = new StorageService(out);

  return {
    server,
    out,
    statePath,
    run: async (options = {}, events = {}) => {
      const sync = await SyncStateStore.load(out);
      return new BackupService(client, storage, sync, events).run({
        full: false,
        refreshList: false,
        includeArchived: true,
        retryFailed: false,
        ...options,
      });
    },
    cleanup: async () => {
      await server.close();
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

const readJson = async (file: string) => JSON.parse(await fs.readFile(file, 'utf-8'));

test('first run downloads everything newest-first and writes JSON + Markdown', async () => {
  const conversations = makeConversations(5);
  const h = await harness({ conversations });
  try {
    const result = await h.run();
    assert.equal(result.downloaded, 5);
    assert.equal(result.stopReason, undefined);
    assert.deepEqual(
      h.server.requests.filter(isDetail).map(detailId),
      [...conversations].reverse().map((c) => c.id)
    );
    for (const c of conversations) {
      const json = await readJson(path.join(h.out, 'conversations', `${c.id}.json`));
      assert.equal(json.update_time, c.updateTime);
      const md = await fs.readFile(path.join(h.out, 'conversations', `${c.id}.md`), 'utf-8');
      assert.match(md, new RegExp(`^# ${c.title}`));
      assert.match(md, /Answer about/);
    }
    assert.equal((await readJson(path.join(h.out, 'conversations', 'index.json'))).length, 5);
  } finally {
    await h.cleanup();
  }
});

test('downloads start as soon as the first page is listed, and stay newest first', async () => {
  const conversations = makeConversations(350); // 4 pages
  const h = await harness({ conversations, listDelayMs: 300 });
  try {
    const result = await h.run();
    assert.equal(result.downloaded, 350);
    const pages = h.server.requests.filter((r) => isMainList(r) && r.path.includes('limit=100'));
    const details = h.server.requests.filter(isDetail);
    assert.equal(pages.length, 4);
    const lastPage = pages[pages.length - 1].at;
    assert.ok(details[0].at < pages[1].at + 150, 'first download began right after page 1 arrived');
    assert.ok(details.filter((d) => d.at < lastPage).length >= 100, 'downloads ran while the list was still being read');
    assert.deepEqual(
      details.map(detailId),
      [...conversations].reverse().map((c) => c.id),
      'strictly newest first across pages'
    );
  } finally {
    await h.cleanup();
  }
});

test('Ctrl+C during a slow listing stops straight away', async () => {
  const controller = new AbortController();
  const h = await harness({ conversations: makeConversations(500), listDelayMs: 5_000 }, {}, { signal: controller.signal });
  try {
    setTimeout(() => controller.abort(), 200);
    const started = Date.now();
    const result = await h.run({ signal: controller.signal });
    assert.equal(result.stopReason, 'interrupted');
    assert.ok(Date.now() - started < 1_500, `took ${Date.now() - started} ms`);
  } finally {
    await h.cleanup();
  }
});

test('a capped run still finishes the listing, so index.json is complete', async () => {
  const conversations = makeConversations(250);
  const h = await harness({ conversations, listDelayMs: 50 });
  try {
    const result = await h.run({ maxDownloads: 3 });
    assert.equal(result.downloaded, 3);
    assert.equal(result.stopReason, 'max-downloads');
    assert.equal((await readJson(path.join(h.out, 'conversations', 'index.json'))).length, 250);
  } finally {
    await h.cleanup();
  }
});

test('later runs read just the top of the list and fetch only what changed', async () => {
  const conversations = makeConversations(250);
  const h = await harness({ conversations });
  try {
    await h.run();
    assert.equal(h.server.count(isMainList), 3, 'first run lists all 3 pages');

    let mark = h.server.requests.length;
    const second = await h.run();
    let since = h.server.requests.slice(mark);
    assert.equal(second.downloaded, 0);
    assert.equal(second.upToDate, 250);
    assert.equal(since.filter(isMainList).length, 1, 'stopped at the first unchanged page');
    assert.equal(since.filter(isDetail).length, 0);

    // Continue an old chat and start a new one: both move to the top of the list.
    h.server.conversations.get(conversations[10].id)!.updateTime = 1_900_000_000.5;
    h.server.conversations.set('new-chat', { id: 'new-chat', title: 'Brand new', updateTime: 1_900_000_100.25 });
    mark = h.server.requests.length;
    const third = await h.run();
    since = h.server.requests.slice(mark);
    assert.deepEqual(since.filter(isDetail).map(detailId), ['new-chat', conversations[10].id]);
    assert.equal(third.upToDate, 249);
    assert.equal(since.filter(isMainList).length, 2);
    assert.equal((await readJson(path.join(h.out, 'conversations', 'index.json'))).length, 251, 'index still lists everything');

    mark = h.server.requests.length;
    await h.run({ refreshList: true });
    assert.equal(h.server.requests.slice(mark).filter(isMainList).length, 3, '--refresh-list reads every page');
  } finally {
    await h.cleanup();
  }
});

test('--max-downloads stops early and the next run carries on, newest first', async () => {
  const conversations = makeConversations(10);
  const h = await harness({ conversations });
  try {
    const first = await h.run({ maxDownloads: 4 });
    assert.equal(first.downloaded, 4);
    assert.equal(first.remaining, 6);
    assert.equal(first.stopReason, 'max-downloads');

    const mark = h.server.requests.length;
    const second = await h.run({ maxDownloads: 4 });
    assert.equal(second.upToDate, 4);
    assert.deepEqual(
      h.server.requests.slice(mark).filter(isDetail).map(detailId),
      [conversations[5], conversations[4], conversations[3], conversations[2]].map((c) => c.id)
    );

    const third = await h.run();
    assert.equal(third.downloaded, 2);
    assert.equal(third.stopReason, undefined);
  } finally {
    await h.cleanup();
  }
});

test('pacing below the server limit means no 429s at all', async () => {
  const h = await harness(
    { conversations: makeConversations(12), bucket: { capacity: 3, refillMs: 40 } },
    { conversation: { intervalMs: 60, burst: 2 } }
  );
  try {
    const result = await h.run();
    assert.equal(result.downloaded, 12);
    assert.equal(h.server.count((r) => r.status === 429), 0);
  } finally {
    await h.cleanup();
  }
});

test('a 429 pauses everything for at least Retry-After, then the run finishes', async () => {
  const h = await harness({
    conversations: makeConversations(6),
    bucket: { capacity: 2, refillMs: 150, retryAfterSeconds: 0.3 },
  });
  try {
    const result = await h.run();
    assert.equal(result.downloaded, 6);
    const throttled = h.server.requests.filter((r) => r.status === 429);
    assert.ok(throttled.length >= 1, 'the fast client did get throttled');
    for (const hit of throttled) {
      const next = h.server.requests.find((r) => r.at > hit.at);
      assert.ok(next && next.at - hit.at >= 290, `next request ${next ? next.at - hit.at : '?'} ms after a 429`);
    }
  } finally {
    await h.cleanup();
  }
});

test('repeated 429s end the run after a few tries instead of hammering', { timeout: 10_000 }, async () => {
  const h = await harness(
    { conversations: makeConversations(5), bucket: { capacity: 0, refillMs: 1e9 } },
    { throttleCooldownMs: 20, maxThrottleCooldownMs: 80, maxConsecutiveThrottles: 2 }
  );
  try {
    const result = await h.run();
    assert.equal(result.stopReason, 'throttled');
    assert.equal(result.downloaded, 0);
    assert.equal(result.remaining, 5);
    assert.equal(h.server.count(isDetail), 3, 'three attempts in total, then stop');
    const state = await readJson(h.statePath);
    assert.ok(state.throttledUntil > Date.now(), 'cooldown remembered for the next run');
  } finally {
    await h.cleanup();
  }
});

test('an expired token stops the run cleanly when nobody can sign in', async () => {
  const h = await harness({ conversations: makeConversations(5) });
  try {
    const result = await h.run({}, {
      onDownloaded: (_entry, done) => {
        if (done === 2) h.server.setToken('rotated');
      },
    });
    assert.equal(result.stopReason, 'auth');
    assert.equal(result.downloaded, 2);
    assert.equal(result.remaining, 3);
    assert.equal(result.failed, 0, 'not counted as failures');
  } finally {
    await h.cleanup();
  }
});

test('an expired token mid-run asks for a fresh one and carries on', async () => {
  const fresh = fakeJwt({ email: 'fresh@example.com' });
  let prompts = 0;
  const h = await harness({ conversations: makeConversations(5) }, {}, {
    onAuthExpired: async () => {
      prompts += 1;
      return { accessToken: fresh };
    },
  });
  try {
    const result = await h.run({}, {
      onDownloaded: (_entry, done) => {
        if (done === 2) h.server.setToken(fresh);
      },
    });
    assert.equal(result.downloaded, 5);
    assert.equal(result.stopReason, undefined);
    assert.equal(prompts, 1);
  } finally {
    await h.cleanup();
  }
});

test('archived chats are included, and a server ignoring the filter is detected', async () => {
  const conversations = makeConversations(6).map((c, i) => ({ ...c, archived: i < 2 }));
  const h = await harness({ conversations });
  try {
    const result = await h.run();
    assert.equal(result.downloaded, 6);
    const index = await readJson(path.join(h.out, 'conversations', 'index.json'));
    assert.equal(index.filter((c: { is_archived: boolean }) => c.is_archived).length, 2);
  } finally {
    await h.cleanup();
  }

  const warnings: string[] = [];
  const ignored = await harness({ conversations, archivedSupported: false });
  try {
    const result = await ignored.run({}, { onWarning: (m) => warnings.push(m) });
    assert.equal(result.downloaded, 4);
    assert.match(warnings.join('\n'), /ignored the archived-chats filter/);
  } finally {
    await ignored.cleanup();
  }
});

test('project chats are downloaded once and copied into the project folder', async () => {
  const conversations = makeConversations(5).map((c, i) => (i < 2 ? { ...c, projectId: 'g-p1' } : c));
  const h = await harness({ conversations, projects: [{ id: 'g-p1', name: 'Log shipping / S3' }] });
  try {
    const first = await h.run();
    assert.equal(h.server.count(isDetail), 5, 'each conversation fetched once');
    assert.equal(first.downloaded, 5);
    const projectDir = path.join(h.out, 'projects', 'Log_shipping___S3', 'conversations');
    for (const c of conversations.slice(0, 2)) {
      await fs.access(path.join(projectDir, `${c.id}.json`));
      await fs.access(path.join(projectDir, `${c.id}.md`));
    }

    await fs.rm(path.join(projectDir, `${conversations[0].id}.json`));
    const mark = h.server.requests.length;
    const second = await h.run();
    assert.equal(second.copied, 1);
    assert.equal(h.server.requests.slice(mark).filter(isDetail).length, 0, 'copied from the main folder, not re-fetched');
    await fs.access(path.join(projectDir, `${conversations[0].id}.json`));
  } finally {
    await h.cleanup();
  }
});

test('a deleted conversation (404) is parked instead of retried every run', async () => {
  const conversations = makeConversations(3).map((c, i) => (i === 1 ? { ...c, gone: true } : c));
  const h = await harness({ conversations });
  try {
    const first = await h.run();
    assert.equal(first.downloaded, 2);
    assert.equal(first.failed, 1);

    const mark = h.server.requests.length;
    const second = await h.run();
    assert.equal(second.skippedFailed, 1);
    assert.equal(h.server.requests.slice(mark).filter(isDetail).length, 0);

    const third = await h.run({ retryFailed: true });
    assert.equal(third.failed, 1, '--retry-failed tries it again');
  } finally {
    await h.cleanup();
  }
});

test('an unexpected response format fails that chat at once, and a systemic change stops the run', async () => {
  const one = await harness({ conversations: makeConversations(4).map((c, i) => (i === 2 ? { ...c, malformed: true } : c)) });
  try {
    const started = Date.now();
    const result = await one.run();
    assert.equal(result.downloaded, 3);
    assert.equal(result.failed, 1);
    assert.equal(one.server.count(isDetail), 4, 'not retried like a network error');
    assert.ok(Date.now() - started < 5_000);
  } finally {
    await one.cleanup();
  }

  const all = await harness({ conversations: makeConversations(20).map((c) => ({ ...c, malformed: true })) });
  try {
    const result = await all.run();
    assert.equal(result.stopReason, 'too-many-failures');
    assert.equal(result.failed, 5);
    assert.equal(result.remaining, 15, 'stopped instead of grinding through the queue');
  } finally {
    await all.cleanup();
  }
});

test('Ctrl+C stops between requests and keeps what was saved', async () => {
  const controller = new AbortController();
  const h = await harness(
    { conversations: makeConversations(20) },
    { conversation: { intervalMs: 50, burst: 1 } },
    { signal: controller.signal }
  );
  try {
    setTimeout(() => controller.abort(), 130);
    const result = await h.run({ signal: controller.signal });
    assert.equal(result.stopReason, 'interrupted');
    assert.ok(result.downloaded >= 1 && result.downloaded < 20);
    const files = await fs.readdir(path.join(h.out, 'conversations'));
    assert.equal(files.filter((f) => f.endsWith('.md')).length, result.downloaded);
  } finally {
    await h.cleanup();
  }
});
