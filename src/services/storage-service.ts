import fs from 'node:fs/promises';
import path from 'node:path';
import type { ConversationItem, ConversationDetail } from '../api/types.js';
import { abortError } from '../utils/time.js';
import { idSuffix, markdownFileName, suffixOfMarkdownName } from './conversation-names.js';
import { buildFileMap } from './file-service.js';
import { conversationTimes, convertConversation, type ConversationTimes } from './markdown-service.js';

/** Bumped whenever the Markdown changes (content or location), so the next backup regenerates it from the JSON. */
export const MARKDOWN_FORMAT = 3;

export function projectFolderName(projectName: string): string {
  return projectName.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/** What the sync compares with the conversation list. */
export interface SavedVersion {
  updateTime: number | null;
  title: string | null;
}

export function savedVersionOf(detail: ConversationDetail): SavedVersion {
  return {
    updateTime: typeof detail.update_time === 'number' ? detail.update_time : null,
    title: typeof detail.title === 'string' ? detail.title : null,
  };
}

export interface StorageOptions {
  /** IANA zone for dates in the Markdown. */
  timeZone: string;
  /** Saves into projects/<this name, made safe for a folder name>/. */
  projectName?: string;
  /** An existing folder under projects/ (when converting what's already on disk). */
  projectFolder?: string;
}

export class StorageService {
  readonly outputDir: string;
  /** The JSON: what the sync reads and writes, one `<id>.json` per conversation. */
  readonly conversationsDir: string;
  /** The readable Markdown, named by date and title (markdown/, or markdown/projects/<folder>/). */
  readonly markdownDir: string;
  /** "Conversations" for the main folder, otherwise the project name. */
  readonly label: string;
  readonly timeZone: string;
  private fileLinks?: Map<string, string>;
  /** Markdown file names by id suffix, read once. */
  private markdownFiles?: Promise<Map<string, Set<string>>>;

  constructor(outputDir: string, options: StorageOptions) {
    this.outputDir = outputDir;
    this.timeZone = options.timeZone;
    this.label = options.projectName ?? options.projectFolder ?? 'Conversations';
    const folder = options.projectFolder ?? (options.projectName === undefined ? undefined : projectFolderName(options.projectName));
    this.conversationsDir = folder === undefined
      ? path.join(outputDir, 'conversations')
      : path.join(outputDir, 'projects', folder, 'conversations');
    this.markdownDir = folder === undefined ? path.join(outputDir, 'markdown') : path.join(outputDir, 'markdown', 'projects', folder);
  }

  /** This archive's folder for a project. */
  forProject(projectName: string): StorageService {
    return new StorageService(this.outputDir, { timeZone: this.timeZone, projectName });
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.conversationsDir, { recursive: true });
    await fs.mkdir(this.markdownDir, { recursive: true });
    await removeStaleTempFiles(this.conversationsDir);
    await removeStaleTempFiles(this.markdownDir);
  }

  jsonPath(id: string): string {
    return path.join(this.conversationsDir, `${id}.json`);
  }

  /** Lets Markdown written during the run link to files already downloaded into files/. */
  async loadFileLinks(): Promise<void> {
    const globalMap = await buildFileMap(path.join(this.outputDir, 'files'));
    if (globalMap.size === 0) return;
    this.fileLinks = new Map();
    for (const [fileId, filePath] of globalMap) {
      this.fileLinks.set(fileId, path.relative(this.markdownDir, path.join(this.outputDir, filePath)));
    }
  }

  /**
   * Writes the Markdown and the JSON straight away, so an interrupted run leaves no gaps. The Markdown goes
   * first: the JSON is what marks a conversation as saved, so a save cut short in between is redone next run.
   */
  async saveConversation(id: string, data: ConversationDetail): Promise<void> {
    const times = conversationTimes(data);
    await this.saveMarkdown(id, data, times);
    await writeAtomic(this.jsonPath(id), JSON.stringify(data, null, 2));
    await stampTimes(this.jsonPath(id), times);
  }

  /** Regenerates one conversation's Markdown from its saved JSON and restores both files' dates. */
  async refreshMarkdown(id: string): Promise<'written' | 'unchanged'> {
    const data = JSON.parse(await fs.readFile(this.jsonPath(id), 'utf-8')) as ConversationDetail;
    const times = conversationTimes(data);
    const written = await this.saveMarkdown(id, data, times);
    await stampTimes(this.jsonPath(id), times);
    return written ? 'written' : 'unchanged';
  }

  /** Rewrites the Markdown only when it changed, then gives it the chat's dates; returns whether it was written. */
  private async saveMarkdown(id: string, data: ConversationDetail, times: ConversationTimes): Promise<boolean> {
    const name = markdownFileName(id, data.title, times.created, this.timeZone);
    const file = path.join(this.markdownDir, name);
    const markdown = convertConversation(data, { id, timeZone: this.timeZone, fileMap: this.fileLinks });
    const changed = (await readTextIfExists(file)) !== markdown;
    if (changed) await writeAtomic(file, markdown);
    await stampTimes(file, times);
    await this.removeOtherMarkdown(id, name);
    return changed;
  }

  private markdownIndex(): Promise<Map<string, Set<string>>> {
    this.markdownFiles ??= (async () => {
      const index = new Map<string, Set<string>>();
      for (const name of await fs.readdir(this.markdownDir).catch(() => [] as string[])) {
        const suffix = suffixOfMarkdownName(name);
        if (suffix === undefined) continue;
        const names = index.get(suffix) ?? new Set<string>();
        index.set(suffix, names.add(name));
      }
      return index;
    })();
    return this.markdownFiles;
  }

  /** This conversation's Markdown under an earlier title, and the copy beside the JSON written before version 2.0.0-fork.7. */
  private async removeOtherMarkdown(id: string, keep: string): Promise<void> {
    const suffix = idSuffix(id);
    const index = await this.markdownIndex();
    const names = index.get(suffix) ?? new Set<string>();
    for (const name of names) {
      if (name === keep) continue;
      // A conversation whose id happens to end the same way would be listed too: remove only this one's.
      if ((await readFrontMatterId(path.join(this.markdownDir, name))) !== id) continue;
      await fs.rm(path.join(this.markdownDir, name), { force: true });
      names.delete(name);
    }
    index.set(suffix, names.add(keep));
    await fs.rm(path.join(this.conversationsDir, `${id}.md`), { force: true });
  }

  /** Copies a conversation saved in another folder; returns the version copied. */
  async copyConversationFrom(source: StorageService, id: string): Promise<SavedVersion> {
    const detail = JSON.parse(await fs.readFile(source.jsonPath(id), 'utf-8')) as ConversationDetail;
    await this.saveConversation(id, detail);
    return savedVersionOf(detail);
  }

  async saveIndex(conversations: ConversationItem[]): Promise<void> {
    await writeAtomic(path.join(this.conversationsDir, 'index.json'), JSON.stringify(conversations, null, 2));
  }

  async loadIndex(): Promise<ConversationItem[] | null> {
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(path.join(this.conversationsDir, 'index.json'), 'utf-8'));
      return Array.isArray(parsed) ? (parsed as ConversationItem[]) : null;
    } catch {
      return null;
    }
  }

  async appendLog(message: string): Promise<void> {
    const filePath = path.join(this.outputDir, 'backup.log');
    await fs.appendFile(filePath, `[${new Date().toISOString()}] ${message}\n`, 'utf-8');
  }

  async conversationExists(id: string): Promise<boolean> {
    try {
      await fs.access(this.jsonPath(id));
      return true;
    } catch {
      return false;
    }
  }

  /** Ids of the conversations saved in this folder. */
  async savedIds(): Promise<string[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.conversationsDir);
    } catch {
      return [];
    }
    return names.filter((name) => name.endsWith('.json') && name !== 'index.json').map((name) => name.slice(0, -'.json'.length));
  }

  async getExistingConversationVersion(id: string): Promise<SavedVersion | null> {
    try {
      return savedVersionOf(JSON.parse(await fs.readFile(this.jsonPath(id), 'utf-8')) as ConversationDetail);
    } catch {
      return null;
    }
  }

  /**
   * update_time and title of every saved conversation, keyed by id. Reads only the top of each file
   * (~15× faster than parsing ~300 MB of JSON) and falls back to a full parse if needed.
   */
  async loadSavedVersions(): Promise<Map<string, SavedVersion>> {
    const versions = new Map<string, SavedVersion>();
    const buffer = Buffer.alloc(4096);
    for (const id of await this.savedIds()) {
      const version = await this.readVersionFromHead(id, buffer);
      if (version) versions.set(id, version);
    }
    return versions;
  }

  private async readVersionFromHead(id: string, buffer: Buffer): Promise<SavedVersion | null> {
    let head: string;
    try {
      head = await readHead(this.jsonPath(id), buffer);
    } catch {
      return null;
    }
    // Files are written with JSON.stringify(…, null, 2), so top-level keys are indented exactly two spaces
    // (messages inside `mapping` have their own update_time, indented deeper).
    const update = /^ {2}"update_time": (-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|null),?\r?$/m.exec(head);
    const title = /^ {2}"title": (null|"(?:[^"\\]|\\.)*"),?\r?$/m.exec(head);
    if (!update || !title) return this.getExistingConversationVersion(id);
    return { updateTime: update[1] === 'null' ? null : Number(update[1]), title: JSON.parse(title[1]) as string | null };
  }
}

export interface ConvertResult {
  /** Markdown files written because their content changed. */
  converted: number;
  unchanged: number;
  /** JSON files that couldn't be read. */
  errors: number;
}

/**
 * Regenerates every conversation's Markdown from its saved JSON, in the main folder and each project folder,
 * and restores both files' dates. Only files whose content changed are rewritten. No network requests.
 */
export async function convertArchive(
  outputDir: string,
  options: { timeZone: string; signal?: AbortSignal; onProgress?: (done: number, total: number) => void }
): Promise<ConvertResult> {
  const folders = [new StorageService(outputDir, { timeZone: options.timeZone })];
  for (const entry of await fs.readdir(path.join(outputDir, 'projects'), { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory()) folders.push(new StorageService(outputDir, { timeZone: options.timeZone, projectFolder: entry.name }));
  }
  const work: Array<{ storage: StorageService; ids: string[] }> = [];
  for (const storage of folders) work.push({ storage, ids: await storage.savedIds() });
  const total = work.reduce((sum, folder) => sum + folder.ids.length, 0);

  const result: ConvertResult = { converted: 0, unchanged: 0, errors: 0 };
  let done = 0;
  if (total > 0) options.onProgress?.(0, total);
  for (const { storage, ids } of work) {
    if (ids.length === 0) continue;
    await storage.initialize();
    await storage.loadFileLinks();
    for (const id of ids) {
      if (options.signal?.aborted) throw abortError(options.signal);
      try {
        if ((await storage.refreshMarkdown(id)) === 'written') result.converted += 1;
        else result.unchanged += 1;
      } catch {
        result.errors += 1;
      }
      done += 1;
      if (done % 250 === 0 || done === total) options.onProgress?.(done, total);
    }
  }
  return result;
}

/**
 * Gives a saved file the chat's dates: Date Modified = its last update and, on macOS, Date Created = when it
 * started. An mtime earlier than a file's birth time also moves the birth time back (APFS and HFS+), so setting
 * the creation time first and then the update time sets both. Elsewhere only the modified time sticks.
 */
export async function stampTimes(filePath: string, times: ConversationTimes): Promise<void> {
  const modified = times.updated ?? times.created;
  if (modified === null) return;
  const created = Math.min(times.created ?? modified, modified);
  try {
    const stat = await fs.stat(filePath);
    // A birth time already earlier than `created` can't be moved forward, so it counts as done.
    const birthDone = process.platform !== 'darwin' || stat.birthtimeMs <= created * 1000 + 2;
    if (birthDone && Math.abs(stat.mtimeMs - modified * 1000) < 2) return;
    if (!birthDone) await fs.utimes(filePath, stat.atime, created);
    await fs.utimes(filePath, stat.atime, modified);
  } catch {
    // The dates are a convenience: never fail a save over them.
  }
}

async function readHead(filePath: string, buffer: Buffer): Promise<string> {
  const handle = await fs.open(filePath, 'r');
  try {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.toString('utf8', 0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** The id in the front matter of a Markdown file this tool wrote; null for any other file. */
async function readFrontMatterId(filePath: string): Promise<string | null> {
  try {
    return /^---\r?\nid: (\S+)/.exec(await readHead(filePath, Buffer.alloc(256)))?.[1] ?? null;
  } catch {
    return null;
  }
}

async function readTextIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

export async function writeAtomic(filePath: string, content: string): Promise<void> {
  const tmp = `${filePath}.${process.pid}.tmp`;
  try {
    await fs.writeFile(tmp, content, 'utf-8');
    await fs.rename(tmp, filePath);
  } catch (error) {
    await fs.rm(tmp, { force: true });
    throw error;
  }
}

/** Removes temp files left by an earlier run that was killed mid-write (callers hold the backup lock). */
export async function removeStaleTempFiles(dir: string): Promise<void> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const pid = /\.(?:json|md|html)\.(\d+)\.tmp$/.exec(name)?.[1];
    if (pid !== undefined && Number(pid) !== process.pid) await fs.rm(path.join(dir, name), { force: true });
  }
}

export async function readMetadata(outputDir: string): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(path.join(outputDir, 'metadata.json'), 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    // First run, or unreadable: start fresh.
    return {};
  }
}

/** Merges into metadata.json, keeping keys written by other steps (e.g. failedFiles). */
export async function updateMetadata(outputDir: string, patch: Record<string, unknown>): Promise<void> {
  const metadata = await readMetadata(outputDir);
  await writeAtomic(path.join(outputDir, 'metadata.json'), JSON.stringify({ ...metadata, ...patch }, null, 2));
}
