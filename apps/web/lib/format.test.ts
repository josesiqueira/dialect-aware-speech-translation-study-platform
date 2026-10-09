import { describe, expect, it } from "vitest";
import { formatCount, formatCountOf, formatDate, formatDateTime, formatDurationMs, formatRelativeTime } from "./format";

describe("formatDateTime", () => {
  const instant = "2026-10-03T11:05:09Z";

  it("formats in the given time zone with a 24-hour clock", () => {
    expect(formatDateTime(instant, "UTC")).toBe("2026-10-03 11:05");
    expect(formatDateTime(instant, "Europe/Helsinki")).toBe("2026-10-03 14:05");
    expect(formatDateTime(new Date(instant), "America/New_York", { seconds: true })).toBe("2026-10-03 07:05:09");
  });

  it("crosses the date line correctly and never prints hour 24", () => {
    expect(formatDateTime("2026-10-03T22:30:00Z", "Europe/Helsinki")).toBe("2026-10-04 01:30");
    expect(formatDateTime("2026-10-03T21:00:00Z", "Europe/Helsinki")).toBe("2026-10-04 00:00");
  });

  it("can append the zone and handles invalid input", () => {
    expect(formatDateTime(instant, "UTC", { zone: true })).toBe("2026-10-03 11:05 UTC");
    expect(formatDateTime("not a date", "UTC")).toBe("");
  });

  it("formats the date alone", () => {
    expect(formatDate("2026-10-03T22:30:00Z", "Europe/Helsinki")).toBe("2026-10-04");
  });
});

describe("formatDurationMs", () => {
  it("formats as a clock and rounds down", () => {
    expect(formatDurationMs(0)).toBe("00:00");
    expect(formatDurationMs(14_000)).toBe("00:14");
    expect(formatDurationMs(14_999)).toBe("00:14");
    expect(formatDurationMs(754_000)).toBe("12:34");
    expect(formatDurationMs(3_723_000)).toBe("1:02:03");
    expect(formatDurationMs(14_320, { tenths: true })).toBe("00:14.3");
  });

  it("treats missing and invalid input as zero", () => {
    expect(formatDurationMs(null)).toBe("00:00");
    expect(formatDurationMs(undefined)).toBe("00:00");
    expect(formatDurationMs(-5)).toBe("00:00");
    expect(formatDurationMs(Number.NaN)).toBe("00:00");
  });
});

describe("formatRelativeTime and formatCount", () => {
  it("describes elapsed time", () => {
    const now = Date.parse("2026-10-03T12:00:00Z");
    expect(formatRelativeTime("2026-10-03T11:59:58Z", now)).toBe("just now");
    expect(formatRelativeTime("2026-10-03T11:59:18Z", now)).toBe("42 seconds ago");
    expect(formatRelativeTime("2026-10-03T11:59:00Z", now)).toBe("1 minute ago");
    expect(formatRelativeTime("2026-10-03T09:00:00Z", now)).toBe("3 hours ago");
    expect(formatRelativeTime("2026-09-30T12:00:00Z", now)).toBe("3 days ago");
  });

  it("formats counts", () => {
    expect(formatCount(12345)).toBe("12,345");
    expect(formatCount(null)).toBe("0");
  });

  it("writes a count with its noun in the right number", () => {
    expect(formatCountOf(1, "utterance")).toBe("1 utterance");
    expect(formatCountOf(2, "utterance")).toBe("2 utterances");
    expect(formatCountOf(0, "utterance")).toBe("0 utterances");
    expect(formatCountOf(null, "session")).toBe("0 sessions");
    expect(formatCountOf(1200, "file")).toBe("1,200 files");
    expect(formatCountOf(1, "entry", "entries")).toBe("1 entry");
    expect(formatCountOf(3, "entry", "entries")).toBe("3 entries");
  });
});
