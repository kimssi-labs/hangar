/**
 * Projects a session started: a folder no one opened in a terminal, filled by headless runs.
 *
 * Claude Code keys a project by the folder a session ran in, so a session that prepares folders
 * and starts `claude -p` in each leaves a project per folder, side by side with the one it came
 * from, and nothing in a run's own transcript says who started it. What does say it is the starting
 * session's transcript: the command that made or entered the folder names it. So a project whose
 * sessions are all headless is tucked under the project of the session that was running when its
 * first run began and whose transcript names its folder. Names and places of the folders do not
 * matter, only that link.
 */
import { statSync } from "node:fs";

import { readBytes } from "./store.js";

/** How far back from a project's first run its starting session is searched for the folder's name. */
const LOOK_BACK_MS = 30 * 60_000;
/** How far a starting session may begin after the run it started: its first line can lag the command. */
const START_SLACK_MS = 60_000;
/** A binary search by time stops once the span left is this small; that span is then read whole. */
const SEARCH_SPAN_BYTES = 64 * 1024;
/** What one probe of the binary search reads to find a line's timestamp. */
const PROBE_BYTES = 16 * 1024;
const TIMESTAMP = /"timestamp":"([^"]+)"/;
const NEWLINE = String.fromCharCode(10);

interface SessionLike { file: string; headless: boolean; startedAt: number; modifiedAt: number }
interface ProjectLike { dir: string; cwd: string | null; parentDir: string | null; sessions: SessionLike[] }

/**
 * The ways a transcript spells a folder: as JSON writes a Windows path (each `\` doubled), with
 * forward slashes, and as Git Bash writes it (`/c/...`).
 */
export function spellings(cwd: string): string[] {
  const path = cwd.replace(/[\\/]+$/, "");
  const forward = path.replace(/\\/g, "/");
  const out = new Set([path.replace(/\\/g, "\\\\"), forward]);
  const drive = /^([A-Za-z]):\//.exec(forward);
  if (drive) out.add(`/${drive[1]!.toLowerCase()}/${forward.slice(3)}`);
  return [...out];
}

/** A byte that can continue a folder name, so `app` inside `app-old` is not a mention of `app`. */
function continuesName(byte: number | undefined): boolean {
  if (byte === undefined) return false;
  return (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a)
    || byte === 0x2d || byte === 0x5f || byte === 0x2e || byte >= 0x80;
}

function mentions(bytes: Buffer, needle: Buffer): boolean {
  for (let at = bytes.indexOf(needle); at >= 0; at = bytes.indexOf(needle, at + 1)) {
    if (!continuesName(bytes[at + needle.length])) return true;
  }
  return false;
}

/** How many probes a timestamp is looked for in before giving up: a tool result can be megabytes. */
const PROBE_LIMIT = 64;

/** The time of the first timestamped line starting after `at`, or null if there is none near it. */
function timeAfter(file: string, at: number): number | null {
  let lineStart = at === 0;
  for (let probe = 0; probe < PROBE_LIMIT; probe++) {
    const bytes = readBytes(file, at + probe * PROBE_BYTES, PROBE_BYTES);
    if (!bytes.length) return null;
    let text = bytes.toString("utf8");
    if (!lineStart) {
      const newline = text.indexOf(NEWLINE);
      if (newline < 0) continue;                    // still inside the line the probe landed in
      text = text.slice(newline + 1);
      lineStart = true;
    }
    const match = TIMESTAMP.exec(text);
    const time = match ? Date.parse(match[1] as string) : NaN;
    if (!Number.isNaN(time)) return time;
  }
  return null;
}

/** A byte offset at or before the first line written at `time`: transcripts are written in time order. */
export function offsetAt(file: string, size: number, time: number): number {
  let low = 0;
  let high = size;
  while (high - low > SEARCH_SPAN_BYTES) {
    const middle = Math.floor((low + high) / 2);
    const seen = timeAfter(file, middle);
    // No time near the probe: the end of the file, so the earlier half holds what is wanted.
    if (seen !== null && seen < time) low = middle;
    else high = middle;
  }
  return low;
}

/**
 * Whether a session's transcript named a folder in the half hour before a time.
 *
 * Only that part of the transcript is read, found by a binary search on its timestamps, so a
 * 100 MB conversation costs a few small reads and the window itself. An answer is kept once the
 * transcript has been written past the window: nothing later can change it.
 */
export class MentionIndex {
  private answers = new Map<string, boolean>();

  names(file: string, cwd: string, time: number): boolean {
    const key = [file, cwd, time].join(NEWLINE);
    const known = this.answers.get(key);
    if (known !== undefined) return known;
    let st: { size: number; mtimeMs: number };
    try {
      st = statSync(file);
    } catch {
      return false;
    }
    const from = offsetAt(file, st.size, time - LOOK_BACK_MS);
    const to = Math.min(st.size, offsetAt(file, st.size, time + START_SLACK_MS) + SEARCH_SPAN_BYTES);
    const bytes = readBytes(file, from, to - from);
    const hit = spellings(cwd).some((spelling) => mentions(bytes, Buffer.from(spelling)));
    if (hit || st.mtimeMs > time + START_SLACK_MS) this.answers.set(key, hit);
    return hit;
  }
}

/**
 * Point each project of headless runs at the project whose session started them.
 *
 * Worktrees are linked first and keep their repository. Of the sessions running when a project's
 * first run began, the most recently started one that names its folder wins; a project nobody can
 * be found for stays at the top of the list.
 */
export function linkSpawned<T extends ProjectLike>(
  projects: T[],
  names: (file: string, cwd: string, time: number) => boolean,
): void {
  for (const child of projects) {
    if (child.parentDir || !child.cwd || !child.sessions.length) continue;
    if (!child.sessions.every((session) => session.headless)) continue;
    const firstRun = Math.min(...child.sessions.map((session) => session.startedAt));
    const starter = projects
      .filter((project) => project !== child)
      .flatMap((project) => project.sessions
        .filter((session) => session.startedAt <= firstRun + START_SLACK_MS && session.modifiedAt >= firstRun)
        .map((session) => ({ project, session })))
      .sort((a, b) => b.session.startedAt - a.session.startedAt)
      .find(({ session }) => names(session.file, child.cwd as string, firstRun));
    if (starter) child.parentDir = starter.project.dir;
  }
}
