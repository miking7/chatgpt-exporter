import fs from 'node:fs/promises';
import path from 'node:path';
import type { ConversationItem, ConversationDetail } from '../api/types.js';
import { buildFileMap } from './file-service.js';
import { convertConversation } from './markdown-service.js';

export function projectFolderName(projectName: string): string {
  return projectName.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export class StorageService {
  readonly outputDir: string;
  readonly conversationsDir: string;
  /** "Conversations" for the main folder, otherwise the project name. */
  readonly label: string;
  private fileLinks?: Map<string, string>;

  constructor(outputDir: string, projectName?: string) {
    this.outputDir = outputDir;
    this.label = projectName ?? 'Conversations';
    this.conversationsDir = projectName
      ? path.join(outputDir, 'projects', projectFolderName(projectName), 'conversations')
      : path.join(outputDir, 'conversations');
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.conversationsDir, { recursive: true });
  }

  jsonPath(id: string): string {
    return path.join(this.conversationsDir, `${id}.json`);
  }

  markdownPath(id: string): string {
    return path.join(this.conversationsDir, `${id}.md`);
  }

  /** Lets Markdown written during the run link to files already downloaded into files/. */
  async loadFileLinks(): Promise<void> {
    const globalMap = await buildFileMap(path.join(this.outputDir, 'files'));
    if (globalMap.size === 0) return;
    this.fileLinks = new Map();
    for (const [fileId, filePath] of globalMap) {
      this.fileLinks.set(fileId, path.relative(this.conversationsDir, path.join(this.outputDir, filePath)));
    }
  }

  /** Writes the JSON and its Markdown straight away, so an interrupted run leaves no gaps. */
  async saveConversation(id: string, data: ConversationDetail): Promise<void> {
    await writeAtomic(this.jsonPath(id), JSON.stringify(data, null, 2));
    await writeAtomic(this.markdownPath(id), convertConversation(data, this.fileLinks));
  }

  /** Copies a conversation saved in another folder; returns its update_time. */
  async copyConversationFrom(source: StorageService, id: string): Promise<number | null> {
    const detail = JSON.parse(await fs.readFile(source.jsonPath(id), 'utf-8')) as ConversationDetail;
    await this.saveConversation(id, detail);
    return typeof detail.update_time === 'number' ? detail.update_time : null;
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

  async getExistingConversationUpdateTime(id: string): Promise<number | null> {
    try {
      const data = JSON.parse(await fs.readFile(this.jsonPath(id), 'utf-8')) as ConversationDetail;
      return typeof data.update_time === 'number' ? data.update_time : null;
    } catch {
      return null;
    }
  }

  /**
   * update_time of every saved conversation, keyed by id. Reads only the top of each file
   * (~15× faster than parsing ~300 MB of JSON) and falls back to a full parse if needed.
   */
  async loadSavedVersions(): Promise<Map<string, number | null>> {
    const versions = new Map<string, number | null>();
    let names: string[];
    try {
      names = await fs.readdir(this.conversationsDir);
    } catch {
      return versions;
    }
    const buffer = Buffer.alloc(4096);
    for (const name of names) {
      if (!name.endsWith('.json') || name === 'index.json') continue;
      const id = name.slice(0, -'.json'.length);
      versions.set(id, await this.readUpdateTimeFromHead(id, buffer));
    }
    return versions;
  }

  private async readUpdateTimeFromHead(id: string, buffer: Buffer): Promise<number | null> {
    let head: string;
    try {
      const handle = await fs.open(this.jsonPath(id), 'r');
      try {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        head = buffer.toString('utf8', 0, bytesRead);
      } finally {
        await handle.close();
      }
    } catch {
      return null;
    }
    // Files are written with JSON.stringify(…, null, 2), so top-level keys are indented exactly two spaces
    // (messages inside `mapping` have their own update_time, indented deeper).
    const match = /^ {2}"update_time": (-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|null),?\r?$/m.exec(head);
    if (match) return match[1] === 'null' ? null : Number(match[1]);
    return this.getExistingConversationUpdateTime(id);
  }
}

export async function writeAtomic(filePath: string, content: string): Promise<void> {
  const tmp = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tmp, content, 'utf-8');
  await fs.rename(tmp, filePath);
}

/** Merges into metadata.json, keeping keys written by other steps (e.g. failedFiles). */
export async function updateMetadata(outputDir: string, patch: Record<string, unknown>): Promise<void> {
  const metadataPath = path.join(outputDir, 'metadata.json');
  let metadata: Record<string, unknown> = {};
  try {
    metadata = JSON.parse(await fs.readFile(metadataPath, 'utf-8')) as Record<string, unknown>;
  } catch {
    // First run, or unreadable: start fresh.
  }
  await writeAtomic(metadataPath, JSON.stringify({ ...metadata, ...patch }, null, 2));
}
