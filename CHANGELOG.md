# Changelog

## 2.0.0-fork.3

Ready for use from GitHub: `npx github:miking7/chatgpt-exporter backup`, or `npm install -g https://github.com/miking7/chatgpt-exporter/tarball/main` (npm 11's global install of a `github:` package leaves a broken link; the tarball URL or `--install-links` avoids it).

### Changed

- Settings moved from `.env` next to the package to a per-user folder: `~/.config/chatgpt-exporter/config.env` (`$XDG_CONFIG_HOME`, or `%APPDATA%\chatgpt-exporter` on Windows). Under `npx` the package folder is the npm cache, which is hidden, wiped by `npm cache clean`, and different for every version. The rate-limit state and lock live there too. `CHATGPT_EXPORTER_HOME` still overrides the folder.
- The archive folder is no longer relative to the current directory (a second run from elsewhere would have started a second archive and spent the whole download allowance). The first run asks where to keep it, suggesting `~/Documents/chatgpt-export` (or `./chatgpt-export` if an archive from the original tool is there), and saves the answer. Unattended runs take the default.
- `dist/index.js` is committed, so `npx github:…` and `npm install -g github:…` work without a registry release or a build step (npm can't run `prepare` for global installs of git packages). A test fails if it goes stale.
- README rewritten for first-time users.

## 2.0.0-fork.2

### Changed

- The conversation list is read alongside the downloads instead of before them. Downloads start once the first page arrives (~6 s) rather than after the whole list (~3 min on a full listing). Order is still strictly newest first, and the progress total grows as pages arrive.
- A `--max-downloads` run still finishes reading the list, so `index.json` stays complete.
- Local version checks read only the top of each saved file: 0.1 s instead of 1.7 s for ~1,750 files.

### Fixed

- Ctrl+C was ignored whenever a spinner was showing, i.e. the whole listing phase. ora's `discardStdin` switches the terminal to raw mode, and its Ctrl+C listener never receives input. Spinners now leave the terminal alone.
- Under `npm run`, one Ctrl+C arrives twice (npm forwards it), which forced an immediate quit instead of a graceful stop.
- The "3 throttles in a row" limit is now counted per request type. Successful list pages running alongside could otherwise reset a streak of refused downloads.
- When the listing and the downloads hit an expired token at the same moment, they now share one sign-in prompt.

## 2.0.0-fork.1

Fork focused on keeping a local archive in sync without disturbing your own ChatGPT use.

### Added

- `login` / `logout`: the token is saved to `.env` (mode 600). It is read from the clipboard after you copy chatgpt.com/api/auth/session, or captured with a console script (`--console`). The clipboard is cleared afterwards.
- Sign-in again when the token expires, including mid-run (interactive). Unattended runs exit with code 2 and show a macOS notification.
- `ChatGPT-Account-Id` workspace header for Team/Business, verified at login.
- Request scheduler that stays under ChatGPT's measured limit (~200 burst, ~1/min refill): 90 s pace after a burst of 30, persisted across runs.
- On 429: a global pause of max(30 min, `Retry-After`) that doubles on repeats (capped at 2 h), with a slower pace afterwards. Stops after 3 in a row.
- Incremental listing that stops at the first page unchanged since the last listing (full listing every 30 days or with `--refresh-list`).
- Archived chats (`is_archived=true`) are included by default; `--no-archived` skips them.
- `status` (offline overview), `convert`, `--max-downloads`, `--since`, `--retry-failed`, `--refresh-list`, `--pace`, `--burst`.
- Markdown written as each conversation is saved; atomic writes.
- Project chats downloaded once and copied to the project folder.
- Deleted (404) chats and chats failing 3+ runs are parked (`.sync-state.json`).
- A lock against overlapping runs; `caffeinate` keeps a Mac awake during a run.
- 60 s request timeout. Network errors are retried for ~8 minutes (sleep/Wi-Fi), and 5xx errors with backoff.
- Test suite with a mock ChatGPT server (`npm test`).

### Changed

- Incremental is the default (`--incremental` is accepted and ignored; `--full` re-downloads everything).
- Downloads are sequential and paced; `--concurrency` and `--delay` were removed.
- `metadata.json` now summarises the whole run instead of the last project only.
- Non-interactive output is plain timestamped log lines on stderr.

### Fixed

- Strict TypeScript errors in `pagination.ts`.

## 1.1.0

### Added

- `--download-files` flag to download file attachments and images referenced in conversations
- Two-step file download: fetches metadata from ChatGPT API, then downloads the actual file
- Downloaded files stored in `files/{fileId}/` with original filenames, deduplicated across conversations
- Markdown files reference local copies with relative paths when files are available
- Support for three file reference types: `image_asset_pointer`, `attachments`, and `citations`
- Progress bar with Downloaded/Skipped/Failed stats during file downloads
- Failed file IDs persisted in `metadata.json` to skip on subsequent incremental runs
- Errors grouped by message in output for cleaner reporting
- Privacy & Security section in README

### Fixed

- Pagination limit increased from 28 to 100 (the API maximum), reducing listing requests by ~3x
- `listProjectConversations` options made properly optional

## 1.0.0

### Added

- Full backup of all ChatGPT conversations and projects as JSON
- Automatic Markdown conversion with message threading
- Incremental backups (`--incremental`) — only downloads new or updated conversations
- Project support — backs up project conversations in separate directories
- Single project backup with `--project <name-or-id>`
- `list` command to preview conversations without downloading
- `projects` command to list all ChatGPT projects
- Configurable concurrency, delay, and output directory
- Retry with exponential backoff for rate limits and transient errors
- Progress bars for listing and downloading phases
- JSON output option for `list` and `projects` commands
