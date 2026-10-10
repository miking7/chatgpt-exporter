import fs from 'node:fs/promises';
import path from 'node:path';
import chalk from 'chalk';
import { loadSettings, resolveOutputDir } from '../../config/settings.js';
import { convertDirectory } from '../../services/markdown-service.js';
import { formatCount } from '../../utils/format.js';
import { EXIT } from '../errors.js';

/** Regenerates every .md from its .json (no network). */
export async function convertCommand(options: { output?: string }): Promise<number> {
  const settings = await loadSettings();
  const output = resolveOutputDir(settings, options.output);
  const filesDir = path.join(output, 'files');
  const hasFiles = await fs.stat(filesDir).then((s) => s.isDirectory(), () => false);
  const result = await convertDirectory(output, hasFiles ? filesDir : undefined);
  console.log(`Converted ${formatCount(result.converted)} conversations to Markdown in ${chalk.cyan(output)}`);
  if (result.errors > 0) console.log(chalk.red(`  ${formatCount(result.errors)} couldn't be converted`));
  return result.errors > 0 ? EXIT.error : EXIT.ok;
}
