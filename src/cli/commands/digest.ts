import path from 'node:path';
import chalk from 'chalk';
import { loadSettings, resolveOutputDir } from '../../config/settings.js';
import { buildDigest, type DigestResult } from '../../services/digest-service.js';
import { acquireLock, type Lock } from '../../utils/lock.js';
import { formatCount, plural } from '../../utils/format.js';
import { createReporter } from '../reporter.js';
import { EXIT, handleCommandError } from '../errors.js';

const kb = (bytes: number) => `${formatCount(Math.round(bytes / 1024))} KB`;

/** One line for backup and convert, e.g. "Digest: 1 of 36 files updated in digest/ (2,832 chats)". */
export function digestLine(result: DigestResult): string {
  return (
    `Digest: ${formatCount(result.written)} of ${plural(result.files, 'file')} updated in digest/ (${plural(result.chats, 'chat')})` +
    (result.failures.length > 0 ? `; ${plural(result.failures.length, 'Markdown file')} couldn't be read` : '')
  );
}

/** Rebuilds digest/ from the saved Markdown (no network). */
export async function digestCommand(options: { output?: string }): Promise<number> {
  const reporter = createReporter();
  let lock: Lock | undefined;
  try {
    const settings = await loadSettings();
    const output = resolveOutputDir(settings, options.output);
    // A backup rebuilds the same files.
    lock = await acquireLock(settings.stateDir);

    const started = performance.now();
    reporter.spin('Building the digest…');
    const result = await buildDigest(output);
    reporter.finish();
    if (result.chats === 0) {
      console.log(`No saved conversations in ${chalk.cyan(path.join(output, 'markdown'))}`);
      return result.failures.length > 0 ? EXIT.error : EXIT.ok;
    }
    console.log(
      `Parsed ${plural(result.chats, 'transcript')} in ${((performance.now() - started) / 1000).toFixed(1)} s: ` +
        `${plural(result.userTurns, 'user turn')}, ${plural(result.assistantTurns, 'assistant turn')}, ${plural(result.months, 'month')}.`
    );
    if (result.silent.length > 0) console.log(`No typed questions (${result.silent.length}): ${result.silent.join('; ')}`);
    console.log(
      `Wrote ${formatCount(result.written)} of ${plural(result.files, 'file')} to ${chalk.cyan(path.join(output, 'digest'))}` +
        (result.removed.length > 0 ? ` (removed ${result.removed.join(', ')})` : '') +
        `: INDEX.md ${kb(result.bytes.index)}, month pages ${kb(result.bytes.months)}, index.html ${kb(result.bytes.html)}.`
    );
    for (const failure of result.failures) console.error(chalk.red(`Couldn't parse ${failure}`));
    return result.failures.length > 0 ? EXIT.error : EXIT.ok;
  } catch (error) {
    reporter.finish();
    return handleCommandError(error);
  } finally {
    await lock?.release();
  }
}
