import type { ChatGPTClient } from './client.js';
import type {
  ConversationItem,
  ConversationsResponse,
  ProjectConversationsResponse,
  ProjectsSidebarResponse,
  SidebarItem,
} from './types.js';

export interface ConversationPage {
  items: ConversationItem[];
  total: number;
  /** Items listed so far, including this page. */
  fetched: number;
}

/** Pages of conversations, most recently updated first. Pacing comes from the client's scheduler. */
export async function* conversationPages(
  client: ChatGPTClient,
  options: { archived?: boolean; pageSize?: number; signal?: AbortSignal } = {}
): AsyncGenerator<ConversationPage, void, unknown> {
  const pageSize = options.pageSize ?? 100;
  let offset = 0;
  let total = Number.POSITIVE_INFINITY;

  while (offset < total) {
    const response: ConversationsResponse = await client.listConversations(offset, pageSize, options.archived, options.signal);
    total = response.total;
    // Advance by what actually came back, in case the server caps the page size.
    offset += response.items.length;
    yield { items: response.items, total: response.total, fetched: offset };
    if (response.items.length === 0) break;
  }
}

export async function fetchAllConversations(
  client: ChatGPTClient,
  options: { archived?: boolean; signal?: AbortSignal } = {}
): Promise<ConversationItem[]> {
  const all: ConversationItem[] = [];
  for await (const page of conversationPages(client, options)) all.push(...page.items);
  return all;
}

export async function fetchAllProjects(client: ChatGPTClient, options: { signal?: AbortSignal } = {}): Promise<SidebarItem[]> {
  const all: SidebarItem[] = [];
  let cursor: string | null = null;
  do {
    const response: ProjectsSidebarResponse = await client.listProjectsPage(cursor, options.signal);
    all.push(...response.items);
    const next: string | null = response.cursor ?? null;
    if (next === cursor) break;
    cursor = next;
  } while (cursor);
  return all;
}

export async function fetchProjectConversations(
  client: ChatGPTClient,
  gizmoId: string,
  options: { signal?: AbortSignal } = {}
): Promise<ConversationItem[]> {
  const all: ConversationItem[] = [];
  let cursor: string | null = '0';
  while (cursor !== null) {
    const response: ProjectConversationsResponse = await client.listProjectConversationsPage(gizmoId, cursor, options.signal);
    all.push(...response.items);
    const next: string | null = response.cursor ?? null;
    if (response.items.length === 0 || next === cursor) break;
    cursor = next;
  }
  return all;
}
