/**
 * Claude Code's usage figures — the main side.
 *
 * Claude Code does not publish its rate limits to anything outside itself: no hook input carries
 * them (checked against 2.1.263, all 33 events), no transcript line does, and the one place they
 * do go — the status line's stdin — is the user's own status line. So the figures are asked for the
 * way Claude Code's own `/usage` asks: the usage endpoint, with the login Claude Code keeps
 * (core/usageEndpoint.ts). A timer of this process does the asking whether or not the window is
 * looking — every minute while a Claude Code session is running, every ten minutes otherwise, and
 * never twice within a minute; a double-click on any gauge asks at once, and the card turned off
 * asks for nothing at all. Nothing to install, nothing to switch on, and nothing spent: the
 * endpoint is a reading, not a model call.
 */
import { net } from "electron";

import type { Wire } from "../../bridge/build.js";
import type { MainContext } from "../../bridge/context.js";
import { readJson, writeJson } from "../../core/json.js";
import { homePaths } from "../../core/paths.js";
import { readStatus, readStatusUpdatedAt } from "../../core/status.js";
import { accessTokenFrom, backoffFor, cacheFromEndpoint, type EndpointFailure, failureFor, loginState, OAUTH_BETA, shouldAsk, USAGE_ENDPOINT, USER_AGENT } from "../../core/usageEndpoint.js";
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

/** Whether any Claude Code session is running right now, by the registry Claude Code keeps. */
function sessionRunning(ctx: MainContext): boolean {
  return ctx.store.liveSessions().size > 0;
}

function usageState(): UsageState {
  return {
    updatedAt: readStatusUpdatedAt(),
    login: loginState(readJson<unknown>(homePaths().credentials, null)),
    endpointFailure: lastFailure,
  };
}

/** How long one request to the usage endpoint may take. */
const ENDPOINT_TIMEOUT_MS = 10_000;
/** How often the timer looks; it asks only when the figures are stale for the moment's cadence and the wait is over. */
const ENDPOINT_TICK_MS = 60_000;
let lastAskedAt = 0;
let nextAttemptAt = 0;
let inFlight = false;
let lastFailure: EndpointFailure | null = null;

/**
 * Ask Claude Code's usage endpoint, and say so when new figures have landed.
 *
 * Whether to ask at all is core's decision (usageEndpoint.shouldAsk): stale figures on the timer,
 * or the user's double-click, never two requests within a minute — five seconds by hand — and never
 * during a refusal's backoff. The timer does not await this; a double-click does, so the answer it
 * gets back is the fresh one. Guarded so that a machine with no login or an expired token costs
 * nothing: Claude Code renews the token when it next runs, and the figures follow.
 */
async function refreshFromEndpoint(landed: () => void, live: boolean, manual = false): Promise<void> {
  const paths = homePaths();
  const now = Date.now();
  if (inFlight || !shouldAsk({ now, updatedAt: readStatusUpdatedAt(), lastAskedAt, nextAttemptAt, live, manual })) return;
  const token = accessTokenFrom(readJson<unknown>(paths.credentials, null), now);
  if (!token) return;
  lastAskedAt = now;
  inFlight = true;
  try {
    // Chromium's network stack, not Node's: it follows the machine's proxy settings, which is the
    // difference between working and not on a company network.
    const response = await net.fetch(USAGE_ENDPOINT, {
      headers: { Authorization: `Bearer ${token}`, "anthropic-beta": OAUTH_BETA, "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(ENDPOINT_TIMEOUT_MS),
    });
    if (!response.ok) {
      lastFailure = failureFor(response.status);
      nextAttemptAt = Date.now() + backoffFor(response.status, response.headers.get("retry-after"));
      throw new Error(`HTTP ${response.status}`);
    }
    lastFailure = null;
    const cache = cacheFromEndpoint(await response.json(), Date.now());
    if (!cache) return;
    writeJson(paths.hangarUsage, cache);
    landed();
  } catch (error) {
    console.error("[hangar] usage endpoint:", (error as Error).message);
  } finally {
    inFlight = false;
  }
}

export function register(ctx: MainContext, wire: Wire): UsageFeature {
  const publish = (): void => wire.emit(usageContract.onStatus, readStatus(undefined, ctx.config.status()));
  /** Whether any gauge is drawn: off is off, and nothing is asked for what nothing shows. */
  const showing = (): boolean => {
    const windows = ctx.config.status().windows;
    return windows === null || windows.length > 0;
  };
  const refresh = async (manual = false): Promise<void> => {
    if (showing()) await refreshFromEndpoint(publish, sessionRunning(ctx), manual);
  };
  let timer: NodeJS.Timeout | null = null;
  wire.bind(usageContract, {
    status: () => {
      void refresh();                            // a poll that finds them stale need not wait for the tick
      return readStatus(undefined, ctx.config.status());
    },
    // The user's double-click on a gauge: ask now, and answer with what came back.
    refreshUsage: async () => {
      await refresh(true);
      return readStatus(undefined, ctx.config.status());
    },
  });
  return {
    state: usageState,
    // The figures keep themselves current with nobody looking: this process asks, not the page, so a
    // window that is docked, hidden or busy elsewhere still has today's numbers the moment it draws.
    start() {
      if (timer) return;
      timer = setInterval(() => void refresh(), ENDPOINT_TICK_MS);
      timer.unref();
      void refresh();                                  // and once now, so the first paint has them
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
