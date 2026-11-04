/**
 * Which programs this machine has.
 *
 * `where`/`which` costs a process each time and the answer does not change while the app is open,
 * so what the launcher asks about repeatedly is remembered for the run — without that, opening one
 * session ran the lookup up to three times.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

import { CLAUDE_EXE, LINUX_TERMINALS } from "../core/launcher.js";

/** The full path of `exe` if it is on PATH, else null. Never cached: callers that care do that. */
export function which(exe: string): string | null {
  const command = process.platform === "win32" ? "where" : "which";
  try {
    const out = execFileSync(command, [exe], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const first = out.split(/\r?\n/).find((line) => line.trim());
    return first ? first.trim() : null;
  } catch {
    return null;
  }
}

/** How long "not on PATH" is believed: installing git or claude while the app is open shows up within it. */
const MISSING_TTL_MS = 60_000;
const located = new Map<string, { path: string | null; at: number }>();

/**
 * `which`, remembered: `where` is a process started synchronously on the thread that draws the
 * window, and the settings answer alone asked it about git every time it was built.
 *
 * A path found is kept while the file is still there; an answer of "missing" for a minute.
 */
export function cachedWhich(exe: string): string | null {
  const known = located.get(exe);
  if (known?.path && existsSync(known.path)) return known.path;
  if (known && !known.path && Date.now() - known.at < MISSING_TTL_MS) return null;
  const path = which(exe);
  located.set(exe, { path, at: Date.now() });
  return path;
}

const presence = new Map<string, boolean>();

/** Whether `exe` is on PATH, remembered for the life of the run. */
export function haveExecutable(exe: string): boolean {
  const known = presence.get(exe);
  if (known !== undefined) return known;
  const found = Boolean(which(exe));
  presence.set(exe, found);
  return found;
}

/** Resolve the claude executable, never the bare name: a shell function of that name would win. */
export function claudeExecutable(): string | null {
  return cachedWhich(CLAUDE_EXE);
}

/** The terminal configured, or the first known one this machine has. */
export function detectLinuxTerminal(configured: string): { exe: string; args: readonly string[] } | null {
  if (configured) return { exe: configured, args: [] };
  for (const candidate of LINUX_TERMINALS) if (which(candidate.exe)) return candidate;
  return null;
}
