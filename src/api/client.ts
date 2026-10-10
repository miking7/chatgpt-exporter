import crypto from 'node:crypto';
import { ENDPOINTS, resolveBaseUrl } from './endpoints.js';
import {
  AuthenticationError,
  ConversationDetailSchema,
  ConversationsResponseSchema,
  HttpError,
  NetworkError,
  NotFoundError,
  ProjectConversationsResponseSchema,
  ProjectsSidebarResponseSchema,
  ThrottledError,
  type ConversationDetail,
  type ConversationsResponse,
  type ProjectConversationsResponse,
  type ProjectsSidebarResponse,
} from './types.js';
import type { RequestKind, RequestScheduler, ThrottleDecision } from './scheduler.js';
import type { Credentials } from '../auth/tokens.js';
import { abortError, sleep } from '../utils/time.js';
import { formatClock, formatDuration } from '../utils/format.js';

export interface ClientOptions {
  scheduler: RequestScheduler;
  accountId?: string;
  baseUrl?: string;
  /** Aborts waits and in-flight requests (Ctrl+C). */
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Receives notable events (throttling, retries) for backup.log. */
  log?: (message: string) => void | Promise<void>;
  /** Called when ChatGPT rejects the token; return fresh credentials to retry, or null to give up. */
  onAuthExpired?: (reason: string) => Promise<Credentials | null>;
}

const BROWSER_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://chatgpt.com/',
  'Origin': 'https://chatgpt.com',
  'Sec-Ch-Ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"macOS"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
};

const DEFAULT_TIMEOUT_MS = 60_000;
/** Covers a Mac sleeping or Wi-Fi dropping (~8 min in total) before a request counts as failed. */
const NETWORK_RETRY_DELAYS_MS = [5_000, 15_000, 45_000, 120_000, 300_000];
const SERVER_ERROR_RETRY_DELAYS_MS = [10_000, 30_000, 90_000];
const MAX_RELOGINS_PER_REQUEST = 2;

export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(parseFloat(trimmed) * 1000);
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/** Rate-limit-related response headers, for the log (helps tune the pacing later). */
function describeRateHeaders(headers: Headers): string {
  const parts: string[] = [];
  headers.forEach((value, name) => {
    if (/retry|ratelimit|rate-limit/i.test(name)) parts.push(`${name}=${value.slice(0, 80)}`);
  });
  return parts.length > 0 ? `; ${parts.join(', ')}` : '';
}

function looksLikeChallengePage(response: Response, body: string): boolean {
  const type = response.headers.get('content-type') ?? '';
  return type.includes('text/html') || /<html|cf-chl|just a moment/i.test(body.slice(0, 2000));
}

function looksLikeAuthFailure(body: string): boolean {
  return /token|auth|sign(ed)?[ -]?in|session|expired|unauthori[sz]ed/i.test(body.slice(0, 2000));
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause;
    const causeMessage = cause instanceof Error ? cause.message : undefined;
    return causeMessage ? `${error.message}: ${causeMessage}` : error.message;
  }
  return String(error);
}

export class ChatGPTClient {
  private accessToken: string;
  private accountId?: string;
  private readonly baseUrl: string;
  private readonly deviceId = crypto.randomUUID();
  private readonly options: ClientOptions;
  /** A sign-in prompt in progress, shared by every request that hit the expired token. */
  private relogin: Promise<Credentials | null> | null = null;

  constructor(accessToken: string, options: ClientOptions) {
    this.accessToken = accessToken;
    this.accountId = options.accountId;
    this.baseUrl = resolveBaseUrl(options.baseUrl);
    this.options = options;
  }

  get scheduler(): RequestScheduler {
    return this.options.scheduler;
  }

  setCredentials(credentials: Credentials): void {
    this.accessToken = credentials.accessToken;
    this.accountId = credentials.accountId;
  }

  /** Verifies the token with one tiny list request; returns the workspace the conversations belong to. */
  async initialize(): Promise<{ workspaceId?: string; total: number }> {
    const response = await this.listConversations(0, 1);
    return { workspaceId: response.items[0]?.workspace_id ?? undefined, total: response.total };
  }

  // Every call takes an optional signal on top of the client's own, so one part of a run
  // (e.g. the listing) can be stopped without stopping everything else.

  listConversations(offset: number, limit: number, archived = false, signal?: AbortSignal): Promise<ConversationsResponse> {
    const query = `offset=${offset}&limit=${limit}&order=updated${archived ? '&is_archived=true' : ''}`;
    return this.getJson('list', `${ENDPOINTS.CONVERSATIONS}?${query}`, (data) => ConversationsResponseSchema.parse(data), signal);
  }

  getConversation(id: string, signal?: AbortSignal): Promise<ConversationDetail> {
    return this.getJson('conversation', ENDPOINTS.CONVERSATION(id), (data) => ConversationDetailSchema.parse(data), signal);
  }

  listProjectsPage(cursor: string | null, signal?: AbortSignal): Promise<ProjectsSidebarResponse> {
    const url = cursor
      ? `${ENDPOINTS.PROJECTS_SIDEBAR}?cursor=${encodeURIComponent(cursor)}`
      : ENDPOINTS.PROJECTS_SIDEBAR;
    return this.getJson('list', url, (data) => ProjectsSidebarResponseSchema.parse(data), signal);
  }

  listProjectConversationsPage(gizmoId: string, cursor: string, signal?: AbortSignal): Promise<ProjectConversationsResponse> {
    const url = `${ENDPOINTS.PROJECT_CONVERSATIONS(gizmoId)}?cursor=${encodeURIComponent(cursor)}`;
    return this.getJson('list', url, (data) => ProjectConversationsResponseSchema.parse(data), signal);
  }

  getJson<T>(kind: RequestKind, endpoint: string, parse: (data: unknown) => T, signal?: AbortSignal): Promise<T> {
    return this.request(kind, `${this.baseUrl}${endpoint}`, true, async (response) => parse(await response.json()), signal);
  }

  /** Downloads a file body; auth headers are only sent to chatgpt.com itself. */
  fetchRaw(url: string, signal?: AbortSignal): Promise<ArrayBuffer> {
    const isAbsolute = /^https?:\/\//.test(url);
    const fullUrl = isAbsolute ? url : `${this.baseUrl}${url}`;
    const sameOrigin = !isAbsolute || fullUrl.startsWith(this.baseUrl);
    return this.request('file', fullUrl, sameOrigin, (response) => response.arrayBuffer(), signal);
  }

  private headers(sameOrigin: boolean): Record<string, string> {
    if (!sameOrigin) return {};
    const headers: Record<string, string> = {
      ...BROWSER_HEADERS,
      Authorization: `Bearer ${this.accessToken}`,
      'Oai-Device-Id': this.deviceId,
      'Oai-Language': 'en-US',
    };
    if (this.accountId) headers['ChatGPT-Account-Id'] = this.accountId;
    return headers;
  }

  /** The client's signal combined with a per-call one (either aborts the request). */
  private callSignal(extra?: AbortSignal): AbortSignal | undefined {
    const own = this.options.signal;
    if (own && extra) return AbortSignal.any([own, extra]);
    return own ?? extra;
  }

  private requestSignal(signal?: AbortSignal): AbortSignal {
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    return signal ? AbortSignal.any([signal, timeout]) : timeout;
  }

  private async note(message: string): Promise<void> {
    await this.options.log?.(message);
  }

  private async handleThrottle(
    kind: RequestKind,
    what: string,
    response: Response,
    retryAfterMs: number | undefined
  ): Promise<ThrottleDecision> {
    const decision = await this.scheduler.reportThrottle(retryAfterMs, kind);
    const detail = describeRateHeaders(response.headers);
    if (decision.giveUp) {
      await this.note(
        `${what}${detail} — ${decision.consecutive} times in a row; stopping. Safe to retry after ${formatClock(decision.resumeAt)}.`
      );
      throw new ThrottledError('ChatGPT is still throttling requests', decision.resumeAt);
    }
    await this.note(
      `${what}${detail} — pausing ${formatDuration(decision.pauseMs)} until ${formatClock(decision.resumeAt)}, then continuing at a slower pace`
    );
    return decision;
  }

  private async request<T>(
    kind: RequestKind,
    url: string,
    sameOrigin: boolean,
    read: (response: Response) => Promise<T>,
    extraSignal?: AbortSignal
  ): Promise<T> {
    let networkFailures = 0;
    let serverFailures = 0;
    let relogins = 0;
    const signal = this.callSignal(extraSignal);

    for (;;) {
      await this.scheduler.acquire(kind, signal);

      const tokenSent = this.accessToken;
      let response: Response;
      let result: T | undefined;
      try {
        response = await fetch(url, { headers: this.headers(sameOrigin), signal: this.requestSignal(signal) });
        if (response.ok) result = await read(response);
      } catch (error) {
        if (signal?.aborted) throw abortError(signal);
        if (error instanceof SyntaxError || (error as Error).name === 'ZodError') throw error;
        const delay = NETWORK_RETRY_DELAYS_MS[networkFailures];
        networkFailures += 1;
        if (delay === undefined) throw new NetworkError(`Network error: ${describeError(error)}`);
        await this.note(`Network problem (${describeError(error)}); retrying in ${formatDuration(delay)}`);
        await sleep(delay, signal);
        continue;
      }

      if (response.ok) {
        await this.scheduler.reportSuccess(kind);
        return result as T;
      }

      const status = response.status;
      if (status === 429) {
        await response.body?.cancel().catch(() => {});
        await this.handleThrottle(kind, 'Throttled by ChatGPT (HTTP 429)', response, parseRetryAfter(response.headers.get('retry-after')));
        continue;
      }

      const body = await response.text().catch(() => '');
      if (status === 403 && looksLikeChallengePage(response, body)) {
        await this.handleThrottle(kind, "Blocked by ChatGPT's bot protection (HTTP 403)", response, undefined);
        continue;
      }
      if (status === 401 || (status === 403 && looksLikeAuthFailure(body))) {
        // Another request already got a fresh token while this one was in flight: just retry.
        if (this.accessToken !== tokenSent) continue;
        if (this.options.onAuthExpired && relogins < MAX_RELOGINS_PER_REQUEST) {
          relogins += 1;
          // The listing and the downloads run side by side; both may hit the expired token, so they share one prompt.
          this.relogin ??= this.options.onAuthExpired(`ChatGPT rejected the saved token (HTTP ${status})`).finally(() => {
            this.relogin = null;
          });
          const fresh = await this.relogin;
          if (fresh) {
            this.setCredentials(fresh);
            continue;
          }
        }
        throw new AuthenticationError(`ChatGPT rejected the access token (HTTP ${status}).`);
      }
      if (status === 404) throw new NotFoundError('Not found (HTTP 404)');
      if (status >= 500) {
        const delay = SERVER_ERROR_RETRY_DELAYS_MS[serverFailures];
        serverFailures += 1;
        if (delay !== undefined) {
          await this.note(`ChatGPT server error (HTTP ${status}); retrying in ${formatDuration(delay)}`);
          await sleep(delay, signal);
          continue;
        }
      }
      const excerpt = body.trim().slice(0, 200);
      throw new HttpError(`Request failed: HTTP ${status} ${response.statusText}${excerpt ? ` — ${excerpt}` : ''}`, status);
    }
  }
}
