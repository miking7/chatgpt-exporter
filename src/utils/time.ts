export interface Clock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export function abortError(signal?: AbortSignal): Error {
  const reason: unknown = signal?.reason;
  if (reason instanceof Error) return reason;
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
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
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, Math.max(0, ms));
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep,
};

/**
 * Converts a ChatGPT timestamp (epoch seconds, or an ISO string from the list endpoint) to epoch seconds.
 * ISO strings are parsed at millisecond precision, matching upstream's incremental comparison.
 */
export function toEpochSeconds(value: string | number | null | undefined): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value === '') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms / 1000;
}

const zoneFormatters = new Map<string, Intl.DateTimeFormat>();

function zoneParts(epochSeconds: number, timeZone: string): Record<string, string> {
  let formatter = zoneFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'longOffset',
    });
    zoneFormatters.set(timeZone, formatter);
  }
  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(new Date(epochSeconds * 1000))) parts[part.type] = part.value;
  return parts;
}

/** "2026-10-11": the calendar date in an IANA time zone. */
export function localDate(epochSeconds: number, timeZone: string): string {
  const p = zoneParts(epochSeconds, timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}

/** "2026-10-11T09:14:05+11:00": ISO 8601 with the zone's offset at that moment. */
export function formatIsoLocal(epochSeconds: number, timeZone: string): string {
  const p = zoneParts(epochSeconds, timeZone);
  const offset = p.timeZoneName === 'GMT' ? '+00:00' : p.timeZoneName.replace('GMT', '');
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${offset}`;
}
