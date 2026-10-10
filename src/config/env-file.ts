import fs from 'node:fs/promises';
import path from 'node:path';

const LINE_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

/** Parses KEY=VALUE lines: supports `export`, single/double quotes, `#` comments. Later keys win. */
export function parseEnv(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(#|$)/.test(line)) continue;
    const match = LINE_RE.exec(line);
    if (match) values[match[1]] = parseValue(match[2]);
  }
  return values;
}

function parseValue(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\(.)/g, (_, c: string) => (c === 'n' ? '\n' : c));
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  const comment = value.search(/\s#/);
  return (comment >= 0 ? value.slice(0, comment) : value).trim();
}

export function formatEnvValue(value: string): string {
  if (/^[A-Za-z0-9_./:@+-]+$/.test(value)) return value;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

/**
 * Sets keys (or removes them, when the value is undefined) in an .env file, keeping comments, ordering
 * and unrelated keys. The file is written atomically with owner-only permissions.
 */
export async function updateEnvFile(
  filePath: string,
  updates: Record<string, string | undefined>,
  headerForNewFile = ''
): Promise<void> {
  let text: string;
  try {
    text = await fs.readFile(filePath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    text = headerForNewFile;
  }

  const pending = new Map(Object.entries(updates));
  const handled = new Set<string>();
  const lines: string[] = [];

  for (const line of text.split(/\r?\n/)) {
    const key = LINE_RE.exec(line)?.[1];
    if (key && Object.hasOwn(updates, key)) {
      // Write the key where it first appeared and drop any later duplicates.
      if (!handled.has(key)) {
        handled.add(key);
        const value = pending.get(key);
        if (value !== undefined) lines.push(`${key}=${formatEnvValue(value)}`);
      }
      pending.delete(key);
      continue;
    }
    lines.push(line);
  }

  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  for (const [key, value] of pending) {
    if (value !== undefined) lines.push(`${key}=${formatEnvValue(value)}`);
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${lines.join('\n')}\n`, { mode: 0o600 });
  await fs.rename(tmp, filePath);
  await fs.chmod(filePath, 0o600);
}
