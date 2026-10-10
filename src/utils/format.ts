export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return 'unknown';
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

const pad = (n: number) => String(n).padStart(2, '0');

export function formatDateTime(value: number | Date): string {
  const d = new Date(value);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatDay(value: number | Date): string {
  const d = new Date(value);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "15:42" for times later today, otherwise the full date and time. */
export function formatClock(value: number): string {
  const d = new Date(value);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : formatDateTime(d);
}

export function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

export function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${formatCount(n)} ${n === 1 ? singular : pluralForm}`;
}

export function formatRelative(targetMs: number, now = Date.now()): string {
  const delta = targetMs - now;
  return delta >= 0 ? `in ${formatDuration(delta)}` : `${formatDuration(-delta)} ago`;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
