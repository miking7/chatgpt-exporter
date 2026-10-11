import type { ChatGPTClient } from '../api/client.js';
import { conversationPages, fetchAllProjects, fetchProjectConversations } from '../api/pagination.js';
import {
  AuthenticationError,
  NotFoundError,
  ThrottledError,
  type ConversationDetail,
  type ConversationItem,
  type SidebarItem,
} from '../api/types.js';
import { savedVersionOf, type SavedVersion, type StorageService } from './storage-service.js';
import type { SyncStateStore } from './sync-state.js';
import { abortError, isAbortError, toEpochSeconds } from '../utils/time.js';
import { errorMessage } from '../utils/format.js';

/** Read the whole list at least this often, so index.json drops deleted chats. */
const FULL_LISTING_MAX_AGE_MS = 30 * 24 * 3600 * 1000;
/** Stop when this many conversations fail back-to-back: something systemic is wrong. */
const MAX_CONSECUTIVE_FAILURES = 5;

export type StopReason = 'max-downloads' | 'throttled' | 'auth' | 'interrupted' | 'too-many-failures';

export interface BackupOptions {
  /** Re-download everything instead of only new/changed conversations. */
  full: boolean;
  /** Read the whole conversation list instead of stopping at the first unchanged page. */
  refreshList: boolean;
  includeArchived: boolean;
  /** Back up only this project (name or id). */
  project?: string;
  /** Epoch seconds: skip downloading conversations last updated before this. */
  since?: number;
  retryFailed: boolean;
  maxDownloads?: number;
  signal?: AbortSignal;
}

export interface SourceSummary {
  label: string;
  listed: number;
  complete: boolean;
}

export interface BackupPlan {
  sources: SourceSummary[];
  unique: number;
  upToDate: number;
  /** Copies between folders (e.g. into a project folder) of a version already downloaded. */
  copied: number;
  toDownload: number;
  skippedFailed: number;
  skippedSince: number;
}

export interface QueueEntry {
  id: string;
  title: string;
  updateTime: number | null;
}

export interface BackupEvents {
  /** Listing progress for one source: main list pages, archived chats, a project. */
  onListing?(label: string, fetched: number, total?: number): void;
  /** How many conversations are queued for download so far (grows while the list is read). */
  onQueued?(queued: number): void;
  /** The whole list has been read; downloads may already be under way. */
  onListingDone?(plan: BackupPlan): void;
  onWarning?(message: string): void;
  onDownloaded?(entry: QueueEntry, done: number): void;
  onFailed?(entry: QueueEntry, error: Error, done: number): void;
}

export interface BackupResult extends BackupPlan {
  downloaded: number;
  failed: number;
  /** Queued but not attempted (the next run picks them up). */
  remaining: number;
  stopReason?: StopReason;
  stopDetail?: string;
  errors: Array<{ conversationId: string; error: string }>;
  workspaceIds: string[];
}

export function stopReasonFor(error: unknown): StopReason | undefined {
  if (error instanceof ThrottledError) return 'throttled';
  if (error instanceof AuthenticationError) return 'auth';
  if (isAbortError(error)) return 'interrupted';
  return undefined;
}

function isUpToDate(saved: number | null, listed: number | null): boolean {
  return saved !== null && (listed === null || saved >= listed);
}

function sameVersion(cached: ConversationItem | undefined, fresh: ConversationItem): boolean {
  return cached !== undefined && toEpochSeconds(cached.update_time) === toEpochSeconds(fresh.update_time);
}

const shorten = (text: string) => (text.length > 300 ? `${text.slice(0, 300)}…` : text);

export class BackupService {
  constructor(
    private readonly client: ChatGPTClient,
    private readonly mainStorage: StorageService,
    private readonly sync: SyncStateStore,
    private readonly events: BackupEvents = {}
  ) {}

  /**
   * Reads the conversation list and downloads at the same time. Downloads start as soon as the first
   * page of the list arrives and go newest first, while the rest of the list is read in the background.
   */
  run(options: BackupOptions): Promise<BackupResult> {
    return new BackupRun(this.client, this.mainStorage, this.sync, this.events, options).execute();
  }
}

type Status = 'current' | 'queued' | 'downloading' | 'downloaded' | 'skipped';

interface Tracked {
  item: ConversationItem;
  updateTime: number | null;
  status: Status;
  /** A folder holding the current version, to copy from. */
  current?: StorageService;
  /** Folders waiting for the download. */
  targets: StorageService[];
}

class BackupRun {
  private readonly result: BackupResult = {
    sources: [],
    unique: 0,
    upToDate: 0,
    copied: 0,
    toDownload: 0,
    skippedFailed: 0,
    skippedSince: 0,
    downloaded: 0,
    failed: 0,
    remaining: 0,
    errors: [],
    workspaceIds: [],
  };
  private readonly tracked = new Map<string, Tracked>();
  /** Ids waiting to be downloaded (picked newest first). */
  private readonly queue: string[] = [];
  private readonly savedVersions = new Map<StorageService, Map<string, SavedVersion>>();
  /** Lets the run stop the listing without stopping everything (and vice versa via the run's signal). */
  private readonly stopListing = new AbortController();
  private readonly listSignal: AbortSignal;
  private listingDone = false;
  private listingError: unknown;
  private attempted = 0;
  private wake: (() => void) | null = null;

  constructor(
    private readonly client: ChatGPTClient,
    private readonly mainStorage: StorageService,
    private readonly sync: SyncStateStore,
    private readonly events: BackupEvents,
    private readonly options: BackupOptions
  ) {
    this.listSignal = options.signal ? AbortSignal.any([options.signal, this.stopListing.signal]) : this.stopListing.signal;
  }

  async execute(): Promise<BackupResult> {
    await this.mainStorage.initialize();
    await this.mainStorage.loadFileLinks();
    const wakeOnAbort = () => this.notify();
    this.options.signal?.addEventListener('abort', wakeOnAbort, { once: true });

    const listing = this.listEverything()
      .then(
        () => this.events.onListingDone?.(this.plan()),
        (error: unknown) => {
          this.listingError = error;
        }
      )
      .finally(() => {
        this.listingDone = true;
        this.notify();
      });

    let downloadError: unknown;
    try {
      await this.downloadLoop();
    } catch (error) {
      downloadError = error;
    }

    try {
      const downloadStop = downloadError === undefined ? undefined : stopReasonFor(downloadError);
      if (downloadStop) this.stop(downloadStop, errorMessage(downloadError));
      // A download cap lets the (cheap) listing finish so index.json stays complete; anything else stops it.
      const stopped = this.result.stopReason !== undefined && this.result.stopReason !== 'max-downloads';
      if (stopped || (downloadError !== undefined && !downloadStop)) this.stopListing.abort();
      await listing;
    } finally {
      this.options.signal?.removeEventListener('abort', wakeOnAbort);
      await this.sync.save();
    }

    if (downloadError !== undefined && !stopReasonFor(downloadError)) throw downloadError;
    if (this.listingError !== undefined) {
      const reason = stopReasonFor(this.listingError);
      if (!reason) throw this.listingError;
      this.stop(reason, errorMessage(this.listingError));
    }

    this.result.workspaceIds = [
      ...new Set([...this.tracked.values()].map((t) => t.item.workspace_id).filter((w): w is string => !!w)),
    ];
    this.result.remaining = Math.max(0, this.result.toDownload - this.result.downloaded - this.result.failed);
    return this.result;
  }

  // ── Coordination ──────────────────────────────────────────────────────────

  private notify(): void {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  /** Resolves on the next queue change, listing progress or Ctrl+C. */
  private nextEvent(): Promise<void> {
    return new Promise((resolve) => {
      this.wake = resolve;
    });
  }

  private stop(reason: StopReason, detail?: string): void {
    if (this.result.stopReason) return;
    this.result.stopReason = reason;
    this.result.stopDetail = detail;
  }

  private throwIfListingStopped(): void {
    if (this.listSignal.aborted) throw abortError(this.listSignal);
  }

  private plan(): BackupPlan {
    const { sources, unique, upToDate, copied, toDownload, skippedFailed, skippedSince } = this.result;
    return { sources: [...sources], unique, upToDate, copied, toDownload, skippedFailed, skippedSince };
  }

  private log(message: string): Promise<void> {
    return this.mainStorage.appendLog(message);
  }

  private async warn(message: string): Promise<void> {
    this.events.onWarning?.(message);
    await this.log(`Warning: ${message}`);
  }

  // ── Deciding what each listed conversation needs ──────────────────────────

  private async savedVersion(storage: StorageService, id: string): Promise<SavedVersion | null> {
    let versions = this.savedVersions.get(storage);
    if (!versions) {
      versions = await storage.loadSavedVersions();
      this.savedVersions.set(storage, versions);
    }
    return versions.get(id) ?? null;
  }

  /**
   * Renaming a chat doesn't always change its update_time, so titles are compared too. A listed title that a
   * fresh download already didn't match (the list and the conversation disagree) doesn't count.
   */
  private renamed(id: string, saved: SavedVersion, item: ConversationItem): boolean {
    const listed = item.title;
    if (typeof listed !== 'string' || listed === '' || listed === saved.title) return false;
    return !this.sync.knownTitleMismatch(id, listed);
  }

  private async save(storage: StorageService, id: string, detail: ConversationDetail): Promise<void> {
    await storage.saveConversation(id, detail);
    this.savedVersions.get(storage)?.set(id, savedVersionOf(detail));
  }

  private async copy(from: StorageService, to: StorageService, id: string): Promise<void> {
    const version = await to.copyConversationFrom(from, id);
    this.savedVersions.get(to)?.set(id, version);
    this.result.copied += 1;
  }

  /** Nothing, a copy from another folder, or a download: decided as each listed conversation arrives. */
  private async consider(item: ConversationItem, storage: StorageService): Promise<void> {
    const id = item.id;
    const listed = toEpochSeconds(item.update_time);
    const saved = this.options.full ? null : await this.savedVersion(storage, id);
    const upToDate = saved !== null && isUpToDate(saved.updateTime, listed) && !this.renamed(id, saved, item);
    const tracked = this.tracked.get(id);

    if (!tracked) {
      const entry: Tracked = { item, updateTime: listed, status: 'current', targets: [] };
      this.tracked.set(id, entry);
      this.result.unique += 1;
      if (upToDate) {
        entry.current = storage;
        this.result.upToDate += 1;
      } else if (this.options.since !== undefined && listed !== null && listed < this.options.since) {
        entry.status = 'skipped';
        this.result.skippedSince += 1;
      } else if (this.sync.shouldSkip(id, listed, this.options.retryFailed)) {
        entry.status = 'skipped';
        this.result.skippedFailed += 1;
      } else {
        entry.status = 'queued';
        entry.targets.push(storage);
        this.queue.push(id);
        this.result.toDownload += 1;
        this.events.onQueued?.(this.result.toDownload);
        this.notify();
      }
      return;
    }

    // Already seen in another folder (e.g. a project chat that's also in the main list).
    if (listed !== null && (tracked.updateTime === null || listed > tracked.updateTime)) {
      tracked.item = item;
      tracked.updateTime = listed;
    }
    switch (tracked.status) {
      case 'queued':
        if (upToDate) {
          // This folder already has it: copy it across instead of downloading.
          this.queue.splice(this.queue.indexOf(id), 1);
          for (const target of tracked.targets) await this.copy(storage, target, id);
          tracked.status = 'current';
          tracked.current = storage;
          tracked.targets = [];
          this.result.toDownload -= 1;
          this.events.onQueued?.(this.result.toDownload);
        } else if (!tracked.targets.includes(storage)) {
          tracked.targets.push(storage);
        }
        return;
      case 'downloading':
        if (!upToDate && !tracked.targets.includes(storage)) tracked.targets.push(storage);
        return;
      case 'current':
      case 'downloaded':
        if (!upToDate && tracked.current && tracked.current !== storage) await this.copy(tracked.current, storage, id);
        return;
      case 'skipped':
        return;
    }
  }

  // ── Listing ───────────────────────────────────────────────────────────────

  private async listEverything(): Promise<void> {
    if (!this.options.project) await this.listMain();
    await this.listProjects();
  }

  private async listMain(): Promise<void> {
    const storage = this.mainStorage;
    const cached = (await storage.loadIndex()) ?? [];
    const cachedMain = cached.filter((c) => !c.is_archived);
    let archived = cached.filter((c) => c.is_archived);
    const lastFull = Date.parse(this.sync.state.lastFullListingAt ?? '');
    const recentFullListing = Number.isFinite(lastFull) && Date.now() - lastFull < FULL_LISTING_MAX_AGE_MS;
    // The list is sorted by update time, so anything new or changed is above the first page
    // that exactly matches the previous listing; everything below it is unchanged.
    const canStopEarly = !this.options.refreshList && !this.options.full && recentFullListing && cachedMain.length > 0;
    const cachedById = new Map(cachedMain.map((c) => [c.id, c]));

    const items: ConversationItem[] = [];
    const seen = new Set<string>();
    let complete = false;
    let stoppedEarly = false;
    let pages = 0;
    try {
      for await (const page of conversationPages(this.client, { signal: this.listSignal })) {
        pages += 1;
        for (const item of page.items) {
          if (seen.has(item.id)) continue;
          seen.add(item.id);
          items.push(item);
          await this.consider(item, storage);
        }
        this.events.onListing?.('Conversations', page.fetched, page.total);
        if (canStopEarly && page.items.length > 0 && page.items.every((item) => sameVersion(cachedById.get(item.id), item))) {
          stoppedEarly = true;
          break;
        }
      }
      complete = !stoppedEarly;
      if (complete) this.sync.state.lastFullListingAt = new Date().toISOString();

      const unchanged = stoppedEarly ? cachedMain.filter((c) => !seen.has(c.id)) : [];
      for (const c of unchanged) {
        seen.add(c.id);
        items.push(c);
      }
      for (const c of unchanged) {
        this.throwIfListingStopped();
        await this.consider(c, storage);
      }

      if (this.options.includeArchived) {
        const fresh = await this.listArchived();
        if (fresh) archived = fresh;
      }
      archived = archived.filter((c) => !seen.has(c.id));
      if (this.options.includeArchived) {
        for (const c of archived) {
          this.throwIfListingStopped();
          await this.consider(c, storage);
        }
      }

      this.result.sources.push({ label: 'Conversations', listed: items.length + archived.length, complete });
      await this.log(
        `Listed ${items.length} conversations` +
          (complete ? '' : ` (read ${pages} page${pages === 1 ? '' : 's'}; the rest are unchanged since the last listing)`) +
          (this.options.includeArchived ? `, ${archived.length} archived` : '')
      );
    } finally {
      // Keep index.json complete even if the listing was cut short, filling in from the last one.
      const listedIds = new Set(items.map((c) => c.id));
      const main = complete ? items : [...items, ...cachedMain.filter((c) => !listedIds.has(c.id))];
      const mainIds = new Set(main.map((c) => c.id));
      await storage.saveIndex([...main, ...archived.filter((c) => !mainIds.has(c.id))]);
    }
  }

  private async listArchived(): Promise<ConversationItem[] | null> {
    const items: ConversationItem[] = [];
    try {
      for await (const page of conversationPages(this.client, { archived: true, signal: this.listSignal })) {
        if (page.items.some((item) => item.is_archived !== true)) {
          await this.warn('ChatGPT ignored the archived-chats filter, so archived chats were skipped this run.');
          return null;
        }
        items.push(...page.items);
        this.events.onListing?.('Archived', page.fetched, page.total);
      }
    } catch (error) {
      if (stopReasonFor(error)) throw error;
      await this.warn(`Couldn't list archived chats: ${errorMessage(error)}`);
      return null;
    }
    return items;
  }

  private async listProjects(): Promise<void> {
    let projects: SidebarItem[];
    try {
      projects = await fetchAllProjects(this.client, { signal: this.listSignal });
    } catch (error) {
      if (this.options.project || stopReasonFor(error)) throw error;
      await this.warn(`Couldn't list projects: ${errorMessage(error)}`);
      return;
    }

    let selected = projects;
    if (this.options.project) {
      const wanted = this.options.project.toLowerCase();
      const match = projects.find(
        (p) => p.gizmo.id === this.options.project || p.gizmo.display.name.toLowerCase() === wanted
      );
      if (!match) {
        const available = projects.map((p) => p.gizmo.display.name).join(', ') || '(none)';
        throw new Error(`Project "${this.options.project}" not found. Available projects: ${available}`);
      }
      selected = [match];
    }

    for (const project of selected) {
      const name = project.gizmo.display.name;
      try {
        const items = await fetchProjectConversations(this.client, project.gizmo.id, { signal: this.listSignal });
        const storage = this.mainStorage.forProject(name);
        await storage.initialize();
        await storage.loadFileLinks();
        await storage.saveIndex(items);
        this.events.onListing?.(`Project: ${name}`, items.length, items.length);
        this.result.sources.push({ label: name, listed: items.length, complete: true });
        for (const item of items) {
          this.throwIfListingStopped();
          await this.consider(item, storage);
        }
      } catch (error) {
        if (this.options.project || stopReasonFor(error)) throw error;
        await this.warn(`Couldn't list project "${name}": ${errorMessage(error)}`);
      }
    }
  }

  // ── Downloading ───────────────────────────────────────────────────────────

  /**
   * The newest queued conversation. Pages arrive newest first and only listed conversations are queued,
   * so this keeps the whole run newest first even while later pages are still being read.
   */
  private takeNext(): string | undefined {
    let best = -1;
    let bestTime = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < this.queue.length; i++) {
      const time = this.tracked.get(this.queue[i])!.updateTime ?? Number.NEGATIVE_INFINITY;
      if (best === -1 || time > bestTime) {
        best = i;
        bestTime = time;
      }
    }
    return best === -1 ? undefined : this.queue.splice(best, 1)[0];
  }

  private async downloadLoop(): Promise<void> {
    const maxDownloads = this.options.maxDownloads ?? Number.POSITIVE_INFINITY;
    let consecutiveFailures = 0;

    for (;;) {
      if (this.options.signal?.aborted) return this.stop('interrupted');
      if (this.listingError !== undefined) return;

      if (this.result.downloaded >= maxDownloads) {
        // Let the listing finish (it's quick) so we know whether anything was left over.
        while (!this.listingDone && !this.options.signal?.aborted) await this.nextEvent();
        if (this.options.signal?.aborted) return this.stop('interrupted');
        if (this.queue.length > 0) this.stop('max-downloads');
        return;
      }

      const id = this.takeNext();
      if (id === undefined) {
        if (this.listingDone) return;
        await this.nextEvent();
        continue;
      }

      const tracked = this.tracked.get(id)!;
      tracked.status = 'downloading';
      const entry: QueueEntry = { id, title: tracked.item.title ?? 'Untitled', updateTime: tracked.updateTime };
      try {
        const detail = await this.client.getConversation(id);
        // Read targets after the download: a project listing may have added folders meanwhile.
        for (const storage of tracked.targets) await this.save(storage, id, detail);
        tracked.status = 'downloaded';
        tracked.current = tracked.targets[0];
        tracked.targets = [];
        this.attempted += 1;
        this.result.downloaded += 1;
        consecutiveFailures = 0;
        this.sync.clearFailure(id);
        this.sync.noteTitle(id, tracked.item.title, detail.title);
        await this.log(`Downloaded: ${id} - ${entry.title}`);
        this.events.onDownloaded?.(entry, this.attempted);
      } catch (error) {
        if (stopReasonFor(error)) throw error;
        const message = shorten(errorMessage(error));
        const gone = error instanceof NotFoundError;
        tracked.status = 'skipped';
        tracked.targets = [];
        this.attempted += 1;
        this.result.failed += 1;
        this.result.errors.push({ conversationId: id, error: message });
        this.sync.recordFailure(id, message, entry.updateTime, gone);
        await this.log(`Failed: ${id} - ${message}`);
        this.events.onFailed?.(entry, error instanceof Error ? error : new Error(message), this.attempted);
        if (!gone && ++consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return this.stop('too-many-failures', message);
      }

      if (this.attempted % 20 === 0) await this.sync.save();
    }
  }
}
