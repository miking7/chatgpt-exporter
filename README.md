# ChatGPT Exporter (paced, incremental fork)

Back up your ChatGPT conversations to your own computer, as JSON plus readable Markdown, and keep the backup up to date by re-running one command.

It works with **Team and Business workspaces**, which have no "Export data" button. It is paced to stay under ChatGPT's rate limits, so a backup running in the background never locks you out of your own chats.

This is a fork of [FdezRomero/chatgpt-exporter](https://github.com/FdezRomero/chatgpt-exporter). [What's different](#whats-different-from-the-original) is at the end.

## Quick start

You need [Node.js](https://nodejs.org/) 20.3 or newer (`brew install node` on a Mac).

```bash
npx github:miking7/chatgpt-exporter backup
```

The first run walks you through two things, then starts downloading:

1. **Signing in.** Open <https://chatgpt.com/api/auth/session> in the browser you use for ChatGPT, copy the whole page (⌘A, ⌘C), and press Enter in the terminal. The token is checked with ChatGPT, saved for later runs, and cleared from your clipboard.
2. **Where to keep the archive.** Press Enter for `~/Documents/chatgpt-export`, or type another folder.

Run the same command again whenever you like. It picks up where it left off, fetches new and changed conversations first, and then keeps filling in older ones. `npx` fetches the latest version each time.

For regular use (and for scheduling), install it as a command instead:

```bash
npm install -g https://github.com/miking7/chatgpt-exporter/tarball/main
```

```bash
chatgpt-exporter backup
```

To update an installed copy, run the install command again. (The tarball URL rather than `github:…` because npm's global install of a git package currently leaves a broken link; `npm install -g --install-links github:miking7/chatgpt-exporter` also works.)

## How long it takes

ChatGPT lets an account open roughly **200 conversations in a burst, then about 1 per minute**, and your browser draws on the same allowance whenever you open a chat. So this tool downloads one conversation every **90 seconds** after an initial burst of 30, which is about two-thirds of the refill rate. You can carry on using ChatGPT normally while it runs.

- Expect about **40 conversations an hour**: a 1,000-chat history takes about a day, spread over as many runs as you like.
- Later runs are quick: the list of conversations is only read until it reaches chats that haven't changed, which is usually one or two requests.
- If you won't be using ChatGPT (overnight, say), `--pace 65` is still under the limit and about 40% faster. Anything below 60 seconds will eventually eat into your own usage.
- If ChatGPT does ask the tool to slow down, it pauses everything for at least 30 minutes, then continues at half speed. The progress bar shows what's happening.

The first page of the conversation list arrives in a few seconds and downloads start right away; the rest of the list is read alongside them.

## Keeping it up to date

Just run `backup` again. Each run also keeps the Mac awake (`caffeinate`) so an overnight run isn't cut short, though closing the lid still sleeps it.

### Running it on a schedule (macOS)

[`launchd/com.github.miking7.chatgpt-exporter.plist`](launchd/com.github.miking7.chatgpt-exporter.plist) runs `backup` every 4 hours (at 00:15, 04:15, 08:15, 12:15, 16:15 and 20:15). Slots missed while the Mac is asleep run once when it wakes. Install it with the globally installed command in place:

```bash
curl -fsSL https://raw.githubusercontent.com/miking7/chatgpt-exporter/main/launchd/com.github.miking7.chatgpt-exporter.plist | sed "s|CHANGEME|$USER|g" > ~/Library/LaunchAgents/com.github.miking7.chatgpt-exporter.plist
```

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.github.miking7.chatgpt-exporter.plist
```

If `which chatgpt-exporter` isn't `/opt/homebrew/bin/chatgpt-exporter` (Intel Macs: `/usr/local/bin`), edit the path in the file first. Scheduled output goes to `~/Library/Logs/chatgpt-exporter.log`, and the archive's own `backup.log` records every run. To run a backup now: `launchctl kickstart gui/$(id -u)/com.github.miking7.chatgpt-exporter`; to remove the schedule: `launchctl bootout gui/$(id -u)/com.github.miking7.chatgpt-exporter`. On Linux, a cron line such as `15 */4 * * * chatgpt-exporter backup --no-keep-awake >> ~/chatgpt-exporter.log 2>&1` does the same.

Scheduled runs are safe to overlap: a lock stops two backups running at once, and the download allowance is shared and remembered between runs, so frequent runs can't add up to more than the pace allows.

Unattended runs print plain log lines instead of a progress bar, and exit with:

| Code | Meaning |
| --- | --- |
| `0` | Done, or `--max-downloads` reached |
| `2` | Your sign-in expired; run `chatgpt-exporter login` |
| `3` | ChatGPT kept throttling; try again later |
| `130` | Interrupted with Ctrl+C |

### When you need to sign in again

ChatGPT sign-in tokens last about 10 days; `status` shows when yours expires. An interactive run asks you to sign in again and carries on. Unattended runs can't, so on a Mac they warn you:

- From two days before the token expires, a notification once a day: *"Your ChatGPT sign-in expires in …"*.
- Once it has expired, every scheduled run shows *"Backups have stopped…"*, exits with code 2, and does nothing else until you run `chatgpt-exporter login`.

If notifications don't appear, allow them for **Script Editor** in System Settings → Notifications (that's how command-line tools post them).

## Where things live

Settings are kept in a per-user folder, so the tool finds them wherever it's run from:

| | Settings and state |
| --- | --- |
| macOS, Linux | `~/.config/chatgpt-exporter/` (or `$XDG_CONFIG_HOME/chatgpt-exporter/`) |
| Windows | `%APPDATA%\chatgpt-exporter\` |

`config.env` there holds your token (readable only by you) and the archive folder, in `KEY=VALUE` form:

```bash
CHATGPT_EXPORT_DIR="/Users/you/Documents/chatgpt-export"
CHATGPT_TIMEZONE=Australia/Melbourne   # saved on the first run
CHATGPT_PACE_SECONDS=90   # optional
CHATGPT_BURST=30          # optional
```

Set `CHATGPT_EXPORTER_HOME` to use a different settings folder, e.g. one per workspace.

The archive itself:

```
chatgpt-export/
  markdown/
    2026-10-11 Scheduled sync on macOS (3f1e2b4c5d6e).md   # readable Markdown of the current branch
    projects/<Project_Name>/                               # the same, per project
  conversations/
    index.json            # every conversation (incl. archived), newest first
    <id>.json             # the full conversation from the API (all branches)
  projects/<Project_Name>/conversations/   # the same JSON layout per project
  files/<fileId>/<name>   # with --download-files
  metadata.json           # summary of the last run
  backup.log              # what happened, run by run
  .sync-state.json        # when the list was last read in full; chats that keep failing
```

The Markdown files are named by the date the chat started, its title and the end of its id, so they sort by date and are easy to recognise in Finder and Spotlight results. Characters that some systems don't allow in file names are left out of the name (the title inside the file is complete). When a chat is renamed in ChatGPT, its file is renamed too. The JSON keeps the plain `<id>.json` name, which is what keeps track of what's been downloaded.

Each conversation's files carry the chat's own dates: in Finder, **Date Created** is when the chat started and **Date Modified** is when it last changed (Linux and Windows get Date Modified only). **Date Added** shows when the backup last wrote the file. Each Markdown file starts with a small YAML header (`id`, a `url` back to the chat, `title`, `created`, `updated`) that Obsidian and other editors can sort and filter on.

Dates are shown in your time zone, which the first run saves as `CHATGPT_TIMEZONE`, so they don't shift when you travel. Change it there if you like; the next backup redoes the Markdown to match.

## Commands and options

```bash
chatgpt-exporter backup [options]
```

| Option | Description | Default |
| --- | --- | --- |
| `-o, --output <dir>` | Archive folder for this run | `CHATGPT_EXPORT_DIR` |
| `--pace <seconds>` | Average seconds between conversation downloads | `90` |
| `--burst <n>` | Downloads allowed back-to-back after a quiet period | `30` |
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
| `-v, --verbose` | Also print throttling and retry details | |

Ctrl+C stops after the current request (press it twice to quit at once). Every download, throttle event and failure is recorded in `backup.log`.

Other commands:

- `status`: sign-in and token expiry, how much is downloaded, the backlog and its ETA, any throttle cooldown, and whether a backup is running. Makes no network requests.
- `login [--console]`: save a fresh token. `--console` gives you a one-line script to paste into the browser console of a chatgpt.com tab instead of copying the session page. It also captures the workspace you have open.
- `logout`: remove the saved token.
- `list [--archived] [--project <name>] [--json]`: list conversations without downloading.
- `projects [--json]`: list projects.
- `convert`: regenerate every `.md` from the saved `.json` files and restore the files' dates. Only files whose content changed are rewritten. A backup does this by itself after an update that changes the Markdown.

## Already have an archive from the original tool?

This fork reads the same layout. Run `backup` from the folder that contains your `chatgpt-export/` and the first-run question suggests it, or set `CHATGPT_EXPORT_DIR` to it. Conversations you already have are left alone; only new and changed ones are fetched. The first run writes the Markdown into `markdown/` from the JSON you already have (nothing is downloaded again) and removes the old `.md` files beside the JSON.

## Troubleshooting

- **"Sign-in needed" / exit code 2:** run `chatgpt-exporter login`.
- **Scheduled runs can't reach ChatGPT, but it works from Terminal:** a per-app firewall. Little Snitch, for example, allows `node` when you run it from Terminal but not when launchd starts it: add a rule allowing `node` (Homebrew's, under `/opt/homebrew/Cellar/node/…/bin/node`) to connect to `chatgpt.com` on port 443. Unattended runs post a notification once a day while this persists.
- **"ChatGPT asked us to slow down":** the tool is already pausing. If it happens often, raise `--pace`. `status` shows when the cooldown ends.
- **The backup stopped overnight:** check `backup.log`. If the Mac went to sleep, the next run carries on; `--no-keep-awake` disables the sleep prevention if you'd rather not have it.
- **A renamed chat still has its old title:** recent chats are picked up on the next run. For older ones, ChatGPT doesn't always move a renamed chat up the list, so the rename is noticed at the monthly full listing; `backup --refresh-list` picks it up now.
- **Short Markdown files:** normal for short chats. System messages and internal tool calls are skipped. The `.json` has everything.

## Privacy & security

This tool runs entirely on your machine. It only talks to OpenAI's servers (`chatgpt.com`), using your session token to call the same API the ChatGPT web app uses. There is no telemetry, no analytics, no third-party services, and nothing is sent anywhere else. The token is stored only in `config.env` (mode 600, in your settings folder, never inside the archive), and the clipboard is cleared after `login` reads it.

## What's different from the original

| | Original 1.1.0 | This fork |
| --- | --- | --- |
| Sign-in | `--token` on every run | `login` saves the token; you're asked to sign in again when it expires, even mid-run |
| Default mode | Re-downloads everything | **Incremental**: new and changed chats first, then older gaps. `--full` forces a re-download |
| Pacing | 3 parallel requests every 0.5 s | One conversation every **90 s** after a burst of 30, shared and persisted across runs |
| On HTTP 429 | Retries each chat 5× for ~30 s, ignores `Retry-After`, moves on | Pauses **everything** for 30 min or `Retry-After` (whichever is longer), then halves the pace. Stops after 3 throttles in a row |
| Listing | All ~28 pages (~3 min) before the first download | Read alongside the downloads; stops at the first unchanged page |
| Settings and archive | `--token` flag; archive relative to the current folder | Per-user settings folder; absolute archive folder chosen once |
| Ctrl+C | Ignored while a spinner is showing | Stops gracefully at any point |
| Archived chats | Not backed up | Included |
| Markdown | `<id>.md` beside the JSON, only written when the whole run finishes | `markdown/2026-10-11 Title (id).md`, written as each conversation is saved, with a YAML header and dates in your time zone |
| File dates | The download time | The chat's own dates (Finder's Date Created and Date Modified) |
| Project chats | Downloaded twice | Downloaded once, then copied |
| Extras | | `status`, `--max-downloads`, `--since`, `logout`, `convert`, a lock against overlapping runs, deleted chats aren't retried forever |

## Development

```bash
git clone https://github.com/miking7/chatgpt-exporter.git
cd chatgpt-exporter
npm install
npm run dev -- backup --pace 65
npm run typecheck    # source and tests
npm test             # against a local mock ChatGPT server
npm run build        # dist/index.js is committed: rebuild it before committing changes to src/
```

`dist/index.js` is checked in so that installing straight from GitHub needs no build step (npm can't run build scripts for global installs of git packages). A test fails if it goes stale.

The tests run against `test/helpers/mock-chatgpt.ts`, which emulates ChatGPT's limiter (a burst, slow refill, then 429 with `Retry-After`), so they can check that the pacing never triggers it. Terminal behaviour (Ctrl+C, the first-run prompt) is tested in a real pseudo-terminal.
