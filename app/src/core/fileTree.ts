/**
 * The project's folder, as the panel draws it: what is in one directory, and what git says about it.
 *
 * Reading a directory is main's job; the decisions are here so they can be tested — the order rows
 * appear in, the cap that keeps a folder of ten thousand files from becoming ten thousand rows, and
 * the translation of `git status --porcelain` into a mark per path.
 *
 * Only the read side. Nothing here creates, renames or deletes: this app opens sessions, and a file
 * tree that edits files is an editor someone would then expect to behave like one.
 */

/** What git says about a path, in the four kinds a row can show. */
export type FileStatus = "conflicted" | "staged" | "modified" | "untracked";

export interface DirEntry {
  name: string;
  /** Path from the project's root, with "/" separators — the spelling git uses. */
  path: string;
  directory: boolean;
  /** Git's verdict: a file's own, or for a directory the worst of anything inside it. */
  status: FileStatus | null;
}

export interface DirListing {
  /** The directory that was read, from the project's root; "" is the root itself. */
  dir: string;
  entries: DirEntry[];
  /** How many entries the cap left out. */
  hidden: number;
  /** Why nothing could be read, when that is the answer. */
  error?: string;
}

/**
 * Most entries one directory may contribute.
 *
 * A cap rather than a virtual list: `node_modules` has tens of thousands of entries and no one
 * reads past the first screen of them. The count that was left out is shown, so the number is not
 * quietly wrong.
 */
export const ENTRY_CAP = 500;

/** Never listed: the repository's own database is not part of anyone's project. */
export const SKIPPED = new Set([".git"]);

/** Worst first — a conflict outranks a staged change, which outranks an edit, which outranks a new file. */
const SEVERITY: FileStatus[] = ["conflicted", "staged", "modified", "untracked"];

/**
 * Directories first, then by name the way a person reads numbers: 9, 99, 100 — not 100, 9, 99.
 *
 * `Intl.Collator` with `numeric` does it and is in the platform; the alternative is a hand-rolled
 * chunked comparison that gets Korean, accents and case wrong in ways nobody notices until they do.
 */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function compareEntries(a: DirEntry, b: DirEntry): number {
  if (a.directory !== b.directory) return a.directory ? -1 : 1;
  return collator.compare(a.name, b.name);
}

export function sortEntries(entries: DirEntry[]): DirEntry[] {
  return [...entries].sort(compareEntries);
}

/** The first `cap` entries, and how many were left behind. */
export function capEntries(entries: DirEntry[], cap = ENTRY_CAP): { entries: DirEntry[]; hidden: number } {
  return entries.length <= cap
    ? { entries, hidden: 0 }
    : { entries: entries.slice(0, cap), hidden: entries.length - cap };
}

/** The more serious of two verdicts, either of which may be absent. */
export function worseOf(a: FileStatus | null, b: FileStatus | null): FileStatus | null {
  if (!a) return b;
  if (!b) return a;
  return SEVERITY.indexOf(a) <= SEVERITY.indexOf(b) ? a : b;
}

/** One porcelain line's two letters, as the mark a row shows. */
export function statusOf(index: string, work: string): FileStatus | null {
  if (index === "?" && work === "?") return "untracked";
  if (index === "!" && work === "!") return null;             // ignored: nothing to say about it
  if (index === "U" || work === "U" || (index === "A" && work === "A") || (index === "D" && work === "D")) {
    return "conflicted";
  }
  if (work !== " " && work !== "") return "modified";
  if (index !== " " && index !== "") return "staged";
  return null;
}

/** A path as porcelain wrote it: quoted when it has anything unusual in it, with C-style escapes. */
function unquote(path: string): string {
  if (!path.startsWith('"') || !path.endsWith('"')) return path;
  const inner = path.slice(1, -1);
  return inner.replace(/\\(.)/g, (_, c: string) => (c === "n" ? "\n" : c === "t" ? "\t" : c));
}

/**
 * `git status --porcelain` as a verdict per path.
 *
 * A rename is written `R  old -> new`; the new name is the one on disk, so that is the one marked.
 * Paths arrive relative to the repository root with "/" separators on every platform.
 */
export function parsePorcelain(text: string): Map<string, FileStatus> {
  const out = new Map<string, FileStatus>();
  for (const line of text.split("\n")) {
    if (line.length < 4) continue;
    const status = statusOf(line[0] ?? " ", line[1] ?? " ");
    if (!status) continue;
    let path = line.slice(3);
    const arrow = path.indexOf(" -> ");
    if (arrow >= 0) path = path.slice(arrow + 4);
    out.set(unquote(path.trim()), status);
  }
  return out;
}

/**
 * What a directory row should show: the worst verdict on anything beneath it.
 *
 * A folder with an edited file inside is worth marking — otherwise a change three levels down is
 * invisible until someone happens to expand the right folders.
 */
export function statusOfDirectory(dir: string, statuses: Map<string, FileStatus>): FileStatus | null {
  const prefix = `${dir}/`;
  let worst: FileStatus | null = null;
  for (const [path, status] of statuses) {
    if (path.startsWith(prefix)) worst = worseOf(worst, status);
    if (worst === SEVERITY[0]) break;            // nothing outranks a conflict; stop looking
  }
  return worst;
}

/** Every changed path, worst first and then by name — what a panel too narrow for a tree shows. */
export function changedPaths(statuses: Map<string, FileStatus>, cap = ENTRY_CAP): {
  items: { path: string; status: FileStatus }[];
  hidden: number;
} {
  const items = [...statuses].map(([path, status]) => ({ path, status }));
  items.sort((a, b) => {
    const bySeverity = SEVERITY.indexOf(a.status) - SEVERITY.indexOf(b.status);
    return bySeverity !== 0 ? bySeverity : collator.compare(a.path, b.path);
  });
  return items.length <= cap
    ? { items, hidden: 0 }
    : { items: items.slice(0, cap), hidden: items.length - cap };
}

/**
 * `dir` joined to `name` the way the panel spells paths — "/" throughout, no leading slash.
 *
 * The renderer keys expanded folders by this string and hands it back to main, so it has to be the
 * same on Windows as anywhere else.
 */
export function childPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

/** A path the panel may ask for: inside the project, no climbing out of it. */
export function isInsideProject(dir: string): boolean {
  if (dir === "") return true;
  if (dir.startsWith("/") || dir.startsWith("\\") || /^[A-Za-z]:/.test(dir)) return false;
  return !dir.split(/[/\\]/).includes("..");
}
