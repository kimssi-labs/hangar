/**
 * Which programs this machine has.
 *
 * `where`/`which` costs a process each time, started synchronously on the thread that draws the
 * window, and the answer does not change while the app is open — so it is remembered for the run:
 * without that, opening one session ran the lookup up to three times, and the settings answer asked
 * about git every time it was built.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

import { CLAUDE_EXE, LINUX_TERMINALS } from "../core/launcher.js";

/** How long "not on PATH" is believed: installing git or claude while the app is open shows up within it. */
const MISSING_TTL_MS = 60_000;
const located = new Map<string, { path: string | null; at: number }>();

/**
 * The full path of `exe` if it is on PATH, else null. A path found is kept while the file is still
 * there; an answer of "missing" for a minute.
 */
export function which(exe: string): string | null {
  const known = located.get(exe);
  if (known?.path && existsSync(known.path)) return known.path;
  if (known && !known.path && Date.now() - known.at < MISSING_TTL_MS) return null;
  let path: string | null = null;
  try {
    // Windowless: `where.exe` is a console program, and this is not a console process.
    const out = execFileSync(process.platform === "win32" ? "where" : "which", [exe],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    path = out.split(/\r?\n/).find((line) => line.trim())?.trim() ?? null;
  } catch {
    /* not on PATH */
  }
  located.set(exe, { path, at: Date.now() });
  return path;
}

/** Resolve the claude executable, never the bare name: a shell function of that name would win. */
export function claudeExecutable(): string | null {
  return which(CLAUDE_EXE);
}

/** The terminal configured, or the first known one this machine has. */
export function detectLinuxTerminal(configured: string): { exe: string; args: readonly string[] } | null {
  if (configured) return { exe: configured, args: [] };
  for (const candidate of LINUX_TERMINALS) if (which(candidate.exe)) return candidate;
  return null;
}
