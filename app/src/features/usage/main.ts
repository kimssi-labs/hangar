/**
 * Claude Code's usage figures — the main side.
 *
 * Claude Code does not publish its rate limits to anything outside itself: no hook input carries
 * them (checked against 2.1.263, all 33 events), no transcript line does, and the one place they
 * do go — the status line's stdin — is the user's own status line. So the figures are asked for the
 * way Claude Code's own `/usage` asks: the usage endpoint, with the login Claude Code keeps
 * (core/usageEndpoint.ts). A timer of this process does the asking whether or not the window is
 * looking — every minute while a Claude Code session is running, every ten minutes otherwise, and
 * never twice within a minute. Nothing to install, nothing to switch on, and nothing spent: the
 * endpoint is a reading, not a model call.
 *
 * Earlier versions offered a Stop hook instead (core/usageHook.ts says what became of it); one an
 * older version installed is taken back out at start-up.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { net } from "electron";

import type { Wire } from "../../bridge/build.js";
import type { MainContext } from "../../bridge/context.js";
import { homePaths } from "../../core/paths.js";
import { readStatus, readStatusJson, readStatusUpdatedAt } from "../../core/status.js";
import { accessTokenFrom, backoffFor, cacheFromEndpoint, type EndpointFailure, failureFor, isStale, loginState, OAUTH_BETA, RETRY_MS, STALE_LIVE_MS, STALE_MS, USAGE_ENDPOINT, USER_AGENT } from "../../core/usageEndpoint.js";
import { hookFileName, hookInstalled, withoutHook } from "../../core/usageHook.js";
import { usageContract, type UsageState } from "./contract.js";

/** What the rest of main may ask of this feature. */
export interface UsageFeature {
  /** How the reading stands — the settings payload carries it. */
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
 * answers, and only the first is a file we may leave alone without a word.
 */
function readClaudeSettings(): { settings: Record<string, unknown>; readable: boolean } {
  let text: string;
  try {
    // A BOM here is normal: plenty of editors and PowerShell itself write one.
    text = readFileSync(homePaths().settings, "utf8").replace(/^﻿/, "");
  } catch {
    return { settings: {}, readable: true };
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

/**
 * Take out the Stop hook an older version installed, once, quietly.
 *
 * Its entry in settings.json and its script go together: the entry alone would have Claude Code
 * report a failing hook at the end of every turn, the script alone would keep running for nothing.
 * Only our own entry is touched (core/usageHook.ts), and a settings file that does not parse is
 * left exactly as it is — the fault is reported, not written over.
 */
function retireHook(): void {
  try {
    const paths = homePaths();
    const current = readClaudeSettings();
    if (!hookInstalled(current.settings)) return;
    if (!current.readable) {
      console.error(`[hangar] ${paths.settings} is not valid JSON; the old usage hook entry was left in it`);
      return;
    }
    writeFileSync(paths.settings, `${JSON.stringify(withoutHook(current.settings), null, 2)}\n`, "utf8");
    rmSync(join(paths.hooks, hookFileName(process.platform)), { force: true });
    console.log("[hangar] the usage hook an older version installed was removed");
  } catch (error) {
    console.error("[hangar] retiring the usage hook:", (error as Error).message);
  }
}

/** Whether any Claude Code session is running right now, by the registry Claude Code keeps. */
function sessionRunning(ctx: MainContext): boolean {
  return ctx.store.liveSessions().size > 0;
}

function usageState(ctx: MainContext): UsageState {
  return {
    updatedAt: readStatusUpdatedAt(),
    reported: readStatus(undefined, { windows: null }).windows.length,
    live: sessionRunning(ctx),
    login: loginState(readStatusJson<unknown>(homePaths().credentials, null)),
    endpointFailure: lastFailure,
  };
}

/** How long one request to the usage endpoint may take. */
const ENDPOINT_TIMEOUT_MS = 10_000;
/** How often the timer looks; it asks only when the figures are stale for the moment's cadence and the wait is over. */
const ENDPOINT_TICK_MS = 60_000;
let nextAttemptAt = 0;
let inFlight = false;
let lastFailure: EndpointFailure | null = null;

/**
 * Ask Claude Code's usage endpoint when the figures are stale, and say so when new ones have landed.
 *
 * Stale is a minute while a session is running and ten when none is: usage moves only while
 * something runs, and asking every minute of an idle evening would be asking for the same number.
 * Not awaited by the caller — the first status read happens on the way to the first paint. Guarded
 * so that a machine with no login, an expired token, or fresh figures costs nothing, and one that
 * does ask never asks twice within RETRY_MS whatever the answer was.
 */
function refreshFromEndpoint(landed: () => void, live: boolean): void {
  const paths = homePaths();
  const now = Date.now();
  if (!isStale(readStatusUpdatedAt(), now, live ? STALE_LIVE_MS : STALE_MS) || inFlight || now < nextAttemptAt) return;
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
      mkdirSync(dirname(paths.hangarUsage), { recursive: true });
      // Write then rename, so a read never catches a half-written file.
      const tmp = `${paths.hangarUsage}.tmp`;
      writeFileSync(tmp, JSON.stringify(cache), "utf8");
      renameSync(tmp, paths.hangarUsage);
      landed();
    })
    .catch((error: unknown) => console.error("[hangar] usage endpoint:", (error as Error).message))
    .finally(() => {
      inFlight = false;
    });
}

export function register(ctx: MainContext, wire: Wire): UsageFeature {
  retireHook();
  const publish = (): void => wire.emit(usageContract.onStatus, readStatus(undefined, ctx.config.status()));
  const refresh = (): void => refreshFromEndpoint(publish, sessionRunning(ctx));
  let timer: NodeJS.Timeout | null = null;
  wire.bind(usageContract, {
    status: () => {
      refresh();                                 // a poll that finds them stale need not wait for the tick
      return readStatus(undefined, ctx.config.status());
    },
  });
  return {
    state: () => usageState(ctx),
    // The figures keep themselves current with nobody looking: this process asks, not the page, so a
    // window that is docked, hidden or busy elsewhere still has today's numbers the moment it draws.
    start() {
      if (timer) return;
      timer = setInterval(refresh, ENDPOINT_TICK_MS);
      timer.unref();
      refresh();                                  // and once now, so the first paint has them
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
