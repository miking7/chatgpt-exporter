#!/usr/bin/env node

// src/cli/index.ts
import { Command, InvalidArgumentError, Option } from "commander";

// src/config/settings.ts
import fs2 from "fs";
import fsp from "fs/promises";
import os from "os";
import path2 from "path";

// src/config/env-file.ts
import fs from "fs/promises";
import path from "path";
var LINE_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;
function parseEnv(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(#|$)/.test(line)) continue;
    const match = LINE_RE.exec(line);
    if (match) values[match[1]] = parseValue(match[2]);
  }
  return values;
}
function parseValue(raw) {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\(.)/g, (_, c) => c === "n" ? "\n" : c);
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  const comment = value.search(/\s#/);
  return (comment >= 0 ? value.slice(0, comment) : value).trim();
}
function formatEnvValue(value) {
  if (/^[A-Za-z0-9_./:@+-]+$/.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}
async function updateEnvFile(filePath, updates, headerForNewFile = "") {
  let text;
  try {
    text = await fs.readFile(filePath, "utf-8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    text = headerForNewFile;
  }
  const pending = new Map(Object.entries(updates));
  const handled = /* @__PURE__ */ new Set();
  const lines = [];
  for (const line of text.split(/\r?\n/)) {
    const key = LINE_RE.exec(line)?.[1];
    if (key && Object.hasOwn(updates, key)) {
      if (!handled.has(key)) {
        handled.add(key);
        const value = pending.get(key);
        if (value !== void 0) lines.push(`${key}=${formatEnvValue(value)}`);
      }
      pending.delete(key);
      continue;
    }
    lines.push(line);
  }
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  for (const [key, value] of pending) {
    if (value !== void 0) lines.push(`${key}=${formatEnvValue(value)}`);
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${lines.join("\n")}
`, { mode: 384 });
  await fs.rename(tmp, filePath);
  await fs.chmod(filePath, 384);
}

// src/config/settings.ts
var APP_NAME = "chatgpt-exporter";
var CONFIG_FILE = "config.env";
var ENV = {
  token: "CHATGPT_TOKEN",
  accountId: "CHATGPT_ACCOUNT_ID",
  exportDir: "CHATGPT_EXPORT_DIR",
  pace: "CHATGPT_PACE_SECONDS",
  burst: "CHATGPT_BURST",
  /** IANA time zone for dates in the Markdown and its file names; saved on the first run. */
  timeZone: "CHATGPT_TIMEZONE",
  /** Overrides the config folder (e.g. one folder per workspace). */
  home: "CHATGPT_EXPORTER_HOME"
};
var DEFAULT_PACE_SECONDS = 90;
var DEFAULT_BURST = 30;
var CONFIG_HEADER = `# chatgpt-exporter settings (KEY=VALUE, the same format as a .env file).
# Private: this file holds your ChatGPT access token. \`chatgpt-exporter login\` updates
# CHATGPT_TOKEN (and CHATGPT_ACCOUNT_ID for Team/Business workspaces).
#
# CHATGPT_EXPORT_DIR     folder the archive is kept in
# CHATGPT_PACE_SECONDS   average seconds between conversation downloads (default ${DEFAULT_PACE_SECONDS})
# CHATGPT_BURST          downloads allowed back-to-back after a quiet period (default ${DEFAULT_BURST})
# CHATGPT_TIMEZONE       time zone for dates in the archive (set to this computer's zone on the first run)
`;
function expandHome(p) {
  return p === "~" || p.startsWith("~/") ? path2.join(os.homedir(), p.slice(1)) : p;
}
function configDir() {
  const override = process.env[ENV.home];
  if (override) return path2.resolve(expandHome(override));
  if (process.platform === "win32" && process.env.APPDATA) return path2.join(process.env.APPDATA, APP_NAME);
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && path2.isAbsolute(xdg) ? xdg : path2.join(os.homedir(), ".config");
  return path2.join(base, APP_NAME);
}
function defaultOutputDir() {
  const documents = path2.join(os.homedir(), "Documents");
  const base = fs2.existsSync(documents) ? documents : os.homedir();
  return path2.join(base, "chatgpt-export");
}
async function loadSettings() {
  const dir = configDir();
  const configPath = path2.join(dir, CONFIG_FILE);
  let env = {};
  try {
    env = parseEnv(await fsp.readFile(configPath, "utf-8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return { configDir: dir, configPath, stateDir: dir, env };
}
function getSetting(settings, key) {
  const value = process.env[key] ?? settings.env[key];
  return value === void 0 || value.trim() === "" ? void 0 : value;
}
function isOutputDirConfigured(settings) {
  return getSetting(settings, ENV.exportDir) !== void 0;
}
function resolveOutputDir(settings, flag) {
  return path2.resolve(expandHome(flag ?? getSetting(settings, ENV.exportDir) ?? defaultOutputDir()));
}
function resolveTimeZone(settings) {
  const configured = getSetting(settings, ENV.timeZone);
  if (configured === void 0) return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: configured });
  } catch {
    throw new Error(`${ENV.timeZone} must be a time zone such as Australia/Melbourne (got "${configured}")`);
  }
  return configured;
}
async function ensureTimeZone(settings) {
  const zone = resolveTimeZone(settings);
  if (getSetting(settings, ENV.timeZone) === void 0) await saveSettings(settings, { [ENV.timeZone]: zone });
  return zone;
}
async function saveSettings(settings, updates) {
  await updateEnvFile(settings.configPath, updates, CONFIG_HEADER);
  for (const [key, value] of Object.entries(updates)) {
    if (value === void 0) delete settings.env[key];
    else settings.env[key] = value;
  }
}
function saveCredentials(settings, credentials) {
  return saveSettings(settings, { [ENV.token]: credentials.accessToken, [ENV.accountId]: credentials.accountId });
}
function clearSavedToken(settings) {
  return saveSettings(settings, { [ENV.token]: void 0 });
}

// src/cli/commands/backup.ts
import fs10 from "fs/promises";
import path11 from "path";
import chalk5 from "chalk";

// src/api/pagination.ts
async function* conversationPages(client, options = {}) {
  const pageSize = options.pageSize ?? 100;
  let offset = 0;
  let total = Number.POSITIVE_INFINITY;
  while (offset < total) {
    const response = await client.listConversations(offset, pageSize, options.archived, options.signal);
    total = response.total;
    offset += response.items.length;
    yield { items: response.items, total: response.total, fetched: offset };
    if (response.items.length === 0) break;
  }
}
async function fetchAllConversations(client, options = {}) {
  const all = [];
  for await (const page of conversationPages(client, options)) all.push(...page.items);
  return all;
}
async function fetchAllProjects(client, options = {}) {
  const all = [];
  let cursor = null;
  do {
    const response = await client.listProjectsPage(cursor, options.signal);
    all.push(...response.items);
    const next = response.cursor ?? null;
    if (next === cursor) break;
    cursor = next;
  } while (cursor);
  return all;
}
async function fetchProjectConversations(client, gizmoId, options = {}) {
  const all = [];
  let cursor = "0";
  while (cursor !== null) {
    const response = await client.listProjectConversationsPage(gizmoId, cursor, options.signal);
    all.push(...response.items);
    const next = response.cursor ?? null;
    if (response.items.length === 0 || next === cursor) break;
    cursor = next;
  }
  return all;
}

// src/api/types.ts
import { z } from "zod";
var SessionSchema = z.looseObject({
  accessToken: z.string(),
  user: z.looseObject({
    id: z.string(),
    name: z.string().optional(),
    email: z.string().optional(),
    image: z.string().optional()
  }).optional(),
  expires: z.string().optional()
});
var ConversationItemSchema = z.looseObject({
  id: z.string(),
  title: z.string().nullable(),
  create_time: z.string().or(z.number()).nullable(),
  update_time: z.string().or(z.number()).nullable(),
  mapping: z.record(z.string(), z.unknown()).nullable().optional(),
  current_node: z.string().nullable().optional(),
  conversation_template_id: z.string().nullable().optional(),
  gizmo_id: z.string().nullable().optional(),
  is_archived: z.boolean().optional(),
  workspace_id: z.string().nullable().optional()
});
var ConversationsResponseSchema = z.looseObject({
  items: z.array(ConversationItemSchema),
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
  has_missing_conversations: z.boolean().optional()
});
var MessageContentSchema = z.looseObject({
  content_type: z.string(),
  parts: z.array(z.unknown()).optional(),
  text: z.string().optional()
});
var MessageSchema = z.looseObject({
  id: z.string(),
  author: z.looseObject({
    role: z.string(),
    name: z.string().nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).optional()
  }),
  create_time: z.number().nullable().optional(),
  update_time: z.number().nullable().optional(),
  content: MessageContentSchema.optional(),
  status: z.string().optional(),
  end_turn: z.boolean().nullable().optional(),
  weight: z.number().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  recipient: z.string().optional()
});
var MappingNodeSchema = z.looseObject({
  id: z.string(),
  message: MessageSchema.nullable().optional(),
  parent: z.string().nullable().optional(),
  children: z.array(z.string()).optional()
});
var ConversationDetailSchema = z.looseObject({
  id: z.string().optional(),
  title: z.string().nullable(),
  create_time: z.number().nullable(),
  update_time: z.number().nullable(),
  mapping: z.record(z.string(), MappingNodeSchema),
  moderation_results: z.array(z.unknown()).optional(),
  current_node: z.string().nullable().optional(),
  conversation_id: z.string().optional(),
  is_archived: z.boolean().optional()
});
var ProjectGizmoSchema = z.looseObject({
  id: z.string(),
  display: z.looseObject({
    name: z.string(),
    theme: z.unknown().optional()
  }),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  last_interacted_at: z.string().nullable().optional(),
  num_interactions: z.number().optional(),
  is_archived: z.boolean().optional(),
  gizmo_type: z.string().optional()
});
var SidebarItemSchema = z.looseObject({
  gizmo: ProjectGizmoSchema
});
var ProjectsSidebarResponseSchema = z.looseObject({
  items: z.array(SidebarItemSchema),
  cursor: z.string().nullable().optional()
});
var ProjectConversationsResponseSchema = z.looseObject({
  items: z.array(ConversationItemSchema),
  cursor: z.string().nullable().optional()
});
var AuthenticationError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "AuthenticationError";
  }
};
var ThrottledError = class extends Error {
  resumeAt;
  constructor(message, resumeAt) {
    super(message);
    this.name = "ThrottledError";
    this.resumeAt = resumeAt;
  }
};
var NetworkError = class extends Error {
  statusCode;
  constructor(message, statusCode) {
    super(message);
    this.name = "NetworkError";
    this.statusCode = statusCode;
  }
};
var HttpError = class extends Error {
  statusCode;
  constructor(message, statusCode) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
  }
};
var NotFoundError = class extends HttpError {
  constructor(message) {
    super(message, 404);
    this.name = "NotFoundError";
  }
};

// src/services/storage-service.ts
import fs4 from "fs/promises";
import path4 from "path";

// src/utils/time.ts
function abortError(signal) {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}
function isAbortError(error) {
  return error instanceof Error && error.name === "AbortError";
}
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, ms));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
var systemClock = {
  now: () => Date.now(),
  sleep
};
function toEpochSeconds(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value === "") return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms / 1e3;
}
var zoneFormatters = /* @__PURE__ */ new Map();
function zoneParts(epochSeconds, timeZone) {
  let formatter = zoneFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
      timeZoneName: "longOffset"
    });
    zoneFormatters.set(timeZone, formatter);
  }
  const parts = {};
  for (const part of formatter.formatToParts(new Date(epochSeconds * 1e3))) parts[part.type] = part.value;
  return parts;
}
function localDate(epochSeconds, timeZone) {
  const p = zoneParts(epochSeconds, timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}
function formatIsoLocal(epochSeconds, timeZone) {
  const p = zoneParts(epochSeconds, timeZone);
  const offset = p.timeZoneName === "GMT" ? "+00:00" : p.timeZoneName.replace("GMT", "");
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${offset}`;
}

// src/services/file-service.ts
import fs3 from "fs/promises";
import path3 from "path";

// src/api/endpoints.ts
var DEFAULT_BASE_URL = "https://chatgpt.com";
var ENDPOINTS = {
  SESSION: "/api/auth/session",
  CONVERSATIONS: "/backend-api/conversations",
  CONVERSATION: (id) => `/backend-api/conversation/${id}`,
  PROJECTS_SIDEBAR: "/backend-api/gizmos/snorlax/sidebar",
  PROJECT_CONVERSATIONS: (gizmoId) => `/backend-api/gizmos/${gizmoId}/conversations`,
  FILE_DOWNLOAD: (fileId) => `/backend-api/files/download/${fileId}`
};
function resolveBaseUrl(explicit) {
  if (explicit) return explicit.replace(/\/+$/, "");
  const fromEnv = process.env.CHATGPT_BASE_URL;
  if (fromEnv && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(fromEnv)) {
    return fromEnv.replace(/\/+$/, "");
  }
  return DEFAULT_BASE_URL;
}

// src/services/file-service.ts
var FILE_SERVICE_PREFIX = "file-service://";
function extractFileIdFromPointer(pointer) {
  if (!pointer.startsWith(FILE_SERVICE_PREFIX)) return null;
  return pointer.slice(FILE_SERVICE_PREFIX.length);
}
function extractFileReferences(detail) {
  const refs = /* @__PURE__ */ new Map();
  for (const node of Object.values(detail.mapping)) {
    const msg = node.message;
    if (!msg) continue;
    if (msg.content?.parts) {
      for (const part of msg.content.parts) {
        if (part && typeof part === "object") {
          const obj = part;
          if (obj.content_type === "image_asset_pointer") {
            const pointer = obj.asset_pointer;
            if (pointer) {
              const fileId = extractFileIdFromPointer(pointer);
              if (fileId && !refs.has(fileId)) {
                refs.set(fileId, { fileId, source: "image_asset_pointer" });
              }
            }
          }
        }
      }
    }
    const metadata = msg.metadata;
    if (metadata?.attachments && Array.isArray(metadata.attachments)) {
      for (const att of metadata.attachments) {
        const a = att;
        const id = a.id;
        if (id && !refs.has(id)) {
          refs.set(id, {
            fileId: id,
            filename: a.name,
            source: "attachment"
          });
        }
      }
    }
    if (metadata?.citations && Array.isArray(metadata.citations)) {
      for (const cit of metadata.citations) {
        const c = cit;
        const metadata2 = c.metadata;
        const fileId = metadata2?.file_id ?? c.file_id;
        if (fileId && !refs.has(fileId)) {
          refs.set(fileId, {
            fileId,
            filename: metadata2?.title ?? c.title,
            source: "citation"
          });
        }
      }
    }
  }
  return Array.from(refs.values());
}
async function scanAllConversations(inputDir) {
  const refs = /* @__PURE__ */ new Map();
  const jsonFiles = await collectAllJsonFiles(inputDir);
  for (const jsonPath of jsonFiles) {
    try {
      const raw = await fs3.readFile(jsonPath, "utf-8");
      const detail = JSON.parse(raw);
      for (const ref of extractFileReferences(detail)) {
        if (!refs.has(ref.fileId)) {
          refs.set(ref.fileId, ref);
        }
      }
    } catch {
    }
  }
  return Array.from(refs.values());
}
async function findJsonFiles(dir) {
  const files = [];
  try {
    const entries = await fs3.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path3.join(dir, entry.name);
      if (entry.isFile() && entry.name.endsWith(".json") && entry.name !== "index.json") {
        files.push(fullPath);
      }
    }
  } catch {
  }
  return files;
}
async function collectAllJsonFiles(inputDir) {
  const files = [];
  const mainDir = path3.join(inputDir, "conversations");
  files.push(...await findJsonFiles(mainDir));
  const projectsDir = path3.join(inputDir, "projects");
  try {
    const projectEntries = await fs3.readdir(projectsDir, { withFileTypes: true });
    for (const entry of projectEntries) {
      if (entry.isDirectory()) {
        const projectConvDir = path3.join(projectsDir, entry.name, "conversations");
        files.push(...await findJsonFiles(projectConvDir));
      }
    }
  } catch {
  }
  return files;
}
async function dirHasFiles(dir) {
  try {
    const entries = await fs3.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile()) return true;
      if (entry.isDirectory()) {
        if (await dirHasFiles(path3.join(dir, entry.name))) return true;
      }
    }
  } catch {
  }
  return false;
}
async function downloadFiles(client, allRefs, outputDir, options) {
  const { verbose, skipFileIds, signal, onProgress, onError } = options;
  const filesDir = path3.join(outputDir, "files");
  const refs = skipFileIds && skipFileIds.size > 0 ? allRefs.filter((ref) => !skipFileIds.has(ref.fileId)) : allRefs;
  let downloaded = 0;
  let skipped = 0;
  let failed = 0;
  let completed = 0;
  const failedFileIds = [];
  const reportProgress = () => {
    completed++;
    onProgress?.(completed, refs.length, { downloaded, skipped, failed });
  };
  for (const ref of refs) {
    if (signal?.aborted) break;
    const fileDir = path3.join(filesDir, ref.fileId);
    if (await dirHasFiles(fileDir)) {
      skipped++;
      reportProgress();
      continue;
    }
    try {
      const meta = await client.getJson("file", ENDPOINTS.FILE_DOWNLOAD(ref.fileId), (data) => data);
      if (!meta.download_url) {
        throw new Error("File not available");
      }
      const buffer = await client.fetchRaw(meta.download_url);
      const filename = meta.file_name || ref.filename || ref.fileId;
      const filePath = path3.join(fileDir, filename);
      await fs3.mkdir(path3.dirname(filePath), { recursive: true });
      await fs3.writeFile(filePath, Buffer.from(buffer));
      downloaded++;
      if (verbose) {
        console.log(`  Downloaded file: ${ref.fileId} \u2192 ${filename}`);
      }
    } catch (error) {
      if (error instanceof ThrottledError || error instanceof AuthenticationError || isAbortError(error)) {
        throw error;
      }
      failed++;
      failedFileIds.push(ref.fileId);
      onError?.(ref.fileId, error);
    }
    reportProgress();
  }
  return { downloaded, skipped, failed, total: refs.length, failedFileIds };
}
async function findFirstFile(dir) {
  try {
    const entries = await fs3.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile()) return entry.name;
      if (entry.isDirectory()) {
        const nested = await findFirstFile(path3.join(dir, entry.name));
        if (nested) return path3.join(entry.name, nested);
      }
    }
  } catch {
  }
  return null;
}
async function buildFileMap(filesDir) {
  const fileMap = /* @__PURE__ */ new Map();
  try {
    const fileIdDirs = await fs3.readdir(filesDir, { withFileTypes: true });
    for (const entry of fileIdDirs) {
      if (!entry.isDirectory()) continue;
      const fileId = entry.name;
      const dirPath = path3.join(filesDir, fileId);
      const relFile = await findFirstFile(dirPath);
      if (relFile) {
        fileMap.set(fileId, path3.join("files", fileId, relFile));
      }
    }
  } catch {
  }
  return fileMap;
}

// src/services/markdown-service.ts
function extractTextFromParts(parts, fileMap) {
  const pieces = [];
  for (const part of parts) {
    if (typeof part === "string") {
      pieces.push(part);
    } else if (part && typeof part === "object") {
      const obj = part;
      if (obj.content_type === "image_asset_pointer") {
        const pointer = obj.asset_pointer;
        if (pointer && fileMap) {
          const fileId = pointer.startsWith("file-service://") ? pointer.slice("file-service://".length) : null;
          if (fileId && fileMap.has(fileId)) {
            pieces.push(`![image](${fileMap.get(fileId)})`);
            continue;
          }
        }
        pieces.push(`![image](${pointer ?? "unknown"})`);
      }
    }
  }
  return pieces.join("\n");
}
function getLinearThread(mapping, currentNode) {
  if (currentNode && mapping[currentNode]) {
    const path13 = [];
    let nodeId = currentNode;
    while (nodeId && mapping[nodeId]) {
      path13.unshift(mapping[nodeId]);
      nodeId = mapping[nodeId].parent;
    }
    return path13;
  }
  let root;
  for (const node of Object.values(mapping)) {
    if (node.parent === null || node.parent === void 0) {
      root = node;
      break;
    }
  }
  if (!root) return [];
  const thread = [root];
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
function formatRole(role) {
  switch (role) {
    case "user":
      return "User";
    case "assistant":
      return "Assistant";
    default:
      return role.charAt(0).toUpperCase() + role.slice(1);
  }
}
var isTimestamp = (value) => typeof value === "number" && Number.isFinite(value) && value > 0;
function conversationTimes(detail) {
  const ownCreated = isTimestamp(detail.create_time) ? detail.create_time : null;
  const ownUpdated = isTimestamp(detail.update_time) ? detail.update_time : null;
  if (ownCreated !== null && ownUpdated !== null) return { created: ownCreated, updated: ownUpdated };
  let first = null;
  let last = null;
  for (const node of Object.values(detail.mapping ?? {})) {
    const time = node.message?.create_time;
    if (!isTimestamp(time)) continue;
    if (first === null || time < first) first = time;
    if (last === null || time > last) last = time;
  }
  const created = ownCreated ?? first ?? ownUpdated;
  return { created, updated: ownUpdated ?? last ?? created };
}
function frontMatter(detail, options, times) {
  const lines = [
    "---",
    `id: ${options.id}`,
    `url: https://chatgpt.com/c/${options.id}`,
    // A JSON string is also a valid YAML double-quoted string, whatever the title contains.
    `title: ${JSON.stringify(detail.title ?? "Untitled")}`
  ];
  if (times.created !== null) lines.push(`created: ${formatIsoLocal(times.created, options.timeZone)}`);
  if (times.updated !== null) lines.push(`updated: ${formatIsoLocal(times.updated, options.timeZone)}`);
  lines.push("---", "");
  return lines;
}
function convertConversation(detail, options) {
  const { fileMap } = options;
  const times = conversationTimes(detail);
  const lines = frontMatter(detail, options, times);
  const title = detail.title ?? "Untitled";
  lines.push(`# ${title}`);
  if (times.created !== null) {
    lines.push(`*${localDate(times.created, options.timeZone)}*`);
  }
  const thread = getLinearThread(
    detail.mapping,
    detail.current_node
  );
  let firstMessage = true;
  for (const node of thread) {
    const msg = node.message;
    if (!msg) continue;
    const role = msg.author.role;
    if (role === "system" || role === "tool") continue;
    if (msg.metadata?.is_visually_hidden_from_conversation) continue;
    if (msg.weight === 0) continue;
    let text = "";
    if (msg.content) {
      if (msg.content.parts && msg.content.parts.length > 0) {
        text = extractTextFromParts(msg.content.parts, fileMap);
      } else if (msg.content.text) {
        text = msg.content.text;
      }
    }
    if (!text.trim()) continue;
    if (firstMessage) {
      lines.push("");
      firstMessage = false;
    } else {
      lines.push("");
      lines.push("---");
      lines.push("");
    }
    lines.push(`**${formatRole(role)}:**`);
    lines.push("");
    lines.push(text);
  }
  lines.push("");
  return lines.join("\n");
}

// src/services/storage-service.ts
var MARKDOWN_FORMAT = 2;
function projectFolderName(projectName) {
  return projectName.replace(/[^a-zA-Z0-9_-]/g, "_");
}
function savedVersionOf(detail) {
  return {
    updateTime: typeof detail.update_time === "number" ? detail.update_time : null,
    title: typeof detail.title === "string" ? detail.title : null
  };
}
var StorageService = class _StorageService {
  outputDir;
  conversationsDir;
  /** "Conversations" for the main folder, otherwise the project name. */
  label;
  timeZone;
  fileLinks;
  constructor(outputDir, options) {
    this.outputDir = outputDir;
    this.timeZone = options.timeZone;
    this.label = options.projectName ?? options.projectFolder ?? "Conversations";
    const folder = options.projectFolder ?? (options.projectName === void 0 ? void 0 : projectFolderName(options.projectName));
    this.conversationsDir = folder === void 0 ? path4.join(outputDir, "conversations") : path4.join(outputDir, "projects", folder, "conversations");
  }
  /** This archive's folder for a project. */
  forProject(projectName) {
    return new _StorageService(this.outputDir, { timeZone: this.timeZone, projectName });
  }
  async initialize() {
    await fs4.mkdir(this.conversationsDir, { recursive: true });
    await removeStaleTempFiles(this.conversationsDir);
  }
  jsonPath(id) {
    return path4.join(this.conversationsDir, `${id}.json`);
  }
  markdownPath(id) {
    return path4.join(this.conversationsDir, `${id}.md`);
  }
  /** Lets Markdown written during the run link to files already downloaded into files/. */
  async loadFileLinks() {
    const globalMap = await buildFileMap(path4.join(this.outputDir, "files"));
    if (globalMap.size === 0) return;
    this.fileLinks = /* @__PURE__ */ new Map();
    for (const [fileId, filePath] of globalMap) {
      this.fileLinks.set(fileId, path4.relative(this.conversationsDir, path4.join(this.outputDir, filePath)));
    }
  }
  /**
   * Writes the Markdown and the JSON straight away, so an interrupted run leaves no gaps. The Markdown goes
   * first: the JSON is what marks a conversation as saved, so a save cut short in between is redone next run.
   */
  async saveConversation(id, data) {
    const times = conversationTimes(data);
    await this.saveMarkdown(id, data, times);
    await writeAtomic(this.jsonPath(id), JSON.stringify(data, null, 2));
    await stampTimes(this.jsonPath(id), times);
  }
  /** Regenerates one conversation's Markdown from its saved JSON and restores both files' dates. */
  async refreshMarkdown(id) {
    const data = JSON.parse(await fs4.readFile(this.jsonPath(id), "utf-8"));
    const times = conversationTimes(data);
    const written = await this.saveMarkdown(id, data, times);
    await stampTimes(this.jsonPath(id), times);
    return written ? "written" : "unchanged";
  }
  /** Rewrites the Markdown only when it changed, then gives it the chat's dates; returns whether it was written. */
  async saveMarkdown(id, data, times) {
    const file = this.markdownPath(id);
    const markdown = convertConversation(data, { id, timeZone: this.timeZone, fileMap: this.fileLinks });
    const changed = await readTextIfExists(file) !== markdown;
    if (changed) await writeAtomic(file, markdown);
    await stampTimes(file, times);
    return changed;
  }
  /** Copies a conversation saved in another folder; returns the version copied. */
  async copyConversationFrom(source, id) {
    const detail = JSON.parse(await fs4.readFile(source.jsonPath(id), "utf-8"));
    await this.saveConversation(id, detail);
    return savedVersionOf(detail);
  }
  async saveIndex(conversations) {
    await writeAtomic(path4.join(this.conversationsDir, "index.json"), JSON.stringify(conversations, null, 2));
  }
  async loadIndex() {
    try {
      const parsed = JSON.parse(await fs4.readFile(path4.join(this.conversationsDir, "index.json"), "utf-8"));
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  async appendLog(message) {
    const filePath = path4.join(this.outputDir, "backup.log");
    await fs4.appendFile(filePath, `[${(/* @__PURE__ */ new Date()).toISOString()}] ${message}
`, "utf-8");
  }
  async conversationExists(id) {
    try {
      await fs4.access(this.jsonPath(id));
      return true;
    } catch {
      return false;
    }
  }
  /** Ids of the conversations saved in this folder. */
  async savedIds() {
    let names;
    try {
      names = await fs4.readdir(this.conversationsDir);
    } catch {
      return [];
    }
    return names.filter((name) => name.endsWith(".json") && name !== "index.json").map((name) => name.slice(0, -".json".length));
  }
  async getExistingConversationVersion(id) {
    try {
      return savedVersionOf(JSON.parse(await fs4.readFile(this.jsonPath(id), "utf-8")));
    } catch {
      return null;
    }
  }
  /**
   * update_time and title of every saved conversation, keyed by id. Reads only the top of each file
   * (~15× faster than parsing ~300 MB of JSON) and falls back to a full parse if needed.
   */
  async loadSavedVersions() {
    const versions = /* @__PURE__ */ new Map();
    const buffer = Buffer.alloc(4096);
    for (const id of await this.savedIds()) {
      const version = await this.readVersionFromHead(id, buffer);
      if (version) versions.set(id, version);
    }
    return versions;
  }
  async readVersionFromHead(id, buffer) {
    let head;
    try {
      const handle = await fs4.open(this.jsonPath(id), "r");
      try {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        head = buffer.toString("utf8", 0, bytesRead);
      } finally {
        await handle.close();
      }
    } catch {
      return null;
    }
    const update = /^ {2}"update_time": (-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|null),?\r?$/m.exec(head);
    const title = /^ {2}"title": (null|"(?:[^"\\]|\\.)*"),?\r?$/m.exec(head);
    if (!update || !title) return this.getExistingConversationVersion(id);
    return { updateTime: update[1] === "null" ? null : Number(update[1]), title: JSON.parse(title[1]) };
  }
};
async function convertArchive(outputDir, options) {
  const folders = [new StorageService(outputDir, { timeZone: options.timeZone })];
  for (const entry of await fs4.readdir(path4.join(outputDir, "projects"), { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory()) folders.push(new StorageService(outputDir, { timeZone: options.timeZone, projectFolder: entry.name }));
  }
  const work = [];
  for (const storage of folders) work.push({ storage, ids: await storage.savedIds() });
  const total = work.reduce((sum, folder) => sum + folder.ids.length, 0);
  const result = { converted: 0, unchanged: 0, errors: 0 };
  let done = 0;
  if (total > 0) options.onProgress?.(0, total);
  for (const { storage, ids } of work) {
    if (ids.length === 0) continue;
    await storage.loadFileLinks();
    for (const id of ids) {
      if (options.signal?.aborted) throw abortError(options.signal);
      try {
        if (await storage.refreshMarkdown(id) === "written") result.converted += 1;
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
async function stampTimes(filePath, times) {
  const modified = times.updated ?? times.created;
  if (modified === null) return;
  const created = Math.min(times.created ?? modified, modified);
  try {
    const stat = await fs4.stat(filePath);
    const birthDone = process.platform !== "darwin" || stat.birthtimeMs <= created * 1e3 + 2;
    if (birthDone && Math.abs(stat.mtimeMs - modified * 1e3) < 2) return;
    if (!birthDone) await fs4.utimes(filePath, stat.atime, created);
    await fs4.utimes(filePath, stat.atime, modified);
  } catch {
  }
}
async function readTextIfExists(filePath) {
  try {
    return await fs4.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}
async function writeAtomic(filePath, content) {
  const tmp = `${filePath}.${process.pid}.tmp`;
  try {
    await fs4.writeFile(tmp, content, "utf-8");
    await fs4.rename(tmp, filePath);
  } catch (error) {
    await fs4.rm(tmp, { force: true });
    throw error;
  }
}
async function removeStaleTempFiles(dir) {
  let names;
  try {
    names = await fs4.readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const pid = /\.(?:json|md)\.(\d+)\.tmp$/.exec(name)?.[1];
    if (pid !== void 0 && Number(pid) !== process.pid) await fs4.rm(path4.join(dir, name), { force: true });
  }
}
async function readMetadata(outputDir) {
  try {
    const parsed = JSON.parse(await fs4.readFile(path4.join(outputDir, "metadata.json"), "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
async function updateMetadata(outputDir, patch) {
  const metadata = await readMetadata(outputDir);
  await writeAtomic(path4.join(outputDir, "metadata.json"), JSON.stringify({ ...metadata, ...patch }, null, 2));
}

// src/utils/format.ts
function formatDuration(ms) {
  if (!Number.isFinite(ms)) return "unknown";
  const totalSeconds = Math.max(0, Math.round(ms / 1e3));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor(totalSeconds % 86400 / 3600);
  const minutes = Math.floor(totalSeconds % 3600 / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}
var pad = (n) => String(n).padStart(2, "0");
function formatDateTime(value) {
  const d = new Date(value);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function formatDay(value) {
  const d = new Date(value);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function formatClock(value) {
  const d = new Date(value);
  const today = /* @__PURE__ */ new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : formatDateTime(d);
}
function formatCount(n) {
  return n.toLocaleString("en-US");
}
function plural(n, singular, pluralForm = `${singular}s`) {
  return `${formatCount(n)} ${n === 1 ? singular : pluralForm}`;
}
function formatRelative(targetMs, now = Date.now()) {
  const delta = targetMs - now;
  return delta >= 0 ? `in ${formatDuration(delta)}` : `${formatDuration(-delta)} ago`;
}
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

// src/services/backup-service.ts
var FULL_LISTING_MAX_AGE_MS = 30 * 24 * 3600 * 1e3;
var MAX_CONSECUTIVE_FAILURES = 5;
function stopReasonFor(error) {
  if (error instanceof ThrottledError) return "throttled";
  if (error instanceof AuthenticationError) return "auth";
  if (isAbortError(error)) return "interrupted";
  return void 0;
}
function isUpToDate(saved, listed) {
  return saved !== null && (listed === null || saved >= listed);
}
function sameVersion(cached, fresh) {
  return cached !== void 0 && toEpochSeconds(cached.update_time) === toEpochSeconds(fresh.update_time);
}
var shorten = (text) => text.length > 300 ? `${text.slice(0, 300)}\u2026` : text;
var BackupService = class {
  constructor(client, mainStorage, sync, events = {}) {
    this.client = client;
    this.mainStorage = mainStorage;
    this.sync = sync;
    this.events = events;
  }
  /**
   * Reads the conversation list and downloads at the same time. Downloads start as soon as the first
   * page of the list arrives and go newest first, while the rest of the list is read in the background.
   */
  run(options) {
    return new BackupRun(this.client, this.mainStorage, this.sync, this.events, options).execute();
  }
};
var BackupRun = class {
  constructor(client, mainStorage, sync, events, options) {
    this.client = client;
    this.mainStorage = mainStorage;
    this.sync = sync;
    this.events = events;
    this.options = options;
    this.listSignal = options.signal ? AbortSignal.any([options.signal, this.stopListing.signal]) : this.stopListing.signal;
  }
  result = {
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
    workspaceIds: []
  };
  tracked = /* @__PURE__ */ new Map();
  /** Ids waiting to be downloaded (picked newest first). */
  queue = [];
  savedVersions = /* @__PURE__ */ new Map();
  /** Lets the run stop the listing without stopping everything (and vice versa via the run's signal). */
  stopListing = new AbortController();
  listSignal;
  listingDone = false;
  listingError;
  attempted = 0;
  wake = null;
  async execute() {
    await this.mainStorage.initialize();
    await this.mainStorage.loadFileLinks();
    const wakeOnAbort = () => this.notify();
    this.options.signal?.addEventListener("abort", wakeOnAbort, { once: true });
    const listing = this.listEverything().then(
      () => this.events.onListingDone?.(this.plan()),
      (error) => {
        this.listingError = error;
      }
    ).finally(() => {
      this.listingDone = true;
      this.notify();
    });
    let downloadError;
    try {
      await this.downloadLoop();
    } catch (error) {
      downloadError = error;
    }
    try {
      const downloadStop = downloadError === void 0 ? void 0 : stopReasonFor(downloadError);
      if (downloadStop) this.stop(downloadStop, errorMessage(downloadError));
      const stopped = this.result.stopReason !== void 0 && this.result.stopReason !== "max-downloads";
      if (stopped || downloadError !== void 0 && !downloadStop) this.stopListing.abort();
      await listing;
    } finally {
      this.options.signal?.removeEventListener("abort", wakeOnAbort);
      await this.sync.save();
    }
    if (downloadError !== void 0 && !stopReasonFor(downloadError)) throw downloadError;
    if (this.listingError !== void 0) {
      const reason = stopReasonFor(this.listingError);
      if (!reason) throw this.listingError;
      this.stop(reason, errorMessage(this.listingError));
    }
    this.result.workspaceIds = [
      ...new Set([...this.tracked.values()].map((t) => t.item.workspace_id).filter((w) => !!w))
    ];
    this.result.remaining = Math.max(0, this.result.toDownload - this.result.downloaded - this.result.failed);
    return this.result;
  }
  // ── Coordination ──────────────────────────────────────────────────────────
  notify() {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }
  /** Resolves on the next queue change, listing progress or Ctrl+C. */
  nextEvent() {
    return new Promise((resolve) => {
      this.wake = resolve;
    });
  }
  stop(reason, detail) {
    if (this.result.stopReason) return;
    this.result.stopReason = reason;
    this.result.stopDetail = detail;
  }
  throwIfListingStopped() {
    if (this.listSignal.aborted) throw abortError(this.listSignal);
  }
  plan() {
    const { sources, unique, upToDate, copied, toDownload, skippedFailed, skippedSince } = this.result;
    return { sources: [...sources], unique, upToDate, copied, toDownload, skippedFailed, skippedSince };
  }
  log(message) {
    return this.mainStorage.appendLog(message);
  }
  async warn(message) {
    this.events.onWarning?.(message);
    await this.log(`Warning: ${message}`);
  }
  // ── Deciding what each listed conversation needs ──────────────────────────
  async savedVersion(storage, id) {
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
  renamed(id, saved, item) {
    const listed = item.title;
    if (typeof listed !== "string" || listed === "" || listed === saved.title) return false;
    return !this.sync.knownTitleMismatch(id, listed);
  }
  async save(storage, id, detail) {
    await storage.saveConversation(id, detail);
    this.savedVersions.get(storage)?.set(id, savedVersionOf(detail));
  }
  async copy(from, to, id) {
    const version = await to.copyConversationFrom(from, id);
    this.savedVersions.get(to)?.set(id, version);
    this.result.copied += 1;
  }
  /** Nothing, a copy from another folder, or a download: decided as each listed conversation arrives. */
  async consider(item, storage) {
    const id = item.id;
    const listed = toEpochSeconds(item.update_time);
    const saved = this.options.full ? null : await this.savedVersion(storage, id);
    const upToDate = saved !== null && isUpToDate(saved.updateTime, listed) && !this.renamed(id, saved, item);
    const tracked = this.tracked.get(id);
    if (!tracked) {
      const entry = { item, updateTime: listed, status: "current", targets: [] };
      this.tracked.set(id, entry);
      this.result.unique += 1;
      if (upToDate) {
        entry.current = storage;
        this.result.upToDate += 1;
      } else if (this.options.since !== void 0 && listed !== null && listed < this.options.since) {
        entry.status = "skipped";
        this.result.skippedSince += 1;
      } else if (this.sync.shouldSkip(id, listed, this.options.retryFailed)) {
        entry.status = "skipped";
        this.result.skippedFailed += 1;
      } else {
        entry.status = "queued";
        entry.targets.push(storage);
        this.queue.push(id);
        this.result.toDownload += 1;
        this.events.onQueued?.(this.result.toDownload);
        this.notify();
      }
      return;
    }
    if (listed !== null && (tracked.updateTime === null || listed > tracked.updateTime)) {
      tracked.item = item;
      tracked.updateTime = listed;
    }
    switch (tracked.status) {
      case "queued":
        if (upToDate) {
          this.queue.splice(this.queue.indexOf(id), 1);
          for (const target of tracked.targets) await this.copy(storage, target, id);
          tracked.status = "current";
          tracked.current = storage;
          tracked.targets = [];
          this.result.toDownload -= 1;
          this.events.onQueued?.(this.result.toDownload);
        } else if (!tracked.targets.includes(storage)) {
          tracked.targets.push(storage);
        }
        return;
      case "downloading":
        if (!upToDate && !tracked.targets.includes(storage)) tracked.targets.push(storage);
        return;
      case "current":
      case "downloaded":
        if (!upToDate && tracked.current && tracked.current !== storage) await this.copy(tracked.current, storage, id);
        return;
      case "skipped":
        return;
    }
  }
  // ── Listing ───────────────────────────────────────────────────────────────
  async listEverything() {
    if (!this.options.project) await this.listMain();
    await this.listProjects();
  }
  async listMain() {
    const storage = this.mainStorage;
    const cached = await storage.loadIndex() ?? [];
    const cachedMain = cached.filter((c) => !c.is_archived);
    let archived = cached.filter((c) => c.is_archived);
    const lastFull = Date.parse(this.sync.state.lastFullListingAt ?? "");
    const recentFullListing = Number.isFinite(lastFull) && Date.now() - lastFull < FULL_LISTING_MAX_AGE_MS;
    const canStopEarly = !this.options.refreshList && !this.options.full && recentFullListing && cachedMain.length > 0;
    const cachedById = new Map(cachedMain.map((c) => [c.id, c]));
    const items = [];
    const seen = /* @__PURE__ */ new Set();
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
        this.events.onListing?.("Conversations", page.fetched, page.total);
        if (canStopEarly && page.items.length > 0 && page.items.every((item) => sameVersion(cachedById.get(item.id), item))) {
          stoppedEarly = true;
          break;
        }
      }
      complete = !stoppedEarly;
      if (complete) this.sync.state.lastFullListingAt = (/* @__PURE__ */ new Date()).toISOString();
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
      this.result.sources.push({ label: "Conversations", listed: items.length + archived.length, complete });
      await this.log(
        `Listed ${items.length} conversations` + (complete ? "" : ` (read ${pages} page${pages === 1 ? "" : "s"}; the rest are unchanged since the last listing)`) + (this.options.includeArchived ? `, ${archived.length} archived` : "")
      );
    } finally {
      const listedIds = new Set(items.map((c) => c.id));
      const main = complete ? items : [...items, ...cachedMain.filter((c) => !listedIds.has(c.id))];
      const mainIds = new Set(main.map((c) => c.id));
      await storage.saveIndex([...main, ...archived.filter((c) => !mainIds.has(c.id))]);
    }
  }
  async listArchived() {
    const items = [];
    try {
      for await (const page of conversationPages(this.client, { archived: true, signal: this.listSignal })) {
        if (page.items.some((item) => item.is_archived !== true)) {
          await this.warn("ChatGPT ignored the archived-chats filter, so archived chats were skipped this run.");
          return null;
        }
        items.push(...page.items);
        this.events.onListing?.("Archived", page.fetched, page.total);
      }
    } catch (error) {
      if (stopReasonFor(error)) throw error;
      await this.warn(`Couldn't list archived chats: ${errorMessage(error)}`);
      return null;
    }
    return items;
  }
  async listProjects() {
    let projects;
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
        const available = projects.map((p) => p.gizmo.display.name).join(", ") || "(none)";
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
  takeNext() {
    let best = -1;
    let bestTime = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < this.queue.length; i++) {
      const time = this.tracked.get(this.queue[i]).updateTime ?? Number.NEGATIVE_INFINITY;
      if (best === -1 || time > bestTime) {
        best = i;
        bestTime = time;
      }
    }
    return best === -1 ? void 0 : this.queue.splice(best, 1)[0];
  }
  async downloadLoop() {
    const maxDownloads = this.options.maxDownloads ?? Number.POSITIVE_INFINITY;
    let consecutiveFailures = 0;
    for (; ; ) {
      if (this.options.signal?.aborted) return this.stop("interrupted");
      if (this.listingError !== void 0) return;
      if (this.result.downloaded >= maxDownloads) {
        while (!this.listingDone && !this.options.signal?.aborted) await this.nextEvent();
        if (this.options.signal?.aborted) return this.stop("interrupted");
        if (this.queue.length > 0) this.stop("max-downloads");
        return;
      }
      const id = this.takeNext();
      if (id === void 0) {
        if (this.listingDone) return;
        await this.nextEvent();
        continue;
      }
      const tracked = this.tracked.get(id);
      tracked.status = "downloading";
      const entry = { id, title: tracked.item.title ?? "Untitled", updateTime: tracked.updateTime };
      try {
        const detail = await this.client.getConversation(id);
        for (const storage of tracked.targets) await this.save(storage, id, detail);
        tracked.status = "downloaded";
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
        tracked.status = "skipped";
        tracked.targets = [];
        this.attempted += 1;
        this.result.failed += 1;
        this.result.errors.push({ conversationId: id, error: message });
        this.sync.recordFailure(id, message, entry.updateTime, gone);
        await this.log(`Failed: ${id} - ${message}`);
        this.events.onFailed?.(entry, error instanceof Error ? error : new Error(message), this.attempted);
        if (!gone && ++consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return this.stop("too-many-failures", message);
      }
      if (this.attempted % 20 === 0) await this.sync.save();
    }
  }
};

// src/services/sync-state.ts
import fs5 from "fs/promises";
import path5 from "path";
var MAX_FAILED_RUNS = 3;
var SyncStateStore = class _SyncStateStore {
  filePath;
  state;
  constructor(filePath, state) {
    this.filePath = filePath;
    this.state = state;
  }
  static async load(outputDir) {
    const filePath = path5.join(outputDir, ".sync-state.json");
    let state = { version: 1, failures: {} };
    try {
      const parsed = JSON.parse(await fs5.readFile(filePath, "utf-8"));
      state = {
        version: 1,
        lastFullListingAt: parsed.lastFullListingAt,
        failures: parsed.failures ?? {},
        titleMismatches: parsed.titleMismatches
      };
    } catch {
    }
    return new _SyncStateStore(filePath, state);
  }
  shouldSkip(id, updateTime, retryFailed) {
    const record = this.state.failures[id];
    if (!record || retryFailed || record.updateTime !== updateTime) return false;
    return Boolean(record.gone) || record.count >= MAX_FAILED_RUNS;
  }
  recordFailure(id, error, updateTime, gone) {
    const previous = this.state.failures[id];
    const sameVersion2 = previous?.updateTime === updateTime;
    this.state.failures[id] = {
      count: sameVersion2 ? previous.count + 1 : 1,
      lastError: error,
      lastAttemptAt: (/* @__PURE__ */ new Date()).toISOString(),
      updateTime,
      ...gone ? { gone: true } : {}
    };
  }
  clearFailure(id) {
    delete this.state.failures[id];
  }
  /** This listed title was already fetched once, and the conversation itself had another title. */
  knownTitleMismatch(id, listedTitle) {
    return this.state.titleMismatches?.[id] === listedTitle;
  }
  /** After a download: remembers a listed title the conversation didn't match, or forgets an old one. */
  noteTitle(id, listedTitle, savedTitle) {
    if (typeof listedTitle === "string" && listedTitle !== "" && listedTitle !== savedTitle) {
      (this.state.titleMismatches ??= {})[id] = listedTitle;
    } else if (this.state.titleMismatches && id in this.state.titleMismatches) {
      delete this.state.titleMismatches[id];
    }
  }
  parkedCount() {
    return Object.values(this.state.failures).filter((r) => r.gone || r.count >= MAX_FAILED_RUNS).length;
  }
  async save() {
    await writeAtomic(this.filePath, JSON.stringify(this.state, null, 2));
  }
};

// src/cli/output-dir.ts
import fs6 from "fs/promises";
import path6 from "path";
import chalk from "chalk";

// src/utils/prompt.ts
import readline from "readline";
import { Writable } from "stream";
var PromptCancelledError = class extends Error {
  constructor() {
    super("Cancelled");
    this.name = "PromptCancelledError";
  }
};
function isInteractive() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}
function ask(question, hidden) {
  let muted = false;
  const output = new Writable({
    write(chunk, encoding, callback) {
      if (!muted) process.stdout.write(chunk, encoding);
      callback();
    }
  });
  const rl = readline.createInterface({ input: process.stdin, output, terminal: true });
  return new Promise((resolve, reject) => {
    let answered = false;
    rl.on("SIGINT", () => {
      rl.close();
      process.stdout.write("\n");
    });
    rl.on("close", () => {
      if (!answered) reject(new PromptCancelledError());
    });
    rl.question(question, (answer) => {
      answered = true;
      rl.close();
      if (hidden) process.stdout.write("\n");
      resolve(answer);
    });
    muted = hidden;
  });
}
function promptLine(question) {
  return ask(question, false);
}
function promptHidden(question) {
  return ask(question, true);
}

// src/cli/output-dir.ts
async function looksLikeArchive(dir) {
  try {
    await fs6.access(path6.join(dir, "conversations", "index.json"));
    return true;
  } catch {
    return false;
  }
}
async function chooseOutputDir(settings, flag) {
  if (flag || isOutputDirConfigured(settings)) return resolveOutputDir(settings, flag);
  const local = path6.resolve("chatgpt-export");
  const suggestion = await looksLikeArchive(local) ? local : defaultOutputDir();
  let chosen = suggestion;
  if (isInteractive()) {
    console.log(chalk.bold("\nWhere should the archive go?"));
    console.log(chalk.dim("  Each conversation is saved there as JSON and Markdown. Press Enter to accept the suggestion."));
    const answer = (await promptLine(`  Archive folder [${suggestion}]: `)).trim();
    chosen = answer ? path6.resolve(expandHome(answer)) : suggestion;
  }
  await saveSettings(settings, { [ENV.exportDir]: chosen });
  console.log(chalk.dim(`  Archive folder saved to ${settings.configPath} (edit ${ENV.exportDir} there, or pass -o).
`));
  return chosen;
}

// src/utils/lock.ts
import fs7 from "fs";
import fsp2 from "fs/promises";
import path7 from "path";
var AlreadyRunningError = class extends Error {
  constructor(pid, startedAt) {
    super(`Another backup is already running (pid ${pid}${startedAt ? `, started ${startedAt}` : ""}).`);
    this.name = "AlreadyRunningError";
  }
};
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
async function acquireLock(dir, name = "backup.lock") {
  await fsp2.mkdir(dir, { recursive: true });
  const file = path7.join(dir, name);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await fsp2.open(file, "wx");
      await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: (/* @__PURE__ */ new Date()).toISOString() }));
      await handle.close();
      let released = false;
      const releaseSync = () => {
        if (released) return;
        released = true;
        try {
          fs7.unlinkSync(file);
        } catch {
        }
      };
      process.once("exit", releaseSync);
      return {
        async release() {
          process.removeListener("exit", releaseSync);
          releaseSync();
        }
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let holder = {};
      try {
        holder = JSON.parse(await fsp2.readFile(file, "utf-8"));
      } catch {
      }
      if (holder.pid && holder.pid !== process.pid && isAlive(holder.pid)) {
        throw new AlreadyRunningError(holder.pid, holder.startedAt);
      }
      await fsp2.rm(file, { force: true });
    }
  }
  throw new Error(`Couldn't create the lock file ${file}`);
}
async function lockHolder(dir, name = "backup.lock") {
  try {
    const holder = JSON.parse(await fsp2.readFile(path7.join(dir, name), "utf-8"));
    return holder.pid && isAlive(holder.pid) ? { pid: holder.pid, startedAt: holder.startedAt } : null;
  } catch {
    return null;
  }
}

// src/utils/system.ts
import { execFile, spawn } from "child_process";
function keepAwake() {
  if (process.platform !== "darwin") return () => {
  };
  try {
    const child = spawn("caffeinate", ["-i", "-w", String(process.pid)], { stdio: "ignore" });
    child.on("error", () => {
    });
    child.unref();
    return () => {
      if (child.exitCode === null) child.kill();
    };
  } catch {
    return () => {
    };
  }
}
function notify(title, message) {
  if (process.platform !== "darwin") return;
  const script = `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`;
  execFile("osascript", ["-e", script], () => {
  });
}

// src/cli/reminders.ts
import fs8 from "fs/promises";
import path8 from "path";

// src/auth/tokens.ts
var JWT_RE = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/;
var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
var EXPIRY_SKEW_MS = 6e4;
function isUuid(value) {
  return typeof value === "string" && UUID_RE.test(value);
}
function decodeJwtPayload(token) {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8"));
    return payload && typeof payload === "object" ? payload : null;
  } catch {
    return null;
  }
}
function getTokenInfo(token) {
  const payload = decodeJwtPayload(token);
  if (!payload) return null;
  const auth = payload["https://api.openai.com/auth"] ?? {};
  const profile = payload["https://api.openai.com/profile"] ?? {};
  return {
    exp: typeof payload.exp === "number" ? payload.exp : void 0,
    email: typeof profile.email === "string" ? profile.email : void 0,
    accountId: isUuid(auth.chatgpt_account_id) ? auth.chatgpt_account_id : void 0,
    planType: typeof auth.chatgpt_plan_type === "string" ? auth.chatgpt_plan_type : void 0
  };
}
function tokenExpiresAt(token) {
  const exp = getTokenInfo(token)?.exp;
  return exp === void 0 ? null : exp * 1e3;
}
function isTokenExpired(token, now = Date.now()) {
  const expiresAt = tokenExpiresAt(token);
  return expiresAt !== null && expiresAt - EXPIRY_SKEW_MS <= now;
}
function pickToken(candidates, now = Date.now()) {
  const expired = [];
  for (const candidate of candidates) {
    if (!JWT_RE.test(candidate.token)) continue;
    if (isTokenExpired(candidate.token, now)) {
      expired.push(candidate);
      continue;
    }
    return { chosen: candidate, expired };
  }
  return { expired };
}
function parseCredentialsText(text) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(trimmed.slice(start, end + 1));
      if (parsed && typeof parsed === "object") {
        const obj = parsed;
        const token2 = typeof obj.accessToken === "string" ? JWT_RE.exec(obj.accessToken)?.[0] : void 0;
        if (token2) {
          return { accessToken: token2, accountId: isUuid(obj.accountId) ? obj.accountId : void 0 };
        }
      }
    } catch {
    }
  }
  const keyed = /"accessToken"\s*:\s*"([^"]+)"/.exec(trimmed)?.[1];
  const token = (keyed && JWT_RE.exec(keyed)?.[0]) ?? JWT_RE.exec(trimmed)?.[0];
  return token ? { accessToken: token } : null;
}

// src/cli/reminders.ts
var EXPIRY_WARNING_MS = 2 * 24 * 36e5;
var REPEAT_MS = 24 * 36e5;
async function remindOncePerDay(stateDir, key, message, about = "", send = notify) {
  const stampPath = path8.join(stateDir, `reminder-${key}.json`);
  let stamp = {};
  try {
    stamp = JSON.parse(await fs8.readFile(stampPath, "utf-8"));
  } catch {
  }
  const due = stamp.about !== about || Date.now() - (stamp.notifiedAt ?? 0) >= REPEAT_MS;
  if (!due) return false;
  send("ChatGPT exporter", message);
  await fs8.mkdir(stateDir, { recursive: true });
  await fs8.writeFile(stampPath, JSON.stringify({ notifiedAt: Date.now(), about }));
  return true;
}
async function warnIfTokenExpiringSoon(settings, accessToken, send = notify) {
  const expiresAt = tokenExpiresAt(accessToken);
  if (expiresAt === null || expiresAt - Date.now() > EXPIRY_WARNING_MS) return null;
  const message = `Your ChatGPT sign-in expires ${formatRelative(expiresAt)} (${formatDateTime(expiresAt)}). Run \`chatgpt-exporter login\` to keep backups going.`;
  await remindOncePerDay(settings.stateDir, "token-expiry", message, String(expiresAt), send);
  return message;
}

// src/cli/reporter.ts
import chalk2 from "chalk";
import cliProgress from "cli-progress";
import ora from "ora";
function createReporter() {
  const usableTerminal = process.stdout.isTTY && process.stderr.isTTY && (process.stderr.columns ?? 0) > 0;
  return usableTerminal ? new TtyReporter() : new PlainReporter();
}
function waitText(wait, now = Date.now()) {
  if (wait.reason === "throttle") return chalk2.yellow(`ChatGPT asked us to slow down; resuming at ${formatClock(wait.until)}`);
  return `next in ${formatDuration(Math.max(0, wait.until - now))}`;
}
function listingText(label, fetched, total) {
  const count = total !== void 0 && Number.isFinite(total) ? `${formatCount(fetched)}/${formatCount(total)}` : formatCount(fetched);
  return `listing ${label.toLowerCase()} ${count}`;
}
function startSpinner(text) {
  return ora({ text, discardStdin: false }).start();
}
var TtyReporter = class {
  interactive = true;
  spinner = null;
  bar = null;
  timer = null;
  wait = null;
  listingStatus = null;
  total = 0;
  done = 0;
  failed = 0;
  estimateMs = () => Number.NaN;
  suspended = false;
  info(message) {
    this.above(() => console.log(message));
  }
  warn(message) {
    this.above(() => console.log(chalk2.yellow(`\u26A0 ${message}`)));
  }
  spin(text) {
    if (this.suspended) return;
    if (this.spinner) this.spinner.text = text;
    else this.spinner = startSpinner(text);
  }
  spinDone(text) {
    if (this.spinner) {
      this.spinner.succeed(text);
      this.spinner = null;
    } else {
      this.info(`${chalk2.green("\u2714")} ${text}`);
    }
  }
  listing(label, fetched, total) {
    this.listingStatus = listingText(label, fetched, total);
    if (this.bar) this.refresh();
    else this.spin(`${this.listingStatus.charAt(0).toUpperCase()}${this.listingStatus.slice(1)}\u2026`);
  }
  listingDone(summary) {
    this.listingStatus = null;
    this.spinDone(summary);
    this.refresh();
  }
  startDownloads(total, estimateMs) {
    this.spinner?.stop();
    this.spinner = null;
    this.total = total;
    this.done = 0;
    this.failed = 0;
    this.estimateMs = estimateMs;
    this.createBar();
  }
  setTotal(total) {
    this.total = total;
    this.bar?.setTotal(total);
    this.refresh();
  }
  downloadDone(_title, done) {
    this.done = done;
    this.refresh();
  }
  downloadFailed(_title, _message, done) {
    this.done = done;
    this.failed += 1;
    this.refresh();
  }
  waiting(kind, info) {
    if (kind !== "conversation" && info?.reason !== "throttle") return;
    this.wait = info;
    if (this.bar) {
      this.refresh();
    } else if (info?.reason === "throttle" && this.spinner) {
      this.spinner.text = waitText(info);
    }
  }
  suspend() {
    this.suspended = true;
    this.spinner?.stop();
    this.spinner = null;
    this.stopBar();
  }
  resume() {
    this.suspended = false;
    if (this.total > 0) this.createBar();
  }
  finish() {
    this.spinner?.stop();
    this.spinner = null;
    this.stopBar();
    this.total = 0;
  }
  /** Prints without the bar or spinner overwriting the message. */
  above(print) {
    const hadBar = this.bar !== null;
    const spinnerText = this.spinner?.text;
    this.spinner?.stop();
    this.spinner = null;
    this.stopBar();
    print();
    if (spinnerText !== void 0 && !this.suspended) this.spinner = startSpinner(spinnerText);
    if (hadBar && !this.suspended) this.createBar();
  }
  createBar() {
    if (this.suspended || this.bar) return;
    this.bar = new cliProgress.SingleBar(
      {
        // {timeLeft}, not {eta}: cli-progress fills its own {eta} token and would overwrite ours.
        format: `${chalk2.cyan("Downloading")} ${chalk2.cyan("{bar}")} {value}/{total} {failed}\xB7 {timeLeft} \xB7 {status}`,
        barCompleteChar: "\u2588",
        barIncompleteChar: "\u2591",
        barsize: 24,
        hideCursor: true,
        gracefulExit: false
      },
      cliProgress.Presets.shades_classic
    );
    this.bar.start(this.total, this.done, this.payload());
    this.timer = setInterval(() => this.refresh(), 1e3);
  }
  stopBar() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.bar?.stop();
    this.bar = null;
  }
  payload() {
    const remaining = this.total - this.done;
    const estimate = remaining > 0 ? this.estimateMs(remaining) : 0;
    const activity = this.wait ? waitText(this.wait) : remaining > 0 ? "downloading\u2026" : "done";
    return {
      timeLeft: Number.isFinite(estimate) ? `\u2248 ${formatDuration(estimate)} left` : "\u2026",
      status: this.listingStatus ? `${activity} \xB7 ${chalk2.dim(`${this.listingStatus}\u2026`)}` : activity,
      failed: this.failed > 0 ? chalk2.red(`(${this.failed} failed) `) : ""
    };
  }
  refresh() {
    this.bar?.update(this.done, this.payload());
  }
};
var PlainReporter = class {
  interactive = false;
  lastThrottleUntil = 0;
  lastListingLog = 0;
  total = 0;
  /** stderr, so `list --json > file` and similar stay clean. */
  line(message) {
    process.stderr.write(`[${(/* @__PURE__ */ new Date()).toISOString()}] ${message}
`);
  }
  info(message) {
    this.line(message);
  }
  warn(message) {
    this.line(`Warning: ${message}`);
  }
  spin(text) {
    this.line(text);
  }
  spinDone(text) {
    this.line(text);
  }
  listing(label, fetched, total) {
    const now = Date.now();
    const finished = total !== void 0 && fetched >= total;
    if (!finished && now - this.lastListingLog < 3e4) return;
    this.lastListingLog = now;
    this.line(`Listing ${label.toLowerCase()}: ${formatCount(fetched)}${total !== void 0 ? `/${formatCount(total)}` : ""}`);
  }
  listingDone(summary) {
    this.line(summary);
  }
  startDownloads(total, estimateMs) {
    this.total = total;
    this.line(`Downloading, newest first, while the rest of the list is read (\u2248 ${formatDuration(estimateMs(total))} for the first ${formatCount(total)})`);
  }
  setTotal(total) {
    this.total = total;
  }
  downloadDone(title, done) {
    this.line(`[${done}/${this.total}] ${title}`);
  }
  downloadFailed(title, message, done) {
    this.line(`[${done}/${this.total}] FAILED ${title}: ${message}`);
  }
  waiting(_kind, info) {
    if (info?.reason === "throttle" && info.until !== this.lastThrottleUntil) {
      this.lastThrottleUntil = info.until;
      this.line(`ChatGPT asked us to slow down; resuming at ${formatClock(info.until)}`);
    }
  }
  suspend() {
  }
  resume() {
  }
  finish() {
  }
};

// src/cli/runtime.ts
import path10 from "path";

// src/api/client.ts
import crypto from "crypto";
var BROWSER_HEADERS = {
  "Content-Type": "application/json",
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Accept": "application/json",
  "Accept-Language": "en-US,en;q=0.9",
  "Referer": "https://chatgpt.com/",
  "Origin": "https://chatgpt.com",
  "Sec-Ch-Ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"macOS"',
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-origin"
};
var DEFAULT_TIMEOUT_MS = 6e4;
var NETWORK_RETRY_DELAYS_MS = [5e3, 15e3, 45e3, 12e4, 3e5];
var SERVER_ERROR_RETRY_DELAYS_MS = [1e4, 3e4, 9e4];
var MAX_RELOGINS_PER_REQUEST = 2;
function parseRetryAfter(value, now = Date.now()) {
  if (!value) return void 0;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(parseFloat(trimmed) * 1e3);
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? void 0 : Math.max(0, date - now);
}
function describeRateHeaders(headers) {
  const parts = [];
  headers.forEach((value, name) => {
    if (/retry|ratelimit|rate-limit/i.test(name)) parts.push(`${name}=${value.slice(0, 80)}`);
  });
  return parts.length > 0 ? `; ${parts.join(", ")}` : "";
}
function looksLikeChallengePage(response, body) {
  const type = response.headers.get("content-type") ?? "";
  return type.includes("text/html") || /<html|cf-chl|just a moment/i.test(body.slice(0, 2e3));
}
function looksLikeAuthFailure(body) {
  return /token|auth|sign(ed)?[ -]?in|session|expired|unauthori[sz]ed/i.test(body.slice(0, 2e3));
}
function describeError(error) {
  if (error instanceof Error) {
    const cause = error.cause;
    const causeMessage = cause instanceof Error ? cause.message : void 0;
    return causeMessage ? `${error.message}: ${causeMessage}` : error.message;
  }
  return String(error);
}
var ChatGPTClient = class {
  accessToken;
  accountId;
  baseUrl;
  deviceId = crypto.randomUUID();
  options;
  /** A sign-in prompt in progress, shared by every request that hit the expired token. */
  relogin = null;
  constructor(accessToken, options) {
    this.accessToken = accessToken;
    this.accountId = options.accountId;
    this.baseUrl = resolveBaseUrl(options.baseUrl);
    this.options = options;
  }
  get scheduler() {
    return this.options.scheduler;
  }
  setCredentials(credentials) {
    this.accessToken = credentials.accessToken;
    this.accountId = credentials.accountId;
  }
  /** Verifies the token with one tiny list request; returns the workspace the conversations belong to. */
  async initialize() {
    const response = await this.listConversations(0, 1);
    return { workspaceId: response.items[0]?.workspace_id ?? void 0, total: response.total };
  }
  // Every call takes an optional signal on top of the client's own, so one part of a run
  // (e.g. the listing) can be stopped without stopping everything else.
  listConversations(offset, limit, archived = false, signal) {
    const query = `offset=${offset}&limit=${limit}&order=updated${archived ? "&is_archived=true" : ""}`;
    return this.getJson("list", `${ENDPOINTS.CONVERSATIONS}?${query}`, (data) => ConversationsResponseSchema.parse(data), signal);
  }
  getConversation(id, signal) {
    return this.getJson("conversation", ENDPOINTS.CONVERSATION(id), (data) => ConversationDetailSchema.parse(data), signal);
  }
  listProjectsPage(cursor, signal) {
    const url = cursor ? `${ENDPOINTS.PROJECTS_SIDEBAR}?cursor=${encodeURIComponent(cursor)}` : ENDPOINTS.PROJECTS_SIDEBAR;
    return this.getJson("list", url, (data) => ProjectsSidebarResponseSchema.parse(data), signal);
  }
  listProjectConversationsPage(gizmoId, cursor, signal) {
    const url = `${ENDPOINTS.PROJECT_CONVERSATIONS(gizmoId)}?cursor=${encodeURIComponent(cursor)}`;
    return this.getJson("list", url, (data) => ProjectConversationsResponseSchema.parse(data), signal);
  }
  getJson(kind, endpoint, parse, signal) {
    return this.request(kind, `${this.baseUrl}${endpoint}`, true, async (response) => parse(await response.json()), signal);
  }
  /** Downloads a file body; auth headers are only sent to chatgpt.com itself. */
  fetchRaw(url, signal) {
    const isAbsolute = /^https?:\/\//.test(url);
    const fullUrl = isAbsolute ? url : `${this.baseUrl}${url}`;
    const sameOrigin = !isAbsolute || fullUrl.startsWith(this.baseUrl);
    return this.request("file", fullUrl, sameOrigin, (response) => response.arrayBuffer(), signal);
  }
  headers(sameOrigin) {
    if (!sameOrigin) return {};
    const headers = {
      ...BROWSER_HEADERS,
      Authorization: `Bearer ${this.accessToken}`,
      "Oai-Device-Id": this.deviceId,
      "Oai-Language": "en-US"
    };
    if (this.accountId) headers["ChatGPT-Account-Id"] = this.accountId;
    return headers;
  }
  /** The client's signal combined with a per-call one (either aborts the request). */
  callSignal(extra) {
    const own = this.options.signal;
    if (own && extra) return AbortSignal.any([own, extra]);
    return own ?? extra;
  }
  requestSignal(signal) {
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    return signal ? AbortSignal.any([signal, timeout]) : timeout;
  }
  async note(message) {
    await this.options.log?.(message);
  }
  async handleThrottle(kind, what, response, retryAfterMs) {
    const decision = await this.scheduler.reportThrottle(retryAfterMs, kind);
    const detail = describeRateHeaders(response.headers);
    if (decision.giveUp) {
      await this.note(
        `${what}${detail} \u2014 ${decision.consecutive} times in a row; stopping. Safe to retry after ${formatClock(decision.resumeAt)}.`
      );
      throw new ThrottledError("ChatGPT is still throttling requests", decision.resumeAt);
    }
    await this.note(
      `${what}${detail} \u2014 pausing ${formatDuration(decision.pauseMs)} until ${formatClock(decision.resumeAt)}, then continuing at a slower pace`
    );
    return decision;
  }
  async request(kind, url, sameOrigin, read, extraSignal) {
    let networkFailures = 0;
    let serverFailures = 0;
    let relogins = 0;
    const signal = this.callSignal(extraSignal);
    for (; ; ) {
      await this.scheduler.acquire(kind, signal);
      const tokenSent = this.accessToken;
      let response;
      let result;
      try {
        response = await fetch(url, { headers: this.headers(sameOrigin), signal: this.requestSignal(signal) });
        if (response.ok) result = await read(response);
      } catch (error) {
        if (signal?.aborted) throw abortError(signal);
        if (error instanceof SyntaxError || error.name === "ZodError") throw error;
        const delay = NETWORK_RETRY_DELAYS_MS[networkFailures];
        networkFailures += 1;
        if (delay === void 0) throw new NetworkError(`Network error: ${describeError(error)}`);
        await this.note(`Network problem (${describeError(error)}); retrying in ${formatDuration(delay)}`);
        await sleep(delay, signal);
        continue;
      }
      if (response.ok) {
        await this.scheduler.reportSuccess(kind);
        return result;
      }
      const status = response.status;
      if (status === 429) {
        await response.body?.cancel().catch(() => {
        });
        await this.handleThrottle(kind, "Throttled by ChatGPT (HTTP 429)", response, parseRetryAfter(response.headers.get("retry-after")));
        continue;
      }
      const body = await response.text().catch(() => "");
      if (status === 403 && looksLikeChallengePage(response, body)) {
        await this.handleThrottle(kind, "Blocked by ChatGPT's bot protection (HTTP 403)", response, void 0);
        continue;
      }
      if (status === 401 || status === 403 && looksLikeAuthFailure(body)) {
        if (this.accessToken !== tokenSent) continue;
        if (this.options.onAuthExpired && relogins < MAX_RELOGINS_PER_REQUEST) {
          relogins += 1;
          this.relogin ??= this.options.onAuthExpired(`ChatGPT rejected the saved token (HTTP ${status})`).finally(() => {
            this.relogin = null;
          });
          const fresh = await this.relogin;
          if (fresh) {
            this.setCredentials(fresh);
            continue;
          }
        }
        throw new AuthenticationError(`ChatGPT rejected the access token (HTTP ${status}).`);
      }
      if (status === 404) throw new NotFoundError("Not found (HTTP 404)");
      if (status >= 500) {
        const delay = SERVER_ERROR_RETRY_DELAYS_MS[serverFailures];
        serverFailures += 1;
        if (delay !== void 0) {
          await this.note(`ChatGPT server error (HTTP ${status}); retrying in ${formatDuration(delay)}`);
          await sleep(delay, signal);
          continue;
        }
      }
      const excerpt = body.trim().slice(0, 200);
      throw new HttpError(`Request failed: HTTP ${status} ${response.statusText}${excerpt ? ` \u2014 ${excerpt}` : ""}`, status);
    }
  }
};

// src/api/scheduler.ts
import fs9 from "fs/promises";
import path9 from "path";
var KINDS = ["conversation", "list", "file"];
var MAX_SLOWDOWN = 4;
var MAX_SLEEP_SLICE_MS = 3e4;
var TOKEN_EPSILON = 1e-9;
var RequestScheduler = class _RequestScheduler {
  config;
  clock;
  buckets;
  throttledUntil = 0;
  /**
   * 429s in a row, per kind of request. The pause applies to everything, but the streak is per kind:
   * list pages succeeding alongside must not reset a streak of refused conversation downloads.
   */
  throttleStreaks = { conversation: 0, list: 0, file: 0 };
  /** Interval multiplier for the rest of this run after a 429. */
  slowdown = 1;
  lastRequestAt = Number.NEGATIVE_INFINITY;
  /** Told when a request of `kind` starts waiting (reason, end time) and when it goes ahead (null). */
  onWait;
  constructor(config) {
    this.config = config;
    this.clock = config.clock ?? systemClock;
    const now = this.clock.now();
    this.buckets = {
      conversation: { tokens: config.conversation.burst, updatedAt: now },
      list: { tokens: config.list.burst, updatedAt: now },
      file: { tokens: config.file.burst, updatedAt: now }
    };
  }
  static async create(config) {
    const scheduler = new _RequestScheduler(config);
    await scheduler.restore();
    return scheduler;
  }
  /** Resolves when a request of this kind may be sent, waiting out pacing and cooldowns. */
  async acquire(kind, signal) {
    for (; ; ) {
      if (signal?.aborted) throw abortError(signal);
      const now = this.clock.now();
      if (now < this.throttledUntil) {
        await this.waitUntil({ kind, reason: "throttle", until: this.throttledUntil }, signal);
        continue;
      }
      this.refill(kind, now);
      const bucket = this.buckets[kind];
      const gapReadyAt = this.lastRequestAt + this.config.minGapMs;
      if (bucket.tokens >= 1 - TOKEN_EPSILON && now >= gapReadyAt) {
        bucket.tokens = Math.max(0, bucket.tokens - 1);
        this.lastRequestAt = now;
        this.onWait?.(kind, null);
        if (kind === "conversation") await this.persist();
        return;
      }
      const tokenReadyAt = bucket.tokens >= 1 - TOKEN_EPSILON ? now : now + Math.ceil((1 - bucket.tokens) * this.interval(kind));
      await this.waitUntil({ kind, reason: "pace", until: Math.max(tokenReadyAt, gapReadyAt) }, signal);
    }
  }
  /** Records a 429 (or a bot-protection block) on `kind` and decides how long everything pauses. */
  async reportThrottle(retryAfterMs, kind = "conversation") {
    const now = this.clock.now();
    const streak = this.throttleStreaks[kind] += 1;
    for (const k of KINDS) this.buckets[k] = { tokens: 0, updatedAt: now };
    const backoff = Math.min(this.config.maxThrottleCooldownMs, this.config.throttleCooldownMs * 2 ** (streak - 1));
    const pauseMs = Math.max(backoff, retryAfterMs ?? 0);
    this.throttledUntil = Math.max(this.throttledUntil, now + pauseMs);
    this.slowdown = Math.min(MAX_SLOWDOWN, this.slowdown * 2);
    await this.persist();
    return {
      pauseMs,
      resumeAt: this.throttledUntil,
      consecutive: streak,
      giveUp: streak > this.config.maxConsecutiveThrottles
    };
  }
  async reportSuccess(kind = "conversation") {
    if (this.throttleStreaks[kind] === 0) return;
    this.throttleStreaks[kind] = 0;
    await this.persist();
  }
  snapshot(kind = "conversation") {
    this.refill(kind, this.clock.now());
    return {
      tokens: this.buckets[kind].tokens,
      burst: this.config[kind].burst,
      intervalMs: this.interval(kind),
      throttledUntil: this.throttledUntil,
      consecutiveThrottles: this.longestStreak()
    };
  }
  longestStreak() {
    return Math.max(...KINDS.map((k) => this.throttleStreaks[k]));
  }
  /** Rough time to send `count` more requests of this kind at the current pace. */
  estimateMs(count, kind = "conversation") {
    const { tokens, intervalMs, throttledUntil } = this.snapshot(kind);
    const waitForCooldown = Math.max(0, throttledUntil - this.clock.now());
    return waitForCooldown + Math.max(0, count - Math.floor(tokens)) * intervalMs;
  }
  interval(kind) {
    return this.config[kind].intervalMs * this.slowdown;
  }
  refill(kind, now) {
    const bucket = this.buckets[kind];
    if (now <= bucket.updatedAt) return;
    bucket.tokens = Math.min(this.config[kind].burst, bucket.tokens + (now - bucket.updatedAt) / this.interval(kind));
    bucket.updatedAt = now;
  }
  async waitUntil(info, signal) {
    this.onWait?.(info.kind, info);
    const remaining = info.until - this.clock.now();
    if (remaining > 0) await this.clock.sleep(Math.min(remaining, MAX_SLEEP_SLICE_MS), signal);
  }
  async restore() {
    if (!this.config.statePath) return;
    let raw;
    try {
      raw = await fs9.readFile(this.config.statePath, "utf-8");
    } catch {
      return;
    }
    try {
      const state = JSON.parse(raw);
      const now = this.clock.now();
      const saved = state.conversation;
      if (saved && Number.isFinite(saved.tokens) && Number.isFinite(saved.updatedAt)) {
        this.buckets.conversation = {
          tokens: Math.min(Math.max(saved.tokens, 0), this.config.conversation.burst),
          updatedAt: Math.min(saved.updatedAt, now)
        };
      }
      if (Number.isFinite(state.throttledUntil)) this.throttledUntil = state.throttledUntil;
      if (state.throttleStreaks) {
        for (const kind of KINDS) {
          const streak = state.throttleStreaks[kind];
          if (Number.isFinite(streak)) this.throttleStreaks[kind] = streak;
        }
      } else if (Number.isFinite(state.consecutiveThrottles)) {
        this.throttleStreaks.conversation = state.consecutiveThrottles;
      }
    } catch {
    }
  }
  async persist() {
    const statePath = this.config.statePath;
    if (!statePath) return;
    const state = {
      version: 1,
      conversation: this.buckets.conversation,
      throttledUntil: this.throttledUntil,
      consecutiveThrottles: this.longestStreak(),
      throttleStreaks: { ...this.throttleStreaks }
    };
    try {
      await fs9.mkdir(path9.dirname(statePath), { recursive: true });
      const tmp = `${statePath}.${process.pid}.tmp`;
      await fs9.writeFile(tmp, JSON.stringify(state, null, 2));
      await fs9.rename(tmp, statePath);
    } catch {
    }
  }
};

// src/auth/login.ts
import chalk3 from "chalk";

// src/utils/clipboard.ts
import { execFile as execFile2, spawn as spawn2 } from "child_process";
function readCommands() {
  if (process.platform === "darwin") return [["pbpaste", []]];
  if (process.platform === "win32") return [["powershell", ["-NoProfile", "-Command", "Get-Clipboard -Raw"]]];
  return [
    ["wl-paste", ["--no-newline"]],
    ["xclip", ["-selection", "clipboard", "-o"]],
    ["xsel", ["--clipboard", "--output"]]
  ];
}
function writeCommands() {
  if (process.platform === "darwin") return [["pbcopy", []]];
  if (process.platform === "win32") return [["clip", []]];
  return [
    ["wl-copy", []],
    ["xclip", ["-selection", "clipboard"]],
    ["xsel", ["--clipboard", "--input"]]
  ];
}
async function readClipboard() {
  for (const [cmd, args] of readCommands()) {
    const text = await new Promise((resolve) => {
      execFile2(cmd, args, { maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
        resolve(error ? null : stdout);
      });
    });
    if (text !== null) return text;
  }
  return null;
}
async function writeClipboard(text) {
  for (const [cmd, args] of writeCommands()) {
    const ok = await new Promise((resolve) => {
      const child = spawn2(cmd, args, { stdio: ["pipe", "ignore", "ignore"] });
      child.on("error", () => resolve(false));
      child.on("close", (code) => resolve(code === 0));
      child.stdin.end(text);
    });
    if (ok) return true;
  }
  return false;
}

// src/auth/login.ts
var SESSION_URL = "https://chatgpt.com/api/auth/session";
var CONSOLE_SNIPPET = "(async()=>{const s=await(await fetch('/api/auth/session')).json();if(!s.accessToken){alert('Not signed in to ChatGPT in this tab');return}const a=(document.cookie.match(/(?:^|; )_account=([^;]*)/)||[])[1],v=JSON.stringify({accessToken:s.accessToken,accountId:a?decodeURIComponent(a):null});try{copy(v);console.log('%cCopied. Go back to the terminal and press Enter.','font-weight:bold')}catch{prompt('Copy this (Cmd+C / Ctrl+C), click OK, then go back to the terminal:',v)}})()";
var MAX_ATTEMPTS = 3;
async function printInstructions(method) {
  console.log(chalk3.bold("\nSign in to ChatGPT"));
  if (method === "console") {
    const copied = await writeClipboard(CONSOLE_SNIPPET);
    console.log(`  1. Open ${chalk3.cyan("https://chatgpt.com")} in the browser you use for ChatGPT, in the workspace to back up.`);
    console.log("  2. Open the browser console (Chrome/Edge \u2325\u2318J, Safari \u2325\u2318C, Firefox \u2325\u2318K).");
    console.log(
      `  3. Paste ${copied ? "the script now on your clipboard" : "the script below"} and press Enter (Chrome may ask you to type "allow pasting" first).`
    );
    if (!copied) console.log(chalk3.dim(`
${CONSOLE_SNIPPET}
`));
    console.log("  4. Come back here.");
  } else {
    console.log(`  1. In the browser you use for ChatGPT, open ${chalk3.cyan(SESSION_URL)}`);
    console.log("  2. Copy the whole page (\u2318A, then \u2318C).");
    console.log("  3. Come back here.");
    console.log(chalk3.dim("  (Prefer the browser console? Run `login --console` instead.)"));
  }
  console.log();
}
async function readCredentials(attempt) {
  const answer = await promptLine(`Press Enter once it's copied${attempt > 1 ? " again" : ""} (q to cancel): `);
  if (answer.trim().toLowerCase() === "q") return null;
  const clipboard = await readClipboard();
  const fromClipboard = clipboard ? parseCredentialsText(clipboard) : null;
  if (fromClipboard) return { credentials: fromClipboard, fromClipboard: true };
  const pasted = await promptHidden("Couldn't find a token on the clipboard. Paste it here instead (input is hidden): ");
  return { credentials: parseCredentialsText(pasted), fromClipboard: false };
}
async function interactiveLogin(options) {
  if (options.reason) console.log(chalk3.yellow(`
${options.reason}`));
  await printInstructions(options.method ?? "session-page");
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let read;
    try {
      read = await readCredentials(attempt);
    } catch (error) {
      if (error instanceof PromptCancelledError) return null;
      throw error;
    }
    if (!read) return null;
    let credentials = read.credentials;
    if (!credentials) {
      console.log(chalk3.red("That didn't contain a ChatGPT access token. Check you're signed in, reload the page and copy it again."));
      continue;
    }
    if (isTokenExpired(credentials.accessToken)) {
      console.log(chalk3.red("That token has already expired. Reload the page and copy it again."));
      continue;
    }
    const info = getTokenInfo(credentials.accessToken);
    if (!credentials.accountId && info?.accountId) credentials = { ...credentials, accountId: info.accountId };
    const verified = await options.verify(credentials);
    if (!verified.ok) {
      console.log(chalk3.red(`ChatGPT didn't accept that token: ${verified.error ?? "unknown error"}`));
      continue;
    }
    await saveCredentials(options.settings, verified.credentials);
    if (read.fromClipboard) await writeClipboard("");
    const expiresAt = tokenExpiresAt(verified.credentials.accessToken);
    const who = info?.email ? ` as ${info.email}` : "";
    const workspace = verified.credentials.accountId ?? verified.workspaceId;
    console.log(chalk3.green(`
\u2714 Signed in${who}${workspace ? ` \xB7 workspace ${workspace}` : ""}`));
    if (verified.unverified) {
      console.log(chalk3.yellow("  Couldn't double-check the token because ChatGPT is throttling right now; saved it anyway."));
    }
    if (expiresAt) {
      console.log(`  Token valid until ${formatDateTime(expiresAt)} (${formatRelative(expiresAt)}); you'll be asked to sign in again after that.`);
    }
    console.log(chalk3.dim(`  Saved to ${options.settings.configPath} (readable only by you)${read.fromClipboard ? "; clipboard cleared" : ""}.`));
    return verified.credentials;
  }
  console.log(chalk3.red(`Giving up after ${MAX_ATTEMPTS} attempts.`));
  return null;
}

// src/cli/runtime.ts
var CLI_NAME = "chatgpt-exporter";
var LoginRequiredError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "LoginRequiredError";
  }
};
function numberSetting(settings, key) {
  const raw = getSetting(settings, key);
  if (raw === void 0) return void 0;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${key} must be a positive number (got "${raw}")`);
  return value;
}
function resolvePacing(settings, flags) {
  const paceSeconds = flags.pace ?? numberSetting(settings, ENV.pace) ?? DEFAULT_PACE_SECONDS;
  const burst = flags.burst ?? numberSetting(settings, ENV.burst) ?? DEFAULT_BURST;
  return { paceSeconds, burst: Math.max(1, Math.floor(burst)) };
}
function rateLimitStatePath(settings) {
  return path10.join(settings.stateDir, "rate-limit.json");
}
function schedulerConfig(settings, pacing) {
  return {
    conversation: { intervalMs: pacing.paceSeconds * 1e3, burst: pacing.burst },
    list: { intervalMs: 2e3, burst: 3 },
    file: { intervalMs: 5e3, burst: 5 },
    minGapMs: Math.min(1e3, pacing.paceSeconds * 1e3),
    throttleCooldownMs: 30 * 6e4,
    maxThrottleCooldownMs: 2 * 36e5,
    maxConsecutiveThrottles: 3,
    statePath: rateLimitStatePath(settings)
  };
}
function tokenCandidates(settings, flag) {
  const candidates = [];
  if (flag) candidates.push({ token: flag, source: "flag" });
  const fromEnvironment = process.env[ENV.token];
  if (fromEnvironment) candidates.push({ token: fromEnvironment, source: "environment" });
  const fromFile = settings.env[ENV.token];
  if (fromFile) candidates.push({ token: fromFile, source: "env-file" });
  return candidates;
}
async function verifyCredentials(scheduler, credentials) {
  const signal = AbortSignal.timeout(45e3);
  const probe = (creds) => new ChatGPTClient(creds.accessToken, { scheduler, accountId: creds.accountId, signal }).initialize();
  try {
    const { workspaceId } = await probe(credentials);
    return { ok: true, credentials, workspaceId };
  } catch (error) {
    if (signal.aborted) return { ok: true, credentials, unverified: true };
    if (!credentials.accountId) return { ok: false, credentials, error: errorMessage(error) };
    const withoutWorkspace = { accessToken: credentials.accessToken };
    try {
      const { workspaceId } = await probe(withoutWorkspace);
      return { ok: true, credentials: withoutWorkspace, workspaceId };
    } catch (retryError) {
      if (signal.aborted) return { ok: true, credentials, unverified: true };
      return { ok: false, credentials, error: errorMessage(retryError) };
    }
  }
}
function runLogin(settings, scheduler, options = {}) {
  return interactiveLogin({
    settings,
    method: options.method,
    reason: options.reason,
    verify: (credentials) => verifyCredentials(scheduler, credentials)
  });
}
async function createRuntime(options = {}) {
  const settings = options.settings ?? await loadSettings();
  const pacing = resolvePacing(settings, options);
  const scheduler = await RequestScheduler.create(schedulerConfig(settings, pacing));
  const interactive = isInteractive();
  const { chosen, expired } = pickToken(tokenCandidates(settings, options.tokenFlag));
  let tokenSource = chosen?.source ?? "login";
  let current = chosen ? { accessToken: chosen.token, accountId: getSetting(settings, ENV.accountId) } : null;
  const signIn = async (reason) => {
    options.ui?.suspend();
    try {
      const fresh = await runLogin(settings, scheduler, { reason });
      if (fresh) {
        current = fresh;
        tokenSource = "login";
      }
      return fresh;
    } finally {
      options.ui?.resume();
    }
  };
  if (!current) {
    const expiredAt = expired[0] ? tokenExpiresAt(expired[0].token) : null;
    const reason = expiredAt ? `Your saved ChatGPT token expired on ${formatDateTime(expiredAt)}.` : "No ChatGPT token is saved yet.";
    if (!interactive) throw new LoginRequiredError(reason);
    if (!await signIn(reason)) throw new LoginRequiredError("Sign-in was cancelled.");
  }
  const initial = current;
  if (!initial) throw new LoginRequiredError("No ChatGPT token available.");
  const client = new ChatGPTClient(initial.accessToken, {
    scheduler,
    accountId: initial.accountId,
    signal: options.signal,
    log: options.log,
    onAuthExpired: interactive ? (reason) => signIn(`${reason}. Sign in again to carry on.`) : void 0
  });
  const { workspaceId } = await client.initialize();
  return {
    settings,
    pacing,
    scheduler,
    client,
    get tokenSource() {
      return tokenSource;
    },
    workspaceId,
    credentials: () => current ?? initial
  };
}
function describeCredentials(credentials) {
  return { email: getTokenInfo(credentials.accessToken)?.email, expiresAt: tokenExpiresAt(credentials.accessToken) };
}

// src/cli/errors.ts
import chalk4 from "chalk";
var EXIT = {
  ok: 0,
  error: 1,
  needsLogin: 2,
  throttled: 3,
  interrupted: 130
};
function loginHint() {
  return `Run ${chalk4.cyan(`${CLI_NAME} login`)} (or ${chalk4.cyan("npm run login")} in the exporter folder), then run the backup again; it carries on where it stopped.`;
}
function notifyIfUnattended(message) {
  if (!isInteractive()) notify("ChatGPT exporter", message);
}
async function handleCommandError(error, verbose = false) {
  if (error instanceof LoginRequiredError || error instanceof AuthenticationError) {
    console.error(chalk4.red(`
${error.message}`));
    console.error(loginHint());
    notifyIfUnattended("Backups have stopped: your ChatGPT sign-in has expired. Run `chatgpt-exporter login` in Terminal.");
    return EXIT.needsLogin;
  }
  if (error instanceof ThrottledError) {
    const when = error.resumeAt ? ` Try again after ${formatClock(error.resumeAt)}.` : "";
    console.error(chalk4.yellow(`
ChatGPT is still asking us to slow down, so this run stopped.${when}`));
    return EXIT.throttled;
  }
  if (isAbortError(error)) {
    console.error(chalk4.yellow("\nStopped."));
    return EXIT.interrupted;
  }
  if (error instanceof AlreadyRunningError) {
    console.error(chalk4.yellow(`
${error.message}`));
    return EXIT.error;
  }
  if (error instanceof NetworkError) {
    console.error(chalk4.red(`
${error.message}`));
    console.error("Couldn't reach ChatGPT. If it works from Terminal but not on a schedule, a per-app firewall (such as Little Snitch) may be blocking node when launchd starts it.");
    if (!isInteractive()) {
      await remindOncePerDay(
        configDir(),
        "network",
        "Scheduled backup couldn't reach ChatGPT. If it works from Terminal, check that your firewall (e.g. Little Snitch) allows node when run on a schedule."
      );
    }
    return EXIT.error;
  }
  console.error(chalk4.red(`
Error: ${error instanceof Error ? error.message : String(error)}`));
  if (verbose && error instanceof Error && error.stack) console.error(chalk4.dim(error.stack));
  return EXIT.error;
}

// src/cli/commands/backup.ts
var STOP_MESSAGES = {
  "max-downloads": "reached --max-downloads",
  throttled: "ChatGPT kept asking us to slow down",
  auth: "the ChatGPT token stopped working",
  interrupted: "stopped by Ctrl+C",
  "too-many-failures": "several conversations failed in a row"
};
function exitCodeFor(reason) {
  switch (reason) {
    case "throttled":
      return EXIT.throttled;
    case "auth":
      return EXIT.needsLogin;
    case "interrupted":
      return EXIT.interrupted;
    case "too-many-failures":
      return EXIT.error;
    default:
      return EXIT.ok;
  }
}
function describePlan(plan) {
  const main = plan.sources.find((s) => s.label === "Conversations");
  const projects = plan.sources.filter((s) => s !== main);
  const parts = [
    `${formatCount(plan.unique)} conversations listed${projects.length > 0 ? ` (incl. ${plural(projects.length, "project")})` : ""}`,
    `${formatCount(plan.upToDate)} up to date`
  ];
  if (plan.copied > 0) parts.push(`${formatCount(plan.copied)} copied between folders`);
  if (plan.skippedFailed > 0) parts.push(`${formatCount(plan.skippedFailed)} skipped after repeated failures`);
  if (plan.skippedSince > 0) parts.push(`${formatCount(plan.skippedSince)} older than --since`);
  parts.push(plan.toDownload > 0 ? chalk5.bold(`${formatCount(plan.toDownload)} to download`) : "nothing new to download");
  return parts.join(" \xB7 ");
}
function printSettings(runtime, output, timeZone, options) {
  const { paceSeconds, burst } = runtime.pacing;
  const perHour = Math.round(3600 / paceSeconds);
  console.log(chalk5.dim(`  Output:  ${output} \xB7 dates in ${timeZone}`));
  console.log(
    chalk5.dim(
      `  Mode:    ${options.full ? "full (re-download everything)" : "incremental (new and changed chats, then older gaps)"}${options.archived ? " \xB7 archived chats included" : ""}${options.project ? ` \xB7 project "${options.project}" only` : ""}`
    )
  );
  console.log(
    chalk5.dim(
      `  Pace:    1 conversation every ${paceSeconds}s (\u2248 ${perHour}/hour) after a burst of up to ${burst}${options.maxDownloads ? ` \xB7 stop after ${options.maxDownloads}` : ""}`
    )
  );
  if (paceSeconds < 60) {
    console.log(chalk5.yellow("  Note: faster than ChatGPT refills (~1/minute), so this may slow down your own ChatGPT use."));
  }
  console.log();
}
function printSummary(result, runtime, output) {
  const finished = !result.stopReason;
  const heading = finished ? chalk5.green("\n\u2714 Backup finished") : chalk5.yellow("\n\u23F8 Backup paused");
  console.log(heading);
  console.log(`  Downloaded   ${formatCount(result.downloaded)}`);
  console.log(`  Up to date   ${formatCount(result.upToDate)}`);
  if (result.copied > 0) console.log(`  Copied       ${formatCount(result.copied)} (already downloaded in another folder)`);
  if (result.failed > 0) console.log(`  Failed       ${chalk5.red(formatCount(result.failed))} (details in backup.log; retried next run)`);
  if (result.skippedFailed > 0) {
    console.log(`  Parked       ${formatCount(result.skippedFailed)} that failed in several runs (use --retry-failed)`);
  }
  if (result.remaining > 0) {
    const eta = formatDuration(runtime.scheduler.estimateMs(result.remaining));
    console.log(`  Still to do  ${chalk5.bold(formatCount(result.remaining))} \xB7 \u2248 ${eta} at this pace; run backup again to continue`);
  }
  if (result.stopReason) {
    console.log(`  Stopped      ${STOP_MESSAGES[result.stopReason]}${result.stopDetail && result.stopReason !== "interrupted" ? chalk5.dim(` (${result.stopDetail})`) : ""}`);
  }
  if (result.workspaceIds.length > 1) {
    console.log(chalk5.yellow(`  Note: conversations came from ${result.workspaceIds.length} workspaces: ${result.workspaceIds.join(", ")}`));
  }
  console.log(`  Output       ${chalk5.cyan(output)}`);
  if (result.stopReason === "auth") console.log(`
${loginHint()}`);
}
function summaryLine(result) {
  return `Backup ${result.stopReason ? "paused" : "finished"}: ${result.downloaded} downloaded, ${result.upToDate} up to date, ${result.copied} copied, ${result.failed} failed, ${result.remaining} remaining` + (result.stopReason ? ` (stopped: ${STOP_MESSAGES[result.stopReason]})` : "");
}
async function upgradeMarkdown(output, timeZone, storage, reporter, signal) {
  const metadata = await readMetadata(output);
  if (metadata.markdownFormat === MARKDOWN_FORMAT && metadata.markdownTimeZone === timeZone) return;
  const result = await convertArchive(output, {
    timeZone,
    signal,
    onProgress: (done, total) => reporter.spin(`Updating the Markdown files: ${formatCount(done)}/${formatCount(total)}`)
  });
  if (result.converted + result.unchanged + result.errors > 0) {
    const summary = `Markdown files updated: ${formatCount(result.converted)} rewritten, ${formatCount(result.unchanged)} already current` + (result.errors > 0 ? `, ${formatCount(result.errors)} unreadable` : "");
    reporter.spinDone(summary);
    await storage.appendLog(summary);
  }
  await updateMetadata(output, { markdownFormat: MARKDOWN_FORMAT, markdownTimeZone: timeZone });
}
async function loadFailedFiles(output) {
  try {
    const metadata = JSON.parse(await fs10.readFile(path11.join(output, "metadata.json"), "utf-8"));
    if (Array.isArray(metadata.failedFiles)) return new Set(metadata.failedFiles);
  } catch {
  }
  return /* @__PURE__ */ new Set();
}
async function runFileDownloads(client, output, reporter, options) {
  reporter.spin("Scanning conversations for file references\u2026");
  const refs = await scanAllConversations(output);
  const skipFileIds = await loadFailedFiles(output);
  const known = refs.filter((r) => skipFileIds.has(r.fileId)).length;
  reporter.spinDone(`Found ${plural(refs.length, "file reference")}${known > 0 ? ` (${known} previously failed, skipped)` : ""}`);
  if (refs.length - known === 0) return;
  const errors = /* @__PURE__ */ new Map();
  let failedIds = [];
  try {
    const result = await downloadFiles(client, refs, output, {
      verbose: options.verbose,
      skipFileIds,
      signal: options.signal,
      onProgress: (completed, total) => reporter.spin(`Files: ${formatCount(completed)}/${formatCount(total)}`),
      onError: (_fileId, error) => errors.set(error.message, (errors.get(error.message) ?? 0) + 1)
    });
    failedIds = result.failedFileIds;
    reporter.spinDone(`Files: ${result.downloaded} downloaded, ${result.skipped} already present, ${result.failed} failed`);
  } finally {
    await updateMetadata(output, { failedFiles: [...skipFileIds, ...failedIds] });
  }
  for (const [message, count] of errors) reporter.warn(`${plural(count, "file")}: ${message}`);
}
async function backupCommand(options) {
  const reporter = createReporter();
  const controller = new AbortController();
  let interrupts = 0;
  let firstInterruptAt = 0;
  const onSigint = () => {
    const now = Date.now();
    if (interrupts === 0) {
      interrupts += 1;
      firstInterruptAt = now;
      reporter.warn("Stopping after the current step\u2026 (Ctrl+C again to quit immediately)");
      controller.abort();
      return;
    }
    if (now - firstInterruptAt < 1500) return;
    reporter.finish();
    process.exit(EXIT.interrupted);
  };
  process.on("SIGINT", onSigint);
  let lock;
  const stopKeepingAwake = options.keepAwake ? keepAwake() : () => {
  };
  try {
    const settings = await loadSettings();
    const output = await chooseOutputDir(settings, options.output);
    const timeZone = await ensureTimeZone(settings);
    lock = await acquireLock(settings.stateDir);
    const storage = new StorageService(output, { timeZone });
    await storage.initialize();
    await removeStaleTempFiles(output);
    const log = async (message) => {
      await storage.appendLog(message);
      if (options.verbose) reporter.info(chalk5.dim(message));
    };
    await upgradeMarkdown(output, timeZone, storage, reporter, controller.signal);
    reporter.spin("Checking your ChatGPT sign-in\u2026");
    const runtime = await createRuntime({
      settings,
      tokenFlag: options.token,
      pace: options.pace,
      burst: options.burst,
      signal: controller.signal,
      log,
      ui: reporter
    });
    const { email, expiresAt } = describeCredentials(runtime.credentials());
    reporter.spinDone(
      `Signed in${email ? ` as ${email}` : ""}${runtime.workspaceId ? ` \xB7 workspace ${runtime.workspaceId}` : ""}` + (expiresAt ? chalk5.dim(` \xB7 token valid until ${formatDateTime(expiresAt)} (${formatRelative(expiresAt)})`) : "")
    );
    if (runtime.tokenSource === "environment") {
      reporter.info(chalk5.dim("  Using CHATGPT_TOKEN from your shell environment (it takes priority over config.env)."));
    }
    if (!reporter.interactive) {
      const warning = await warnIfTokenExpiringSoon(settings, runtime.credentials().accessToken);
      if (warning) {
        reporter.warn(warning);
        await storage.appendLog(`Warning: ${warning}`);
      }
    }
    printSettings(runtime, output, timeZone, options);
    runtime.scheduler.onWait = (kind, info) => reporter.waiting(kind, info);
    const sync = await SyncStateStore.load(output);
    const capped = (queued) => Math.min(queued, options.maxDownloads ?? Number.POSITIVE_INFINITY);
    let downloadsShown = false;
    const service = new BackupService(runtime.client, storage, sync, {
      onListing: (label, fetched, total) => reporter.listing(label, fetched, total),
      onQueued: (queued) => {
        if (downloadsShown) {
          reporter.setTotal(capped(queued));
        } else if (queued > 0) {
          downloadsShown = true;
          reporter.startDownloads(capped(queued), (remaining) => runtime.scheduler.estimateMs(remaining));
        }
      },
      onListingDone: (plan) => reporter.listingDone(describePlan(plan)),
      onWarning: (message) => reporter.warn(message),
      onDownloaded: (entry, done) => reporter.downloadDone(entry.title, done),
      onFailed: (entry, error, done) => reporter.downloadFailed(entry.title, error.message, done)
    });
    const { paceSeconds, burst } = runtime.pacing;
    await storage.appendLog(
      `Starting backup (${options.full ? "full" : "incremental"}; pace ${paceSeconds}s, burst ${burst}${options.maxDownloads ? `, max ${options.maxDownloads}` : ""}${options.project ? `, project ${options.project}` : ""})`
    );
    reporter.spin("Listing conversations\u2026");
    const result = await service.run({
      full: options.full,
      refreshList: options.refreshList,
      includeArchived: options.archived,
      project: options.project,
      since: options.since,
      retryFailed: options.retryFailed,
      maxDownloads: options.maxDownloads,
      signal: controller.signal
    });
    reporter.finish();
    if (options.downloadFiles && (!result.stopReason || result.stopReason === "max-downloads")) {
      try {
        await runFileDownloads(runtime.client, output, reporter, { verbose: options.verbose, signal: controller.signal });
      } catch (error) {
        reporter.finish();
        reporter.warn(`File downloads stopped: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (options.downloadFiles) await convertArchive(output, { timeZone });
    await updateMetadata(output, {
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      mode: options.full ? "full" : "incremental",
      pace: paceSeconds,
      burst,
      totalConversations: result.unique,
      sources: result.sources,
      upToDate: result.upToDate,
      copied: result.copied,
      successfulDownloads: result.downloaded,
      failedDownloads: result.failed,
      remaining: result.remaining,
      skippedFailed: result.skippedFailed,
      skippedSince: result.skippedSince,
      stopReason: result.stopReason ?? null,
      workspaceIds: result.workspaceIds,
      errors: result.errors.slice(0, 200)
    });
    await storage.appendLog(summaryLine(result));
    printSummary(result, runtime, output);
    if (result.stopReason === "auth") notifyIfUnattended("Backup paused: sign in again with `chatgpt-exporter login`.");
    return exitCodeFor(result.stopReason);
  } catch (error) {
    reporter.finish();
    return handleCommandError(error, options.verbose);
  } finally {
    process.removeListener("SIGINT", onSigint);
    stopKeepingAwake();
    await lock?.release();
  }
}

// src/cli/commands/convert.ts
import chalk6 from "chalk";
async function convertCommand(options) {
  const reporter = createReporter();
  let lock;
  try {
    const settings = await loadSettings();
    const output = resolveOutputDir(settings, options.output);
    const timeZone = await ensureTimeZone(settings);
    lock = await acquireLock(settings.stateDir);
    const result = await convertArchive(output, {
      timeZone,
      onProgress: (done, total) => reporter.spin(`Converting: ${formatCount(done)}/${formatCount(total)}`)
    });
    reporter.finish();
    const converted = result.converted + result.unchanged;
    if (converted + result.errors === 0) {
      console.log(`No saved conversations in ${chalk6.cyan(output)}`);
      return EXIT.ok;
    }
    await updateMetadata(output, { markdownFormat: MARKDOWN_FORMAT, markdownTimeZone: timeZone });
    console.log(
      `Converted ${plural(converted, "conversation")} in ${chalk6.cyan(output)} (dates in ${timeZone}): ${formatCount(result.converted)} Markdown files rewritten, ${formatCount(result.unchanged)} already current`
    );
    if (result.errors > 0) console.log(chalk6.red(`  ${formatCount(result.errors)} couldn't be converted`));
    return result.errors > 0 ? EXIT.error : EXIT.ok;
  } catch (error) {
    reporter.finish();
    return handleCommandError(error);
  } finally {
    await lock?.release();
  }
}

// src/cli/commands/list.ts
import chalk7 from "chalk";
async function listCommand(options) {
  const reporter = createReporter();
  try {
    reporter.spin("Checking your ChatGPT sign-in\u2026");
    const runtime = await createRuntime({ tokenFlag: options.token, ui: reporter });
    const client = runtime.client;
    let conversations;
    if (options.project) {
      reporter.spin("Resolving project\u2026");
      const wanted = options.project.toLowerCase();
      const projects = await fetchAllProjects(client);
      const match = projects.find((p) => p.gizmo.id === options.project || p.gizmo.display.name.toLowerCase() === wanted);
      if (!match) {
        const available = projects.map((p) => p.gizmo.display.name).join(", ") || "(none)";
        throw new Error(`Project "${options.project}" not found. Available projects: ${available}`);
      }
      reporter.spin(`Listing conversations in "${match.gizmo.display.name}"\u2026`);
      conversations = await fetchProjectConversations(client, match.gizmo.id);
    } else {
      reporter.spin(`Listing ${options.archived ? "archived " : ""}conversations\u2026`);
      conversations = await fetchAllConversations(client, { archived: options.archived });
    }
    reporter.spinDone(`Found ${plural(conversations.length, "conversation")}`);
    reporter.finish();
    if (options.json) {
      console.log(JSON.stringify(conversations, null, 2));
      return EXIT.ok;
    }
    console.log();
    for (const conv of conversations) {
      const title = conv.title ?? chalk7.dim("(untitled)");
      const date = conv.update_time ? new Date(typeof conv.update_time === "number" ? conv.update_time * 1e3 : conv.update_time).toLocaleDateString() : "unknown date";
      console.log(`${chalk7.cyan(conv.id)} ${title} ${chalk7.dim(`[${date}]`)}`);
    }
    console.log();
    console.log(chalk7.green(`Total: ${plural(conversations.length, "conversation")}`));
    return EXIT.ok;
  } catch (error) {
    reporter.finish();
    return handleCommandError(error, options.verbose);
  }
}

// src/cli/commands/login.ts
import chalk8 from "chalk";
async function loginCommand(options) {
  if (!isInteractive()) {
    console.error("`login` needs an interactive terminal.");
    return EXIT.error;
  }
  try {
    const settings = await loadSettings();
    const scheduler = await RequestScheduler.create(schedulerConfig(settings, resolvePacing(settings, {})));
    const credentials = await runLogin(settings, scheduler, { method: options.console ? "console" : "session-page" });
    if (!credentials) return EXIT.error;
    if (process.env[ENV.token]) {
      console.log(chalk8.yellow(`  Note: CHATGPT_TOKEN is also set in your shell and takes priority over config.env while it's valid; run \`unset ${ENV.token}\`.`));
    }
    const output = await chooseOutputDir(settings);
    console.log(`Next: run ${chalk8.cyan(`${CLI_NAME} backup`)} to start backing up to ${output}`);
    return EXIT.ok;
  } catch (error) {
    return handleCommandError(error);
  }
}
async function logoutCommand() {
  const settings = await loadSettings();
  await clearSavedToken(settings);
  console.log(`Removed the saved token from ${settings.configPath}.`);
  if (process.env[ENV.token]) console.log(chalk8.yellow(`CHATGPT_TOKEN is still set in your shell environment.`));
  return EXIT.ok;
}

// src/cli/commands/projects.ts
import chalk9 from "chalk";
async function projectsCommand(options) {
  const reporter = createReporter();
  try {
    reporter.spin("Checking your ChatGPT sign-in\u2026");
    const runtime = await createRuntime({ tokenFlag: options.token, ui: reporter });
    reporter.spin("Fetching projects\u2026");
    const projects = await fetchAllProjects(runtime.client);
    reporter.spinDone(`Found ${plural(projects.length, "project")}`);
    reporter.finish();
    if (options.json) {
      const output = projects.map((p) => ({
        id: p.gizmo.id,
        name: p.gizmo.display.name,
        num_interactions: p.gizmo.num_interactions,
        last_interacted_at: p.gizmo.last_interacted_at,
        is_archived: p.gizmo.is_archived
      }));
      console.log(JSON.stringify(output, null, 2));
      return EXIT.ok;
    }
    console.log();
    for (const project of projects) {
      const gizmo = project.gizmo;
      const lastInteracted = gizmo.last_interacted_at ? new Date(gizmo.last_interacted_at).toLocaleDateString() : "never";
      console.log(`${chalk9.cyan(gizmo.id)} ${chalk9.bold(gizmo.display.name)} ${chalk9.dim(`[last: ${lastInteracted}]`)}`);
    }
    console.log();
    console.log(chalk9.green(`Total: ${plural(projects.length, "project")}`));
    return EXIT.ok;
  } catch (error) {
    reporter.finish();
    return handleCommandError(error, options.verbose);
  }
}

// src/cli/commands/status.ts
import fs11 from "fs/promises";
import path12 from "path";
import chalk10 from "chalk";
async function readJson(file) {
  try {
    return JSON.parse(await fs11.readFile(file, "utf-8"));
  } catch {
    return null;
  }
}
async function downloadedIds(dir) {
  try {
    const files = await fs11.readdir(dir);
    return new Set(files.filter((f) => f.endsWith(".json") && f !== "index.json").map((f) => f.slice(0, -5)));
  } catch {
    return /* @__PURE__ */ new Set();
  }
}
var row = (label, value) => console.log(`  ${label.padEnd(12)} ${value}`);
async function statusCommand(options) {
  const settings = await loadSettings();
  const output = resolveOutputDir(settings, options.output);
  const pacing = resolvePacing(settings, {});
  const now = Date.now();
  console.log(chalk10.bold("ChatGPT exporter status"));
  const configExists = await fs11.stat(settings.configPath).then(() => true, () => false);
  row("Settings", `${settings.configPath}${configExists ? "" : chalk10.dim(" (not created yet)")}`);
  const { chosen, expired } = pickToken(tokenCandidates(settings), now);
  if (chosen) {
    const info = getTokenInfo(chosen.token);
    const expiresAt = tokenExpiresAt(chosen.token);
    row(
      "Sign-in",
      `${info?.email ?? "token saved"}` + (expiresAt ? ` \xB7 valid until ${formatDateTime(expiresAt)} (${formatRelative(expiresAt, now)})` : "") + (chosen.source === "environment" ? chalk10.dim(" \xB7 from CHATGPT_TOKEN in your shell") : "")
    );
  } else {
    const expiredAt = expired[0] ? tokenExpiresAt(expired[0].token) : null;
    row("Sign-in", chalk10.yellow(`${expiredAt ? `token expired ${formatRelative(expiredAt, now)}` : "not signed in"}; run \`${CLI_NAME} login\``));
  }
  const accountId = getSetting(settings, ENV.accountId);
  if (accountId) row("Workspace", accountId);
  row("Output", `${output}${options.output || isOutputDirConfigured(settings) ? "" : chalk10.dim(" (default; the first backup asks where to keep the archive)")}`);
  try {
    const pinned = getSetting(settings, ENV.timeZone) !== void 0;
    row("Time zone", `${resolveTimeZone(settings)}${pinned ? "" : chalk10.dim(" (this computer's; the next backup saves it)")}`);
  } catch (error) {
    row("Time zone", chalk10.yellow(errorMessage(error)));
  }
  const conversationsDir = path12.join(output, "conversations");
  const index = await readJson(path12.join(conversationsDir, "index.json"));
  let missingCount = 0;
  if (!Array.isArray(index)) {
    row("Archive", "no backup here yet");
  } else {
    const have = await downloadedIds(conversationsDir);
    const missing = index.filter((c) => !have.has(c.id));
    missingCount = missing.length;
    const archived = index.filter((c) => c.is_archived).length;
    const done = index.length - missing.length;
    const pct = index.length > 0 ? Math.floor(done / index.length * 100) : 100;
    const listedAt = (await fs11.stat(path12.join(conversationsDir, "index.json"))).mtimeMs;
    row(
      "Archive",
      `${formatCount(done)} of ${formatCount(index.length)} conversations downloaded (${pct}%)` + (archived > 0 ? `, incl. ${formatCount(archived)} archived` : "") + chalk10.dim(` \xB7 as listed ${formatDateTime(listedAt)}`)
    );
    if (missing.length > 0) {
      const times = missing.map((c) => toEpochSeconds(c.update_time)).filter((t) => t !== null).sort((a, b) => a - b);
      const range = times.length > 0 ? ` (last updated ${formatDay(times[0] * 1e3)} to ${formatDay(times[times.length - 1] * 1e3)})` : "";
      row("To do", `${formatCount(missing.length)} not downloaded yet${range}`);
    }
  }
  const projectsDir = path12.join(output, "projects");
  const projectNames = await fs11.readdir(projectsDir).catch(() => []);
  let projectTotal = 0;
  let projectDone = 0;
  let projectCount = 0;
  for (const name of projectNames) {
    const dir = path12.join(projectsDir, name, "conversations");
    const projectIndex = await readJson(path12.join(dir, "index.json"));
    if (!Array.isArray(projectIndex)) continue;
    const have = await downloadedIds(dir);
    projectCount += 1;
    projectTotal += projectIndex.length;
    projectDone += projectIndex.filter((c) => have.has(c.id)).length;
  }
  if (projectCount > 0) row("Projects", `${plural(projectCount, "project")}: ${formatCount(projectDone)} of ${formatCount(projectTotal)} downloaded`);
  const state = await readJson(
    rateLimitStatePath(settings)
  );
  const intervalMs = pacing.paceSeconds * 1e3;
  let ready = pacing.burst;
  if (state?.conversation && Number.isFinite(state.conversation.tokens)) {
    ready = Math.min(pacing.burst, state.conversation.tokens + Math.max(0, now - state.conversation.updatedAt) / intervalMs);
  }
  row("Pace", `1 conversation every ${pacing.paceSeconds}s after a burst of up to ${pacing.burst} (${Math.floor(ready)} ready now)`);
  if (missingCount > 0) {
    row("Backlog ETA", `\u2248 ${formatDuration(Math.max(0, missingCount - Math.floor(ready)) * intervalMs)} of paced downloading`);
  }
  if (state?.throttledUntil && state.throttledUntil > now) {
    row("Throttle", chalk10.yellow(`cooling down until ${formatClock(state.throttledUntil)} (${plural(state.consecutiveThrottles ?? 1, "429")} in a row)`));
  }
  const sync = await SyncStateStore.load(output);
  const parked = sync.parkedCount();
  if (parked > 0) row("Parked", `${plural(parked, "conversation")} skipped after repeated failures (backup --retry-failed)`);
  if (sync.state.lastFullListingAt) row("Full listing", formatDateTime(Date.parse(sync.state.lastFullListingAt)));
  const meta = await readJson(path12.join(output, "metadata.json"));
  if (meta && typeof meta.timestamp === "string") {
    const forkFormat = typeof meta.mode === "string";
    row(
      "Last run",
      `${formatDateTime(Date.parse(meta.timestamp))}: ${String(meta.successfulDownloads ?? 0)} downloaded, ${String(meta.failedDownloads ?? 0)} failed` + (meta.stopReason ? ` \xB7 stopped: ${String(meta.stopReason)}` : "") + (forkFormat ? "" : chalk10.dim(" (written by the original tool; covers only its last project)"))
    );
  }
  const holder = await lockHolder(settings.stateDir);
  row("Running now", holder ? chalk10.green(`yes (pid ${holder.pid}${holder.startedAt ? `, since ${formatDateTime(Date.parse(holder.startedAt))}` : ""})`) : "no");
  return 0;
}

// src/cli/index.ts
var VERSION = "2.0.0-fork.6";
function positiveNumber(flag) {
  return (value) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) throw new InvalidArgumentError(`${flag} must be a positive number.`);
    return n;
  };
}
function positiveInteger(flag) {
  return (value) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0) throw new InvalidArgumentError(`${flag} must be a whole number above 0.`);
    return n;
  };
}
function parseSince(value) {
  const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const date = ymd ? new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3])) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new InvalidArgumentError("use a date like 2025-01-31.");
  return date.getTime() / 1e3;
}
function createCli() {
  const program = new Command();
  program.name(CLI_NAME).description("Back up your ChatGPT conversations, paced so your own ChatGPT use is never throttled").version(VERSION).showHelpAfterError();
  program.command("backup").description("Download new and changed conversations, then keep filling in older ones").option("-o, --output <dir>", "output folder (default: CHATGPT_EXPORT_DIR from .env, else ./chatgpt-export)").option(
    "--pace <seconds>",
    `average seconds between conversation downloads (default ${DEFAULT_PACE_SECONDS}, or CHATGPT_PACE_SECONDS)`,
    positiveNumber("--pace")
  ).option(
    "--burst <n>",
    `downloads allowed back-to-back after a quiet period (default ${DEFAULT_BURST}, or CHATGPT_BURST)`,
    positiveInteger("--burst")
  ).option("--max-downloads <n>", "stop after downloading this many conversations", positiveInteger("--max-downloads")).option("--since <date>", "only download conversations updated on or after this date (YYYY-MM-DD)", parseSince).option("--full", "re-download every conversation, even unchanged ones", false).option("--refresh-list", "read the whole conversation list instead of stopping at the first unchanged page", false).option("--no-archived", "skip archived chats").option("--retry-failed", "retry conversations that failed in several earlier runs", false).option("--download-files", "also download file attachments and images", false).option("--project <name-or-id>", "only back up one project").option("--no-keep-awake", "let the Mac sleep during the run (it's kept awake with caffeinate by default)").option("-t, --token <token>", "use this access token instead of the saved one").option("-v, --verbose", "also print throttling and retry details", false).addOption(new Option("--incremental", "no effect: incremental is now the default").hideHelp()).action(async (opts) => {
    process.exitCode = await backupCommand({
      token: opts.token,
      output: opts.output,
      full: opts.full,
      refreshList: opts.refreshList,
      archived: opts.archived,
      since: opts.since,
      maxDownloads: opts.maxDownloads,
      pace: opts.pace,
      burst: opts.burst,
      retryFailed: opts.retryFailed,
      downloadFiles: opts.downloadFiles,
      project: opts.project,
      keepAwake: opts.keepAwake,
      verbose: opts.verbose
    });
  });
  program.command("login").description("Save a fresh ChatGPT access token to .env (copied from your browser)").option("--console", "use a one-line browser-console script instead of the session page", false).action(async (opts) => {
    process.exitCode = await loginCommand({ console: opts.console });
  });
  program.command("logout").description("Remove the saved access token from .env").action(async () => {
    process.exitCode = await logoutCommand();
  });
  program.command("status").description("Show sign-in, how much is backed up, and the backlog (no network requests)").option("-o, --output <dir>", "output folder (default: CHATGPT_EXPORT_DIR from .env, else ./chatgpt-export)").action(async (opts) => {
    process.exitCode = await statusCommand({ output: opts.output });
  });
  program.command("list").description("List conversations without downloading").option("--archived", "list archived chats instead", false).option("--project <name-or-id>", "list conversations from a specific project").option("--json", "output as JSON", false).option("-t, --token <token>", "use this access token instead of the saved one").option("-v, --verbose", "verbose errors", false).action(async (opts) => {
    process.exitCode = await listCommand({
      token: opts.token,
      verbose: opts.verbose,
      json: opts.json,
      archived: opts.archived,
      project: opts.project
    });
  });
  program.command("projects").description("List all projects").option("--json", "output as JSON", false).option("-t, --token <token>", "use this access token instead of the saved one").option("-v, --verbose", "verbose errors", false).action(async (opts) => {
    process.exitCode = await projectsCommand({ token: opts.token, verbose: opts.verbose, json: opts.json });
  });
  program.command("convert").description("Regenerate the Markdown files and restore the files' dates from the saved JSON (no network requests)").option("-o, --output <dir>", "output folder (default: CHATGPT_EXPORT_DIR from .env, else ./chatgpt-export)").action(async (opts) => {
    process.exitCode = await convertCommand({ output: opts.output });
  });
  return program;
}

// src/index.ts
await createCli().parseAsync(process.argv);
