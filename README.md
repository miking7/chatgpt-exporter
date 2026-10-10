# ChatGPT Exporter (paced, incremental fork)

A CLI that backs up your ChatGPT conversations as JSON plus readable Markdown. It works with Team/Business workspaces, which have no "Export data" button.

This is a fork of [FdezRomero/chatgpt-exporter](https://github.com/FdezRomero/chatgpt-exporter) v1.1.0. It is built for keeping a **local archive in sync** without ever tripping ChatGPT's rate limits, which would also lock you out of your own chats.

## What's different from upstream

| | Upstream 1.1.0 | This fork |
| --- | --- | --- |
| Sign-in | `--token` on every run | `login` saves the token to `.env`; you're asked to sign in again when it expires, even mid-run |
| Default mode | Re-downloads everything | **Incremental**: new and changed chats first, then fills in older gaps. `--full` forces a re-download |
| Pacing | 3 parallel requests every 0.5 s | One conversation every **90 s** after a burst of up to **30**, persisted across runs |
| On HTTP 429 | Retries each chat 5× for ~30 s, ignores `Retry-After`, moves on to the next | Pauses **everything** for 30 min or `Retry-After` (whichever is longer), then halves the pace. Stops after 3 throttles in a row |
| Listing | All ~28 pages (~3 min) before the first download | Read **alongside** the downloads: downloading starts as soon as the first page arrives. Stops at the first page that hasn't changed since last time (usually 1–2 requests) |
| Ctrl+C | Ignored while a spinner is showing | Stops gracefully at any point, including via `npm run` |
| Archived chats | Not backed up | Included (`--no-archived` to skip) |
| Markdown | Only written when the whole run finishes | Written as each conversation is saved |
| Project chats | Downloaded twice | Downloaded once, then copied |
| Long runs | Mac sleeps mid-run | Kept awake with `caffeinate` (`--no-keep-awake` to opt out) |
| Extras | | `status`, `--max-downloads`, `--since`, `logout`, `convert`, a lock against overlapping runs, skips deleted chats |

### Why 90 seconds?

Measured on a Team account, ChatGPT lets an account open about **200 conversations in a burst, then about 1 per minute**. The web app draws on that same allowance whenever you open a chat. At one download every 90 s (≈40/hour), the backup uses about two-thirds of the refill. That leaves your own browsing its full allowance, even during a 24-hour backfill.

If you know you won't be using ChatGPT (e.g. overnight), `--pace 65` is still under the limit. Anything below 60 s will eventually eat into your own usage, and the tool warns you.

## Quick start

```bash
npm install
npm run build
npm link            # optional: puts `chatgpt-exporter` on your PATH
```

Then:

```bash
chatgpt-exporter login      # once; again whenever the token expires
chatgpt-exporter backup     # incremental, paced; safe to re-run any time
chatgpt-exporter status     # what's downloaded, what's left, token expiry (no network)
```

Without `npm link`, use `npm run login`, `npm run backup` or `npm run status` from this folder, or `node dist/index.js <command>`.

To keep your archive somewhere other than `./chatgpt-export`, put this in `.env`:

```bash
CHATGPT_EXPORT_DIR="/path/to/chatgpt-export"
```

## Signing in

`login` walks you through it:

1. In the browser you use for ChatGPT, open <https://chatgpt.com/api/auth/session>.
2. Copy the whole page (⌘A, ⌘C).
3. Press Enter in the terminal.

The tool reads the token from the clipboard and checks it with ChatGPT. It saves the token to `.env` with owner-only permissions (git-ignored), then clears the clipboard. If the clipboard can't be read, it asks you to paste the token, without echoing it.

- **Workspaces:** for Team/Business accounts, the workspace id is saved too (as `CHATGPT_ACCOUNT_ID`) and sent as the `ChatGPT-Account-Id` header. That pins backups to that workspace.
- **Browser console instead:** `login --console` puts a one-line script on your clipboard. Paste it into the console of a chatgpt.com tab (Chrome: ⌥⌘J). It copies the token, plus the workspace you have open, back to the clipboard.
- **Expiry:** after signing in, the tool shows when the token expires. When it does, an interactive `backup` asks you to sign in again and carries on where it was. An unattended run stops cleanly with exit code 2 and a macOS notification.
- **Precedence:** `--token` beats `CHATGPT_TOKEN` in your shell environment, which beats `.env`. Expired tokens are skipped.

Browser automation (Playwright and similar) was considered for sign-in. It's left out for now because Google/Microsoft SSO and ChatGPT's bot protection tend to block automated browsers.

## Backing up

```bash
chatgpt-exporter backup [options]
```

| Option | Description | Default |
| --- | --- | --- |
| `-o, --output <dir>` | Output folder | `CHATGPT_EXPORT_DIR`, else `./chatgpt-export` |
| `--pace <seconds>` | Average seconds between conversation downloads | `90` (`CHATGPT_PACE_SECONDS`) |
| `--burst <n>` | Downloads allowed back-to-back after a quiet period | `30` (`CHATGPT_BURST`) |
| `--max-downloads <n>` | Stop after this many downloads | no limit |
| `--since <date>` | Only download chats updated on/after this date (`YYYY-MM-DD`) | everything |
| `--full` | Re-download every conversation, even unchanged ones | off |
| `--refresh-list` | Read the whole conversation list (also done automatically every 30 days) | off |
| `--no-archived` | Skip archived chats | included |
| `--retry-failed` | Retry chats that failed in 3+ runs, or were deleted (404) | skipped |
| `--download-files` | Also download attachments and images (paced, 1 per 5 s) | off |
| `--project <name-or-id>` | Only back up one project | all |
| `--no-keep-awake` | Don't run `caffeinate` during the run | keeps the Mac awake |
| `-t, --token <token>` | Use this token instead of the saved one | |
| `-v, --verbose` | Also print throttling/retry details | |

The conversation list is read alongside the downloads, and downloads start as soon as its first page arrives. That page takes ChatGPT about 6 s, and the whole list about 3 minutes. Downloads go newest first, and the progress bar's total grows as later pages are read.

Each run picks up where the previous one stopped. Ctrl+C stops after the current request (press it twice to quit at once). Progress, every throttle event (with ChatGPT's rate-limit headers) and failures go to `backup.log` in the output folder.

### Running on a schedule

You can run `backup` from cron or launchd as often as you like. The allowance is shared and persisted, and a lock stops overlapping runs, so frequent runs can't add up to more than the pace allows.

Unattended runs print plain log lines instead of a progress bar. They exit with:

- `0` when done (or `--max-downloads` was reached)
- `2` when you need to `login`
- `3` when ChatGPT kept throttling
- `130` when interrupted

## Other commands

- `status`: sign-in and token expiry, how much is downloaded per folder, the backlog and its ETA, any throttle cooldown, and whether a backup is running. Makes no network requests.
- `list [--archived] [--project <name>] [--json]`: list conversations without downloading.
- `projects [--json]`: list projects.
- `convert`: regenerate every `.md` from the saved `.json` files.
- `logout`: remove the saved token from `.env`.

## Output layout

```
chatgpt-export/
  conversations/
    index.json            # every conversation (incl. archived), newest first
    <id>.json             # full conversation from the API (all branches)
    <id>.md               # readable Markdown of the current branch
  projects/<Project_Name>/conversations/   # same layout per project
  files/<fileId>/<name>   # with --download-files
  metadata.json           # summary of the last run
  backup.log              # what happened, run by run
  .sync-state.json        # when the list was last read in full; chats that keep failing
```

The tool's own state lives next to `.env` (in this folder, or `CHATGPT_EXPORTER_HOME`). `.state/rate-limit.json` holds the shared download allowance and any cooldown. `.state/backup.lock` exists while a backup is running.

## Troubleshooting

- **"Sign-in needed" / exit code 2:** run `chatgpt-exporter login`.
- **"ChatGPT asked us to slow down":** the tool is already pausing. If it happens often, raise `--pace`. `status` shows when the cooldown ends.
- **Short Markdown files:** normal for short chats. System messages and internal tool calls are skipped. The `.json` has everything.

## Privacy & Security

This tool runs entirely on your machine. It only talks to OpenAI's servers (`chatgpt.com`), using your session token to call the same API the ChatGPT web app uses. There is no telemetry, no analytics, no third-party services, and nothing is sent anywhere else. The token is stored only in `.env` (mode 600, git-ignored), and the clipboard is cleared after `login` reads it.

## Development

```bash
npm install
npm run typecheck   # source and tests
npm test            # unit + integration tests against a local mock ChatGPT server
npm run dev -- backup --pace 65
```

The tests run against `test/helpers/mock-chatgpt.ts`. It emulates ChatGPT's server-side limiter (a burst, slow refill, then 429 with `Retry-After`), so they can check that the pacing never triggers it.
