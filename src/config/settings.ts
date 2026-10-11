import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseEnv, updateEnvFile } from './env-file.js';

export const APP_NAME = 'chatgpt-exporter';
export const CONFIG_FILE = 'config.env';

export const ENV = {
  token: 'CHATGPT_TOKEN',
  accountId: 'CHATGPT_ACCOUNT_ID',
  exportDir: 'CHATGPT_EXPORT_DIR',
  pace: 'CHATGPT_PACE_SECONDS',
  burst: 'CHATGPT_BURST',
  /** IANA time zone for dates in the Markdown and its file names; saved on the first run. */
  timeZone: 'CHATGPT_TIMEZONE',
  /** Overrides the config folder (e.g. one folder per workspace). */
  home: 'CHATGPT_EXPORTER_HOME',
} as const;

export const DEFAULT_PACE_SECONDS = 90;
export const DEFAULT_BURST = 30;

const CONFIG_HEADER = `# chatgpt-exporter settings (KEY=VALUE, the same format as a .env file).
# Private: this file holds your ChatGPT access token. \`chatgpt-exporter login\` updates
# CHATGPT_TOKEN (and CHATGPT_ACCOUNT_ID for Team/Business workspaces).
#
# CHATGPT_EXPORT_DIR     folder the archive is kept in
# CHATGPT_PACE_SECONDS   average seconds between conversation downloads (default ${DEFAULT_PACE_SECONDS})
# CHATGPT_BURST          downloads allowed back-to-back after a quiet period (default ${DEFAULT_BURST})
# CHATGPT_TIMEZONE       time zone for dates in the archive (set to this computer's zone on the first run)
`;

export interface Settings {
  /** Per-user folder holding config.env, the rate-limit state and the lock. */
  configDir: string;
  configPath: string;
  stateDir: string;
  /** Values from config.env (process environment variables are applied on top by getSetting). */
  env: Record<string, string>;
}

export function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p;
}

/**
 * Where settings live, independent of the current directory (so `npx` and scheduled runs find them):
 * CHATGPT_EXPORTER_HOME, else %APPDATA%\chatgpt-exporter on Windows, else $XDG_CONFIG_HOME or
 * ~/.config, plus /chatgpt-exporter. Like the GitHub CLI, ~/.config is used on macOS too.
 */
export function configDir(): string {
  const override = process.env[ENV.home];
  if (override) return path.resolve(expandHome(override));
  if (process.platform === 'win32' && process.env.APPDATA) return path.join(process.env.APPDATA, APP_NAME);
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), '.config');
  return path.join(base, APP_NAME);
}

/** ~/Documents/chatgpt-export where a Documents folder exists, otherwise ~/chatgpt-export. */
export function defaultOutputDir(): string {
  const documents = path.join(os.homedir(), 'Documents');
  const base = fs.existsSync(documents) ? documents : os.homedir();
  return path.join(base, 'chatgpt-export');
}

export async function loadSettings(): Promise<Settings> {
  const dir = configDir();
  const configPath = path.join(dir, CONFIG_FILE);
  let env: Record<string, string> = {};
  try {
    env = parseEnv(await fsp.readFile(configPath, 'utf-8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return { configDir: dir, configPath, stateDir: dir, env };
}

/** Process environment first, then config.env; empty values count as unset. */
export function getSetting(settings: Settings, key: string): string | undefined {
  const value = process.env[key] ?? settings.env[key];
  return value === undefined || value.trim() === '' ? undefined : value;
}

export function isOutputDirConfigured(settings: Settings): boolean {
  return getSetting(settings, ENV.exportDir) !== undefined;
}

/** `-o` flag, else CHATGPT_EXPORT_DIR, else the default folder. */
export function resolveOutputDir(settings: Settings, flag?: string): string {
  return path.resolve(expandHome(flag ?? getSetting(settings, ENV.exportDir) ?? defaultOutputDir()));
}

/** The time zone dates in the archive are shown in: CHATGPT_TIMEZONE, else this computer's zone. */
export function resolveTimeZone(settings: Settings): string {
  const configured = getSetting(settings, ENV.timeZone);
  if (configured === undefined) return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: configured });
  } catch {
    throw new Error(`${ENV.timeZone} must be a time zone such as Australia/Melbourne (got "${configured}")`);
  }
  return configured;
}

/**
 * resolveTimeZone, saving this computer's zone the first time: dates in file names then stay put
 * (and files aren't renamed) if the computer's zone changes, e.g. while travelling.
 */
export async function ensureTimeZone(settings: Settings): Promise<string> {
  const zone = resolveTimeZone(settings);
  if (getSetting(settings, ENV.timeZone) === undefined) await saveSettings(settings, { [ENV.timeZone]: zone });
  return zone;
}

export async function saveSettings(settings: Settings, updates: Record<string, string | undefined>): Promise<void> {
  await updateEnvFile(settings.configPath, updates, CONFIG_HEADER);
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) delete settings.env[key];
    else settings.env[key] = value;
  }
}

export function saveCredentials(settings: Settings, credentials: { accessToken: string; accountId?: string }): Promise<void> {
  return saveSettings(settings, { [ENV.token]: credentials.accessToken, [ENV.accountId]: credentials.accountId });
}

export function clearSavedToken(settings: Settings): Promise<void> {
  return saveSettings(settings, { [ENV.token]: undefined });
}
