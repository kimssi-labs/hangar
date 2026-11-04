/**
 * The small C# programs the app builds on first use and then runs directly — the focus helper
 * (liveSession.ts) and the desktop-icon helper (deskIcons.ts).
 *
 * Built with the compiler every Windows has, the one behind PowerShell's Add-Type, which is only
 * ever run for the build and never for the work. A helper's file is named by its source's hash, so a
 * changed source is a new build, and nothing has to be found on disk or unpacked from the archive.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";

import { psQuote } from "../core/launcher.js";

const COMPILE_TIMEOUT_MS = 60_000;

/** A C# helper: its source, a name for its file, and the assemblies it needs beyond mscorlib. */
export interface HelperSpec {
  source: string;
  kind: string;
  references: string;
}

/** Where the helpers are built and kept: in the app's own profile, read when asked, not at load. */
export function helpersDir(): string {
  return join(app.getPath("userData"), "helpers");
}

/** The helper's file name carries its source's hash, so a change in the source is a new build. */
export function helperName(source: string, kind: string): string {
  return `hangar-${kind}-${createHash("sha1").update(source).digest("hex").slice(0, 12)}.exe`;
}

/** Builds in flight, by file name, so two callers asking at once share one compiler run. */
const building = new Map<string, Promise<string | null>>();

/** The compiled helper under `cacheDir`, built on first use; null when it would not build. */
export function helperExecutable(cacheDir: string, spec: HelperSpec): Promise<string | null> {
  const name = helperName(spec.source, spec.kind);
  const exe = join(cacheDir, name);
  if (existsSync(exe)) return Promise.resolve(exe);
  const inFlight = building.get(name);
  if (inFlight) return inFlight;
  const build = new Promise<string | null>((resolve) => {
    try {
      mkdirSync(cacheDir, { recursive: true });
      const source = exe.replace(/\.exe$/, ".cs");
      writeFileSync(source, spec.source);
      const command = `Add-Type -Path ${psQuote(source)} -OutputAssembly ${psQuote(exe)} -OutputType ConsoleApplication -ReferencedAssemblies ${spec.references}`;
      execFile(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", command],
        { windowsHide: true, timeout: COMPILE_TIMEOUT_MS },
        (error, _stdout, stderr) => {
          if (error || !existsSync(exe)) {
            console.error(`[hangar] the ${spec.kind} helper did not build:`, String(stderr || error?.message || "").trim().slice(0, 300));
            resolve(null);
          } else {
            resolve(exe);
          }
        },
      );
    } catch (error) {
      console.error(`[hangar] the ${spec.kind} helper did not build:`, (error as Error).message);
      resolve(null);
    }
  }).finally(() => {
    building.delete(name);
  });
  building.set(name, build);
  return build;
}
