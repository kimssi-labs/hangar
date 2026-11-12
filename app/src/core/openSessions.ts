/**
 * The sessions that were running, kept so the next start can offer to open them again.
 *
 * Written from Claude Code's live-session registry as it is watched. A session that starts is added
 * at once; one that stops is dropped only after it has stayed stopped for CLOSED_GRACE_MS while this
 * app kept running. A reboot or a shutdown ends the terminals and this app within seconds of each
 * other, so the sessions it ends are still on the list when the machine comes back; a session closed
 * by hand on a running desk is gone from it a minute later.
 */
import { readJson, writeJson } from "./json.js";

/** How long a session must stay stopped, seen by a running app, before it counts as closed by hand. */
export const CLOSED_GRACE_MS = 60_000;

interface SessionLike { id: string; folded: string[]; headless: boolean; live: boolean; title: string }
interface ProjectLike { dir: string; sessions: SessionLike[] }

/** One session the last run had open, as the start-up question names it and the reopen finds it. */
export interface RestorableSession { projectDir: string; sessionId: string; title: string }

export class OpenSessions {
  /** What the last run had open, as this run found it on start-up. */
  readonly before: string[];
  private kept: Set<string>;
  private goneSince = new Map<string, number>();

  constructor(private readonly file: string, private readonly now: () => number = Date.now) {
    const saved = readJson<{ sessions?: unknown }>(file, {}).sessions;
    this.kept = new Set(Array.isArray(saved) ? saved.filter((id): id is string => typeof id === "string") : []);
    this.before = [...this.kept];
  }

  /** Let these go: the person was offered them and said no, so the next start does not ask again. */
  forget(ids: Iterable<string>): void {
    let changed = false;
    for (const id of ids) changed = this.kept.delete(id) || changed;
    if (changed) this.write();
  }

  /** The registry as it is now: running sessions are kept, and stopped ones dropped once the grace is up. */
  observe(live: Iterable<string>): void {
    const now = this.now();
    const running = new Set(live);
    let changed = false;
    for (const id of running) {
      this.goneSince.delete(id);
      if (!this.kept.has(id)) {
        this.kept.add(id);
        changed = true;
      }
    }
    for (const id of [...this.kept]) {
      if (running.has(id)) continue;
      const since = this.goneSince.get(id) ?? now;
      this.goneSince.set(id, since);
      if (now - since >= CLOSED_GRACE_MS) {
        this.kept.delete(id);
        this.goneSince.delete(id);
        changed = true;
      }
    }
    if (changed) this.write();
  }

  private write(): void {
    try {
      writeJson(this.file, { sessions: [...this.kept] });
    } catch {
      /* a list not written is one fewer offer on the next start, not a reason to fail */
    }
  }
}

/**
 * Of the sessions the last run had open, the ones worth offering: still listed, not running now,
 * and opened by a person (a headless run has no terminal to come back to). A session continued by
 * /clear is found under the row it is folded into, and offered once.
 */
export function restorable(before: string[], projects: ProjectLike[]): RestorableSession[] {
  const out: RestorableSession[] = [];
  const offered = new Set<string>();
  for (const id of before) {
    for (const project of projects) {
      const session = project.sessions.find((s) => s.id === id || s.folded.includes(id));
      if (!session) continue;
      if (!session.live && !session.headless && !offered.has(session.id)) {
        offered.add(session.id);
        out.push({ projectDir: project.dir, sessionId: session.id, title: session.title });
      }
      break;
    }
  }
  return out;
}
