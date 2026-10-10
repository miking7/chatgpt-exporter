import fs from 'node:fs/promises';
import path from 'node:path';
import { tokenExpiresAt } from '../auth/tokens.js';
import type { Settings } from '../config/settings.js';
import { formatDateTime, formatRelative } from '../utils/format.js';
import { notify } from '../utils/system.js';

/** Start warning when the token has this long left (ChatGPT tokens last about 10 days). */
export const EXPIRY_WARNING_MS = 2 * 24 * 3600_000;
const REPEAT_MS = 24 * 3600_000;

export type Notifier = (title: string, message: string) => void;

interface Stamp {
  notifiedAt: number;
  /** What the reminder was about; a different value is a new situation and notifies at once. */
  about: string;
}

/**
 * Shows a macOS notification for an ongoing situation at most once a day (unattended runs repeat
 * every few hours, and one reminder a day is enough). A change in `about` resets the clock.
 */
export async function remindOncePerDay(
  stateDir: string,
  key: string,
  message: string,
  about = '',
  send: Notifier = notify
): Promise<boolean> {
  const stampPath = path.join(stateDir, `reminder-${key}.json`);
  let stamp: Partial<Stamp> = {};
  try {
    stamp = JSON.parse(await fs.readFile(stampPath, 'utf-8')) as Partial<Stamp>;
  } catch {
    // Never reminded before.
  }
  const due = stamp.about !== about || Date.now() - (stamp.notifiedAt ?? 0) >= REPEAT_MS;
  if (!due) return false;
  send('ChatGPT exporter', message);
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(stampPath, JSON.stringify({ notifiedAt: Date.now(), about } satisfies Stamp));
  return true;
}

/**
 * For unattended runs: while the token has under two days left, notifies once a day (per token),
 * so the user can sign in again before scheduled backups stop. Returns the warning text whenever
 * the token is close to expiry, notified or not.
 */
export async function warnIfTokenExpiringSoon(
  settings: Settings,
  accessToken: string,
  send: Notifier = notify
): Promise<string | null> {
  const expiresAt = tokenExpiresAt(accessToken);
  if (expiresAt === null || expiresAt - Date.now() > EXPIRY_WARNING_MS) return null;
  const message = `Your ChatGPT sign-in expires ${formatRelative(expiresAt)} (${formatDateTime(expiresAt)}). Run \`chatgpt-exporter login\` to keep backups going.`;
  await remindOncePerDay(settings.stateDir, 'token-expiry', message, String(expiresAt), send);
  return message;
}
