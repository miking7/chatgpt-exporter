import { test } from 'node:test';
import assert from 'node:assert/strict';
import { idSuffix, markdownFileName, safeTitle, suffixOfMarkdownName } from '../src/services/conversation-names.js';

test('the id suffix is the end of the id, not its timestamp start', () => {
  assert.equal(idSuffix('6ac0352d-c2e4-83ec-860a-634402905acd'), '634402905acd');
  assert.equal(idSuffix('new-chat'), 'newchat');
  assert.equal(suffixOfMarkdownName('2026-10-11 Notes (draft) (634402905acd).md'), '634402905acd');
  assert.equal(suffixOfMarkdownName('notes.md'), undefined);
});

test('titles are made safe for file names everywhere', () => {
  assert.equal(safeTitle('Notes: a/b <c> "d" |e| ?*'), 'Notes a b c d e');
  assert.equal(safeTitle('Line one\nLine\ttwo\u0007'), 'Line one Line two');
  assert.equal(safeTitle('[[Wiki]] #tag ^block'), 'Wiki tag block');
  assert.equal(safeTitle('.bashrc tips'), 'bashrc tips', 'no hidden files');
  assert.equal(safeTitle('Ends with dots...  '), 'Ends with dots', 'Windows and SMB drop trailing dots and spaces');
  assert.equal(safeTitle('Café'), 'Café', 'NFC, so Finder and scripts agree on the name');
  assert.equal(safeTitle('???'), 'Untitled');
  assert.equal(safeTitle(''), 'Untitled');
  assert.equal(safeTitle(null), 'Untitled');
});

test('long titles are cut on a word, within the byte limit', () => {
  const long = safeTitle('word '.repeat(60));
  assert.ok(Buffer.byteLength(long) <= 100, `${Buffer.byteLength(long)} bytes`);
  assert.ok(long.endsWith('word'), 'ends on a whole word');
  const cjk = safeTitle('漢'.repeat(80));
  assert.equal(Buffer.byteLength(cjk), 99, 'multi-byte characters are never split');
});

test('file names start with the local date the chat began', () => {
  // 2025-06-15 23:30 UTC is already the 16th in Melbourne.
  const created = Date.UTC(2025, 5, 15, 23, 30) / 1000;
  assert.equal(markdownFileName('6ac0352d-c2e4-83ec-860a-634402905acd', 'Plan', created, 'Australia/Melbourne'), '2025-06-16 Plan (634402905acd).md');
  assert.equal(markdownFileName('6ac0352d-c2e4-83ec-860a-634402905acd', 'Plan', created, 'UTC'), '2025-06-15 Plan (634402905acd).md');
  assert.equal(markdownFileName('abc', 'Plan', null, 'UTC'), 'undated Plan (abc).md');
});
