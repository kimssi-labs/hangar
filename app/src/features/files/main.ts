/**
 * The project's folder — the main side.
 *
 * One directory per request, never a recursive walk: a project is someone's whole source tree, and
 * the panel only ever draws what is expanded. The order, the cap and git's verdict per path are
 * core's (core/fileTree.ts); what is here is the read itself and the guard around it.
 *
 * Asynchronous on purpose. `readdirSync` on a project that lives on a network share blocks this
 * process, and this process is the one drawing the window — measured elsewhere in this app at
 * 10.9 s for an unreachable share (core/store.ts says the same about existsSync).
 */
import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { resolve, sep } from "node:path";

import type { Wire } from "../../bridge/build.js";
import {
  capEntries, changedPaths as sortChanged, childPath, type DirEntry, type DirListing,
  type FileStatus, isInsideProject, SKIPPED, sortEntries, statusOfDirectory,
} from "../../core/fileTree.js";
import { changedPaths } from "../../main/gitStatus.js";
import { filesContract, type ChangedFiles, type DirRequest } from "./contract.js";

/**
 * Git's verdict for this project, or an empty map.
 *
 * Never a reason to fail or to wait long: a folder that is not a repository still has a folder
 * worth drawing, and main/gitStatus answers from its cache when it has one and with nothing when
 * it does not. The page asks for the changed list before it reads a directory, so by the time this
 * is called for the tree the answer is usually already in that cache.
 */
function statusesOf(cwd: string): Promise<Map<string, FileStatus>> {
  return new Promise((done) => {
    try {
      changedPaths(cwd, done);
    } catch {
      done(new Map());
    }
  });
}

async function listDir({ cwd, dir }: DirRequest): Promise<DirListing> {
  if (!cwd || !isInsideProject(dir)) return { dir, entries: [], hidden: 0, error: "not a folder of this project" };
  const statuses = await statusesOf(cwd);
  let found: Dirent[];
  try {
    found = await readdir(resolve(cwd, dir.split("/").join(sep)), { withFileTypes: true });
  } catch (error) {
    return { dir, entries: [], hidden: 0, error: (error as NodeJS.ErrnoException).code ?? "unreadable" };
  }
  const entries: DirEntry[] = [];
  for (const item of found) {
    if (SKIPPED.has(item.name)) continue;
    const path = childPath(dir, item.name);
    // A symlink reports neither file nor directory here without a second stat; treated as a file,
    // which is what it looks like in a list and costs no extra call per entry.
    const directory = item.isDirectory();
    entries.push({
      name: item.name,
      path,
      directory,
      status: directory ? statusOfDirectory(path, statuses) : statuses.get(path) ?? null,
    });
  }
  const capped = capEntries(sortEntries(entries));
  return { dir, entries: capped.entries, hidden: capped.hidden };
}

async function changedFiles(cwd: string): Promise<ChangedFiles> {
  if (!cwd) return { items: [], hidden: 0 };
  return sortChanged(await statusesOf(cwd));
}

export function register(wire: Wire): void {
  wire.bind(filesContract, { listDir, changedFiles });
}
