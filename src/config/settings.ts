import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv, updateEnvFile } from './env-file.js';

export const ENV = {
  token: 'CHATGPT_TOKEN',
  accountId: 'CHATGPT_ACCOUNT_ID',
  exportDir: 'CHATGPT_EXPORT_DIR',
  pace: 'CHATGPT_PACE_SECONDS',
  burst: 'CHATGPT_BURST',
  home: 'CHATGPT_EXPORTER_HOME',
} as const;

export const DEFAULT_PACE_SECONDS = 90;
export const DEFAULT_BURST = 30;

const ENV_HEADER = `# chatgpt-exporter settings. Private: this file holds your ChatGPT access token and is git-ignored.
# \`login\` writes CHATGPT_TOKEN (and CHATGPT_ACCOUNT_ID for Team/Business workspaces).
`;

export interface Settings {
  /** Folder holding .env and .state/ (the package root unless CHATGPT_EXPORTER_HOME is set). */
  home: string;
  envPath: string;
  stateDir: string;
  /** Values from the .env file (process environment variables are applied on top by getSetting). */
  env: Record<string, string>;
}

/** The package root: walks up from this module, so it works from dist/ and from src/ via tsx. */
function packageRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

export async function loadSettings(): Promise<Settings> {
  const override = process.env[ENV.home];
  const home = override ? path.resolve(override) : packageRoot();
  const envPath = path.join(home, '.env');
  let env: Record<string, string> = {};
  try {
    env = parseEnv(await fsp.readFile(envPath, 'utf-8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return { home, envPath, stateDir: path.join(home, '.state'), env };
}

/** Process environment first, then .env; empty values count as unset. */
export function getSetting(settings: Settings, key: string): string | undefined {
  const value = process.env[key] ?? settings.env[key];
  return value === undefined || value.trim() === '' ? undefined : value;
}

export function resolveOutputDir(settings: Settings, flag?: string): string {
  return path.resolve(flag ?? getSetting(settings, ENV.exportDir) ?? './chatgpt-export');
}

export async function saveCredentials(
  settings: Settings,
  credentials: { accessToken: string; accountId?: string }
): Promise<void> {
  await updateEnvFile(
    settings.envPath,
    { [ENV.token]: credentials.accessToken, [ENV.accountId]: credentials.accountId },
    ENV_HEADER
  );
  settings.env[ENV.token] = credentials.accessToken;
  if (credentials.accountId) settings.env[ENV.accountId] = credentials.accountId;
  else delete settings.env[ENV.accountId];
}

export async function clearSavedToken(settings: Settings): Promise<void> {
  await updateEnvFile(settings.envPath, { [ENV.token]: undefined }, ENV_HEADER);
  delete settings.env[ENV.token];
}
