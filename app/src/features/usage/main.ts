/**
 * Claude Code's usage figures — the main side.
 *
 * Claude Code does not publish its rate limits anywhere on its own (measured: none of thousands of
 * transcript lines carry them), so the figures are asked for the way its own `/usage` asks: the
 * endpoint, with the login Claude Code keeps (core/usageEndpoint.ts). That happens here on a timer
 * of this process, whether or not the window is asking and whether or not anything else is set up —
 * nothing to install, nothing to switch on.
 *
 * The Stop hook (core/usageHook.ts) stays as an option beside it, for a machine that would rather
 * publish the figures from Claude Code itself than have them fetched: it costs no request and is
 * current to the last turn. Both land in the one cache file the gauges read (core/status.ts), and a
 * cache the hook keeps fresh means the timer below finds nothing to do.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { app, net } from "electron";

import type { Wire } from "../../bridge/build.js";
import type { MainContext } from "../../bridge/context.js";
import { homePaths } from "../../core/paths.js";
import { readStatus, readStatusJson, readStatusUpdatedAt } from "../../core/status.js";
import { accessTokenFrom, backoffFor, cacheFromEndpoint, type EndpointFailure, failureFor, isStale, loginState, OAUTH_BETA, RETRY_MS, USAGE_ENDPOINT, USER_AGENT } from "../../core/usageEndpoint.js";
import { hookCommand, hookFileName, hookInstalled, hookScript, withHook, withoutHook } from "../../core/usageHook.js";
import type { ActionResult, SettingsPayload } from "../../main/ipc.js";
import { usageContract, type UsageState } from "./contract.js";

/** What this feature needs from the rest of main. */
export interface UsageDeps {
  /** The whole settings payload, which the hook toggle answers with. */
  settingsPayload(): SettingsPayload;
}

/** What the rest of main may ask of this feature. */
export interface UsageFeature {
  /** How collection stands — the settings payload carries it. */
  state(): UsageState;
  /**
   * Begin keeping the figures current, once the platform is ready.
   *
   * Not at registration: `net.fetch` before `app.whenReady()` never answers — measured as an app
   * that launched and then hung with no window at all.
   */
  start(): void;
  /** Stop asking; the app is leaving. */
  stop(): void;
}

/**
 * Claude Code's own settings file, read as it is.
 *
 * It is the user's file, not ours: they may have hooks, permissions and anything else in it, and
 * writing our own object over it would delete every setting they have. So an unreadable file stops
 * the operation rather than starting from an empty one — "absent" and "unparseable" are different
 * answers, and only the first is a file we may create.
 */
function readClaudeSettings(): { settings: Record<string, unknown>; readable: boolean } {
  let text: string;
  try {
    // A BOM here is normal: plenty of editors and PowerShell itself write one.
    text = readFileSync(homePaths().settings, "utf8").replace(/^﻿/, "");
  } catch {
    return { settings: {}, readable: true };     // absent, which is a file we may create
  }
  if (!text.trim()) return { settings: {}, readable: true };
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? { settings: parsed as Record<string, unknown>, readable: true }
      : { settings: {}, readable: false };
  } catch {
    return { settings: {}, readable: false };
  }
}

function usageHookPath(): string {
  return join(homePaths().hooks, hookFileName(process.platform));
}

function usageState(): UsageState {
  const updatedAt = readStatusUpdatedAt();
  const written = readStatusJson<{ source?: unknown }>(homePaths().rateLimits, {}).source;
  return {
    collecting: hookInstalled(readClaudeSettings().settings),
    portable: !app.isPackaged || Boolean(process.env["PORTABLE_EXECUTABLE_DIR"]),
    updatedAt,
    reported: readStatus(undefined, { windows: null }).windows.length,
    source: updatedAt === null ? null : written === "endpoint" ? "endpoint" : "hook",
    login: loginState(readStatusJson<unknown>(homePaths().credentials, null)),
    endpointFailure: lastFailure,
  };
}

/** How long one request to the usage endpoint may take. */
const ENDPOINT_TIMEOUT_MS = 10_000;
/** How often the timer looks; it asks only when the cache is stale (usageEndpoint.STALE_MS) and the wait is over. */
const ENDPOINT_TICK_MS = 60_000;
let nextAttemptAt = 0;
let inFlight = false;
let lastFailure: EndpointFailure | null = null;

/**
 * Ask Claude Code's usage endpoint when the cache is stale, and say so when the answer has landed.
 *
 * Not awaited by the caller: the first status read happens on the way to the first paint. Guarded
 * so that a machine with no login, an expired token, or a fresh cache costs nothing, and one that
 * does ask never asks twice within RETRY_MS. The answer is written the way the hook writes, so the
 * reader cannot tell the two apart — only the `source` field, for the settings screen, differs.
 */
function refreshFromEndpoint(landed: () => void): void {
  const paths = homePaths();
  const now = Date.now();
  if (!isStale(readStatusUpdatedAt(), now) || inFlight || now < nextAttemptAt) return;
  const token = accessTokenFrom(readStatusJson<unknown>(paths.credentials, null), now);
  if (!token) return;                            // none, or run out: Claude Code refreshes it when it next runs
  nextAttemptAt = now + RETRY_MS;
  inFlight = true;
  // Chromium's network stack, not Node's: it follows the machine's proxy settings, which is the
  // difference between working and not on a company network.
  net.fetch(USAGE_ENDPOINT, {
    headers: { Authorization: `Bearer ${token}`, "anthropic-beta": OAUTH_BETA, "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(ENDPOINT_TIMEOUT_MS),
  })
    .then(async (response) => {
      if (!response.ok) {
        lastFailure = failureFor(response.status);
        nextAttemptAt = Date.now() + backoffFor(response.status, response.headers.get("retry-after"));
        throw new Error(`HTTP ${response.status}`);
      }
      lastFailure = null;
      const cache = cacheFromEndpoint(await response.json(), Date.now());
      if (!cache) return;
      mkdirSync(dirname(paths.rateLimits), { recursive: true });
      // Write then rename, so a read never catches a half-written file — the hook does the same.
      const tmp = `${paths.rateLimits}.tmp`;
      writeFileSync(tmp, JSON.stringify(cache), "utf8");
      renameSync(tmp, paths.rateLimits);
      landed();
    })
    .catch((error: unknown) => console.error("[hangar] usage endpoint:", (error as Error).message))
    .finally(() => {
      inFlight = false;
    });
}

/**
 * Turn collection on or off, writing as little of the user's file as the job needs.
 *
 * The script is rewritten on every enable rather than only when absent: an application that moved,
 * or a script this app has since improved, would otherwise keep running yesterday's copy.
 */
function setUsageCollection(on: boolean): ActionResult {
  const paths = homePaths();
  const script = usageHookPath();
  try {
    const current = readClaudeSettings();
    if (!current.readable) {
      return {
        ok: false,
        message: `${paths.settings} is not valid JSON, so it was left alone. Fix it and try again.`,
      };
    }
    if (on) {
      mkdirSync(paths.hooks, { recursive: true });
      // The cache path is baked in rather than derived by the script: Claude Code keys its home off
      // CLAUDE_CONFIG_DIR and this app off CLAUDE_HOME, so only the installer knows both answers.
      writeFileSync(script, hookScript(process.platform, paths.rateLimits, paths.hooks), "utf8");
      if (process.platform !== "win32") chmodSync(script, 0o755);
    }
    const before = current.settings;
    const after = on ? withHook(before, hookCommand(script)) : withoutHook(before);
    mkdirSync(dirname(paths.settings), { recursive: true });
    writeFileSync(paths.settings, `${JSON.stringify(after, null, 2)}\n`, "utf8");
    if (!on) rmSync(script, { force: true });
  } catch (error) {
    return { ok: false, message: `Could not write Claude Code's settings: ${(error as Error).message}` };
  }
  return {
    ok: true,
    message: on
      ? "Collecting usage. The figures appear when the next session finishes a turn."
      : "Usage collection off. The hook has been removed.",
  };
}

/**
 * Bring an installed hook script up to this build's, quietly, at start-up.
 *
 * The script is rewritten on every enable, but a machine that enabled collection under an older
 * build keeps that build's script until someone presses the button twice — and the fix for the
 * code-page fault (core/usageHook.ts, cacheFromScript) is exactly what nobody would know to press for.
 */
function refreshHookScript(): void {
  try {
    const paths = homePaths();
    if (!hookInstalled(readClaudeSettings().settings)) return;
    const script = usageHookPath();
    const wanted = hookScript(process.platform, paths.rateLimits, paths.hooks);
    let current: string | null = null;
    try {
      current = readFileSync(script, "utf8");
    } catch {
      /* gone: written back below */
    }
    if (current === wanted) return;
    mkdirSync(paths.hooks, { recursive: true });
    writeFileSync(script, wanted, "utf8");
    if (process.platform !== "win32") chmodSync(script, 0o755);
    console.log("[hangar] usage hook script brought up to date");
  } catch (error) {
    console.error("[hangar] usage hook script:", (error as Error).message);
  }
}

export function register(ctx: MainContext, wire: Wire, deps: UsageDeps): UsageFeature {
  refreshHookScript();
  const publish = (): void => wire.emit(usageContract.onStatus, readStatus(undefined, ctx.config.status()));
  let timer: NodeJS.Timeout | null = null;
  wire.bind(usageContract, {
    status: () => {
      refreshFromEndpoint(publish);              // a poll that finds them stale need not wait for the tick
      return readStatus(undefined, ctx.config.status());
    },
    setUsageHook: (on) => ({ ...setUsageCollection(on), settings: deps.settingsPayload() }),
  });
  return {
    state: usageState,
    // The figures keep themselves current with nobody looking: this process asks, not the page, so a
    // window that is docked, hidden or busy elsewhere still has today's numbers the moment it draws.
    start() {
      if (timer) return;
      timer = setInterval(() => refreshFromEndpoint(publish), ENDPOINT_TICK_MS);
      timer.unref();
      refreshFromEndpoint(publish);               // and once now, so the first paint has them
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
