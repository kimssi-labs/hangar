/**
 * Reading and writing the JSON (and JSON Lines) the app and Claude Code keep — one way, so every
 * reader agrees.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

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
 */
export function writeJson(file: string, value: unknown, indent = 0): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, indent ? `${JSON.stringify(value, null, indent)}\n` : JSON.stringify(value), "utf8");
  renameSync(tmp, file);
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
