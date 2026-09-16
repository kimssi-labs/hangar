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
import { existsSync, type Dirent } from "node:fs";
import { readdir, rename } from "node:fs/promises";
import { resolve, sep } from "node:path";

import { shell } from "electron";

import type { Wire } from "../../bridge/build.js";
import {
  canMoveInto, capEntries, changedPaths as sortChanged, childPath, type DirEntry, type DirListing,
  type FileStatus, isInsideProject, isValidName, moveTarget, nameOf, renameTarget, SKIPPED,
  sortEntries, statusOfDirectory,
} from "../../core/fileTree.js";
import { changedPaths } from "../../main/gitStatus.js";
import type { ActionResult } from "../../main/ipc.js";
import { filesContract, type ChangedFiles, type DirRequest, type MoveRequest, type RenameRequest } from "./contract.js";

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

/**
 * Open one file with whatever the machine opens it with.
 *
 * The same thing a double-click in Explorer does, on a file of the user's own project — and only
 * there: the path is checked against the project first, so nothing outside it can be asked for
 * through this channel. Opening is the platform's business after that; a file type with nothing
 * registered comes back as the message the platform gives, rather than as silence.
 */
async function openFile({ cwd, dir: path }: DirRequest): Promise<ActionResult> {
  if (!cwd || !path || !isInsideProject(path)) return { ok: false, message: "That file is not in this project." };
  const problem = await shell.openPath(resolve(cwd, path.split("/").join(sep)));
  return problem ? { ok: false, message: problem } : { ok: true };
}

/** The absolute path of something in the project, or null when it is not in the project at all. */
function inProject(cwd: string, path: string): string | null {
  if (!cwd || !path || !isInsideProject(path)) return null;
  return resolve(cwd, path.split("/").join(sep));
}

/** Show it in the machine's own file manager, selected — Explorer, Finder, whatever is there. */
function revealFile({ cwd, dir: path }: DirRequest): ActionResult {
  const full = inProject(cwd, path);
  if (!full) return { ok: false, message: "That file is not in this project." };
  shell.showItemInFolder(full);
  return { ok: true };
}

/**
 * Rename, in the folder it is already in.
 *
 * Refused before anything is written when the name is not a name (a path, a way up, a character
 * Windows will not have) or when something of that name is already there — `rename` would replace
 * a file without a word, and a file view that silently eats a file is not one to trust.
 */
async function renameFile({ cwd, path, name }: RenameRequest): Promise<ActionResult> {
  const from = inProject(cwd, path);
  if (!from) return { ok: false, message: "That file is not in this project." };
  if (!isValidName(name)) return { ok: false, message: `"${name}" cannot be a file name.` };
  const target = renameTarget(path, name);
  if (target === path) return { ok: true };
  const to = inProject(cwd, target);
  if (!to) return { ok: false, message: "That name would leave the project." };
  if (existsSync(to)) return { ok: false, message: `"${nameOf(target)}" is already there.` };
  try {
    await rename(from, to);
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }
  return { ok: true };
}

/**
 * Move it into another folder of this project — a drag onto a folder row.
 *
 * The same refusals as a rename, plus the three moves core knows mean nothing or lose the folder
 * (into where it already is, into itself, into its own child).
 */
async function moveFile({ cwd, path, toDir }: MoveRequest): Promise<ActionResult> {
  const from = inProject(cwd, path);
  if (!from) return { ok: false, message: "That file is not in this project." };
  if (!canMoveInto(path, toDir)) return { ok: false, message: "That file cannot go there." };
  const target = moveTarget(path, toDir);
  const to = inProject(cwd, target);
  if (!to) return { ok: false, message: "That folder is not in this project." };
  if (existsSync(to)) return { ok: false, message: `"${nameOf(target)}" is already there.` };
  try {
    await rename(from, to);
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }
  return { ok: true };
}

/**
 * Into the recycle bin, not gone.
 *
 * `shell.trashItem` rather than `rm`: a delete from a list of files is the one operation someone
 * does by accident, and the platform already has the place it can be got back from.
 */
async function trashFile({ cwd, dir: path }: DirRequest): Promise<ActionResult> {
  const full = inProject(cwd, path);
  if (!full) return { ok: false, message: "That file is not in this project." };
  try {
    await shell.trashItem(full);
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }
  return { ok: true };
}

export function register(wire: Wire): void {
  wire.bind(filesContract, { listDir, changedFiles, openFile, revealFile, renameFile, moveFile, trashFile });
}
