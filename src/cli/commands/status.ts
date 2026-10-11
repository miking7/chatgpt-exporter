import fs from 'node:fs/promises';
import path from 'node:path';
import chalk from 'chalk';
import type { ConversationItem } from '../../api/types.js';
import { getTokenInfo, pickToken, tokenExpiresAt } from '../../auth/tokens.js';
import { ENV, getSetting, isOutputDirConfigured, loadSettings, resolveOutputDir, resolveTimeZone } from '../../config/settings.js';
import { SyncStateStore } from '../../services/sync-state.js';
import { lockHolder } from '../../utils/lock.js';
import { toEpochSeconds } from '../../utils/time.js';
import {
  errorMessage,
  formatClock,
  formatCount,
  formatDateTime,
  formatDay,
  formatDuration,
  formatRelative,
  plural,
} from '../../utils/format.js';
import { CLI_NAME, rateLimitStatePath, resolvePacing, tokenCandidates } from '../runtime.js';

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf-8')) as T;
  } catch {
    return null;
  }
}

async function downloadedIds(dir: string): Promise<Set<string>> {
  try {
    const files = await fs.readdir(dir);
    return new Set(files.filter((f) => f.endsWith('.json') && f !== 'index.json').map((f) => f.slice(0, -5)));
  } catch {
    return new Set();
  }
}

const row = (label: string, value: string) => console.log(`  ${label.padEnd(12)} ${value}`);

/** Local-only summary: sign-in, coverage, backlog and pacing. Makes no network requests. */
export async function statusCommand(options: { output?: string }): Promise<number> {
  const settings = await loadSettings();
  const output = resolveOutputDir(settings, options.output);
  const pacing = resolvePacing(settings, {});
  const now = Date.now();

  console.log(chalk.bold('ChatGPT exporter status'));
  const configExists = await fs.stat(settings.configPath).then(() => true, () => false);
  row('Settings', `${settings.configPath}${configExists ? '' : chalk.dim(' (not created yet)')}`);

  const { chosen, expired } = pickToken(tokenCandidates(settings), now);
  if (chosen) {
    const info = getTokenInfo(chosen.token);
    const expiresAt = tokenExpiresAt(chosen.token);
    row(
      'Sign-in',
      `${info?.email ?? 'token saved'}` +
        (expiresAt ? ` · valid until ${formatDateTime(expiresAt)} (${formatRelative(expiresAt, now)})` : '') +
        (chosen.source === 'environment' ? chalk.dim(' · from CHATGPT_TOKEN in your shell') : '')
    );
  } else {
    const expiredAt = expired[0] ? tokenExpiresAt(expired[0].token) : null;
    row('Sign-in', chalk.yellow(`${expiredAt ? `token expired ${formatRelative(expiredAt, now)}` : 'not signed in'}; run \`${CLI_NAME} login\``));
  }
  const accountId = getSetting(settings, ENV.accountId);
  if (accountId) row('Workspace', accountId);

  row('Output', `${output}${options.output || isOutputDirConfigured(settings) ? '' : chalk.dim(' (default; the first backup asks where to keep the archive)')}`);
  try {
    const pinned = getSetting(settings, ENV.timeZone) !== undefined;
    row('Time zone', `${resolveTimeZone(settings)}${pinned ? '' : chalk.dim(" (this computer's; the next backup saves it)")}`);
  } catch (error) {
    row('Time zone', chalk.yellow(errorMessage(error)));
  }
  const conversationsDir = path.join(output, 'conversations');
  const index = await readJson<ConversationItem[]>(path.join(conversationsDir, 'index.json'));
  let missingCount = 0;
  if (!Array.isArray(index)) {
    row('Archive', 'no backup here yet');
  } else {
    const have = await downloadedIds(conversationsDir);
    const missing = index.filter((c) => !have.has(c.id));
    missingCount = missing.length;
    const archived = index.filter((c) => c.is_archived).length;
    const done = index.length - missing.length;
    const pct = index.length > 0 ? Math.floor((done / index.length) * 100) : 100;
    const listedAt = (await fs.stat(path.join(conversationsDir, 'index.json'))).mtimeMs;
    row(
      'Archive',
      `${formatCount(done)} of ${formatCount(index.length)} conversations downloaded (${pct}%)` +
        (archived > 0 ? `, incl. ${formatCount(archived)} archived` : '') +
        chalk.dim(` · as listed ${formatDateTime(listedAt)}`)
    );
    if (missing.length > 0) {
      const times = missing
        .map((c) => toEpochSeconds(c.update_time))
        .filter((t): t is number => t !== null)
        .sort((a, b) => a - b);
      const range = times.length > 0 ? ` (last updated ${formatDay(times[0] * 1000)} to ${formatDay(times[times.length - 1] * 1000)})` : '';
      row('To do', `${formatCount(missing.length)} not downloaded yet${range}`);
    }
  }

  const projectsDir = path.join(output, 'projects');
  const projectNames = await fs.readdir(projectsDir).catch(() => [] as string[]);
  let projectTotal = 0;
  let projectDone = 0;
  let projectCount = 0;
  for (const name of projectNames) {
    const dir = path.join(projectsDir, name, 'conversations');
    const projectIndex = await readJson<ConversationItem[]>(path.join(dir, 'index.json'));
    if (!Array.isArray(projectIndex)) continue;
    const have = await downloadedIds(dir);
    projectCount += 1;
    projectTotal += projectIndex.length;
    projectDone += projectIndex.filter((c) => have.has(c.id)).length;
  }
  if (projectCount > 0) row('Projects', `${plural(projectCount, 'project')}: ${formatCount(projectDone)} of ${formatCount(projectTotal)} downloaded`);

  const state = await readJson<{ conversation?: { tokens: number; updatedAt: number }; throttledUntil?: number; consecutiveThrottles?: number }>(
    rateLimitStatePath(settings)
  );
  const intervalMs = pacing.paceSeconds * 1000;
  let ready = pacing.burst;
  if (state?.conversation && Number.isFinite(state.conversation.tokens)) {
    ready = Math.min(pacing.burst, state.conversation.tokens + Math.max(0, now - state.conversation.updatedAt) / intervalMs);
  }
  row('Pace', `1 conversation every ${pacing.paceSeconds}s after a burst of up to ${pacing.burst} (${Math.floor(ready)} ready now)`);
  if (missingCount > 0) {
    row('Backlog ETA', `≈ ${formatDuration(Math.max(0, missingCount - Math.floor(ready)) * intervalMs)} of paced downloading`);
  }
  if (state?.throttledUntil && state.throttledUntil > now) {
    row('Throttle', chalk.yellow(`cooling down until ${formatClock(state.throttledUntil)} (${plural(state.consecutiveThrottles ?? 1, '429')} in a row)`));
  }

  const sync = await SyncStateStore.load(output);
  const parked = sync.parkedCount();
  if (parked > 0) row('Parked', `${plural(parked, 'conversation')} skipped after repeated failures (backup --retry-failed)`);
  if (sync.state.lastFullListingAt) row('Full listing', formatDateTime(Date.parse(sync.state.lastFullListingAt)));

  const meta = await readJson<Record<string, unknown>>(path.join(output, 'metadata.json'));
  if (meta && typeof meta.timestamp === 'string') {
    const forkFormat = typeof meta.mode === 'string';
    row(
      'Last run',
      `${formatDateTime(Date.parse(meta.timestamp))}: ${String(meta.successfulDownloads ?? 0)} downloaded, ${String(meta.failedDownloads ?? 0)} failed` +
        (meta.stopReason ? ` · stopped: ${String(meta.stopReason)}` : '') +
        (forkFormat ? '' : chalk.dim(' (written by the original tool; covers only its last project)'))
    );
  }

  const holder = await lockHolder(settings.stateDir);
  row('Running now', holder ? chalk.green(`yes (pid ${holder.pid}${holder.startedAt ? `, since ${formatDateTime(Date.parse(holder.startedAt))}` : ''})`) : 'no');
  return 0;
}
