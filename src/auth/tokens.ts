export interface Credentials {
  accessToken: string;
  /** Team/Business workspace id, sent as the ChatGPT-Account-Id header. */
  accountId?: string;
}

export interface TokenInfo {
  /** Expiry, epoch seconds. */
  exp?: number;
  email?: string;
  /** chatgpt_account_id claim (the workspace the token was issued for). */
  accountId?: string;
  planType?: string;
}

export type TokenSource = 'flag' | 'environment' | 'env-file' | 'login';

export interface TokenCandidate {
  token: string;
  source: TokenSource;
}

const JWT_RE = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Treat tokens this close to expiry as expired, so a run doesn't start on one about to die. */
const EXPIRY_SKEW_MS = 60_000;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
    return payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function getTokenInfo(token: string): TokenInfo | null {
  const payload = decodeJwtPayload(token);
  if (!payload) return null;
  const auth = (payload['https://api.openai.com/auth'] ?? {}) as Record<string, unknown>;
  const profile = (payload['https://api.openai.com/profile'] ?? {}) as Record<string, unknown>;
  return {
    exp: typeof payload.exp === 'number' ? payload.exp : undefined,
    email: typeof profile.email === 'string' ? profile.email : undefined,
    accountId: isUuid(auth.chatgpt_account_id) ? auth.chatgpt_account_id : undefined,
    planType: typeof auth.chatgpt_plan_type === 'string' ? auth.chatgpt_plan_type : undefined,
  };
}

/** Expiry in epoch ms, or null when the token doesn't say. */
export function tokenExpiresAt(token: string): number | null {
  const exp = getTokenInfo(token)?.exp;
  return exp === undefined ? null : exp * 1000;
}

export function isTokenExpired(token: string, now = Date.now()): boolean {
  const expiresAt = tokenExpiresAt(token);
  return expiresAt !== null && expiresAt - EXPIRY_SKEW_MS <= now;
}

/** First candidate that hasn't expired, plus the ones skipped because they had. */
export function pickToken(
  candidates: TokenCandidate[],
  now = Date.now()
): { chosen?: TokenCandidate; expired: TokenCandidate[] } {
  const expired: TokenCandidate[] = [];
  for (const candidate of candidates) {
    if (!JWT_RE.test(candidate.token)) continue;
    if (isTokenExpired(candidate.token, now)) {
      expired.push(candidate);
      continue;
    }
    return { chosen: candidate, expired };
  }
  return { expired };
}

/**
 * Pulls credentials out of whatever was copied: the console snippet's JSON, the whole
 * chatgpt.com/api/auth/session page (Chrome prefixes it with "Pretty-print"), "Bearer …", or a bare token.
 */
export function parseCredentialsText(text: string): Credentials | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const parsed: unknown = JSON.parse(trimmed.slice(start, end + 1));
      if (parsed && typeof parsed === 'object') {
        const obj = parsed as Record<string, unknown>;
        const token = typeof obj.accessToken === 'string' ? JWT_RE.exec(obj.accessToken)?.[0] : undefined;
        if (token) {
          return { accessToken: token, accountId: isUuid(obj.accountId) ? obj.accountId : undefined };
        }
      }
    } catch {
      // Not clean JSON; fall back to pattern matching below.
    }
  }

  const keyed = /"accessToken"\s*:\s*"([^"]+)"/.exec(trimmed)?.[1];
  const token = (keyed && JWT_RE.exec(keyed)?.[0]) ?? JWT_RE.exec(trimmed)?.[0];
  return token ? { accessToken: token } : null;
}
