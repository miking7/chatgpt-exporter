import chalk from 'chalk';
import { AuthenticationError, ThrottledError } from '../api/types.js';
import { AlreadyRunningError } from '../utils/lock.js';
import { isAbortError } from '../utils/time.js';
import { formatClock } from '../utils/format.js';
import { isInteractive } from '../utils/prompt.js';
import { notify } from '../utils/system.js';
import { CLI_NAME, LoginRequiredError } from './runtime.js';

export const EXIT = {
  ok: 0,
  error: 1,
  needsLogin: 2,
  throttled: 3,
  interrupted: 130,
} as const;

export function loginHint(): string {
  return `Run ${chalk.cyan(`${CLI_NAME} login`)} (or ${chalk.cyan('npm run login')} in the exporter folder), then run the backup again; it carries on where it stopped.`;
}

/** Tells an unattended (scheduled) run's owner that they need to act. */
export function notifyIfUnattended(message: string): void {
  if (!isInteractive()) notify('ChatGPT exporter', message);
}

export function handleCommandError(error: unknown, verbose = false): number {
  if (error instanceof LoginRequiredError || error instanceof AuthenticationError) {
    console.error(chalk.red(`\n${error.message}`));
    console.error(loginHint());
    notifyIfUnattended('Sign-in needed: run `chatgpt-exporter login`.');
    return EXIT.needsLogin;
  }
  if (error instanceof ThrottledError) {
    const when = error.resumeAt ? ` Try again after ${formatClock(error.resumeAt)}.` : '';
    console.error(chalk.yellow(`\nChatGPT is still asking us to slow down, so this run stopped.${when}`));
    return EXIT.throttled;
  }
  if (isAbortError(error)) {
    console.error(chalk.yellow('\nStopped.'));
    return EXIT.interrupted;
  }
  if (error instanceof AlreadyRunningError) {
    console.error(chalk.yellow(`\n${error.message}`));
    return EXIT.error;
  }
  console.error(chalk.red(`\nError: ${error instanceof Error ? error.message : String(error)}`));
  if (verbose && error instanceof Error && error.stack) console.error(chalk.dim(error.stack));
  return EXIT.error;
}
