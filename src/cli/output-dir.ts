import fs from 'node:fs/promises';
import path from 'node:path';
import chalk from 'chalk';
import { ENV, defaultOutputDir, expandHome, isOutputDirConfigured, resolveOutputDir, saveSettings, type Settings } from '../config/settings.js';
import { isInteractive, promptLine } from '../utils/prompt.js';

async function looksLikeArchive(dir: string): Promise<boolean> {
  try {
    await fs.access(path.join(dir, 'conversations', 'index.json'));
    return true;
  } catch {
    return false;
  }
}

/**
 * The archive folder for this run. The first time nothing is configured, asks where to keep it
 * (unattended runs take the default) and saves the answer, so every later run uses the same folder.
 */
export async function chooseOutputDir(settings: Settings, flag?: string): Promise<string> {
  if (flag || isOutputDirConfigured(settings)) return resolveOutputDir(settings, flag);

  // An archive made by the original tool in the current folder is the likeliest intention.
  const local = path.resolve('chatgpt-export');
  const suggestion = (await looksLikeArchive(local)) ? local : defaultOutputDir();

  let chosen = suggestion;
  if (isInteractive()) {
    console.log(chalk.bold('\nWhere should the archive go?'));
    console.log(chalk.dim('  Each conversation is saved there as JSON and Markdown. Press Enter to accept the suggestion.'));
    const answer = (await promptLine(`  Archive folder [${suggestion}]: `)).trim();
    chosen = answer ? path.resolve(expandHome(answer)) : suggestion;
  }

  await saveSettings(settings, { [ENV.exportDir]: chosen });
  console.log(chalk.dim(`  Archive folder saved to ${settings.configPath} (edit ${ENV.exportDir} there, or pass -o).\n`));
  return chosen;
}
