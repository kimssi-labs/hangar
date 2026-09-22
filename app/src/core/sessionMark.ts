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
