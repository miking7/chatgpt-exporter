import chalk from 'chalk';
import { RequestScheduler } from '../../api/scheduler.js';
import { clearSavedToken, ENV, loadSettings } from '../../config/settings.js';
import { isInteractive } from '../../utils/prompt.js';
import { chooseOutputDir } from '../output-dir.js';
import { CLI_NAME, resolvePacing, runLogin, schedulerConfig } from '../runtime.js';
import { EXIT, handleCommandError } from '../errors.js';

export async function loginCommand(options: { console: boolean }): Promise<number> {
  if (!isInteractive()) {
    console.error('`login` needs an interactive terminal.');
    return EXIT.error;
  }
  try {
    const settings = await loadSettings();
    const scheduler = await RequestScheduler.create(schedulerConfig(settings, resolvePacing(settings, {})));
    const credentials = await runLogin(settings, scheduler, { method: options.console ? 'console' : 'session-page' });
    if (!credentials) return EXIT.error;
    if (process.env[ENV.token]) {
      console.log(chalk.yellow(`  Note: CHATGPT_TOKEN is also set in your shell and takes priority over config.env while it's valid; run \`unset ${ENV.token}\`.`));
    }
    const output = await chooseOutputDir(settings);
    console.log(`Next: run ${chalk.cyan(`${CLI_NAME} backup`)} to start backing up to ${output}`);
    return EXIT.ok;
  } catch (error) {
    return handleCommandError(error);
  }
}

export async function logoutCommand(): Promise<number> {
  const settings = await loadSettings();
  await clearSavedToken(settings);
  console.log(`Removed the saved token from ${settings.configPath}.`);
  if (process.env[ENV.token]) console.log(chalk.yellow(`CHATGPT_TOKEN is still set in your shell environment.`));
  return EXIT.ok;
}
