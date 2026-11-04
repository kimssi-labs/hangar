/**
 * Reading and writing the JSON (and JSON Lines) the app and Claude Code keep — one way, so every
 * reader agrees.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * What a rename onto a file that someone else holds open fails with on Windows. A virus or DLP
 * scanner that opened the file without sharing delete blocks a rename onto it, but not a write into
 * it, which is what these saves did before they became atomic.
 */
const TARGET_BUSY = new Set(["EPERM", "EBUSY", "EACCES"]);
/** Tries at the rename before writing in place; the scanner usually lets go within a few ms. */
const RENAME_TRIES = 3;
const RENAME_RETRY_MS = 20;

/** A short synchronous pause, for a save that has to finish before its caller goes on. */
function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * The parsed contents of `file`, or `fallback` when it is absent, empty, not JSON or JSON `null`.
 *
 * A BOM is stripped first: PowerShell's `-Encoding utf8` and plenty of Windows editors write one,
 * JSON.parse throws on it, and the throw would read as "no settings yet" or "no projects known"
 * rather than as the encoding accident it is.
 */
export function readJson<T>(file: string, fallback: T): T {
  try {
    return (JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, "")) as T | null) ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * `value` as JSON in `file`: written beside it first and renamed over it, so a reader never catches
 * a half-written file. `indent` is for a file a person may edit. Throws when it cannot be written.
 *
 * When the rename keeps failing because the file is held open by someone else, it is written in
 * place instead: a save that is not atomic beats a save that is lost.
 */
export function writeJson(file: string, value: unknown, indent = 0): void {
  mkdirSync(dirname(file), { recursive: true });
  const text = indent ? `${JSON.stringify(value, null, indent)}\n` : JSON.stringify(value);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text, "utf8");
  for (let attempt = 1; ; attempt += 1) {
    try {
      renameSync(tmp, file);
      return;
    } catch (error) {
      const busy = TARGET_BUSY.has((error as NodeJS.ErrnoException).code ?? "");
      if (busy && attempt < RENAME_TRIES) {
        pause(RENAME_RETRY_MS);
        continue;
      }
      rmSync(tmp, { force: true });
      if (!busy) throw error;
      writeFileSync(file, text, "utf8");
      return;
    }
  }
}

/**
 * The objects in JSON Lines `text`, at most `limit` of them. A blank line, one a byte window cut in
 * half, one still being written and one that is not an object are passed over, never fatal.
 */
export function parseJsonl<T = Record<string, unknown>>(text: string, limit = Infinity): T[] {
  const out: T[] = [];
  for (const line of text.split("\n")) {
    if (out.length >= limit) break;
    if (!line.trim()) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (value && typeof value === "object") out.push(value as T);
    } catch {
      /* cut off, or not finished yet: read again once it is whole */
    }
  }
  return out;
}
