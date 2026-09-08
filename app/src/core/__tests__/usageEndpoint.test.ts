import { describe, expect, it } from "vitest";

import { accessTokenFrom, backoffFor, cacheFromEndpoint, failureFor, isStale, loginState, MANUAL_FLOOR_MS, RETRY_MS, RETRY_ON_ERROR_MS, shouldAsk, STALE_LIVE_MS, STALE_MS } from "../usageEndpoint.js";
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

describe("loginState", () => {
  it("tells a token to send from one that ran out and from no login at all", () => {
    expect(loginState({ claudeAiOauth: { accessToken: "x", expiresAt: NOW + 3600_000 } }, NOW)).toBe("fresh");
    expect(loginState({ claudeAiOauth: { accessToken: "x", expiresAt: NOW - 1 } }, NOW)).toBe("expired");
    expect(loginState({}, NOW)).toBe("absent");
    expect(loginState(null, NOW)).toBe("absent");
  });
});

describe("the weekly limit scoped to one model", () => {
  it("is read from limits[] and named after the model, the way the endpoint answered here", () => {
    const cache = cacheFromEndpoint({
      five_hour: { utilization: 16, resets_at: "2026-09-08T10:39:59.882306+00:00" },
      seven_day: { utilization: 12, resets_at: "2026-09-14T04:59:59.882329+00:00" },
      limits: [
        { kind: "session", percent: 16, resets_at: "2026-09-08T10:39:59.882306+00:00", is_active: true, scope: null },
        { kind: "weekly_all", percent: 12, resets_at: "2026-09-14T04:59:59.882329+00:00", is_active: false, scope: null },
        { kind: "weekly_scoped", percent: 16, resets_at: "2026-09-14T04:59:59.882582+00:00", is_active: false, scope: { model: { id: null, display_name: "Fable" }, surface: null } },
      ],
    }, NOW) as Record<string, unknown>;
    expect(cache["weekly_scoped"]).toEqual({ utilization: 16, resets_at: Math.floor(Date.parse("2026-09-14T04:59:59.882582+00:00") / 1000), model: "Fable" });
    const windows = rateWindows(cache, NOW);
    expect(windows.map((w) => [w.key, w.label, w.usedPercent])).toEqual([["five_hour", "5h", 16], ["seven_day", "1w", 12], ["weekly_scoped", "1w Fable", 16]]);
  });

  it("is left out when limits[] has no model-scoped entry, or none", () => {
    expect(cacheFromEndpoint({ five_hour: { utilization: 1 }, limits: [{ kind: "session", percent: 1 }] }, NOW)).not.toHaveProperty("weekly_scoped");
    expect(cacheFromEndpoint({ five_hour: { utilization: 1 }, limits: null }, NOW)).not.toHaveProperty("weekly_scoped");
  });
});

describe("after a refusal", () => {
  it("waits as long as a rate limit asked, in seconds or as a date, but never more than a day", () => {
    expect(backoffFor(429, "120", NOW)).toBe(120_000);
    expect(backoffFor(429, new Date(NOW + 90_000).toUTCString(), NOW)).toBeGreaterThan(80_000);
    expect(backoffFor(429, "999999999", NOW)).toBe(24 * 3600_000);
    expect(backoffFor(429, "garbage", NOW)).toBe(RETRY_ON_ERROR_MS);
    expect(backoffFor(429, null, NOW)).toBe(RETRY_ON_ERROR_MS);
  });

  it("gives a stale token five minutes and anything else the usual minute", () => {
    expect(backoffFor(401, null, NOW)).toBe(RETRY_ON_ERROR_MS);
    expect(backoffFor(403, null, NOW)).toBe(RETRY_ON_ERROR_MS);
    expect(backoffFor(500, null, NOW)).toBe(RETRY_MS);
    expect(failureFor(401)).toBe("stale-token");
    expect(failureFor(429)).toBe("rate-limited");
    expect(failureFor(502)).toBe("error");
  });
});

describe("whether to ask now", () => {
  const base = { now: 1_000_000_000_000, lastAskedAt: 0, nextAttemptAt: 0, live: false, manual: false };

  it("on the timer, asks only for stale figures — a minute old while a session runs, ten otherwise", () => {
    const fresh = base.now - 90_000;
    expect(shouldAsk({ ...base, updatedAt: fresh })).toBe(false);
    expect(shouldAsk({ ...base, updatedAt: fresh, live: true })).toBe(true);
    expect(shouldAsk({ ...base, updatedAt: base.now - STALE_MS - 1 })).toBe(true);
    expect(shouldAsk({ ...base, updatedAt: base.now - STALE_LIVE_MS + 1, live: true })).toBe(false);
    expect(shouldAsk({ ...base, updatedAt: null })).toBe(true);
  });

  it("never asks twice within a minute on the timer, nor within five seconds by hand", () => {
    const stale = { ...base, updatedAt: null };
    expect(shouldAsk({ ...stale, lastAskedAt: base.now - RETRY_MS + 1 })).toBe(false);
    expect(shouldAsk({ ...stale, lastAskedAt: base.now - RETRY_MS })).toBe(true);
    expect(shouldAsk({ ...stale, manual: true, lastAskedAt: base.now - MANUAL_FLOOR_MS + 1 })).toBe(false);
    expect(shouldAsk({ ...stale, manual: true, lastAskedAt: base.now - MANUAL_FLOOR_MS })).toBe(true);
  });

  it("by hand, asks whatever the age of the figures", () => {
    expect(shouldAsk({ ...base, updatedAt: base.now - 1_000, manual: true })).toBe(true);
  });

  it("holds a refusal's backoff, by hand or on the timer", () => {
    expect(shouldAsk({ ...base, updatedAt: null, nextAttemptAt: base.now + 1 })).toBe(false);
    expect(shouldAsk({ ...base, updatedAt: null, nextAttemptAt: base.now + 1, manual: true })).toBe(false);
    expect(shouldAsk({ ...base, updatedAt: null, nextAttemptAt: base.now })).toBe(true);
  });
});
