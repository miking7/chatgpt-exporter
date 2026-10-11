import chalk from 'chalk';
import { ensureTimeZone, loadSettings, resolveOutputDir } from '../../config/settings.js';
import { MARKDOWN_FORMAT, convertArchive, updateMetadata } from '../../services/storage-service.js';
import { acquireLock, type Lock } from '../../utils/lock.js';
import { formatCount, plural } from '../../utils/format.js';
import { createReporter } from '../reporter.js';
import { EXIT, handleCommandError } from '../errors.js';

/** Regenerates every .md from its .json and restores the files' dates (no network). */
export async function convertCommand(options: { output?: string }): Promise<number> {
  const reporter = createReporter();
  let lock: Lock | undefined;
  try {
    const settings = await loadSettings();
    const output = resolveOutputDir(settings, options.output);
    const timeZone = await ensureTimeZone(settings);
    // A backup writes the same files.
    lock = await acquireLock(settings.stateDir);

    const result = await convertArchive(output, {
      timeZone,
      onProgress: (done, total) => reporter.spin(`Converting: ${formatCount(done)}/${formatCount(total)}`),
    });
    reporter.finish();
    const converted = result.converted + result.unchanged;
    if (converted + result.errors === 0) {
      console.log(`No saved conversations in ${chalk.cyan(output)}`);
      return EXIT.ok;
    }
    await updateMetadata(output, { markdownFormat: MARKDOWN_FORMAT, markdownTimeZone: timeZone });
    console.log(
      `Converted ${plural(converted, 'conversation')} in ${chalk.cyan(output)} (dates in ${timeZone}): ` +
        `${formatCount(result.converted)} Markdown files rewritten, ${formatCount(result.unchanged)} already current`
    );
    if (result.errors > 0) console.log(chalk.red(`  ${formatCount(result.errors)} couldn't be converted`));
    return result.errors > 0 ? EXIT.error : EXIT.ok;
  } catch (error) {
    reporter.finish();
    return handleCommandError(error);
  } finally {
    await lock?.release();
  }
}
