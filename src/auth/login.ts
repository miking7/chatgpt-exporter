import chalk from 'chalk';
import { saveCredentials, type Settings } from '../config/settings.js';
import { getTokenInfo, isTokenExpired, parseCredentialsText, tokenExpiresAt, type Credentials } from './tokens.js';
import { readClipboard, writeClipboard } from '../utils/clipboard.js';
import { PromptCancelledError, promptHidden, promptLine } from '../utils/prompt.js';
import { formatDateTime, formatRelative } from '../utils/format.js';

export type LoginMethod = 'session-page' | 'console';

export interface VerifyResult {
  ok: boolean;
  /** What to save: the account id is dropped if ChatGPT rejected it. */
  credentials: Credentials;
  workspaceId?: string;
  /** Saved without a check because ChatGPT is throttling right now. */
  unverified?: boolean;
  error?: string;
}

export interface LoginOptions {
  settings: Settings;
  method?: LoginMethod;
  /** Shown first, e.g. why sign-in is needed again. */
  reason?: string;
  verify: (credentials: Credentials) => Promise<VerifyResult>;
}

export const SESSION_URL = 'https://chatgpt.com/api/auth/session';

/**
 * For the ChatGPT tab's console: copies {accessToken, accountId}. The account id comes from the
 * _account cookie, i.e. the workspace currently open. If the console's copy() is unavailable inside
 * the async callback, it falls back to a prompt() box to copy from.
 */
export const CONSOLE_SNIPPET =
  "(async()=>{const s=await(await fetch('/api/auth/session')).json();if(!s.accessToken){alert('Not signed in to ChatGPT in this tab');return}" +
  "const a=(document.cookie.match(/(?:^|; )_account=([^;]*)/)||[])[1],v=JSON.stringify({accessToken:s.accessToken,accountId:a?decodeURIComponent(a):null});" +
  "try{copy(v);console.log('%cCopied. Go back to the terminal and press Enter.','font-weight:bold')}" +
  "catch{prompt('Copy this (Cmd+C / Ctrl+C), click OK, then go back to the terminal:',v)}})()";

const MAX_ATTEMPTS = 3;

async function printInstructions(method: LoginMethod): Promise<void> {
  console.log(chalk.bold('\nSign in to ChatGPT'));
  if (method === 'console') {
    const copied = await writeClipboard(CONSOLE_SNIPPET);
    console.log(`  1. Open ${chalk.cyan('https://chatgpt.com')} in the browser you use for ChatGPT, in the workspace to back up.`);
    console.log('  2. Open the browser console (Chrome/Edge ⌥⌘J, Safari ⌥⌘C, Firefox ⌥⌘K).');
    console.log(
      `  3. Paste ${copied ? 'the script now on your clipboard' : 'the script below'} and press Enter` +
        ' (Chrome may ask you to type "allow pasting" first).'
    );
    if (!copied) console.log(chalk.dim(`\n${CONSOLE_SNIPPET}\n`));
    console.log('  4. Come back here.');
  } else {
    console.log(`  1. In the browser you use for ChatGPT, open ${chalk.cyan(SESSION_URL)}`);
    console.log('  2. Copy the whole page (⌘A, then ⌘C).');
    console.log('  3. Come back here.');
    console.log(chalk.dim('  (Prefer the browser console? Run `login --console` instead.)'));
  }
  console.log();
}

async function readCredentials(attempt: number): Promise<{ credentials: Credentials | null; fromClipboard: boolean } | null> {
  const answer = await promptLine(`Press Enter once it's copied${attempt > 1 ? ' again' : ''} (q to cancel): `);
  if (answer.trim().toLowerCase() === 'q') return null;

  const clipboard = await readClipboard();
  const fromClipboard = clipboard ? parseCredentialsText(clipboard) : null;
  if (fromClipboard) return { credentials: fromClipboard, fromClipboard: true };

  const pasted = await promptHidden("Couldn't find a token on the clipboard. Paste it here instead (input is hidden): ");
  return { credentials: parseCredentialsText(pasted), fromClipboard: false };
}

/** Walks the user through copying a fresh token, checks it with ChatGPT and saves it to .env. */
export async function interactiveLogin(options: LoginOptions): Promise<Credentials | null> {
  if (options.reason) console.log(chalk.yellow(`\n${options.reason}`));
  await printInstructions(options.method ?? 'session-page');

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let read: Awaited<ReturnType<typeof readCredentials>>;
    try {
      read = await readCredentials(attempt);
    } catch (error) {
      if (error instanceof PromptCancelledError) return null;
      throw error;
    }
    if (!read) return null;

    let credentials = read.credentials;
    if (!credentials) {
      console.log(chalk.red("That didn't contain a ChatGPT access token. Check you're signed in, reload the page and copy it again."));
      continue;
    }
    if (isTokenExpired(credentials.accessToken)) {
      console.log(chalk.red('That token has already expired. Reload the page and copy it again.'));
      continue;
    }

    const info = getTokenInfo(credentials.accessToken);
    if (!credentials.accountId && info?.accountId) credentials = { ...credentials, accountId: info.accountId };

    const verified = await options.verify(credentials);
    if (!verified.ok) {
      console.log(chalk.red(`ChatGPT didn't accept that token: ${verified.error ?? 'unknown error'}`));
      continue;
    }

    await saveCredentials(options.settings, verified.credentials);
    if (read.fromClipboard) await writeClipboard('');

    const expiresAt = tokenExpiresAt(verified.credentials.accessToken);
    const who = info?.email ? ` as ${info.email}` : '';
    const workspace = verified.credentials.accountId ?? verified.workspaceId;
    console.log(chalk.green(`\n✔ Signed in${who}${workspace ? ` · workspace ${workspace}` : ''}`));
    if (verified.unverified) {
      console.log(chalk.yellow("  Couldn't double-check the token because ChatGPT is throttling right now; saved it anyway."));
    }
    if (expiresAt) {
      console.log(`  Token valid until ${formatDateTime(expiresAt)} (${formatRelative(expiresAt)}); you'll be asked to sign in again after that.`);
    }
    console.log(chalk.dim(`  Saved to ${options.settings.configPath} (readable only by you)${read.fromClipboard ? '; clipboard cleared' : ''}.`));
    return verified.credentials;
  }

  console.log(chalk.red(`Giving up after ${MAX_ATTEMPTS} attempts.`));
  return null;
}
