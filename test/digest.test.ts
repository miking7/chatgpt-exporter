import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ConversationDetail } from '../src/api/types.js';
import { buildChat, buildDigest, cleanText, parseTranscript, truncate } from '../src/services/digest-service.js';
import { convertConversation } from '../src/services/markdown-service.js';
import { StorageService } from '../src/services/storage-service.js';

const ID = '6ad0a947-3c28-83ec-9fa2-996b3a8cc27b';
const FILE = 'markdown/2026-10-15 Test chat (996b3a8cc27b).md';
const ZONE = 'Australia/Brisbane';
const none = { projectOf: new Map<string, string>(), archived: new Set<string>() };

/** A transcript laid out exactly as markdown-service writes one. */
function transcript(title: string, turns: Array<[string, string]>): string {
  const lines = [
    '---', `id: ${ID}`, `url: https://chatgpt.com/c/${ID}`, `title: ${JSON.stringify(title)}`,
    'created: 2026-10-15T21:21:59+11:00', 'updated: 2026-10-15T21:22:46+11:00', '---', '', `# ${title}`, '*2026-10-15*',
  ];
  turns.forEach(([role, text], i) => lines.push(...(i === 0 ? [''] : ['', '---', '']), `**${role}:**`, '', text));
  lines.push('');
  return lines.join('\n');
}

/** A saved conversation: a linear thread of [role, text] messages, an hour apart from `start` (epoch seconds). */
function detail(title: string, start: number, messages: Array<['user' | 'assistant', string]>): ConversationDetail {
  const mapping: ConversationDetail['mapping'] = { root: { id: 'root', message: null, parent: null, children: messages.length ? ['m0'] : [] } };
  messages.forEach(([role, text], i) => {
    mapping[`m${i}`] = {
      id: `m${i}`,
      parent: i === 0 ? 'root' : `m${i - 1}`,
      children: i + 1 < messages.length ? [`m${i + 1}`] : [],
      message: { id: `m${i}`, author: { role }, create_time: start + i * 60, content: { content_type: 'text', parts: [text] } },
    };
  });
  return {
    title,
    create_time: start,
    update_time: start + messages.length * 60,
    mapping,
    current_node: messages.length ? `m${messages.length - 1}` : 'root',
  };
}

test('digest: finds each typed message and anchors it to its marker line', () => {
  const source = transcript('PHP Class "use" Explained', [
    ['User', 'First question?'],
    ['Assistant', 'An answer.\n\n---\n\nWith a horizontal rule.'],
    ['User', 'A follow-up\nover two lines.'],
  ]);
  const chat = buildChat(FILE, source, none);
  const lines = source.split('\n');
  assert.equal(chat.title, 'PHP Class "use" Explained');
  assert.equal(chat.date, '2026-10-15');
  assert.equal(chat.suffix, '996b3a8cc27b');
  assert.equal(chat.assistantTurns, 1);
  assert.deepEqual(chat.turns.map((t) => t.text), ['First question?', 'A follow-up over two lines.']);
  for (const turn of chat.turns) assert.equal(lines[turn.line - 1], '**User:**');
});

test('digest: ignores marker lookalikes pasted inside a message', () => {
  const pasted = 'Here is a log:\n**User:**\nsomething\n---\n**Assistant:**\n\n**Assistant:**\n\nstill mine';
  const parsed = parseTranscript(transcript('Pasted', [['User', pasted], ['Assistant', 'Noted.']]));
  assert.deepEqual(parsed.turns.map((t) => t.role), ['User', 'Assistant']);
  assert.equal(parsed.turns[0].text, pasted);
});

test('digest: falls back to the first reply when nothing was typed', () => {
  const source = transcript('Voice chat', [['Assistant', 'Hello! What would you like to talk about?'], ['Assistant', 'Second.']]);
  const chat = buildChat(FILE, source, none);
  assert.equal(chat.turns.length, 0);
  assert.equal(chat.assistantTurns, 2);
  assert.equal(chat.fallback?.text, 'Hello! What would you like to talk about?');
  assert.equal(source.split('\n')[chat.fallback!.line - 1], '**Assistant:**');
});

test('digest: takes project and archived state from the lookups', () => {
  const chat = buildChat(FILE, transcript('T', [['User', 'q']]), { projectOf: new Map([[ID, 'DuckDB']]), archived: new Set([ID]) });
  assert.equal(chat.project, 'DuckDB');
  assert.equal(chat.archived, true);
});

test('digest: collapses whitespace in titles', () => {
  assert.equal(parseTranscript(transcript('Christ Birth Date\n', [['User', 'q']])).title, 'Christ Birth Date');
});

test('digest: rejects a file without front matter', () => {
  assert.throws(() => parseTranscript('# Just a heading\n'), /frontmatter/);
});

test('digest: cleans code blocks, images, control characters and whitespace', () => {
  assert.equal(cleanText('Fix this:\n```js\nconst a = 1;\n```\n![shot](file-service://x)  please'), 'Fix this: [code] [image] please');
  assert.equal(cleanText('bplist00\u0001\u0002XUTI\u0000data good\u0003 9.\u007f'), 'bplist00 XUTI data good 9.');
});

test('digest: truncates at a word boundary', () => {
  assert.deepEqual(truncate('short', 10), { text: 'short', truncated: false });
  assert.deepEqual(truncate('alpha beta gamma delta', 15), { text: 'alpha beta…', truncated: true });
  assert.deepEqual(truncate('abcdefghijklmnop', 10), { text: 'abcdefghij…', truncated: true });
});

test('digest: reads back exactly what markdown-service wrote', () => {
  const tricky = 'Here is a log:\n**User:**\nsomething\n---\n**Assistant:**\nend of log';
  const messages: Array<['user' | 'assistant', string]> = [
    ['user', 'First question?'],
    ['assistant', 'An answer.\n\n---\n\nWith a horizontal rule.'],
    ['user', tricky],
    ['assistant', 'Second answer.'],
  ];
  const markdown = convertConversation(detail('Round trip', 1_750_000_000, messages), { id: ID, timeZone: ZONE });
  const parsed = parseTranscript(markdown);
  const lines = markdown.split('\n');
  assert.equal(parsed.id, ID);
  assert.equal(parsed.title, 'Round trip');
  assert.deepEqual(parsed.turns.map((t) => [t.role, t.text]), messages.map(([role, text]) => [role === 'user' ? 'User' : 'Assistant', text]));
  for (const turn of parsed.turns) assert.equal(lines[turn.line - 1], `**${turn.role}:**`);
});

test('digest: builds INDEX.md, month pages and index.html from a saved archive, and rebuilds only what changed', async () => {
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'digest-'));
  try {
    const storage = new StorageService(out, { timeZone: ZONE });
    await storage.initialize();
    const ids = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000003'];
    // July and August 2025 in Brisbane; the third chat is a project chat that is also archived.
    await storage.saveConversation(ids[0], detail('Older chat', 1_752_000_000, [['user', 'What about July?'], ['assistant', 'July answer.']]));
    await storage.saveConversation(ids[1], detail('Newer chat', 1_755_000_000, [['user', 'Question one'], ['assistant', 'A1'], ['user', 'Question two'], ['assistant', 'A2']]));
    await storage.saveConversation(ids[2], detail('Project chat', 1_755_100_000, [['assistant', 'Opened by the assistant.']]));
    await fs.writeFile(path.join(out, 'conversations', 'index.json'), JSON.stringify(ids.map((id, i) => ({ id, is_archived: i === 2 }))));
    const project = storage.forProject('DuckDB');
    await project.initialize();
    await project.saveConversation(ids[2], detail('Project chat', 1_755_100_000, [['assistant', 'Opened by the assistant.']]));
    await fs.writeFile(path.join(out, 'projects', 'DuckDB', 'conversations', 'index.json'), JSON.stringify([{ id: ids[2] }]));

    const result = await buildDigest(out);
    assert.equal(result.chats, 3, 'the project copy in markdown/projects/ is not counted twice');
    assert.equal(result.userTurns, 3);
    assert.equal(result.assistantTurns, 4);
    assert.equal(result.months, 2);
    assert.equal(result.files, 4);
    assert.equal(result.written, 4);
    assert.deepEqual(result.failures, []);
    assert.equal(result.silent.length, 1);

    const digest = path.join(out, 'digest');
    assert.deepEqual((await fs.readdir(digest)).sort(), ['2025-07.md', '2025-08.md', 'INDEX.md', 'index.html']);
    const index = await fs.readFile(path.join(digest, 'INDEX.md'), 'utf-8');
    assert.match(index, /^3 conversations, newest first/m);
    assert.match(index, /^- 2025-08-\d\d · \[Project chat\]\(<\.\.\/markdown\/[^>]+>\) · \(no typed questions; assistant opened with\) Opened by the assistant\. · 0 turns · project: DuckDB · archived$/m);
    assert.match(index, /^- 2025-08-\d\d · \[Newer chat\]\(<\.\.\/markdown\/[^>]+>\) · Question one · 2 turns$/m);
    assert.ok(index.indexOf('Project chat') < index.indexOf('Newer chat'), 'newest first');

    const august = await fs.readFile(path.join(digest, '2025-08.md'), 'utf-8');
    const newerFile = /\[Newer chat\]\(<\.\.\/(markdown\/[^>]+)>\)/.exec(august)![1];
    const newer = (await fs.readFile(path.join(out, newerFile), 'utf-8')).split('\n');
    const anchors = [...august.matchAll(/^- L(\d+): Question (?:one|two)$/gm)].map((m) => Number(m[1]));
    assert.equal(anchors.length, 2);
    for (const line of anchors) assert.equal(newer[line - 1], '**User:**');

    const html = await fs.readFile(path.join(digest, 'index.html'), 'utf-8');
    const records = JSON.parse(/<script id="data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)![1]) as Array<{ title: string }>;
    assert.deepEqual(records.map((r) => r.title), ['Project chat', 'Newer chat', 'Older chat']);
    assert.match(html, new RegExp(`data-root="${path.resolve(out).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));

    assert.equal((await buildDigest(out)).written, 0, 'nothing changed, nothing rewritten');

    // Temp files left by a run killed mid-write are removed; the digest's own files are not.
    await fs.writeFile(path.join(digest, 'index.html.99999999.tmp'), '');
    await fs.writeFile(path.join(digest, 'INDEX.md.99999999.tmp'), '');
    await buildDigest(out);
    assert.deepEqual((await fs.readdir(digest)).sort(), ['2025-07.md', '2025-08.md', 'INDEX.md', 'index.html']);

    // A month with no chats left loses its page.
    for (const name of await fs.readdir(path.join(out, 'markdown'))) if (name.includes('Older chat')) await fs.rm(path.join(out, 'markdown', name));
    const after = await buildDigest(out);
    assert.deepEqual(after.removed, ['2025-07.md']);
    assert.equal(after.chats, 2);
    await assert.rejects(fs.access(path.join(digest, '2025-07.md')));
  } finally {
    await fs.rm(out, { recursive: true, force: true });
  }
});

test('digest: an archive with no Markdown yet gets no digest', async () => {
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'digest-'));
  try {
    const result = await buildDigest(out);
    assert.equal(result.chats, 0);
    assert.equal(result.files, 0);
    await assert.rejects(fs.access(path.join(out, 'digest')));
  } finally {
    await fs.rm(out, { recursive: true, force: true });
  }
});
