/**
 * Which session replaced which, seen as it happened.
 *
 * `/clear` does not empty a session: Claude Code starts a new session id in the same terminal and
 * leaves the old transcript finished on disk. Timestamps cannot tie the two together — measured on
 * this machine, a clear typed after a pause leaves the old transcript 10 minutes, 7 hours, even days
 * behind the new one's birth — but the live-session registry can: `sessions/<pid>.json` keeps the
 * pid and swaps the session id (measured: pid 1752, 8fb045e6 → e317e73d, on one /clear).
 *
 * So the app watches that registry as it scans, and writes down every swap it sees. A swap is the
 * exact statement "this terminal's session became that one", and the list folds the pair into one
 * row from then on — see sessionChain.ts. Nothing is inferred: a clear that happened while the app
 * was not running is simply not recorded, and falls back to the timestamp rule.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** One entry of Claude Code's live-session registry. */
export interface RegistryEntry {
  pid: number;
  sessionId: string;
  /** The process's own start time. A recycled pid gets a different one, so it is not the same terminal. */
  procStart?: string;
  /** What the session says it is doing: "busy", "waiting", "idle". */
  status?: string | null;
}

/** What a pid was last seen running. */
export interface Seen {
  sessionId: string;
  procStart: string;
}

/** `from` was replaced by `to` in the same terminal. */
export interface Chain {
  from: string;
  to: string;
}

/** Kept so the file cannot grow without end; a home reaches this after hundreds of clears. */
export const MAX_CHAINS = 300;

/**
 * The swaps between what was seen last time and what the registry says now, plus the new picture.
 *
 * Only pids the registry still lists are remembered: a terminal that closed can tell us nothing, and
 * its pid will belong to someone else soon enough.
 */
export function observe(seen: Record<string, Seen>, entries: RegistryEntry[]): { seen: Record<string, Seen>; chains: Chain[] } {
  const next: Record<string, Seen> = {};
  const chains: Chain[] = [];
  for (const entry of entries) {
    if (!entry.sessionId || !Number.isFinite(entry.pid)) continue;
    const key = String(entry.pid);
    const procStart = entry.procStart ?? "";
    const before = seen[key];
    // The same process, now running a different session: that is the clear. A pid the system handed
    // to another program has another procStart, and says nothing about the session it used to run.
    if (before && before.sessionId !== entry.sessionId && before.procStart === procStart) {
      chains.push({ from: before.sessionId, to: entry.sessionId });
    }
    next[key] = { sessionId: entry.sessionId, procStart };
  }
  return { seen: next, chains };
}

/** Successor id → the session it replaced. */
export function replacedBy(chains: Chain[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const chain of chains) map.set(chain.to, chain.from);
  return map;
}

/**
 * The swaps this machine has seen, in the app's own file.
 *
 * Only the chains are kept: what each pid is running right now is read again at every scan, so a
 * restart costs nothing but the clears that happened while the app was closed.
 */
export class SessionLinks {
  private seen: Record<string, Seen> = {};
  private chains: Chain[];

  constructor(private readonly file: string) {
    let data: { chains?: Chain[] } = {};
    try {
      data = JSON.parse(readFileSync(file, "utf8")) as { chains?: Chain[] };
    } catch {
      // No file yet, or one we cannot make sense of: start with nothing recorded.
    }
    this.chains = (data.chains ?? []).filter((c) => c && typeof c.from === "string" && typeof c.to === "string");
  }

  /** Take in the registry as it is now, and write down anything that changed hands. */
  observe(entries: RegistryEntry[]): void {
    const result = observe(this.seen, entries);
    this.seen = result.seen;
    if (!result.chains.length) return;
    this.chains = [...this.chains, ...result.chains].slice(-MAX_CHAINS);
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify({ chains: this.chains }), "utf8");
    } catch {
      // A cache we could not write is a fold we lose on the next start, not a reason to fail a scan.
    }
  }

  /** Successor id → the session it replaced. */
  map(): Map<string, string> {
    return replacedBy(this.chains);
  }
}
