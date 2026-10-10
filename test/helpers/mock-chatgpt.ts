import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockConversation {
  id: string;
  title: string;
  /** Epoch seconds. */
  updateTime: number;
  archived?: boolean;
  projectId?: string;
  /** Listed, but the detail endpoint returns 404 (deleted in between). */
  gone?: boolean;
  /** The detail response is missing `mapping` (as if ChatGPT changed its format). */
  malformed?: boolean;
}

export interface MockOptions {
  token: string;
  conversations: MockConversation[];
  projects?: Array<{ id: string; name: string }>;
  /** Server-side limiter on /backend-api/conversation/:id, like ChatGPT's (~200 burst, ~1/min refill). */
  bucket?: { capacity: number; refillMs: number; retryAfterSeconds?: number };
  /** When false, ?is_archived=true is ignored (returns normal chats), like an API change would. */
  archivedSupported?: boolean;
  /** Project chats also appear in the main list (true on the account this was built for). */
  projectChatsInMainList?: boolean;
  /** Response delay for list pages (ChatGPT takes ~5 s per page of 100). */
  listDelayMs?: number;
  workspaceId?: string;
}

export interface RequestRecord {
  at: number;
  path: string;
  status: number;
}

export interface MockServer {
  url: string;
  requests: RequestRecord[];
  conversations: Map<string, MockConversation>;
  setToken(token: string): void;
  count(predicate: (r: RequestRecord) => boolean): number;
  close(): Promise<void>;
}

const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

function detailFor(c: MockConversation) {
  return {
    title: c.title,
    create_time: c.updateTime - 60,
    update_time: c.updateTime,
    conversation_id: c.id,
    current_node: 'a1',
    mapping: {
      root: { id: 'root', message: null, parent: null, children: ['u1'] },
      u1: {
        id: 'u1',
        parent: 'root',
        children: ['a1'],
        message: { id: 'u1', author: { role: 'user' }, content: { content_type: 'text', parts: [`Question about ${c.title}`] } },
      },
      a1: {
        id: 'a1',
        parent: 'u1',
        children: [],
        message: { id: 'a1', author: { role: 'assistant' }, content: { content_type: 'text', parts: [`Answer about ${c.title}`] } },
      },
    },
  };
}

export async function startMockServer(options: MockOptions): Promise<MockServer> {
  let token = options.token;
  const conversations = new Map(options.conversations.map((c) => [c.id, { ...c }]));
  const requests: RequestRecord[] = [];
  const bucket = options.bucket;
  let tokens = bucket?.capacity ?? 0;
  let refilledAt = Date.now();
  const workspaceId = options.workspaceId ?? '11111111-2222-4333-8444-555555555555';

  const listItem = (c: MockConversation) => ({
    id: c.id,
    title: c.title,
    create_time: iso(c.updateTime - 60),
    update_time: iso(c.updateTime),
    is_archived: Boolean(c.archived),
    workspace_id: workspaceId,
  });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    // When the request arrived (what pacing controls), even if the answer is delayed.
    const arrivedAt = Date.now();
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      requests.push({ at: arrivedAt, path: url.pathname + url.search, status });
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };

    if (req.headers.authorization !== `Bearer ${token}`) {
      send(401, { detail: 'Could not parse your authentication token. Please try signing in again.' });
      return;
    }

    if (url.pathname === '/backend-api/conversations') {
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const limit = Number(url.searchParams.get('limit') ?? 28);
      const wantArchived = url.searchParams.get('is_archived') === 'true' && options.archivedSupported !== false;
      const all = [...conversations.values()]
        .filter((c) => Boolean(c.archived) === wantArchived && (!c.projectId || options.projectChatsInMainList !== false))
        .sort((a, b) => b.updateTime - a.updateTime);
      const body = { items: all.slice(offset, offset + limit).map(listItem), total: all.length, limit, offset };
      // A 1-item probe (sign-in check) answers quickly; real pages are slow, like ChatGPT's.
      setTimeout(() => send(200, body), limit > 1 ? (options.listDelayMs ?? 0) : 0);
      return;
    }

    const detail = /^\/backend-api\/conversation\/([^/]+)$/.exec(url.pathname);
    if (detail) {
      if (bucket) {
        const now = Date.now();
        tokens = Math.min(bucket.capacity, tokens + (now - refilledAt) / bucket.refillMs);
        refilledAt = now;
        if (tokens < 1) {
          send(429, { detail: 'Too many requests' }, bucket.retryAfterSeconds ? { 'retry-after': String(bucket.retryAfterSeconds) } : {});
          return;
        }
        tokens -= 1;
      }
      const c = conversations.get(detail[1]);
      if (!c || c.gone) send(404, { detail: 'Conversation not found' });
      else if (c.malformed) send(200, { title: c.title, update_time: c.updateTime });
      else send(200, detailFor(c));
      return;
    }

    if (url.pathname === '/backend-api/gizmos/snorlax/sidebar') {
      send(200, { items: (options.projects ?? []).map((p) => ({ gizmo: { id: p.id, display: { name: p.name } } })), cursor: null });
      return;
    }

    const project = /^\/backend-api\/gizmos\/([^/]+)\/conversations$/.exec(url.pathname);
    if (project) {
      const items = [...conversations.values()]
        .filter((c) => c.projectId === project[1])
        .sort((a, b) => b.updateTime - a.updateTime)
        .map(listItem);
      send(200, { items, cursor: null });
      return;
    }

    send(404, { detail: 'unknown endpoint' });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    conversations,
    setToken: (next) => {
      token = next;
    },
    count: (predicate) => requests.filter(predicate).length,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** A structurally valid (unsigned) JWT like ChatGPT's access tokens. */
export function fakeJwt(claims: { expiresInSeconds?: number; email?: string; accountId?: string } = {}): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const payload = {
    exp: Math.floor(Date.now() / 1000) + (claims.expiresInSeconds ?? 3600),
    'https://api.openai.com/profile': { email: claims.email ?? 'someone@example.com' },
    'https://api.openai.com/auth': { chatgpt_account_id: claims.accountId, chatgpt_plan_type: 'team' },
  };
  return `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode(payload)}.signature`;
}

export function makeConversations(count: number, startSeconds = 1_750_000_000): MockConversation[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    title: `Conversation ${i}`,
    updateTime: startSeconds + i * 3600 + 0.123,
  }));
}
