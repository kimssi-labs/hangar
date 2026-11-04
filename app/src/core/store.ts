/**
 * Reading (and editing) what Claude Code keeps under ~/.claude.
 *
 * Ported from the terminal version, including the parts that were learned the hard way: a project's
 * real folder only exists inside its transcripts, a session's title can come from three places, and
 * a "live" session is a pid that still exists — the registry file outlives the process.
 */
import { closeSync, mkdirSync, openSync, readSync, readdirSync, rmSync, statSync, unlinkSync, appendFileSync, type Stats } from "node:fs";
import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import { join } from "node:path";

import { ConfigStore, fileSignature } from "./config.js";
import { parseJsonl, readJson, writeJson } from "./json.js";
import { encodeProjectPath, homePaths, type HomePaths } from "./paths.js";
import { foldClears, type SessionWithOrigin } from "./sessionChain.js";
import { type RegistryEntry, SessionLinks } from "./sessionLinks.js";
import { factsFrom, previousSession, type TranscriptFacts } from "./transcript.js";
import type { ProjectInfo, SessionInfo } from "./types.js";

const TRANSCRIPT_EXT = ".jsonl";
const CUSTOM_TITLE_FILE = "custom-title.json";
const MEMORY_DIR = "memory";
const CUSTOM_TITLE_TYPE = "custom-title";
/** Lines of a transcript scanned for `cwd`; it is written near the top or not at all. */
const HEAD_LINES = 20;
/**
 * How much of a transcript is read to find that `cwd`.
 *
 * These files reach tens of megabytes — the largest here is 48 MB — and reading one whole just to
 * look at its first line is what made a scan take twenty seconds and the window go grey with it.
 */
const HEAD_BYTES = 64 * 1024;
/**
 * How much of the END of a transcript is read, to find the newest `ai-title`.
 *
 * Claude Code rewrites that title as the conversation grows, so the last one is the good one and it
 * sits near the end. Measured on a 139 KB session: 18 KB from the end. Half a megabyte is generous
 * for that and still nothing next to a 48 MB file. A title further back than this window is simply
 * not found, and the row falls back to the first prompt — which is what it showed before.
 */
const TAIL_BYTES = 512 * 1024;
/**
 * How far in to look for the id of the session a continuation carried on from.
 *
 * Measured at roughly 145 KB into the three pairs on this machine — the context attachments come
 * after everything Claude Code writes when a session opens. Only a transcript that already looks
 * like a continuation is read this far; an ordinary session stops at the 64 KB head.
 */
const LINK_BYTES = 256 * 1024;
/**
 * What a row says for a session with no name of any kind yet — the moment after /clear, before a
 * word has been typed. Claude Code's own default name for such a session, so the row reads like the
 * terminal rather than announcing that a field is empty.
 */
export const NO_NAME_YET = "Claude Code";

interface CacheEntry<T> { signature: string; value: T }

/** What a transcript says about itself, plus the session it carried on from (see LINK_BYTES). */
type Facts = TranscriptFacts & { carriedFrom: string | null };

/** The size and identity a transcript had when its cached facts were taken. */
type FileStat = { size: number; mtimeMs: number; ino?: number };

/**
 * A transcript's facts, and what lets the next read start where this one stopped.
 *
 * Past the head window a transcript only ever grows at the end, so its head facts are final and
 * the newest `ai-title` is the only answer left that can change: it is looked for in the bytes
 * appended since, not in a fresh half-megabyte tail on every scan of a running session.
 */
interface FactsEntry extends CacheEntry<Facts> {
  size: number;
  ino: number | undefined;
  /** Facts from the first HEAD_BYTES, taken once the file was longer than that — they cannot change. */
  head?: TranscriptFacts;
  /** The session this one carried on from, final once found or once LINK_BYTES had been read. */
  link?: { value: string | null; final: boolean };
  /** The tail window, scanned once and then extended by what was appended. */
  tail?: TailScan;
}

/** The newest `ai-title` line seen from `from` up to `end` (the end of the last complete line). */
interface TailScan { from: number; end: number; title: string | null; at: number }

/** The literal every `ai-title` line carries: lines without it are not worth a JSON.parse. */
const AI_TITLE_MARK = Buffer.from('"type":"ai-title"');
const NEWLINE = 0x0a;

/**
 * The newest `ai-title` in `bytes`, which start at file offset `base`.
 *
 * Only a line that parses counts — exactly as a whole-window parse would — and `end` is the offset
 * just past the last newline, so a line still being written is read again next time. A complete
 * line that is merely missing its newline still counts, as it would in a full parse.
 */
function scanTitles(bytes: Buffer, base: number): { title: string | null; at: number; end: number } {
  let title: string | null = null;
  let at = -1;
  let start = 0;
  while (start < bytes.length) {
    const newline = bytes.indexOf(NEWLINE, start);
    const stop = newline < 0 ? bytes.length : newline;
    const line = bytes.subarray(start, stop);
    if (line.includes(AI_TITLE_MARK)) {
      try {
        const entry = JSON.parse(line.toString("utf8")) as { type?: string; aiTitle?: string };
        if (entry.type === "ai-title" && entry.aiTitle?.trim()) {
          title = entry.aiTitle.trim();
          at = base + start;
        }
      } catch {
        /* the cut-off first line of a window, or one half-written right now */
      }
    }
    if (newline < 0) break;
    start = newline + 1;
  }
  const last = bytes.lastIndexOf(NEWLINE);
  return { title, at, end: base + last + 1 };
}

/** `length` bytes of a file from `position` — fewer if it is shorter, none if it cannot be read. */
function readBytes(file: string, position: number, length: number): Buffer {
  if (length <= 0) return Buffer.alloc(0);
  let handle: number | null = null;
  try {
    handle = openSync(file, "r");
    const buffer = Buffer.allocUnsafe(length);
    const read = readSync(handle, buffer, 0, length, position);
    return buffer.subarray(0, read);
  } catch {
    return Buffer.alloc(0);
  } finally {
    if (handle !== null) {
      try {
        closeSync(handle);
      } catch {
        /* already gone */
      }
    }
  }
}

/** The first `bytes` of a file as text, without reading (or decoding) the rest of it. */
function readHead(file: string, bytes: number): string {
  return readBytes(file, 0, bytes).toString("utf8");
}

/** How long a just-written folder's mtime is not trusted: two changes in one clock tick share it. */
const MTIME_SETTLE_MS = 2_000;
/**
 * How often a scan reads everything again instead of only what changed.
 *
 * The incremental scan trusts a folder's mtime for its list of files and re-stats only the running
 * sessions' transcripts. Anything that slips past that — a transcript written by something other
 * than a running session — is caught here, within three minutes.
 */
export const FULL_RESCAN_MS = 180_000;
/** A folder known unreachable is asked again this rarely: each probe holds a pool thread for the SMB timeout. */
export const UNREACHABLE_RECHECK_MS = 180_000;

/** What a project folder held at its last listing, and what was learnt about each transcript in it. */
interface FolderEntry {
  mtimeMs: number;
  transcripts: string[];
  /** Names of the per-session sub-directories — only those can hold a custom-title.json. */
  sidecars: Set<string>;
  hasMemory: boolean;
  stats: Map<string, Stats>;
  /** Custom title per session id, against the signature of its custom-title.json. */
  titles: Map<string, CacheEntry<string | null>>;
}

/** A transcript's session id is its file name. */
function idOf(file: string): string {
  return file.slice(file.lastIndexOf(sep()) + 1, -TRANSCRIPT_EXT.length);
}

export interface StoreOptions {
  /** Injected so tests can decide liveness without real processes. */
  isAlive?: (pid: number) => boolean;
  /** Injected so a dead network path cannot block a test. */
  folderExists?: (path: string) => boolean;
  /** Injected so a test can move the clock past FULL_RESCAN_MS. */
  now?: () => number;
}

export class Store {
  readonly paths: HomePaths;
  readonly config: ConfigStore;
  private readonly isAlive: (pid: number) => boolean;
  private readonly folderExists: (path: string) => boolean;
  private readonly now: () => number;
  private titles: CacheEntry<Map<string, string>> | null = null;
  /** Where the last read of history.jsonl stopped — it is only ever appended to. */
  private historyRead: { ino: number; end: number } | null = null;
  private cwds = new Map<string, CacheEntry<string | null>>();
  /** Per transcript, re-read when it grows — unlike the cwd, the title keeps changing. */
  private facts = new Map<string, FactsEntry>();
  /** Every session swap this app has watched happen — see core/sessionLinks.ts. */
  private readonly links: SessionLinks;
  /** Answers for `folderExists`, filled in by a background probe — see `folderReachable`. */
  private folders = new Map<string, { reachable: boolean; at: number }>();
  private probing = new Set<string>();
  /** Per project folder, what its last listing said — see `scan`. */
  private folderCache = new Map<string, FolderEntry>();
  /** `.claude.json`'s project paths, re-read only when the file changed: it is rewritten often and can be large. */
  private claudeJson: CacheEntry<Map<string, string>> | null = null;
  private lastFull = Number.NEGATIVE_INFINITY;
  /** Sessions that were running at the last scan: one that just ended may have written its last lines since. */
  private liveBefore = new Set<string>();
  /** Whether the last scan read everything again — the main side drops its own caches with it. */
  lastScanFull = false;

  constructor(home?: string, options: StoreOptions = {}) {
    this.paths = homePaths(home);
    this.config = new ConfigStore(home);
    this.isAlive = options.isAlive ?? defaultIsAlive;
    this.now = options.now ?? Date.now;
    this.links = new SessionLinks(this.paths.hangarChains);
    // The default is deliberately NOT existsSync: a project on an unreachable network share makes
    // it wait for the SMB timeout — measured at 10.9 s here, on the thread that draws the window.
    this.folderExists = options.folderExists ?? ((path) => this.folderReachable(path));
  }

  /** The registry Claude Code writes, one entry per running session. */
  private registry(): RegistryEntry[] {
    let files: string[] = [];
    try {
      files = readdirSync(this.paths.liveSessions);
    } catch {
      return [];
    }
    const entries: RegistryEntry[] = [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const data = readJson<{ sessionId?: string; pid?: number; procStart?: string; status?: string }>(
        join(this.paths.liveSessions, file), {});
      const pid = Number(data.pid);
      if (data.sessionId && Number.isFinite(pid)) {
        entries.push({ pid, sessionId: data.sessionId, procStart: data.procStart, status: data.status ?? null });
      }
    }
    return entries;
  }

  /**
   * Session ids with a living process behind them, and what each says it is doing.
   *
   * The status is Claude Code's own — "busy" while answering, "waiting" while it asks something,
   * "idle" once the turn is the person's — and it is what a row's mark is drawn from.
   */
  liveSessions(): Map<string, { pid: number; status: string | null }> {
    return this.liveFrom(this.registry());
  }

  private liveFrom(entries: RegistryEntry[]): Map<string, { pid: number; status: string | null }> {
    const live = new Map<string, { pid: number; status: string | null }>();
    for (const entry of entries) {
      if (this.isAlive(entry.pid)) live.set(entry.sessionId, { pid: entry.pid, status: entry.status ?? null });
    }
    return live;
  }

  /** What Claude Code last wrote about the session running as `pid` — "busy", "idle" — or nothing known. */
  sessionStatus(pid: number): string | null {
    const data = readJson<{ status?: string }>(join(this.paths.liveSessions, `${pid}.json`), {});
    return typeof data.status === "string" ? data.status : null;
  }

  /**
   * First prompt per session.
   *
   * history.jsonl is megabytes and only ever appended to, and every prompt typed anywhere grows it:
   * so only the bytes past the last read are parsed, onto a copy of what was known. A file that
   * shrank or was replaced (another inode) is read from the start again.
   */
  historyTitles(): Map<string, string> {
    let st: Stats | undefined;
    try {
      st = statSync(this.paths.history, { throwIfNoEntry: false });
    } catch {
      st = undefined;
    }
    const sig = st ? `${st.size}:${st.mtimeMs}` : "-";
    if (this.titles?.signature === sig) return this.titles.value;
    const before = this.historyRead;
    const grown = st && before && this.titles && before.ino === st.ino && st.size >= before.end;
    const titles = grown ? new Map(this.titles!.value) : new Map<string, string>();
    const from = grown ? before!.end : 0;
    const bytes = st ? readBytes(this.paths.history, from, st.size - from) : Buffer.alloc(0);
    for (const row of parseJsonl<{ sessionId?: string; display?: string }>(bytes.toString("utf8"))) {
      if (!row.sessionId || !row.display || titles.has(row.sessionId)) continue;
      titles.set(row.sessionId, row.display.trim().split("\n")[0] ?? "");
    }
    // Up to the last newline: a line still being written is parsed again once it is whole.
    this.historyRead = st ? { ino: st.ino, end: from + bytes.lastIndexOf(NEWLINE) + 1 } : null;
    this.titles = { signature: sig, value: titles };
    return titles;
  }

  /**
   * Real folder of a transcript.
   *
   * Cached by path with no signature on purpose: a session's cwd cannot change, so a transcript
   * that is being appended to right now — the one session that would otherwise be re-read on every
   * single scan — is read exactly once.
   */
  transcriptCwd(file: string): string | null {
    const hit = this.cwds.get(file);
    if (hit) return hit.value;
    let cwd: string | null = null;
    for (const row of parseJsonl<{ cwd?: string }>(readHead(file, HEAD_BYTES), HEAD_LINES)) {
      if (row.cwd) { cwd = row.cwd; break; }
    }
    this.cwds.set(file, { signature: "", value: cwd });
    return cwd;
  }

  /**
   * The title and the first real prompt, read from the transcript rather than from `history.jsonl`.
   *
   * Two bounded reads — the start for the prompt, the end for the newest `ai-title` — cached
   * against size and mtime, so a session being appended to is re-read only when it actually grows.
   * Once it is past the head window, a growing transcript costs only its new bytes (see FactsEntry).
   */
  transcriptFacts(file: string, st: FileStat): Facts {
    const sig = `${st.size}:${st.mtimeMs}`;
    const hit = this.facts.get(file);
    if (hit?.signature === sig) return hit.value;
    if (st.size <= HEAD_BYTES) {
      // Small enough to read whole, and it may still be changing anything: no shortcuts.
      const head = readHead(file, HEAD_BYTES);
      const facts = factsFrom(head, "", true);
      const carriedFrom = facts.startedByClear || facts.carriedTitle !== null ? previousSession(head, idOf(file)) : null;
      const value = { ...facts, carriedFrom };
      this.facts.set(file, { signature: sig, value, size: st.size, ino: st.ino });
      return value;
    }

    // Append-only from here on; a file that shrank or is another file starts over.
    const same = hit !== undefined && hit.ino === st.ino && st.size >= hit.size;
    const head = (same && hit.head) || factsFrom(readHead(file, HEAD_BYTES), "", false);
    // Only a transcript that already looks like a continuation earns the deeper read. The first id in
    // the link window never changes once it is there, and nothing new can enter a full window.
    let link = same ? hit.link : undefined;
    if ((head.startedByClear || head.carriedTitle !== null) && !link?.final) {
      const value = previousSession(readHead(file, LINK_BYTES), idOf(file));
      link = { value, final: value !== null || st.size >= LINK_BYTES };
    }

    // The tail window is the last TAIL_BYTES, or the whole file while it is shorter than that. It
    // used to be empty below TAIL_BYTES, so a session between 64 KB and 512 KB never saw a title
    // written after its first 64 KB and kept showing its first one.
    const from = Math.max(0, st.size - TAIL_BYTES);
    let tail = same ? hit.tail : undefined;
    if (!tail || tail.from > from || tail.end > st.size) {
      const found = scanTitles(readBytes(file, from, st.size - from), from);
      tail = { from, ...found };
    } else if (st.size > tail.end) {
      const found = scanTitles(readBytes(file, tail.end, st.size - tail.end), tail.end);
      tail = { from: tail.from, end: found.end, title: found.title ?? tail.title, at: found.title ? found.at : tail.at };
    }
    // A title that has scrolled out of the window is no longer seen, as with a fresh window read.
    const tailTitle = tail.at >= from ? tail.title : null;
    const value = { ...head, aiTitle: tailTitle ?? head.aiTitle, carriedFrom: link?.value ?? null };
    this.facts.set(file, { signature: sig, value, size: st.size, ino: st.ino, head, link, tail });
    return value;
  }

  /**
   * Whether a folder is there, answered from the last background probe.
   *
   * A local path answers on the first probe, microseconds later. A dead UNC path takes its ten
   * seconds on a worker thread, where nobody is waiting: until it answers the folder is reported as
   * present, which is the harmless guess — the row simply is not greyed out yet.
   */
  private folderReachable(path: string): boolean {
    const known = this.folders.get(path);
    // An unreachable answer is kept for a while: every probe of a dead share sits on one of libuv's
    // four pool threads for the SMB timeout, where it delays every other file operation in the app.
    const settled = known && !known.reachable && this.now() - known.at < UNREACHABLE_RECHECK_MS;
    if (!settled && !this.probing.has(path)) {
      this.probing.add(path);
      void access(path)
        .then(() => this.folders.set(path, { reachable: true, at: this.now() }))
        .catch(() => this.folders.set(path, { reachable: false, at: this.now() }))
        .finally(() => this.probing.delete(path));
    }
    return known?.reachable ?? true;
  }

  /** Folders known to Claude Code, keyed by their encoded name — the fallback for empty projects. */
  knownPaths(): Map<string, string> {
    const sig = fileSignature(this.paths.claudeJson);
    let fromClaude = this.claudeJson?.signature === sig && sig !== null ? this.claudeJson.value : null;
    if (!fromClaude) {
      const data = readJson<{ projects?: Record<string, unknown> }>(this.paths.claudeJson, {});
      fromClaude = new Map<string, string>();
      for (const path of Object.keys(data.projects ?? {})) {
        const encoded = encodeProjectPath(path);
        if (!fromClaude.has(encoded)) fromClaude.set(encoded, path);
      }
      this.claudeJson = sig === null ? null : { signature: sig, value: fromClaude };
    }
    const known = new Map(fromClaude);
    // A folder added by hand has neither a transcript nor a .claude.json entry yet.
    for (const [dir, path] of Object.entries(this.config.addedProjects())) {
      if (!known.has(dir)) known.set(dir, path);
    }
    return known;
  }

  customTitle(dir: string, sessionId: string): string | null {
    const data = readJson<{ customTitle?: string }>(join(dir, sessionId, CUSTOM_TITLE_FILE), {});
    return data.customTitle || null;
  }

  /**
   * A session's custom title, from the folder's listing rather than a blind open per session.
   *
   * Only a session with a directory of its own can have a custom-title.json, and only a running one
   * (or one a full scan is re-checking) can have had it changed since the last look — and then a
   * stat says whether it did.
   */
  private titleIn(folder: FolderEntry, dir: string, id: string, recheck: boolean): string | null {
    if (!folder.sidecars.has(id)) {
      folder.titles.delete(id);
      return null;
    }
    const hit = folder.titles.get(id);
    if (hit && !recheck) return hit.value;
    const sig = fileSignature(join(dir, id, CUSTOM_TITLE_FILE));
    if (hit && sig !== null && hit.signature === sig) return hit.value;
    const value = sig === "-" ? null : this.customTitle(dir, id);
    folder.titles.set(id, { signature: sig ?? "", value });
    return value;
  }

  /**
   * Note who is running what, so a session replaced by /clear can be folded under its successor.
   *
   * Called on a timer of its own, not only from a scan: the list is re-read when the page asks, and
   * a page in a minimised or covered window is throttled by Chromium — a clear during a quiet hour
   * would be seen too late, or between two swaps, and the pair would never be linked.
   */
  watchRegistry(): void {
    this.links.observe(this.registry());
  }

  /**
   * Every project, newest use first.
   *
   * Incremental, because it runs every fifteen seconds all day: a folder whose mtime has not moved
   * keeps its last listing (a file added, removed or renamed in it moves the mtime), and of its
   * transcripts only the running sessions' — and those running at the last scan, which may have
   * written their last lines since — are stat'ed again. Every FULL_RESCAN_MS everything is read
   * again, which also drops what the caches hold for transcripts that are gone.
   */
  scan(): ProjectInfo[] {
    const now = this.now();
    const full = now - this.lastFull >= FULL_RESCAN_MS;
    // One read of the registry serves both the swap watch and the live marks.
    const entries = this.registry();
    this.links.observe(entries);
    const live = this.liveFrom(entries);
    const titles = this.historyTitles();
    const known = this.knownPaths();
    const aliases = this.config.aliases();
    const pins = this.config.pins();
    let dirs: string[] = [];
    try {
      dirs = readdirSync(this.paths.projects, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }
    const replaced = this.links.map();
    const growing = new Set([...live.keys(), ...this.liveBefore]);
    const seen = full ? new Set<string>() : null;
    const pass = { now, full, growing, seen };
    const projects = dirs.map((name) => this.readProject(name, live, titles, known, aliases, pins, replaced, pass));
    const listed = new Set(dirs);
    for (const name of this.folderCache.keys()) if (!listed.has(name)) this.folderCache.delete(name);
    this.liveBefore = new Set(live.keys());
    this.lastScanFull = full;
    if (seen) {
      this.lastFull = now;
      // Whatever the caches hold for a transcript or folder this scan did not meet is gone for good.
      for (const file of this.cwds.keys()) if (!seen.has(file)) this.cwds.delete(file);
      for (const file of this.facts.keys()) if (!seen.has(file)) this.facts.delete(file);
      for (const path of this.folders.keys()) if (!seen.has(path)) this.folders.delete(path);
    }
    // Pinned rows first, then newest use first — a pin is the user overruling the clock.
    return projects.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.lastUsed - a.lastUsed);
  }

  /** A project folder's listing: the cached one while its mtime stands, else read again. */
  private listing(dirName: string, dir: string, mtimeMs: number, now: number, full: boolean): { folder: FolderEntry; fresh: boolean } {
    const cached = this.folderCache.get(dirName);
    // A folder changed within the last moment is listed again: a second change in the same clock
    // tick would leave its mtime where it was.
    if (cached && !full && cached.mtimeMs === mtimeMs && now - mtimeMs >= MTIME_SETTLE_MS) return { folder: cached, fresh: false };
    const entries = readdirSync(dir, { withFileTypes: true });
    const folder: FolderEntry = {
      mtimeMs,
      transcripts: entries.filter((e) => e.isFile() && e.name.endsWith(TRANSCRIPT_EXT)).map((e) => e.name),
      sidecars: new Set(entries.filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => e.name)),
      hasMemory: entries.some((e) => e.name === MEMORY_DIR),
      stats: cached?.stats ?? new Map(),
      titles: cached?.titles ?? new Map(),
    };
    const ids = new Set(folder.transcripts.map((name) => name.slice(0, -TRANSCRIPT_EXT.length)));
    for (const id of folder.titles.keys()) if (!ids.has(id)) folder.titles.delete(id);
    this.folderCache.set(dirName, folder);
    return { folder, fresh: true };
  }

  private readProject(
    dirName: string,
    live: Map<string, { pid: number; status: string | null }>,
    titles: Map<string, string>,
    known: Map<string, string>,
    aliases: Record<string, string>,
    pins: { projects: string[]; sessions: string[] },
    replaced: Map<string, string>,
    pass: { now: number; full: boolean; growing: Set<string>; seen: Set<string> | null },
  ): ProjectInfo {
    const dir = join(this.paths.projects, dirName);
    // Before the listing: a change landing between the two moves the mtime past what is cached.
    const dirMtime = statSync(dir).mtimeMs;
    const { folder, fresh } = this.listing(dirName, dir, dirMtime, pass.now, pass.full);
    // Stat once per file and sort on that: comparing with statSync() inside the comparator asks
    // the filesystem O(n log n) times for numbers that do not change during a scan.
    const stats: { file: string; stat: Stats }[] = [];
    const statted = new Map<string, Stats>();
    for (const name of folder.transcripts) {
      const file = join(dir, name);
      let stat = fresh || pass.growing.has(idOf(file)) ? undefined : folder.stats.get(file);
      if (!stat) {
        try {
          stat = statSync(file);
        } catch {
          continue;                               // gone since the listing; the next one will not list it
        }
      }
      statted.set(file, stat);
      stats.push({ file, stat });
      pass.seen?.add(file);
    }
    folder.stats = statted;
    stats.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
    const files = stats.map((entry) => entry.file);

    let cwd: string | null = null;
    for (const file of files) {
      cwd = this.transcriptCwd(file);
      if (cwd) break;
    }
    cwd = cwd ?? known.get(dirName) ?? null;

    const transcripts: SessionWithOrigin[] = stats.flatMap(({ file, stat: st }) => {
      const facts = this.transcriptFacts(file, st);
      // Not a session anyone can open: a few hundred bytes holding a title and no conversation.
      // Claude Code leaves one behind whenever the talking ends up in a different file.
      if (!facts.conversation) return [];
      const id = idOf(file);
      const custom = this.titleIn(folder, dir, id, fresh || pass.growing.has(id));
      // The history file is the last resort now, not the first: it is not reliably per-session.
      const prompt = facts.firstPrompt || titles.get(id) || "";
      return [{
        id,
        file,
        // A name the user chose wins; then the one Claude Code wrote, which is what its own tab
        // and /resume picker show; then the name it was handed when the conversation moved into
        // this file, which is what its tab says until it has thought of its own; then the question
        // that started it.
        title: custom || facts.aiTitle || facts.carriedTitle || prompt || NO_NAME_YET,
        named: Boolean(custom),
        prompt,
        startedAt: st.birthtimeMs || st.ctimeMs,
        modifiedAt: st.mtimeMs,
        bytes: st.size,
        live: live.has(id),
        pid: live.get(id)?.pid ?? null,
        status: live.get(id)?.status ?? null,
        pinned: pins.sessions.includes(id),
        folded: [],
        continues: 0,
        startedByClear: facts.startedByClear,
        carriedTitle: facts.carriedTitle,
        carriedFrom: facts.carriedFrom,
      }];
    });
    // A conversation /clear split into several transcripts is one row (core/sessionChain.ts).
    const sessions: SessionInfo[] = foldClears(transcripts, replaced)
      .sort((a, b) => Number(b.pinned) - Number(a.pinned));   // stable: newest first within each group

    if (cwd) pass.seen?.add(cwd);
    const alias = (cwd && aliases[cwd]) || aliases[dirName] || null;
    return {
      dir: dirName,
      cwd,
      alias,
      name: alias || (cwd ? baseName(cwd) : dirName),
      sessions,
      hasMemory: folder.hasMemory,
      exists: cwd ? this.folderExists(cwd) : false,
      lastUsed: sessions.length ? Math.max(...sessions.map((s) => s.modifiedAt)) : dirMtime,
      totalBytes: sessions.reduce((sum, s) => sum + s.bytes, 0),
      liveCount: sessions.filter((s) => s.live).length,
      pinned: pins.projects.includes(dirName),
      // Filled in by the main process, which is where reading a working tree belongs.
      git: null,
      worktree: false,
      mainRepo: null,
      parentDir: null,
    };
  }

  /**
   * Give a session a title, exactly the way Claude Code's own `/rename` does — the sidecar file it
   * reads plus the transcript line it appends — so the new name also shows up in `/resume`.
   */
  renameSession(session: SessionInfo, title: string): void {
    const dir = session.file.slice(0, session.file.lastIndexOf(sep()));
    writeJson(join(dir, session.id, CUSTOM_TITLE_FILE), { customTitle: title });
    const line = JSON.stringify({ type: CUSTOM_TITLE_TYPE, customTitle: title, sessionId: session.id });
    // Only the last byte decides whether a newline is owed — not a read of the whole transcript.
    let size = 0;
    try {
      size = statSync(session.file).size;
    } catch {
      /* not there yet: appending creates it, with nothing to separate from */
    }
    const last = readBytes(session.file, Math.max(0, size - 1), 1);
    appendFileSync(session.file, `${!last.length || last[0] === NEWLINE ? "" : "\n"}${line}\n`, "utf8");
    // The sidecar may have changed without the folder's mtime moving; the next scan looks again.
    this.folderCache.delete(dir.slice(dir.lastIndexOf(sep()) + 1));
  }

  /** Display alias for a project; an empty name clears it. */
  renameProject(project: ProjectInfo, alias: string): void {
    const aliases = this.config.aliases();
    const key = project.cwd ?? project.dir;
    if (alias) aliases[key] = alias;
    else delete aliases[key];
    this.config.saveAliases(aliases);
  }

  /**
   * A folder that has never had a session, made into a project.
   *
   * Claude Code creates a project's directory the first time it writes a transcript there; this
   * makes the same directory ahead of time, so the folder is in the list and a session can be
   * started from it instead of from a terminal. Once one has run, the transcript's cwd takes over.
   */
  addProject(cwd: string): string {
    const dir = encodeProjectPath(cwd);
    mkdirSync(join(this.paths.projects, dir), { recursive: true });
    this.config.saveAddedProject(dir, cwd);
    return dir;
  }

  /**
   * Delete a session — and the earlier transcripts folded under it.
   *
   * A row that says "continues 2" IS those three transcripts: deleting only the newest left the
   * older ones to reappear as rows of their own, which is not what "delete this session" means.
   */
  deleteSession(session: SessionInfo): void {
    const dir = session.file.slice(0, session.file.lastIndexOf(sep()));
    for (const id of [...session.folded, session.id]) {
      try { unlinkSync(join(dir, `${id}${TRANSCRIPT_EXT}`)); } catch { /* already gone */ }
      rmSync(join(dir, id), { recursive: true, force: true });
    }
  }

  deleteProject(project: ProjectInfo): void {
    rmSync(join(this.paths.projects, project.dir), { recursive: true, force: true });
  }
}

function sep(): string {
  return process.platform === "win32" ? "\\" : "/";
}

function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  return cut >= 0 ? trimmed.slice(cut + 1) || trimmed : trimmed;
}

/** A pid that no longer exists is not live; signal 0 asks without touching the process. */
function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";   // exists, owned by someone else
  }
}

/**
 * One short string that changes whenever anything in the list does — what the page passes back so
 * an unchanged list need not cross the process boundary again.
 */
export function scanSignature(projects: ProjectInfo[]): string {
  return createHash("sha1").update(JSON.stringify(projects)).digest("base64");
}

/**
 * A file name for a pasted image: sortable, unique, and readable in a terminal.
 *
 * Seconds are not enough — two screenshots in the same second are normal — so the name carries
 * milliseconds rather than a counter that would have to be remembered between runs.
 */
export function clipFileName(at = new Date()): string {
  const pad = (value: number, width = 2): string => String(value).padStart(width, "0");
  return `clip-${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}`
    + `-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`
    + `-${pad(at.getMilliseconds(), 3)}.png`;
}
