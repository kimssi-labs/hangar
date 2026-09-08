/**
 * Claude Code's usage figures, asked for the way its own /usage asks.
 *
 * Claude Code publishes its rate limits to nothing outside itself — no hook input carries them
 * (checked against 2.1.263, all 33 events), and the status line's stdin, which does, belongs to
 * the user's own status line. /usage reads them from an endpoint with the login Claude Code keeps
 * in .credentials.json; so does this, when the last answer is older than a minute while a session
 * runs or ten minutes while none does, never more than once a minute, and only with a token that
 * has not expired. The endpoint is a reading, not a model call: no tokens, no cost. The token goes
 * to api.anthropic.com and nowhere else, and is never refreshed here — that is Claude Code's job,
 * done whenever it runs. The pure parts are here so they can be tested; the request is the feature's.
 */
import { RATE_WINDOWS } from "./constants.js";

export const USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
/** The beta header Claude Code's OAuth requests carry; without it the endpoint answers 401. */
export const OAUTH_BETA = "oauth-2025-04-20";
/** What Claude Code itself says it is; the endpoint is meant for that client. */
export const USER_AGENT = "claude-code/2.1.0";
/** After a refusal (a stale token, a rate limit with no Retry-After) the next try waits this long. */
export const RETRY_ON_ERROR_MS = 5 * 60_000;
/** A Retry-After longer than this is not believed: a corrupt header must not silence the gauges for days. */
const MAX_RETRY_AFTER_MS = 24 * 3600_000;
/** Figures older than this are asked for again while no session is running: usage does not move then. */
export const STALE_MS = 10 * 60_000;
/** ...and older than this while a Claude Code session is running, since every turn moves them. */
export const STALE_LIVE_MS = 60_000;
/** Never two requests closer than this, whatever the answer was. */
export const RETRY_MS = 60_000;
/** A token this close to its expiry is not worth a request. */
const TOKEN_MARGIN_MS = 60_000;

interface Credentials { claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown } }

/** How Claude Code's login stands: a token to send, one that has run out, or none at all (an API key, or nobody signed in). */
export type LoginState = "fresh" | "expired" | "absent";

export function loginState(credentials: unknown, now = Date.now()): LoginState {
  const oauth = (credentials as Credentials | null | undefined)?.claudeAiOauth;
  if (typeof oauth?.accessToken !== "string" || !oauth.accessToken) return "absent";
  return accessTokenFrom(credentials, now) ? "fresh" : "expired";
}

/** The access token in Claude Code's credentials file, or null when there is none worth sending. */
export function accessTokenFrom(credentials: unknown, now = Date.now()): string | null {
  const oauth = (credentials as Credentials | null | undefined)?.claudeAiOauth;
  const token = oauth?.accessToken;
  if (typeof token !== "string" || !token) return null;
  const expires = oauth?.expiresAt;
  if (typeof expires === "number" && expires <= now + TOKEN_MARGIN_MS) return null;
  return token;
}

/** Whether the figures are old enough to ask again; figures that never were are. */
export function isStale(updatedAt: number | null, now = Date.now(), staleMs = STALE_MS): boolean {
  return updatedAt === null || now - updatedAt > staleMs;
}

interface EndpointBucket { utilization?: unknown; resets_at?: unknown }
interface EndpointLimit { kind?: unknown; percent?: unknown; resets_at?: unknown; scope?: { model?: { display_name?: unknown } | null } | null }

/** Epoch seconds from the endpoint's ISO text, or undefined when there is none. */
function epochSeconds(value: unknown): number | undefined {
  const ms = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
}

/**
 * The weekly limit scoped to one model, from the endpoint's `limits[]` — the newest shape, where each
 * limit says what it is and what it applies to. The first one named after a model is the one drawn.
 */
function scopedWeekly(body: Record<string, unknown>): Record<string, unknown> | null {
  const limits = body["limits"];
  if (!Array.isArray(limits)) return null;
  for (const limit of limits as EndpointLimit[]) {
    if (!limit || limit.kind !== "weekly_scoped" || typeof limit.percent !== "number") continue;
    const model = limit.scope?.model?.display_name;
    if (typeof model !== "string" || !model.trim()) continue;
    const resets = epochSeconds(limit.resets_at);
    return { utilization: limit.percent, ...(resets !== undefined ? { resets_at: resets } : {}), model: model.trim() };
  }
  return null;
}

/**
 * How long to wait after a refusal. A rate limit says so itself (seconds, or an HTTP date); a stale
 * token is Claude Code's to refresh when it next runs, so asking again soon gains nothing.
 */
export function backoffFor(status: number, retryAfter: string | null, now = Date.now()): number {
  if (status === 429) {
    const seconds = Number(retryAfter);
    if (retryAfter && Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
    const at = retryAfter ? Date.parse(retryAfter) : Number.NaN;
    if (Number.isFinite(at) && at > now) return Math.min(at - now, MAX_RETRY_AFTER_MS);
    return RETRY_ON_ERROR_MS;
  }
  if (status === 401 || status === 403) return RETRY_ON_ERROR_MS;
  return RETRY_MS;
}

/** What a refusal means, for the settings screen. */
export type EndpointFailure = "stale-token" | "rate-limited" | "error";

export function failureFor(status: number): EndpointFailure {
  if (status === 401 || status === 403) return "stale-token";
  if (status === 429) return "rate-limited";
  return "error";
}

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
    const resets = epochSeconds(bucket.resets_at);
    out[key] = { utilization: bucket.utilization, ...(resets !== undefined ? { resets_at: resets } : {}) };
  }
  const scoped = scopedWeekly(body as Record<string, unknown>);
  if (scoped) out["weekly_scoped"] = scoped;
  if (Object.keys(out).length === 0) return null;
  out["updated_at"] = Math.floor(now / 1000);
  out["source"] = "endpoint";
  return out;
}
