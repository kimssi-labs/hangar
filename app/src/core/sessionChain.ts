/**
 * One row for a conversation Claude Code moved into a new transcript.
 *
 * /clear does not empty a session: it starts a new session id in the same terminal and leaves the
 * old transcript finished on disk. So the list grew a row every time someone cleared, and the old
 * rows sat there looking like sessions to go back to. Here the finished predecessor is folded under
 * its successor: one row, the newest transcript, saying how many came before it.
 *
 * Two marks say a transcript is a continuation rather than a new session, and a given one may carry
 * either (both measured on this machine):
 *
 *  - the /clear echo, written as the new transcript's first user entry;
 *  - a name in the file before anyone has spoken — Claude Code hands the old session's title to the
 *    new transcript as its first lines, which is how a conversation that moved files keeps its name.
 *
 * What is folded is the session that ENDED as this one was born: not live, started earlier, and
 * last written within a minute of the new transcript's birth (measured at 0-1 s; the minute is
 * slack for the clear's own last lines). Whichever candidate is nearest in time wins. Titles are
 * not compared for a /clear — the new conversation names itself, and waiting for the names to match
 * is what left the rows piling up — but a transcript that only carries a name must carry the SAME
 * name, so that a brand-new session started with `--name` never swallows the session beside it.
 *
 * Deleting the head row brings its predecessors back into the list: nothing is folded that cannot
 * be reached again.
 */
import type { SessionInfo } from "./types.js";

/** How far apart the predecessor's last write and the successor's birth may be. */
export const CLEAR_TOLERANCE_MS = 60_000;

export interface SessionWithOrigin extends SessionInfo {
  /** The transcript opens with the /clear echo — see transcript.ts. */
  startedByClear: boolean;
  /** The name the transcript was handed before anyone spoke in it, or null. */
  carriedTitle: string | null;
}

/** Whether this transcript was opened to carry on from another one. */
function isContinuation(session: SessionWithOrigin): boolean {
  return session.startedByClear || session.carriedTitle !== null;
}

/**
 * The session this one carried on from, or undefined.
 *
 * `candidates` are the sessions not already folded elsewhere. A transcript that only carries a name
 * must find that same name, which is what separates "the conversation moved here" from "a new
 * session was started with a name of its own a moment later".
 */
function predecessorOf(successor: SessionWithOrigin, candidates: SessionWithOrigin[]): SessionWithOrigin | undefined {
  return candidates
    .filter((p) => p.id !== successor.id
      && !p.live
      && p.startedAt < successor.startedAt
      && Math.abs(p.modifiedAt - successor.startedAt) <= CLEAR_TOLERANCE_MS
      && (successor.startedByClear || p.title === successor.carriedTitle))
    .sort((a, b) => Math.abs(a.modifiedAt - successor.startedAt) - Math.abs(b.modifiedAt - successor.startedAt))[0];
}

/** The sessions with every continuation's predecessor folded under it, in the order given. */
export function foldClears(sessions: SessionWithOrigin[]): SessionInfo[] {
  const folded = new Set<string>();
  const byStart = [...sessions].sort((a, b) => a.startedAt - b.startedAt);
  const rows = new Map(sessions.map((s) => [s.id, { ...s }]));
  // Oldest first, so a chain accumulates: the second head counts the first head's predecessors too.
  for (const successor of byStart) {
    if (!isContinuation(successor)) continue;
    const predecessor = predecessorOf(successor, byStart.filter((p) => !folded.has(p.id)));
    if (!predecessor) continue;
    folded.add(predecessor.id);
    const head = rows.get(successor.id) as SessionWithOrigin;
    const prior = rows.get(predecessor.id) as SessionWithOrigin;
    head.continues = prior.continues + 1;
    // The new conversation has not been typed into yet: show what the last one was about until it has.
    if (!head.prompt) head.prompt = prior.prompt;
  }
  return sessions.filter((s) => !folded.has(s.id)).map((s) => withoutOrigin(rows.get(s.id) as SessionWithOrigin));
}

function withoutOrigin(session: SessionWithOrigin): SessionInfo {
  const { startedByClear: _clear, carriedTitle: _carried, ...rest } = session;
  return rest;
}
