import { describe, expect, test } from "bun:test";
import { epochSeconds, timestampFromEpochSeconds } from "../../src/schema/time";

/**
 * Timestamp arithmetic (ADR-0004, hard constraint 1): the codebase's ONLY
 * date machinery, and it touches no clock and no `Date`. Both directions are
 * plain days-from-civil arithmetic, so a window computed on one machine is the
 * window computed on every other.
 */

describe("epochSeconds — the schema's timestamp format to seconds", () => {
  test("the epoch itself, and one second after it", () => {
    expect(epochSeconds("1970-01-01T00:00:00Z")).toBe(0);
    expect(epochSeconds("1970-01-01T00:00:01Z")).toBe(1);
  });

  test("a known instant, cross-checked against the arithmetic it replaces", () => {
    // 2026-07-16T12:00:00Z — the fixtures' epoch.
    expect(epochSeconds("2026-07-16T12:00:00Z")).toBe(1784203200);
  });

  test("leap day is a real day: 2024-02-29 sits between the 28th and March 1st", () => {
    const feb28 = epochSeconds("2024-02-28T00:00:00Z")!;
    expect(epochSeconds("2024-02-29T00:00:00Z")).toBe(feb28 + 86400);
    expect(epochSeconds("2024-03-01T00:00:00Z")).toBe(feb28 + 2 * 86400);
  });

  test("1900 is not a leap year and 2000 is — the century rule holds", () => {
    expect(epochSeconds("1900-03-01T00:00:00Z")! - epochSeconds("1900-02-28T00:00:00Z")!).toBe(
      86400,
    );
    expect(epochSeconds("2000-03-01T00:00:00Z")! - epochSeconds("2000-02-28T00:00:00Z")!).toBe(
      2 * 86400,
    );
  });

  test("anything outside the schema's format is undefined, never a guess", () => {
    for (const bad of [
      "",
      "2026-07-16",
      "2026-07-16T12:00:00",
      "2026-07-16T12:00:00+02:00",
      "2026-07-16T12:00:00.500Z",
      "not a timestamp",
    ]) {
      expect(epochSeconds(bad)).toBeUndefined();
    }
  });
});

describe("timestampFromEpochSeconds — and back again", () => {
  test("the epoch, and the fixtures' epoch, render in the schema's format", () => {
    expect(timestampFromEpochSeconds(0)).toBe("1970-01-01T00:00:00Z");
    expect(timestampFromEpochSeconds(1784203200)).toBe("2026-07-16T12:00:00Z");
  });

  test("round-trips exactly across leap days, century boundaries and pre-epoch dates", () => {
    for (const timestamp of [
      "1969-12-31T23:59:59Z",
      "1970-01-01T00:00:00Z",
      "1999-12-31T23:59:59Z",
      "2000-02-29T12:34:56Z",
      "2024-02-29T00:00:00Z",
      "2026-07-16T12:00:00Z",
      "2100-03-01T00:00:00Z",
    ]) {
      expect(timestampFromEpochSeconds(epochSeconds(timestamp)!)).toBe(timestamp);
    }
  });

  test("subtracting a window crosses a month boundary correctly", () => {
    const now = epochSeconds("2026-08-02T09:15:00Z")!;
    expect(timestampFromEpochSeconds(now - 7 * 86400)).toBe("2026-07-26T09:15:00Z");
    expect(timestampFromEpochSeconds(now - 24 * 3600)).toBe("2026-08-01T09:15:00Z");
  });
});

/**
 * The SHAPE is not the instant (codex review, F4): `\d{4}-\d{2}-\d{2}T…` admits
 * February 30th, month 13 and hour 24, none of which is a moment in time.
 * Arithmetic over one of those produces a number that looks like an answer,
 * which is worse than no answer at all — so the calendar fields are checked,
 * and anything impossible reads exactly like a malformed string: undefined.
 */
describe("epochSeconds — the calendar, not just the shape", () => {
  test("a day the month does not have is not an instant", () => {
    for (const bad of [
      "2026-02-30T00:00:00Z",
      "2026-04-31T00:00:00Z",
      "2026-06-31T00:00:00Z",
      "2026-09-31T00:00:00Z",
      "2026-11-31T00:00:00Z",
      "2026-01-32T00:00:00Z",
      "2026-01-00T00:00:00Z",
    ]) {
      expect(epochSeconds(bad)).toBeUndefined();
    }
  });

  test("the last real day of each month IS an instant", () => {
    for (const good of [
      "2026-01-31T00:00:00Z",
      "2026-02-28T00:00:00Z",
      "2026-04-30T00:00:00Z",
      "2026-12-31T23:59:59Z",
    ]) {
      expect(epochSeconds(good)).toBeDefined();
    }
  });

  test("February 29th exists exactly in the years the leap rule says it does", () => {
    expect(epochSeconds("2024-02-29T00:00:00Z")).toBeDefined();
    expect(epochSeconds("2000-02-29T00:00:00Z")).toBeDefined();
    expect(epochSeconds("2023-02-29T00:00:00Z")).toBeUndefined();
    expect(epochSeconds("1900-02-29T00:00:00Z")).toBeUndefined();
    expect(epochSeconds("2100-02-29T00:00:00Z")).toBeUndefined();
  });

  test("a month outside 1–12 is not an instant", () => {
    expect(epochSeconds("2026-13-01T00:00:00Z")).toBeUndefined();
    expect(epochSeconds("2026-00-01T00:00:00Z")).toBeUndefined();
    expect(epochSeconds("2026-99-01T00:00:00Z")).toBeUndefined();
  });

  test("a clock field outside its range is not an instant — including the leap second", () => {
    expect(epochSeconds("2026-01-01T24:00:00Z")).toBeUndefined();
    expect(epochSeconds("2026-01-01T00:60:00Z")).toBeUndefined();
    // nahel's format is plain UTC seconds; the journal never writes :60.
    expect(epochSeconds("2026-01-01T00:00:60Z")).toBeUndefined();
    expect(epochSeconds("2026-01-01T23:59:59Z")).toBeDefined();
  });
});

describe("timestampFromEpochSeconds — the representable calendar", () => {
  test("the four-digit year is the format's whole range, and its edges round-trip", () => {
    expect(timestampFromEpochSeconds(epochSeconds("0000-01-01T00:00:00Z")!)).toBe(
      "0000-01-01T00:00:00Z",
    );
    expect(timestampFromEpochSeconds(epochSeconds("9999-12-31T23:59:59Z")!)).toBe(
      "9999-12-31T23:59:59Z",
    );
  });

  test("one second outside either edge is unrepresentable, not a malformed year", () => {
    expect(timestampFromEpochSeconds(epochSeconds("0000-01-01T00:00:00Z")! - 1)).toBeUndefined();
    expect(timestampFromEpochSeconds(epochSeconds("9999-12-31T23:59:59Z")! + 1)).toBeUndefined();
  });

  test("a count that is not a whole, safe number of seconds is refused", () => {
    for (const bad of [Number.NaN, Infinity, -Infinity, 1.5, 2 ** 53]) {
      expect(timestampFromEpochSeconds(bad)).toBeUndefined();
    }
  });
});
