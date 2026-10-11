import type { ConversationDetail } from '../api/types.js';
import { formatIsoLocal, localDate } from '../utils/time.js';

interface MappingNode {
  id: string;
  message?: {
    id: string;
    author: { role: string };
    content?: {
      content_type: string;
      parts?: unknown[];
      text?: string;
    };
    weight?: number;
    metadata?: Record<string, unknown>;
  } | null;
  parent?: string | null;
  children?: string[];
}

export function extractTextFromParts(parts: unknown[], fileMap?: Map<string, string>): string {
  const pieces: string[] = [];
  for (const part of parts) {
    if (typeof part === 'string') {
      pieces.push(part);
    } else if (part && typeof part === 'object') {
      const obj = part as Record<string, unknown>;
      if (obj.content_type === 'image_asset_pointer') {
        const pointer = obj.asset_pointer as string | undefined;
        if (pointer && fileMap) {
          const fileId = pointer.startsWith('file-service://') ? pointer.slice('file-service://'.length) : null;
          if (fileId && fileMap.has(fileId)) {
            pieces.push(`![image](${fileMap.get(fileId)})`);
            continue;
          }
        }
        pieces.push(`![image](${pointer ?? 'unknown'})`);
      }
    }
  }
  return pieces.join('\n');
}

function getLinearThread(mapping: Record<string, MappingNode>, currentNode?: string | null): MappingNode[] {
  // If we have current_node, walk backwards to find the active path, then output in order
  if (currentNode && mapping[currentNode]) {
    const path: MappingNode[] = [];
    let nodeId: string | null | undefined = currentNode;
    while (nodeId && mapping[nodeId]) {
      path.unshift(mapping[nodeId]);
      nodeId = mapping[nodeId].parent;
    }
    return path;
  }

  // Fallback: find root and follow children[0]
  let root: MappingNode | undefined;
  for (const node of Object.values(mapping)) {
    if (node.parent === null || node.parent === undefined) {
      root = node;
      break;
    }
  }
  if (!root) return [];

  const thread: MappingNode[] = [root];
  let current = root;
  while (current.children && current.children.length > 0) {
    const nextId = current.children[0];
    const next = mapping[nextId];
    if (!next) break;
    thread.push(next);
    current = next;
  }
  return thread;
}

function formatRole(role: string): string {
  switch (role) {
    case 'user': return 'User';
    case 'assistant': return 'Assistant';
    default: return role.charAt(0).toUpperCase() + role.slice(1);
  }
}

export interface ConversationTimes {
  /** When the chat started (epoch seconds). */
  created: number | null;
  /** When ChatGPT last changed it: the version the backup keys on. */
  updated: number | null;
}

const isTimestamp = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;

/** The chat's own dates, falling back to its messages' times when ChatGPT left one out. */
export function conversationTimes(detail: ConversationDetail): ConversationTimes {
  const ownCreated = isTimestamp(detail.create_time) ? detail.create_time : null;
  const ownUpdated = isTimestamp(detail.update_time) ? detail.update_time : null;
  if (ownCreated !== null && ownUpdated !== null) return { created: ownCreated, updated: ownUpdated };
  let first: number | null = null;
  let last: number | null = null;
  for (const node of Object.values(detail.mapping ?? {})) {
    const time = node.message?.create_time;
    if (!isTimestamp(time)) continue;
    if (first === null || time < first) first = time;
    if (last === null || time > last) last = time;
  }
  const created = ownCreated ?? first ?? ownUpdated;
  return { created, updated: ownUpdated ?? last ?? created };
}

export interface MarkdownOptions {
  /** The conversation id (not every saved JSON carries it). */
  id: string;
  /** IANA zone the dates are shown in. */
  timeZone: string;
  /** fileId → path of the downloaded file, relative to the Markdown file. */
  fileMap?: Map<string, string>;
}

/** YAML front matter: lets Obsidian, editors and scripts sort and find chats by their real dates. */
function frontMatter(detail: ConversationDetail, options: MarkdownOptions, times: ConversationTimes): string[] {
  const lines = [
    '---',
    `id: ${options.id}`,
    `url: https://chatgpt.com/c/${options.id}`,
    // A JSON string is also a valid YAML double-quoted string, whatever the title contains.
    `title: ${JSON.stringify(detail.title ?? 'Untitled')}`,
  ];
  if (times.created !== null) lines.push(`created: ${formatIsoLocal(times.created, options.timeZone)}`);
  if (times.updated !== null) lines.push(`updated: ${formatIsoLocal(times.updated, options.timeZone)}`);
  lines.push('---', '');
  return lines;
}

export function convertConversation(detail: ConversationDetail, options: MarkdownOptions): string {
  const { fileMap } = options;
  const times = conversationTimes(detail);
  const lines = frontMatter(detail, options, times);

  // Title
  const title = detail.title ?? 'Untitled';
  lines.push(`# ${title}`);

  // Date, in the user's time zone
  if (times.created !== null) {
    lines.push(`*${localDate(times.created, options.timeZone)}*`);
  }

  const thread = getLinearThread(
    detail.mapping as unknown as Record<string, MappingNode>,
    detail.current_node,
  );

  let firstMessage = true;
  for (const node of thread) {
    const msg = node.message;
    if (!msg) continue;

    const role = msg.author.role;

    // Skip system and tool messages
    if (role === 'system' || role === 'tool') continue;

    // Skip hidden messages
    if (msg.metadata?.is_visually_hidden_from_conversation) continue;

    // Skip weight: 0 scaffolding
    if (msg.weight === 0) continue;

    // Extract text content
    let text = '';
    if (msg.content) {
      if (msg.content.parts && msg.content.parts.length > 0) {
        text = extractTextFromParts(msg.content.parts, fileMap);
      } else if (msg.content.text) {
        text = msg.content.text;
      }
    }

    // Skip empty messages (e.g. model_editable_context with no useful text)
    if (!text.trim()) continue;

    // Separator between messages
    if (firstMessage) {
      lines.push('');
      firstMessage = false;
    } else {
      lines.push('');
      lines.push('---');
      lines.push('');
    }

    lines.push(`**${formatRole(role)}:**`);
    lines.push('');
    lines.push(text);
  }

  lines.push('');
  return lines.join('\n');
}
