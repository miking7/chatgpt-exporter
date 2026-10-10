import { Command, InvalidArgumentError, Option } from 'commander';
import { DEFAULT_BURST, DEFAULT_PACE_SECONDS } from '../config/settings.js';
import { backupCommand } from './commands/backup.js';
import { convertCommand } from './commands/convert.js';
import { listCommand } from './commands/list.js';
import { loginCommand, logoutCommand } from './commands/login.js';
import { projectsCommand } from './commands/projects.js';
import { statusCommand } from './commands/status.js';
import { CLI_NAME } from './runtime.js';

export const VERSION = '2.0.0-fork.3';

function positiveNumber(flag: string) {
  return (value: string): number => {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) throw new InvalidArgumentError(`${flag} must be a positive number.`);
    return n;
  };
}

function positiveInteger(flag: string) {
  return (value: string): number => {
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0) throw new InvalidArgumentError(`${flag} must be a whole number above 0.`);
    return n;
  };
}

/** YYYY-MM-DD (local midnight) or anything Date can parse; returns epoch seconds. */
export function parseSince(value: string): number {
  const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const date = ymd ? new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3])) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new InvalidArgumentError('use a date like 2025-01-31.');
  return date.getTime() / 1000;
}

export function createCli(): Command {
  const program = new Command();

  program
    .name(CLI_NAME)
    .description('Back up your ChatGPT conversations, paced so your own ChatGPT use is never throttled')
    .version(VERSION)
    .showHelpAfterError();

  program
    .command('backup')
    .description('Download new and changed conversations, then keep filling in older ones')
    .option('-o, --output <dir>', 'output folder (default: CHATGPT_EXPORT_DIR from .env, else ./chatgpt-export)')
    .option(
      '--pace <seconds>',
      `average seconds between conversation downloads (default ${DEFAULT_PACE_SECONDS}, or CHATGPT_PACE_SECONDS)`,
      positiveNumber('--pace')
    )
    .option(
      '--burst <n>',
      `downloads allowed back-to-back after a quiet period (default ${DEFAULT_BURST}, or CHATGPT_BURST)`,
      positiveInteger('--burst')
    )
    .option('--max-downloads <n>', 'stop after downloading this many conversations', positiveInteger('--max-downloads'))
    .option('--since <date>', 'only download conversations updated on or after this date (YYYY-MM-DD)', parseSince)
    .option('--full', 're-download every conversation, even unchanged ones', false)
    .option('--refresh-list', 'read the whole conversation list instead of stopping at the first unchanged page', false)
    .option('--no-archived', 'skip archived chats')
    .option('--retry-failed', 'retry conversations that failed in several earlier runs', false)
    .option('--download-files', 'also download file attachments and images', false)
    .option('--project <name-or-id>', 'only back up one project')
    .option('--no-keep-awake', "let the Mac sleep during the run (it's kept awake with caffeinate by default)")
    .option('-t, --token <token>', 'use this access token instead of the saved one')
    .option('-v, --verbose', 'also print throttling and retry details', false)
    .addOption(new Option('--incremental', 'no effect: incremental is now the default').hideHelp())
    .action(async (opts) => {
      process.exitCode = await backupCommand({
        token: opts.token,
        output: opts.output,
        full: opts.full,
        refreshList: opts.refreshList,
        archived: opts.archived,
        since: opts.since,
        maxDownloads: opts.maxDownloads,
        pace: opts.pace,
        burst: opts.burst,
        retryFailed: opts.retryFailed,
        downloadFiles: opts.downloadFiles,
        project: opts.project,
        keepAwake: opts.keepAwake,
        verbose: opts.verbose,
      });
    });

  program
    .command('login')
    .description('Save a fresh ChatGPT access token to .env (copied from your browser)')
    .option('--console', 'use a one-line browser-console script instead of the session page', false)
    .action(async (opts) => {
      process.exitCode = await loginCommand({ console: opts.console });
    });

  program
    .command('logout')
    .description('Remove the saved access token from .env')
    .action(async () => {
      process.exitCode = await logoutCommand();
    });

  program
    .command('status')
    .description('Show sign-in, how much is backed up, and the backlog (no network requests)')
    .option('-o, --output <dir>', 'output folder (default: CHATGPT_EXPORT_DIR from .env, else ./chatgpt-export)')
    .action(async (opts) => {
      process.exitCode = await statusCommand({ output: opts.output });
    });

  program
    .command('list')
    .description('List conversations without downloading')
    .option('--archived', 'list archived chats instead', false)
    .option('--project <name-or-id>', 'list conversations from a specific project')
    .option('--json', 'output as JSON', false)
    .option('-t, --token <token>', 'use this access token instead of the saved one')
    .option('-v, --verbose', 'verbose errors', false)
    .action(async (opts) => {
      process.exitCode = await listCommand({
        token: opts.token,
        verbose: opts.verbose,
        json: opts.json,
        archived: opts.archived,
        project: opts.project,
      });
    });

  program
    .command('projects')
    .description('List all projects')
    .option('--json', 'output as JSON', false)
    .option('-t, --token <token>', 'use this access token instead of the saved one')
    .option('-v, --verbose', 'verbose errors', false)
    .action(async (opts) => {
      process.exitCode = await projectsCommand({ token: opts.token, verbose: opts.verbose, json: opts.json });
    });

  program
    .command('convert')
    .description('Regenerate every Markdown file from the saved JSON (no network requests)')
    .option('-o, --output <dir>', 'output folder (default: CHATGPT_EXPORT_DIR from .env, else ./chatgpt-export)')
    .action(async (opts) => {
      process.exitCode = await convertCommand({ output: opts.output });
    });

  return program;
}
