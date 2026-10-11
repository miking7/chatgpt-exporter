import { localDate } from '../utils/time.js';

/** Characters some systems refuse in file names (Windows, SMB and exFAT; `:` shows as `/` in Finder), or that break Obsidian links. */
const UNSAFE_CHARACTERS = /[\\/:*?"<>|#^[\]\p{Cc}]/gu;
/** Leaves room for the date, the id and a temp-file suffix within the usual 255-byte limit. */
const MAX_TITLE_BYTES = 100;

/** The last 12 letters and digits of a conversation id: the end of its UUID (newer ids start with a timestamp). */
export function idSuffix(id: string): string {
  return id.replace(/[^0-9A-Za-z]/g, '').slice(-12).toLowerCase();
}

const trimEnds = (text: string) => text.replace(/^[\s.]+|[\s.]+$/g, '');

/** A title that's safe in a file name everywhere: no path or reserved characters, no leading dot, not too long. */
export function safeTitle(title: string | null | undefined): string {
  const cleaned = trimEnds((title ?? '').normalize('NFC').replace(UNSAFE_CHARACTERS, ' ').replace(/\s+/g, ' '));
  return trimEnds(truncateUtf8(cleaned, MAX_TITLE_BYTES)) || 'Untitled';
}

function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  let cut = '';
  let bytes = 0;
  for (const char of text) {
    bytes += Buffer.byteLength(char);
    if (bytes > maxBytes) break;
    cut += char;
  }
  // End on a whole word when there's a space in the second half.
  const space = cut.lastIndexOf(' ');
  return space > cut.length / 2 ? cut.slice(0, space) : cut;
}

/** "2026-10-11 Scheduled sync on macOS (3f1e2b4c5d6e).md": when the chat started (in the user's zone), its title and its id. */
export function markdownFileName(id: string, title: string | null | undefined, created: number | null, timeZone: string): string {
  const date = created === null ? 'undated' : localDate(created, timeZone);
  return `${date} ${safeTitle(title)} (${idSuffix(id)}).md`;
}

/** The id suffix at the end of a name made by markdownFileName. */
export function suffixOfMarkdownName(name: string): string | undefined {
  return /\(([0-9a-z]{1,12})\)\.md$/.exec(name)?.[1];
}
