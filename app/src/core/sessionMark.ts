/**
 * What a session row shows about itself before its name.
 *
 * Claude Code writes what each running session is doing into its registry entry: `busy` while it is
 * answering, `waiting` while it is asking the person something, `idle` once it has finished and the
 * turn is theirs. Measured on this machine, all three appear in `sessions/<pid>.json`.
 *
 * Two marks are enough to act on: something is happening, or it is your turn. A session that is not
 * running has neither — it is a transcript, not a conversation waiting for anyone.
 */
export type SessionMark = "working" | "turn" | null;

export function sessionMark(live: boolean, status: string | null): SessionMark {
  if (!live) return null;
  return status === "busy" ? "working" : "turn";
}

/** The states a running session reports. Anything else it might say is shown as it comes. */
export const SESSION_STATES = ["busy", "waiting", "idle"] as const;
/** What a session that is not running is called. */
export const NOT_RUNNING = "disable";

/**
 * A project's state: the busiest thing happening inside it.
 *
 * A project is only ever as busy as its sessions, so the row says the same four words a session row
 * does — one glance down the project list, the same vocabulary.
 */
export function projectState(sessions: { live: boolean; status: string | null }[]): string {
  const live = sessions.filter((session) => session.live);
  if (!live.length) return NOT_RUNNING;
  if (live.some((session) => session.status === "busy")) return "busy";
  if (live.some((session) => session.status === "waiting")) return "waiting";
  return "idle";
}

/**
 * The word the mark shows when the pointer rests on it.
 *
 * Claude Code's own state name, left in English in every language: these are the four words the
 * registry deals in, and translating them would only make them harder to match up with it.
 */
export function statusLabel(live: boolean, status: string | null): string {
  if (!live) return NOT_RUNNING;
  return status && status.trim() ? status.trim() : "idle";
}
