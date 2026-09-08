/**
 * One row for a conversation that /clear split into several transcripts.
 *
 * Claude Code's /clear does not empty a session: it starts a new session id in the same terminal,
 * gives it the old session's name, and writes the command's echo as the new transcript's first user
 * entry (measured). The old transcript is finished and the new one carries on, so the list showed
 * two rows named alike, one idle and one running. Here the finished predecessor is folded under its
 * successor: the row is the newest transcript, it says how many came before it, and it borrows the
 * first prompt while its own has not been typed yet.
 *
 * Only a named session is folded, and only under a successor of the same name: the name is what
 * Claude Code carries across /clear, and what made the two rows read as one to begin with. An
 * unnamed session cleared gets a new title from its new conversation and reads as new anyway. A
 * predecessor still running is never folded (two processes are two rows), nor one written after its
 * successor was born. Deleting the head row brings its predecessors back into the list: nothing is
 * folded that cannot be reached again.
 */
import type { SessionInfo } from "./types.js";

/** How much later than its successor's birth a predecessor may still have been written: /clear's own last lines. */
export const CLEAR_TOLERANCE_MS = 60_000;

export interface SessionWithOrigin extends SessionInfo {
  /** The transcript opens with the /clear echo — see transcript.ts. */
  startedByClear: boolean;
}

/** The sessions with every /clear predecessor folded under its successor, in the order given. */
export function foldClears(sessions: SessionWithOrigin[]): SessionInfo[] {
  const folded = new Set<string>();
  const byStart = [...sessions].sort((a, b) => a.startedAt - b.startedAt);
  const rows = new Map(sessions.map((s) => [s.id, { ...s }]));
  // Oldest first, so a chain of clears accumulates: the second head counts the first head's predecessors too.
  for (const successor of byStart) {
    if (!successor.startedByClear || !successor.named) continue;
    const predecessor = byStart
      .filter((p) => p.id !== successor.id && !folded.has(p.id)
        && p.named && p.title === successor.title && !p.live
        && p.startedAt < successor.startedAt && p.modifiedAt <= successor.startedAt + CLEAR_TOLERANCE_MS)
      .sort((a, b) => b.modifiedAt - a.modifiedAt)[0];
    if (!predecessor) continue;
    folded.add(predecessor.id);
    const head = rows.get(successor.id) as SessionWithOrigin;
    const prior = rows.get(predecessor.id) as SessionWithOrigin;
    head.continues = prior.continues + 1;
    if (!head.prompt) head.prompt = prior.prompt;
  }
  return sessions.filter((s) => !folded.has(s.id)).map((s) => withoutOrigin(rows.get(s.id) as SessionWithOrigin));
}

function withoutOrigin(session: SessionWithOrigin): SessionInfo {
  const { startedByClear: _origin, ...rest } = session;
  return rest;
}
