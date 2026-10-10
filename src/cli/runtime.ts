import path from 'node:path';
import { ChatGPTClient } from '../api/client.js';
import { RequestScheduler, type SchedulerConfig } from '../api/scheduler.js';
import { interactiveLogin, type LoginMethod, type VerifyResult } from '../auth/login.js';
import {
  getTokenInfo,
  pickToken,
  tokenExpiresAt,
  type Credentials,
  type TokenCandidate,
  type TokenSource,
} from '../auth/tokens.js';
import { DEFAULT_BURST, DEFAULT_PACE_SECONDS, ENV, getSetting, loadSettings, type Settings } from '../config/settings.js';
import { isInteractive } from '../utils/prompt.js';
import { errorMessage, formatDateTime } from '../utils/format.js';

export const CLI_NAME = 'chatgpt-exporter';

export class LoginRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LoginRequiredError';
  }
}

export interface Pacing {
  paceSeconds: number;
  burst: number;
}

function numberSetting(settings: Settings, key: string): number | undefined {
  const raw = getSetting(settings, key);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${key} must be a positive number (got "${raw}")`);
  return value;
}

export function resolvePacing(settings: Settings, flags: { pace?: number; burst?: number }): Pacing {
  const paceSeconds = flags.pace ?? numberSetting(settings, ENV.pace) ?? DEFAULT_PACE_SECONDS;
  const burst = flags.burst ?? numberSetting(settings, ENV.burst) ?? DEFAULT_BURST;
  return { paceSeconds, burst: Math.max(1, Math.floor(burst)) };
}

export function rateLimitStatePath(settings: Settings): string {
  return path.join(settings.stateDir, 'rate-limit.json');
}

export function schedulerConfig(settings: Settings, pacing: Pacing): SchedulerConfig {
  return {
    conversation: { intervalMs: pacing.paceSeconds * 1000, burst: pacing.burst },
    list: { intervalMs: 2_000, burst: 3 },
    file: { intervalMs: 5_000, burst: 5 },
    minGapMs: Math.min(1_000, pacing.paceSeconds * 1000),
    throttleCooldownMs: 30 * 60_000,
    maxThrottleCooldownMs: 2 * 3600_000,
    maxConsecutiveThrottles: 3,
    statePath: rateLimitStatePath(settings),
  };
}

export function tokenCandidates(settings: Settings, flag?: string): TokenCandidate[] {
  const candidates: TokenCandidate[] = [];
  if (flag) candidates.push({ token: flag, source: 'flag' });
  const fromEnvironment = process.env[ENV.token];
  if (fromEnvironment) candidates.push({ token: fromEnvironment, source: 'environment' });
  const fromFile = settings.env[ENV.token];
  if (fromFile) candidates.push({ token: fromFile, source: 'env-file' });
  return candidates;
}

/** Checks a token with one small request; retries without the workspace header if ChatGPT rejects it. */
export async function verifyCredentials(scheduler: RequestScheduler, credentials: Credentials): Promise<VerifyResult> {
  // Don't leave someone at a prompt for a 30-minute throttle cooldown: give up checking after 45 s.
  const signal = AbortSignal.timeout(45_000);
  const probe = (creds: Credentials) =>
    new ChatGPTClient(creds.accessToken, { scheduler, accountId: creds.accountId, signal }).initialize();

  try {
    const { workspaceId } = await probe(credentials);
    return { ok: true, credentials, workspaceId };
  } catch (error) {
    if (signal.aborted) return { ok: true, credentials, unverified: true };
    if (!credentials.accountId) return { ok: false, credentials, error: errorMessage(error) };
    const withoutWorkspace = { accessToken: credentials.accessToken };
    try {
      const { workspaceId } = await probe(withoutWorkspace);
      return { ok: true, credentials: withoutWorkspace, workspaceId };
    } catch (retryError) {
      if (signal.aborted) return { ok: true, credentials, unverified: true };
      return { ok: false, credentials, error: errorMessage(retryError) };
    }
  }
}

export function runLogin(
  settings: Settings,
  scheduler: RequestScheduler,
  options: { method?: LoginMethod; reason?: string } = {}
): Promise<Credentials | null> {
  return interactiveLogin({
    settings,
    method: options.method,
    reason: options.reason,
    verify: (credentials) => verifyCredentials(scheduler, credentials),
  });
}

export interface RuntimeOptions {
  settings?: Settings;
  tokenFlag?: string;
  pace?: number;
  burst?: number;
  signal?: AbortSignal;
  log?: (message: string) => void | Promise<void>;
  /** Hides progress output while a sign-in prompt is on screen. */
  ui?: { suspend(): void; resume(): void };
}

export interface Runtime {
  settings: Settings;
  pacing: Pacing;
  scheduler: RequestScheduler;
  client: ChatGPTClient;
  tokenSource: TokenSource;
  workspaceId?: string;
  /** The credentials in use now (they change if the user signs in again mid-run). */
  credentials(): Credentials;
}

/** Loads settings, finds a usable token (asking the user to sign in if needed) and verifies it. */
export async function createRuntime(options: RuntimeOptions = {}): Promise<Runtime> {
  const settings = options.settings ?? (await loadSettings());
  const pacing = resolvePacing(settings, options);
  const scheduler = await RequestScheduler.create(schedulerConfig(settings, pacing));
  const interactive = isInteractive();

  const { chosen, expired } = pickToken(tokenCandidates(settings, options.tokenFlag));
  let tokenSource: TokenSource = chosen?.source ?? 'login';
  let current: Credentials | null = chosen
    ? { accessToken: chosen.token, accountId: getSetting(settings, ENV.accountId) }
    : null;

  const signIn = async (reason: string): Promise<Credentials | null> => {
    options.ui?.suspend();
    try {
      const fresh = await runLogin(settings, scheduler, { reason });
      if (fresh) {
        current = fresh;
        tokenSource = 'login';
      }
      return fresh;
    } finally {
      options.ui?.resume();
    }
  };

  if (!current) {
    const expiredAt = expired[0] ? tokenExpiresAt(expired[0].token) : null;
    const reason = expiredAt
      ? `Your saved ChatGPT token expired on ${formatDateTime(expiredAt)}.`
      : 'No ChatGPT token is saved yet.';
    if (!interactive) throw new LoginRequiredError(reason);
    if (!(await signIn(reason))) throw new LoginRequiredError('Sign-in was cancelled.');
  }

  const initial = current as Credentials | null;
  if (!initial) throw new LoginRequiredError('No ChatGPT token available.');
  const client = new ChatGPTClient(initial.accessToken, {
    scheduler,
    accountId: initial.accountId,
    signal: options.signal,
    log: options.log,
    onAuthExpired: interactive ? (reason) => signIn(`${reason}. Sign in again to carry on.`) : undefined,
  });

  const { workspaceId } = await client.initialize();
  return {
    settings,
    pacing,
    scheduler,
    client,
    get tokenSource() {
      return tokenSource;
    },
    workspaceId,
    credentials: () => current ?? initial,
  };
}

export function describeCredentials(credentials: Credentials): { email?: string; expiresAt: number | null } {
  return { email: getTokenInfo(credentials.accessToken)?.email, expiresAt: tokenExpiresAt(credentials.accessToken) };
}
