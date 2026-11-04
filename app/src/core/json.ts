/**
 * Reading the JSON files the app and Claude Code keep — one way, so every reader agrees.
 */
import { readFileSync } from "node:fs";

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
