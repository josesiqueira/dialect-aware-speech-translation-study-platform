/**
 * Date, time and duration formatting for display (spec 101).
 *
 * The database stores UTC. Display always names the time zone it uses: the
 * caller passes an IANA zone (the admin display zone from Settings), there is
 * no silent use of the server or browser zone. Exports do not use these
 * helpers; they write ISO 8601.
 *
 * Output is plain text made of digits and separators, suited to
 * `tabular-nums` (use the TABULAR class on the element).
 */

/** Class for counts, durations and timestamps so that digits line up. */
export const TABULAR = "tabular-nums";

export type DateInput = Date | string | number;

function toDate(value: DateInput): Date | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parts(date: Date, timeZone: string, options: Intl.DateTimeFormatOptions): Record<string, string> {
  const formatter = new Intl.DateTimeFormat("en-GB", { timeZone, hourCycle: "h23", ...options });
  const result: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) {
    result[part.type] = part.value;
  }
  return result;
}

/**
 * "2026-10-03 14:05" in the given IANA time zone, 24-hour clock.
 * With `seconds: true`: "2026-10-03 14:05:09". With `zone: true` the zone
 * abbreviation is appended: "2026-10-03 14:05 EEST".
 * An invalid date gives the empty string.
 */
export function formatDateTime(
  value: DateInput,
  timeZone: string,
  options: { seconds?: boolean; zone?: boolean } = {},
): string {
  const date = toDate(value);
  if (!date) return "";
  const p = parts(date, timeZone, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: options.seconds ? "2-digit" : undefined,
    timeZoneName: options.zone ? "short" : undefined,
  });
  const time = options.seconds ? `${p.hour}:${p.minute}:${p.second}` : `${p.hour}:${p.minute}`;
  const zone = options.zone && p.timeZoneName ? ` ${p.timeZoneName}` : "";
  return `${p.year}-${p.month}-${p.day} ${time}${zone}`;
}

/** "2026-10-03" in the given IANA time zone. An invalid date gives the empty string. */
export function formatDate(value: DateInput, timeZone: string): string {
  const date = toDate(value);
  if (!date) return "";
  const p = parts(date, timeZone, { year: "numeric", month: "2-digit", day: "2-digit" });
  return `${p.year}-${p.month}-${p.day}`;
}

/**
 * Duration as a clock: 14000 gives "00:14", 754000 gives "12:34", 3723000
 * gives "1:02:03". Rounds down to whole seconds (a recording timer never
 * shows a second that has not fully passed). With `tenths: true` one decimal
 * is kept: 14320 gives "00:14.3". Negative, null or non-finite input gives "00:00".
 */
export function formatDurationMs(
  durationMs: number | null | undefined,
  options: { tenths?: boolean } = {},
): string {
  const ms = typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0;
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  const tenths = options.tenths ? `.${Math.floor((ms % 1000) / 100)}` : "";
  if (hours > 0) return `${hours}:${two(minutes)}:${two(seconds)}${tenths}`;
  return `${two(minutes)}:${two(seconds)}${tenths}`;
}

/** "just now", "42 seconds ago", "3 minutes ago", "2 hours ago", "5 days ago". */
export function formatRelativeTime(value: DateInput, now: number = Date.now()): string {
  const date = toDate(value);
  if (!date) return "";
  const seconds = Math.max(0, Math.round((now - date.getTime()) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds} seconds ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/** Integer with thousands separators: 12345 gives "12,345". null or undefined gives "0". */
export function formatCount(value: number | null | undefined): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value ?? 0);
}

/**
 * A count with its noun in the right number: "1 utterance", "2 utterances",
 * "0 utterances", "1,200 files". The plural defaults to the singular plus "s".
 */
export function formatCountOf(value: number | null | undefined, singular: string, plural: string = `${singular}s`): string {
  return `${formatCount(value)} ${(value ?? 0) === 1 ? singular : plural}`;
}
