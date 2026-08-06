// Date/time formatting pinned to India Standard Time (Asia/Kolkata).
//
// Two classes of values flow through the app:
//   1. Full timestamps (timestamptz)  → e.g. "2026-06-20T14:30:00.123+00:00"
//   2. Date-only values (DATE column) → e.g. "2026-06-20"
//
// `new Date("2026-06-20")` parses as MIDNIGHT UTC, which then renders as
// "05:30 am" in IST and can shift to the wrong calendar day for non-IST
// viewers. We treat date-only strings as IST-local midnight so the date stays
// put and the time reads as 12:00 am instead of a bogus 05:30 am.

const IST_TIME_ZONE = "Asia/Kolkata";
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse a value into a Date, interpreting bare `YYYY-MM-DD` strings as IST
 * midnight rather than UTC midnight. Returns null for unparseable input.
 */
export function parseIstDate(value: string | number | Date | null | undefined): Date | null {
  if (value === null || value === undefined) return null;

  const raw = typeof value === "string" && DATE_ONLY_PATTERN.test(value.trim())
    ? `${value.trim()}T00:00:00+05:30`
    : value;

  const date = raw instanceof Date ? raw : new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Format the date portion in IST, e.g. "20 Jun 26". */
export function formatIstDate(value: string | number | Date | null | undefined): string {
  const date = parseIstDate(value);
  if (!date) return "—";
  return date.toLocaleDateString("en-IN", {
    timeZone: IST_TIME_ZONE,
    day: "2-digit",
    month: "short",
    year: "2-digit",
  });
}

/** Format the time portion in IST, e.g. "02:30 pm". */
export function formatIstTime(value: string | number | Date | null | undefined): string {
  const date = parseIstDate(value);
  if (!date) return "—";
  return date.toLocaleTimeString("en-IN", {
    timeZone: IST_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

/**
 * The IST calendar day for a value, as a sortable `YYYY-MM-DD` key. Bare
 * date-only strings are treated as IST midnight (so they never shift a day),
 * timestamps are projected into IST first. Used to bucket payments/expenses
 * into the right day for the cash book regardless of the viewer's timezone.
 */
export function istDayKey(value: string | number | Date | null | undefined): string | null {
  const date = parseIstDate(value);
  if (!date) return null;
  // en-CA renders ISO `YYYY-MM-DD`; pinning the zone gives the IST calendar day.
  return date.toLocaleDateString("en-CA", { timeZone: IST_TIME_ZONE });
}

/** Today's IST calendar day as a `YYYY-MM-DD` key. */
export function istToday(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: IST_TIME_ZONE });
}

/** Add (or subtract) whole days to a `YYYY-MM-DD` key, returning a new key. */
export function shiftDayKey(dayKey: string, deltaDays: number): string {
  const [y, m, d] = dayKey.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return dt.toISOString().slice(0, 10);
}

/** Inclusive list of `YYYY-MM-DD` keys from `start` to `end` (ascending). */
export function dayKeyRange(start: string, end: string): string[] {
  const out: string[] = [];
  let cur = start;
  // Guard against a reversed range or runaway loop (cap at ~2 years).
  for (let i = 0; cur <= end && i < 800; i++) {
    out.push(cur);
    cur = shiftDayKey(cur, 1);
  }
  return out;
}

/** Human label for a day key, e.g. "20 Jun 26". */
export function formatDayKey(dayKey: string): string {
  return formatIstDate(dayKey);
}
