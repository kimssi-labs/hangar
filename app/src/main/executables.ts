/**
 * Which programs this machine has.
 *
 * Looked up the way `where` / `which` do, but by reading PATH here instead of starting them: a
 * process start blocks the thread that draws the window until the OS has made it, measured at
 * 0.6 s for one `where git` on a machine whose endpoint agent inspects every process start. The
 * answer does not change while the app is open, so it is remembered for the run as well.
 */
import { accessSync, constants, lstatSync } from "node:fs";
import { delimiter, join } from "node:path";

import { CLAUDE_EXE, LINUX_TERMINALS } from "../core/launcher.js";

/** How long "not on PATH" is believed: installing git or claude while the app is open shows up within it. */
const MISSING_TTL_MS = 60_000;
const located = new Map<string, { path: string | null; at: number }>();

/**
 * Whether a program is at this path. `lstat`, not `existsSync`: a Store app's alias such as
 * `WindowsApps\wt.exe` is a reparse point that `existsSync` and `stat` report as missing.
 */
function present(path: string): boolean {
  try {
    // No throw for the common answer, "not here": PATH times PATHEXT is hundreds of misses a lookup.
    const found = lstatSync(path, { throwIfNoEntry: false });
    if (!found || found.isDirectory()) return false;
    if (process.platform !== "win32") accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The first match on PATH, in `where`'s order: directory by directory, the name as written and then
 * with each PATHEXT extension.
 */
export function lookPath(exe: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const extensions = process.platform === "win32"
    ? ["", ...(env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map((e) => e.toLowerCase())]
    : [""];
  for (const dir of (env["PATH"] ?? "").split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(dir, exe + extension);
      if (present(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * The full path of `exe` if it is on PATH, else null. A path found is kept while the file is still
 * there; an answer of "missing" for a minute.
 */
export function which(exe: string): string | null {
  const known = located.get(exe);
  if (known?.path && present(known.path)) return known.path;
  if (known && !known.path && Date.now() - known.at < MISSING_TTL_MS) return null;
  const path = lookPath(exe);
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
