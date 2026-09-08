import { describe, expect, it } from "vitest";

import { accessTokenFrom, cacheFromEndpoint, isStale, STALE_MS } from "../usageEndpoint.js";
import { rateWindows } from "../status.js";

const NOW = Date.parse("2026-09-08T09:00:00Z");

describe("accessTokenFrom", () => {
  it("reads the token Claude Code keeps, while it is good for another minute", () => {
    expect(accessTokenFrom({ claudeAiOauth: { accessToken: "sk-ant-oat01-x", expiresAt: NOW + 3600_000 } }, NOW)).toBe("sk-ant-oat01-x");
    expect(accessTokenFrom({ claudeAiOauth: { accessToken: "sk-ant-oat01-x" } }, NOW)).toBe("sk-ant-oat01-x");
  });

  it("has nothing to send for an expired, missing or malformed login", () => {
    expect(accessTokenFrom({ claudeAiOauth: { accessToken: "x", expiresAt: NOW + 30_000 } }, NOW)).toBeNull();
    expect(accessTokenFrom({ claudeAiOauth: { accessToken: "", expiresAt: NOW + 3600_000 } }, NOW)).toBeNull();
    expect(accessTokenFrom({}, NOW)).toBeNull();
    expect(accessTokenFrom(null, NOW)).toBeNull();
    expect(accessTokenFrom("text", NOW)).toBeNull();
  });
});

describe("isStale", () => {
  it("is true for a cache that never was, or is older than ten minutes", () => {
    expect(isStale(null, NOW)).toBe(true);
    expect(isStale(NOW - STALE_MS - 1, NOW)).toBe(true);
    expect(isStale(NOW - 1000, NOW)).toBe(false);
  });
});

describe("cacheFromEndpoint", () => {
  /** The endpoint's answer as measured, less the windows the gauges do not draw. */
  const BODY = {
    five_hour: { utilization: 3.0, resets_at: "2026-09-08T10:39:59.682276+00:00", limit_dollars: null },
    seven_day: { utilization: 11.0, resets_at: "2026-09-14T04:59:59.682298+00:00" },
    seven_day_opus: null,
    extra_usage: { is_enabled: true },
  };

  it("keeps the windows the gauges know, with resets_at as epoch seconds like the hook writes", () => {
    const cache = cacheFromEndpoint(BODY, NOW);
    expect(cache).toEqual({
      five_hour: { utilization: 3, resets_at: Math.floor(Date.parse("2026-09-08T10:39:59.682276+00:00") / 1000) },
      seven_day: { utilization: 11, resets_at: Math.floor(Date.parse("2026-09-14T04:59:59.682298+00:00") / 1000) },
      updated_at: Math.floor(NOW / 1000),
      source: "endpoint",
    });
  });

  it("is what the gauges' reader already understands", () => {
    const windows = rateWindows(cacheFromEndpoint(BODY, NOW) as Record<string, unknown>, NOW);
    expect(windows.map((w) => [w.key, w.usedPercent])).toEqual([["five_hour", 3], ["seven_day", 11]]);
    expect(windows[0]!.resetsAt).toBe(Math.floor(Date.parse("2026-09-08T10:39:59.682276+00:00") / 1000) * 1000);
  });

  it("has nothing for an answer without the windows, or that is not an object", () => {
    expect(cacheFromEndpoint({ seven_day_opus: null, extra_usage: {} }, NOW)).toBeNull();
    expect(cacheFromEndpoint(null, NOW)).toBeNull();
    expect(cacheFromEndpoint("nope", NOW)).toBeNull();
  });

  it("copes with a window whose reset is unknown", () => {
    const cache = cacheFromEndpoint({ five_hour: { utilization: 0, resets_at: null } }, NOW) as Record<string, unknown>;
    expect(cache["five_hour"]).toEqual({ utilization: 0 });
  });
});
