/**
 * Claude Code's usage figures asked for directly — the source for a machine where nothing publishes them.
 *
 * The hook (usageHook.ts) is the first source: free, and current to the last turn. It has to be
 * switched on, though, and a machine where it never was — or where no session has ended since —
 * showed blank gauges with no way to tell why. Claude Code's own /usage reads the same figures from
 * an endpoint with the login it keeps in .credentials.json; so does this, when the cache is missing
 * or older than STALE_MS, never more than once a minute, and only with a token that has not
 * expired. The token goes to api.anthropic.com and nowhere else, and is never refreshed here: that
 * is Claude Code's job, done whenever it runs. The pure parts are here so they can be tested; the
 * request itself is the feature's.
 */
import { RATE_WINDOWS } from "./constants.js";

export const USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
/** The beta header Claude Code's OAuth requests carry; without it the endpoint answers 401. */
export const OAUTH_BETA = "oauth-2025-04-20";
/** A cache older than this is asked for again. */
export const STALE_MS = 10 * 60_000;
/** Never two requests closer than this, whatever the answer was. */
export const RETRY_MS = 60_000;
/** A token this close to its expiry is not worth a request. */
const TOKEN_MARGIN_MS = 60_000;

interface Credentials { claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown } }

/** The access token in Claude Code's credentials file, or null when there is none worth sending. */
export function accessTokenFrom(credentials: unknown, now = Date.now()): string | null {
  const oauth = (credentials as Credentials | null | undefined)?.claudeAiOauth;
  const token = oauth?.accessToken;
  if (typeof token !== "string" || !token) return null;
  const expires = oauth?.expiresAt;
  if (typeof expires === "number" && expires <= now + TOKEN_MARGIN_MS) return null;
  return token;
}

/** Whether the cache is old enough to ask again; a cache that never was is. */
export function isStale(updatedAt: number | null, now = Date.now()): boolean {
  return updatedAt === null || now - updatedAt > STALE_MS;
}

interface EndpointBucket { utilization?: unknown; resets_at?: unknown }

/**
 * The endpoint's answer in the cache file's shape, or null when it carries no window we draw.
 *
 * `resets_at` arrives as ISO text and leaves as epoch seconds — what the hook writes and the reader
 * expects. Windows the endpoint lists but the gauges do not know are left out, as the reader would
 * leave them out anyway.
 */
export function cacheFromEndpoint(body: unknown, now = Date.now()): Record<string, unknown> | null {
  if (!body || typeof body !== "object") return null;
  const out: Record<string, unknown> = {};
  for (const { key } of RATE_WINDOWS) {
    const bucket = (body as Record<string, EndpointBucket | null | undefined>)[key];
    if (!bucket || typeof bucket !== "object" || typeof bucket.utilization !== "number") continue;
    const resets = typeof bucket.resets_at === "string" ? Date.parse(bucket.resets_at) : Number.NaN;
    out[key] = {
      utilization: bucket.utilization,
      ...(Number.isFinite(resets) ? { resets_at: Math.floor(resets / 1000) } : {}),
    };
  }
  if (Object.keys(out).length === 0) return null;
  out["updated_at"] = Math.floor(now / 1000);
  out["source"] = "endpoint";
  return out;
}
