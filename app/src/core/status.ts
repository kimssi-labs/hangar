/**
 * The rate-limit windows Claude Code publishes, and nothing else.
 *
 * Three other indicators lived here and were all removed for the same reason: each read a cache
 * file that only one machine's own scripts write, so for anybody else the segment was either absent
 * or, worse, wrong. MCP health could not see a live connection at all; Outlook reachability came
 * from a private mail probe; the ponytail chip from a local mode flag. Usage comes from Claude
 * Code itself, which is what makes it worth drawing for everyone.
 */
import { readFileSync } from "node:fs";

import { RATE_WINDOWS } from "./constants.js";
import { homePaths } from "./paths.js";
import type { RateWindow, StatusConfig, StatusSnapshot } from "./types.js";

export { RATE_WINDOWS } from "./constants.js";


interface RateBucket { used_percentage?: number; utilization?: number; resets_at?: number; model?: unknown }

function readJson<T>(file: string, fallback: T): T {
  try {
    // Strip a BOM: JSON.parse throws on one, and the throw would read as "this machine reports no
    // usage" rather than as the encoding accident it is. Windows tools write one by default.
    return JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, "")) as T;
  } catch {
    return fallback;
  }
}

/** Windows present in the cache, normalised; a window whose reset already passed reads 0 %. */
export function rateWindows(raw: Record<string, unknown>, now = Date.now()): RateWindow[] {
  const out: RateWindow[] = [];
  for (const { key, label, short } of RATE_WINDOWS) {
    const bucket = raw[key] as RateBucket | undefined;
    if (!bucket || typeof bucket !== "object") continue;
    const used = bucket.used_percentage ?? bucket.utilization;
    if (typeof used !== "number" || !Number.isFinite(used)) continue;
    const resetsAt = typeof bucket.resets_at === "number" ? bucket.resets_at * 1000 : null;
    const rolled = resetsAt !== null && resetsAt <= now;
    // A window scoped to one model is named after it: "1w Fable".
    const model = typeof bucket.model === "string" && bucket.model.trim() ? bucket.model.trim() : null;
    out.push({
      key,
      label: model ? `${short} ${model}` : label,
      short: model ? `${short} ${model}` : short,
      usedPercent: rolled ? 0 : Math.max(0, Math.min(100, Math.round(used))),
      resetsAt: rolled ? null : resetsAt,
    });
  }
  return out;
}

function updatedAtOf(raw: { updated_at?: unknown }): number | null {
  const seconds = typeof raw.updated_at === "number" && Number.isFinite(raw.updated_at) ? raw.updated_at : null;
  return seconds ? seconds * 1000 : null;
}

/** When one cache file was written, in epoch ms, or null when it never was. */
export function readUpdatedAt(file: string): number | null {
  return updatedAtOf(readJson<{ updated_at?: unknown }>(file, {}));
}

/** When the figures were last published by anyone, in epoch ms, or null when they never were. */
export function readStatusUpdatedAt(home?: string): number | null {
  const paths = homePaths(home);
  const times = [readUpdatedAt(paths.rateLimits), readUpdatedAt(paths.hangarUsage)].filter((t): t is number => t !== null);
  return times.length ? Math.max(...times) : null;
}

/**
 * The two cache files as one: the newer file's windows over the older file's.
 *
 * Two files because two kinds of writer. Claude Code's own — the Stop hook, a status line — write
 * the block Claude Code hands them: the 5-hour and 7-day windows and nothing else. The usage
 * endpoint (usageEndpoint.ts) also answers with the weekly window scoped to one model, and is the
 * only thing that does. In one shared file the next hook write replaced the endpoint's answer
 * whole, and the model's gauge was gone until the cache went stale — which, with a writer keeping
 * it fresh, was never (measured: "1w Fable" came and went all day). So this app keeps a file of its
 * own that nothing else writes; the newer file wins window by window, and a window only one of
 * them has stays.
 */
export function readRateLimits(home?: string): Record<string, unknown> {
  const paths = homePaths(home);
  const shared = readJson<Record<string, unknown>>(paths.rateLimits, {});
  const own = readJson<Record<string, unknown>>(paths.hangarUsage, {});
  return (updatedAtOf(own) ?? 0) >= (updatedAtOf(shared) ?? 0) ? { ...shared, ...own } : { ...own, ...shared };
}

export function readStatus(
  home?: string,
  config: StatusConfig = { windows: null },
  now = Date.now(),
): StatusSnapshot {
  const all = rateWindows(readRateLimits(home), now);
  const chosen = config.windows;
  return { windows: chosen === null ? all : all.filter((w) => chosen.includes(w.key)) };
}

export { readJson as readStatusJson };
