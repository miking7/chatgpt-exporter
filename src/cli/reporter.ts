import chalk from 'chalk';
import cliProgress from 'cli-progress';
import ora, { type Ora } from 'ora';
import type { RequestKind, WaitInfo } from '../api/scheduler.js';
import { formatClock, formatDuration, formatCount } from '../utils/format.js';

export interface Reporter {
  readonly interactive: boolean;
  info(message: string): void;
  warn(message: string): void;
  spin(text: string): void;
  spinDone(text: string): void;
  /** Listing progress; shown in the progress bar once downloads have started. */
  listing(label: string, fetched: number, total?: number): void;
  listingDone(summary: string): void;
  startDownloads(total: number, estimateMs: (remaining: number) => number): void;
  /** More conversations were queued while the list was still being read. */
  setTotal(total: number): void;
  downloadDone(title: string, done: number): void;
  downloadFailed(title: string, message: string, done: number): void;
  waiting(kind: RequestKind, info: WaitInfo | null): void;
  /** Hide live output while a prompt (sign-in) is on screen. */
  suspend(): void;
  resume(): void;
  finish(): void;
}

export function createReporter(): Reporter {
  // Spinners need a real terminal width: with 0 columns ora redraws forever.
  const usableTerminal = process.stdout.isTTY && process.stderr.isTTY && (process.stderr.columns ?? 0) > 0;
  return usableTerminal ? new TtyReporter() : new PlainReporter();
}

function waitText(wait: WaitInfo, now = Date.now()): string {
  if (wait.reason === 'throttle') return chalk.yellow(`ChatGPT asked us to slow down; resuming at ${formatClock(wait.until)}`);
  return `next in ${formatDuration(Math.max(0, wait.until - now))}`;
}

function listingText(label: string, fetched: number, total?: number): string {
  const count = total !== undefined && Number.isFinite(total) ? `${formatCount(fetched)}/${formatCount(total)}` : formatCount(fetched);
  return `listing ${label.toLowerCase()} ${count}`;
}

/** ora's default (discardStdin) puts the terminal in raw mode and swallows Ctrl+C; keep the terminal as it is. */
function startSpinner(text: string): Ora {
  return ora({ text, discardStdin: false }).start();
}

class TtyReporter implements Reporter {
  readonly interactive = true;
  private spinner: Ora | null = null;
  private bar: cliProgress.SingleBar | null = null;
  private timer: NodeJS.Timeout | null = null;
  private wait: WaitInfo | null = null;
  private listingStatus: string | null = null;
  private total = 0;
  private done = 0;
  private failed = 0;
  private estimateMs: (remaining: number) => number = () => Number.NaN;
  private suspended = false;

  info(message: string): void {
    this.above(() => console.log(message));
  }

  warn(message: string): void {
    this.above(() => console.log(chalk.yellow(`⚠ ${message}`)));
  }

  spin(text: string): void {
    if (this.suspended) return;
    if (this.spinner) this.spinner.text = text;
    else this.spinner = startSpinner(text);
  }

  spinDone(text: string): void {
    if (this.spinner) {
      this.spinner.succeed(text);
      this.spinner = null;
    } else {
      this.info(`${chalk.green('✔')} ${text}`);
    }
  }

  listing(label: string, fetched: number, total?: number): void {
    this.listingStatus = listingText(label, fetched, total);
    if (this.bar) this.refresh();
    else this.spin(`${this.listingStatus.charAt(0).toUpperCase()}${this.listingStatus.slice(1)}…`);
  }

  listingDone(summary: string): void {
    this.listingStatus = null;
    this.spinDone(summary);
    this.refresh();
  }

  startDownloads(total: number, estimateMs: (remaining: number) => number): void {
    this.spinner?.stop();
    this.spinner = null;
    this.total = total;
    this.done = 0;
    this.failed = 0;
    this.estimateMs = estimateMs;
    this.createBar();
  }

  setTotal(total: number): void {
    this.total = total;
    this.bar?.setTotal(total);
    this.refresh();
  }

  downloadDone(_title: string, done: number): void {
    this.done = done;
    this.refresh();
  }

  downloadFailed(_title: string, _message: string, done: number): void {
    this.done = done;
    this.failed += 1;
    this.refresh();
  }

  waiting(kind: RequestKind, info: WaitInfo | null): void {
    // Throttling pauses everything; otherwise only the download pace is worth showing.
    if (kind !== 'conversation' && info?.reason !== 'throttle') return;
    this.wait = info;
    if (this.bar) {
      this.refresh();
    } else if (info?.reason === 'throttle' && this.spinner) {
      this.spinner.text = waitText(info);
    }
  }

  suspend(): void {
    this.suspended = true;
    this.spinner?.stop();
    this.spinner = null;
    this.stopBar();
  }

  resume(): void {
    this.suspended = false;
    if (this.total > 0) this.createBar();
  }

  finish(): void {
    this.spinner?.stop();
    this.spinner = null;
    this.stopBar();
    this.total = 0;
  }

  /** Prints without the bar or spinner overwriting the message. */
  private above(print: () => void): void {
    const hadBar = this.bar !== null;
    const spinnerText = this.spinner?.text;
    this.spinner?.stop();
    this.spinner = null;
    this.stopBar();
    print();
    if (spinnerText !== undefined && !this.suspended) this.spinner = startSpinner(spinnerText);
    if (hadBar && !this.suspended) this.createBar();
  }

  private createBar(): void {
    if (this.suspended || this.bar) return;
    this.bar = new cliProgress.SingleBar(
      {
        // {timeLeft}, not {eta}: cli-progress fills its own {eta} token and would overwrite ours.
        format: `${chalk.cyan('Downloading')} ${chalk.cyan('{bar}')} {value}/{total} {failed}· {timeLeft} · {status}`,
        barCompleteChar: '█',
        barIncompleteChar: '░',
        barsize: 24,
        hideCursor: true,
        gracefulExit: false,
      },
      cliProgress.Presets.shades_classic
    );
    this.bar.start(this.total, this.done, this.payload());
    this.timer = setInterval(() => this.refresh(), 1000);
  }

  private stopBar(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.bar?.stop();
    this.bar = null;
  }

  private payload(): Record<string, string> {
    const remaining = this.total - this.done;
    const estimate = remaining > 0 ? this.estimateMs(remaining) : 0;
    const activity = this.wait ? waitText(this.wait) : remaining > 0 ? 'downloading…' : 'done';
    return {
      timeLeft: Number.isFinite(estimate) ? `≈ ${formatDuration(estimate)} left` : '…',
      status: this.listingStatus ? `${activity} · ${chalk.dim(`${this.listingStatus}…`)}` : activity,
      failed: this.failed > 0 ? chalk.red(`(${this.failed} failed) `) : '',
    };
  }

  private refresh(): void {
    this.bar?.update(this.done, this.payload());
  }
}

class PlainReporter implements Reporter {
  readonly interactive = false;
  private lastThrottleUntil = 0;
  private lastListingLog = 0;
  private total = 0;

  /** stderr, so `list --json > file` and similar stay clean. */
  private line(message: string): void {
    process.stderr.write(`[${new Date().toISOString()}] ${message}\n`);
  }

  info(message: string): void {
    this.line(message);
  }

  warn(message: string): void {
    this.line(`Warning: ${message}`);
  }

  spin(text: string): void {
    this.line(text);
  }

  spinDone(text: string): void {
    this.line(text);
  }

  listing(label: string, fetched: number, total?: number): void {
    const now = Date.now();
    const finished = total !== undefined && fetched >= total;
    if (!finished && now - this.lastListingLog < 30_000) return;
    this.lastListingLog = now;
    this.line(`Listing ${label.toLowerCase()}: ${formatCount(fetched)}${total !== undefined ? `/${formatCount(total)}` : ''}`);
  }

  listingDone(summary: string): void {
    this.line(summary);
  }

  startDownloads(total: number, estimateMs: (remaining: number) => number): void {
    this.total = total;
    this.line(`Downloading, newest first, while the rest of the list is read (≈ ${formatDuration(estimateMs(total))} for the first ${formatCount(total)})`);
  }

  setTotal(total: number): void {
    this.total = total;
  }

  downloadDone(title: string, done: number): void {
    this.line(`[${done}/${this.total}] ${title}`);
  }

  downloadFailed(title: string, message: string, done: number): void {
    this.line(`[${done}/${this.total}] FAILED ${title}: ${message}`);
  }

  waiting(_kind: RequestKind, info: WaitInfo | null): void {
    if (info?.reason === 'throttle' && info.until !== this.lastThrottleUntil) {
      this.lastThrottleUntil = info.until;
      this.line(`ChatGPT asked us to slow down; resuming at ${formatClock(info.until)}`);
    }
  }

  suspend(): void {}
  resume(): void {}
  finish(): void {}
}
