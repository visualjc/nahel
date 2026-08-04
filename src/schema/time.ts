/**
 * Timestamp arithmetic on the schema's own format (`YYYY-MM-DDTHH:MM:SSZ`).
 *
 * The codebase's ONLY date machinery, and deliberately not date machinery at
 * all: plain days-from-civil integer arithmetic — no platform date object, no
 * locale, no timezone table, no clock. Time ENTERS the process in one place —
 * `Env.now()` (ADR-0004, hard constraint 1) — and everything downstream is a
 * pure function of that reading, so a window computed on one machine is the
 * window computed on every other.
 *
 * Both directions live here because two readers now need them: `validate`'s
 * compaction-age threshold measures backwards from the injected reading, and
 * `nahel standup --since 7d` subtracts a window from it and renders the result.
 */

/**
 * The one spelling of a nahel timestamp: `YYYY-MM-DDTHH:MM:SSZ`. Exported
 * because `records.ts` validates every stored timestamp against it — one
 * pattern, so the format the schema accepts and the format this module reads
 * cannot drift apart. It is a SHAPE, not a calendar: see epochSeconds.
 */
export const TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;

/** Seconds in a day — the unit both directions pivot on. */
const SECONDS_PER_DAY = 86400;

/** The years four digits can spell — the format's whole representable range. */
const MIN_YEAR = 0;
const MAX_YEAR = 9999;

/** Whether a year carries a 29th of February (Gregorian, century rule included). */
function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

/** Days in one month of one year — the only place the calendar's lengths live. */
function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/**
 * Seconds since the Unix epoch for a schema-format UTC timestamp. Undefined
 * when the string does not name a real instant — a caller that cannot read a
 * timestamp must say so, never guess at one.
 *
 * The SHAPE is not the instant. `\d{2}` admits February 30th, month 13 and
 * hour 24, and days-from-civil arithmetic would turn each into a number that
 * LOOKS like an answer (Feb 30th silently becoming March 2nd) — worse than no
 * answer, because nothing downstream can tell it from a real one. So the
 * calendar fields are checked here, and anything impossible reads exactly like
 * a malformed string. `:60` goes with them: nahel's format is plain UTC
 * seconds, and no writer in the codebase can produce a leap second.
 */
export function epochSeconds(timestamp: string): number | undefined {
  const parts = TIMESTAMP_PATTERN.exec(timestamp);
  if (parts === null) return undefined;
  const [, year, month, day, hour, minute, second] = parts.map(Number) as number[];
  if (month! < 1 || month! > 12) return undefined;
  if (day! < 1 || day! > daysInMonth(year!, month!)) return undefined;
  if (hour! > 23 || minute! > 59 || second! > 59) return undefined;
  const shiftedYear = month! <= 2 ? year! - 1 : year!;
  const era = Math.floor(shiftedYear / 400);
  const yearOfEra = shiftedYear - era * 400;
  const dayOfYear = Math.floor((153 * (month! + (month! > 2 ? -3 : 9)) + 2) / 5) + day! - 1;
  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  const epochDays = era * 146097 + dayOfEra - 719468;
  return epochDays * SECONDS_PER_DAY + hour! * 3600 + minute! * 60 + second!;
}

/** Two-digit zero padding for the rendered fields. */
function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

/**
 * The schema-format timestamp for a count of seconds since the Unix epoch —
 * the exact inverse of epochSeconds (civil-from-days). Seconds before the
 * epoch are handled by flooring, so a window subtracted past 1970 still
 * renders a real date rather than a negative one.
 *
 * Undefined outside what the format can SPELL. A four-digit year has edges,
 * and past them `pad(year, 4)` would emit `-0164-…` or `12345-…`: strings
 * shaped like timestamps that no reader could parse back. A window nobody can
 * express is a refusal, never a rendered lie. Non-integer and unsafe counts go
 * the same way — arithmetic that has already lost precision cannot name an
 * instant.
 */
export function timestampFromEpochSeconds(seconds: number): string | undefined {
  if (!Number.isSafeInteger(seconds)) return undefined;
  const days = Math.floor(seconds / SECONDS_PER_DAY);
  const secondOfDay = seconds - days * SECONDS_PER_DAY;
  const shifted = days + 719468;
  const era = Math.floor(shifted / 146097);
  const dayOfEra = shifted - era * 146097;
  const yearOfEra = Math.floor(
    (dayOfEra - Math.floor(dayOfEra / 1460) + Math.floor(dayOfEra / 36524) - Math.floor(dayOfEra / 146096)) /
      365,
  );
  const dayOfYear =
    dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const monthPrime = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * monthPrime + 2) / 5) + 1;
  const month = monthPrime + (monthPrime < 10 ? 3 : -9);
  const year = yearOfEra + era * 400 + (month <= 2 ? 1 : 0);
  if (year < MIN_YEAR || year > MAX_YEAR) return undefined;
  const hour = Math.floor(secondOfDay / 3600);
  const minute = Math.floor((secondOfDay % 3600) / 60);
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(
    secondOfDay % 60,
  )}Z`;
}
