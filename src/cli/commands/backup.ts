import fs from 'node:fs/promises';
import path from 'node:path';
import chalk from 'chalk';
import type { ChatGPTClient } from '../../api/client.js';
import { BackupService, type BackupPlan, type BackupResult, type StopReason } from '../../services/backup-service.js';
import { downloadFiles, scanAllConversations } from '../../services/file-service.js';
import {
  MARKDOWN_FORMAT,
  StorageService,
  convertArchive,
  readMetadata,
  removeStaleTempFiles,
  updateMetadata,
} from '../../services/storage-service.js';
import { SyncStateStore } from '../../services/sync-state.js';
import { ensureTimeZone, loadSettings } from '../../config/settings.js';
import { chooseOutputDir } from '../output-dir.js';
import { acquireLock, type Lock } from '../../utils/lock.js';
import { keepAwake } from '../../utils/system.js';
import { formatCount, formatDateTime, formatDuration, formatRelative, plural } from '../../utils/format.js';
import { warnIfTokenExpiringSoon } from '../reminders.js';
import { createReporter, type Reporter } from '../reporter.js';
import { createRuntime, describeCredentials, type Runtime } from '../runtime.js';
import { EXIT, handleCommandError, loginHint, notifyIfUnattended } from '../errors.js';

export interface BackupCommandOptions {
  token?: string;
  output?: string;
  full: boolean;
  refreshList: boolean;
  archived: boolean;
  since?: number;
  maxDownloads?: number;
  pace?: number;
  burst?: number;
  retryFailed: boolean;
  downloadFiles: boolean;
  project?: string;
  keepAwake: boolean;
  verbose: boolean;
}

const STOP_MESSAGES: Record<StopReason, string> = {
  'max-downloads': 'reached --max-downloads',
  throttled: 'ChatGPT kept asking us to slow down',
  auth: 'the ChatGPT token stopped working',
  interrupted: 'stopped by Ctrl+C',
  'too-many-failures': 'several conversations failed in a row',
};

function exitCodeFor(reason?: StopReason): number {
  switch (reason) {
    case 'throttled':
      return EXIT.throttled;
    case 'auth':
      return EXIT.needsLogin;
    case 'interrupted':
      return EXIT.interrupted;
    case 'too-many-failures':
      return EXIT.error;
    default:
      return EXIT.ok;
  }
}

function describePlan(plan: BackupPlan): string {
  const main = plan.sources.find((s) => s.label === 'Conversations');
  const projects = plan.sources.filter((s) => s !== main);
  const parts = [
    `${formatCount(plan.unique)} conversations listed${projects.length > 0 ? ` (incl. ${plural(projects.length, 'project')})` : ''}`,
    `${formatCount(plan.upToDate)} up to date`,
  ];
  if (plan.copied > 0) parts.push(`${formatCount(plan.copied)} copied between folders`);
  if (plan.skippedFailed > 0) parts.push(`${formatCount(plan.skippedFailed)} skipped after repeated failures`);
  if (plan.skippedSince > 0) parts.push(`${formatCount(plan.skippedSince)} older than --since`);
  parts.push(plan.toDownload > 0 ? chalk.bold(`${formatCount(plan.toDownload)} to download`) : 'nothing new to download');
  return parts.join(' · ');
}

function printSettings(runtime: Runtime, output: string, timeZone: string, options: BackupCommandOptions): void {
  const { paceSeconds, burst } = runtime.pacing;
  const perHour = Math.round(3600 / paceSeconds);
  console.log(chalk.dim(`  Output:  ${output} · dates in ${timeZone}`));
  console.log(
    chalk.dim(
      `  Mode:    ${options.full ? 'full (re-download everything)' : 'incremental (new and changed chats, then older gaps)'}` +
        `${options.archived ? ' · archived chats included' : ''}${options.project ? ` · project "${options.project}" only` : ''}`
    )
  );
  console.log(
    chalk.dim(
      `  Pace:    1 conversation every ${paceSeconds}s (≈ ${perHour}/hour) after a burst of up to ${burst}` +
        `${options.maxDownloads ? ` · stop after ${options.maxDownloads}` : ''}`
    )
  );
  if (paceSeconds < 60) {
    console.log(chalk.yellow('  Note: faster than ChatGPT refills (~1/minute), so this may slow down your own ChatGPT use.'));
  }
  console.log();
}

function printSummary(result: BackupResult, runtime: Runtime, output: string): void {
  const finished = !result.stopReason;
  const heading = finished ? chalk.green('\n✔ Backup finished') : chalk.yellow('\n⏸ Backup paused');
  console.log(heading);
  console.log(`  Downloaded   ${formatCount(result.downloaded)}`);
  console.log(`  Up to date   ${formatCount(result.upToDate)}`);
  if (result.copied > 0) console.log(`  Copied       ${formatCount(result.copied)} (already downloaded in another folder)`);
  if (result.failed > 0) console.log(`  Failed       ${chalk.red(formatCount(result.failed))} (details in backup.log; retried next run)`);
  if (result.skippedFailed > 0) {
    console.log(`  Parked       ${formatCount(result.skippedFailed)} that failed in several runs (use --retry-failed)`);
  }
  if (result.remaining > 0) {
    const eta = formatDuration(runtime.scheduler.estimateMs(result.remaining));
    console.log(`  Still to do  ${chalk.bold(formatCount(result.remaining))} · ≈ ${eta} at this pace; run backup again to continue`);
  }
  if (result.stopReason) {
    console.log(`  Stopped      ${STOP_MESSAGES[result.stopReason]}${result.stopDetail && result.stopReason !== 'interrupted' ? chalk.dim(` (${result.stopDetail})`) : ''}`);
  }
  if (result.workspaceIds.length > 1) {
    console.log(chalk.yellow(`  Note: conversations came from ${result.workspaceIds.length} workspaces: ${result.workspaceIds.join(', ')}`));
  }
  console.log(`  Output       ${chalk.cyan(output)}`);
  if (result.stopReason === 'auth') console.log(`\n${loginHint()}`);
}

function summaryLine(result: BackupResult): string {
  return (
    `Backup ${result.stopReason ? 'paused' : 'finished'}: ${result.downloaded} downloaded, ${result.upToDate} up to date, ` +
    `${result.copied} copied, ${result.failed} failed, ${result.remaining} remaining` +
    (result.stopReason ? ` (stopped: ${STOP_MESSAGES[result.stopReason]})` : '')
  );
}

/**
 * Regenerates the Markdown from the saved JSON once after an update changes its format, or when the time zone
 * changes. Local only, and only files whose content changed are rewritten.
 */
async function upgradeMarkdown(output: string, timeZone: string, storage: StorageService, reporter: Reporter, signal: AbortSignal): Promise<void> {
  const metadata = await readMetadata(output);
  if (metadata.markdownFormat === MARKDOWN_FORMAT && metadata.markdownTimeZone === timeZone) return;
  const result = await convertArchive(output, {
    timeZone,
    signal,
    onProgress: (done, total) => reporter.spin(`Updating the Markdown files: ${formatCount(done)}/${formatCount(total)}`),
  });
  if (result.converted + result.unchanged + result.errors > 0) {
    const summary =
      `Markdown files updated: ${formatCount(result.converted)} rewritten, ${formatCount(result.unchanged)} already current` +
      (result.errors > 0 ? `, ${formatCount(result.errors)} unreadable` : '');
    reporter.spinDone(summary);
    await storage.appendLog(summary);
  }
  await updateMetadata(output, { markdownFormat: MARKDOWN_FORMAT, markdownTimeZone: timeZone });
}

async function loadFailedFiles(output: string): Promise<Set<string>> {
  try {
    const metadata = JSON.parse(await fs.readFile(path.join(output, 'metadata.json'), 'utf-8')) as { failedFiles?: unknown };
    if (Array.isArray(metadata.failedFiles)) return new Set(metadata.failedFiles as string[]);
  } catch {
    // No metadata yet
  }
  return new Set();
}

async function runFileDownloads(
  client: ChatGPTClient,
  output: string,
  reporter: Reporter,
  options: { verbose: boolean; signal: AbortSignal }
): Promise<void> {
  reporter.spin('Scanning conversations for file references…');
  const refs = await scanAllConversations(output);
  const skipFileIds = await loadFailedFiles(output);
  const known = refs.filter((r) => skipFileIds.has(r.fileId)).length;
  reporter.spinDone(`Found ${plural(refs.length, 'file reference')}${known > 0 ? ` (${known} previously failed, skipped)` : ''}`);
  if (refs.length - known === 0) return;

  const errors = new Map<string, number>();
  let failedIds: string[] = [];
  try {
    const result = await downloadFiles(client, refs, output, {
      verbose: options.verbose,
      skipFileIds,
      signal: options.signal,
      onProgress: (completed, total) => reporter.spin(`Files: ${formatCount(completed)}/${formatCount(total)}`),
      onError: (_fileId, error) => errors.set(error.message, (errors.get(error.message) ?? 0) + 1),
    });
    failedIds = result.failedFileIds;
    reporter.spinDone(`Files: ${result.downloaded} downloaded, ${result.skipped} already present, ${result.failed} failed`);
  } finally {
    await updateMetadata(output, { failedFiles: [...skipFileIds, ...failedIds] });
  }
  for (const [message, count] of errors) reporter.warn(`${plural(count, 'file')}: ${message}`);
}

export async function backupCommand(options: BackupCommandOptions): Promise<number> {
  const reporter = createReporter();
  const controller = new AbortController();
  let interrupts = 0;
  let firstInterruptAt = 0;
  const onSigint = () => {
    const now = Date.now();
    if (interrupts === 0) {
      interrupts += 1;
      firstInterruptAt = now;
      reporter.warn('Stopping after the current step… (Ctrl+C again to quit immediately)');
      controller.abort();
      return;
    }
    // `npm run` forwards the terminal's Ctrl+C, so a single press can arrive twice in quick succession.
    if (now - firstInterruptAt < 1500) return;
    reporter.finish();
    process.exit(EXIT.interrupted);
  };
  process.on('SIGINT', onSigint);

  let lock: Lock | undefined;
  const stopKeepingAwake = options.keepAwake ? keepAwake() : () => {};

  try {
    const settings = await loadSettings();
    const output = await chooseOutputDir(settings, options.output);
    const timeZone = await ensureTimeZone(settings);
    lock = await acquireLock(settings.stateDir);

    const storage = new StorageService(output, { timeZone });
    await storage.initialize();
    await removeStaleTempFiles(output);
    const log = async (message: string) => {
      await storage.appendLog(message);
      if (options.verbose) reporter.info(chalk.dim(message));
    };
    // Before signing in: it's local, so it happens even when the token has expired.
    await upgradeMarkdown(output, timeZone, storage, reporter, controller.signal);

    reporter.spin('Checking your ChatGPT sign-in…');
    const runtime = await createRuntime({
      settings,
      tokenFlag: options.token,
      pace: options.pace,
      burst: options.burst,
      signal: controller.signal,
      log,
      ui: reporter,
    });
    const { email, expiresAt } = describeCredentials(runtime.credentials());
    reporter.spinDone(
      `Signed in${email ? ` as ${email}` : ''}${runtime.workspaceId ? ` · workspace ${runtime.workspaceId}` : ''}` +
        (expiresAt ? chalk.dim(` · token valid until ${formatDateTime(expiresAt)} (${formatRelative(expiresAt)})`) : '')
    );
    if (runtime.tokenSource === 'environment') {
      reporter.info(chalk.dim('  Using CHATGPT_TOKEN from your shell environment (it takes priority over config.env).'));
    }
    if (!reporter.interactive) {
      // Scheduled runs can't ask for a sign-in, so give notice while there's still time.
      const warning = await warnIfTokenExpiringSoon(settings, runtime.credentials().accessToken);
      if (warning) {
        reporter.warn(warning);
        await storage.appendLog(`Warning: ${warning}`);
      }
    }
    printSettings(runtime, output, timeZone, options);

    runtime.scheduler.onWait = (kind, info) => reporter.waiting(kind, info);
    const sync = await SyncStateStore.load(output);
    const capped = (queued: number) => Math.min(queued, options.maxDownloads ?? Number.POSITIVE_INFINITY);
    let downloadsShown = false;
    const service = new BackupService(runtime.client, storage, sync, {
      onListing: (label, fetched, total) => reporter.listing(label, fetched, total),
      onQueued: (queued) => {
        // Downloads start while the list is still being read; the total grows as pages arrive.
        if (downloadsShown) {
          reporter.setTotal(capped(queued));
        } else if (queued > 0) {
          downloadsShown = true;
          reporter.startDownloads(capped(queued), (remaining) => runtime.scheduler.estimateMs(remaining));
        }
      },
      onListingDone: (plan) => reporter.listingDone(describePlan(plan)),
      onWarning: (message) => reporter.warn(message),
      onDownloaded: (entry, done) => reporter.downloadDone(entry.title, done),
      onFailed: (entry, error, done) => reporter.downloadFailed(entry.title, error.message, done),
    });

    const { paceSeconds, burst } = runtime.pacing;
    await storage.appendLog(
      `Starting backup (${options.full ? 'full' : 'incremental'}; pace ${paceSeconds}s, burst ${burst}` +
        `${options.maxDownloads ? `, max ${options.maxDownloads}` : ''}${options.project ? `, project ${options.project}` : ''})`
    );
    reporter.spin('Listing conversations…');
    const result = await service.run({
      full: options.full,
      refreshList: options.refreshList,
      includeArchived: options.archived,
      project: options.project,
      since: options.since,
      retryFailed: options.retryFailed,
      maxDownloads: options.maxDownloads,
      signal: controller.signal,
    });
    reporter.finish();

    if (options.downloadFiles && (!result.stopReason || result.stopReason === 'max-downloads')) {
      try {
        await runFileDownloads(runtime.client, output, reporter, { verbose: options.verbose, signal: controller.signal });
      } catch (error) {
        reporter.finish();
        reporter.warn(`File downloads stopped: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // Links to files downloaded after their conversation was saved.
    if (options.downloadFiles) await convertArchive(output, { timeZone });

    await updateMetadata(output, {
      timestamp: new Date().toISOString(),
      mode: options.full ? 'full' : 'incremental',
      pace: paceSeconds,
      burst,
      totalConversations: result.unique,
      sources: result.sources,
      upToDate: result.upToDate,
      copied: result.copied,
      successfulDownloads: result.downloaded,
      failedDownloads: result.failed,
      remaining: result.remaining,
      skippedFailed: result.skippedFailed,
      skippedSince: result.skippedSince,
      stopReason: result.stopReason ?? null,
      workspaceIds: result.workspaceIds,
      errors: result.errors.slice(0, 200),
    });
    await storage.appendLog(summaryLine(result));
    printSummary(result, runtime, output);
    if (result.stopReason === 'auth') notifyIfUnattended('Backup paused: sign in again with `chatgpt-exporter login`.');
    return exitCodeFor(result.stopReason);
  } catch (error) {
    reporter.finish();
    return handleCommandError(error, options.verbose);
  } finally {
    process.removeListener('SIGINT', onSigint);
    stopKeepingAwake();
    await lock?.release();
  }
}
