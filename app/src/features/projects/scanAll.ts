/**
 * One full read of the project list: Claude Code's folders, each row's head line and worktree, and
 * which projects a session started. The same steps whether they run on the scan worker
 * (scanWorker.ts) or, if no worker could start, on the main thread.
 *
 * Nothing here may need Electron: on the worker it is not there.
 */
import { realpathSync } from "node:fs";

import type { ConfigStore } from "../../core/config.js";
import { linkSpawned, MentionIndex } from "../../core/spawned.js";
import type { Store } from "../../core/store.js";
import type { ProjectInfo } from "../../core/types.js";
import { linkWorktrees } from "../../core/worktree.js";
import { headOf, isLinkedWorktree, mainCheckoutOf } from "../../main/gitStatus.js";

/** What a scanner keeps between scans, beyond the store's own caches. */
export interface ScanState {
  /** Resolved real paths, per folder — dropped whenever the store reads everything again. */
  realPaths: Map<string, string>;
  /** Whether a session's transcript named a folder just before a run began there (core/spawned.ts). */
  mentions: MentionIndex;
}

export function scanState(): ScanState {
  return { realPaths: new Map(), mentions: new MentionIndex() };
}

export function scanAll(store: Store, config: ConfigStore, state: ScanState): ProjectInfo[] {
  const projects = store.scan();
  // The head line is three small reads per project; the change count is a git process, so it is
  // asked for separately and only for the row in front of the user.
  if (config.git().enabled) {
    for (const project of projects) {
      if (project.cwd && project.exists) {
        project.git = headOf(project.cwd);
        project.worktree = Boolean(project.git) && isLinkedWorktree(project.cwd);
      }
    }
    // Second pass: a worktree points at a folder, and the list is keyed by project. Match the two so
    // the window can show each worktree under the repository it came from, and name that
    // repository even when it is not listed (the folder read here is kept as `mainRepo`).
    // Compared with separators and case normalised: the pointer file writes forward slashes where
    // a transcript's cwd on Windows has backslashes, and the two would never match as written.
    //
    // Only when there is a worktree to place at all, only for a folder that is there, and once per
    // folder: resolving a path on an unreachable share waits out the SMB timeout, and its answer is
    // "fall back to what was written" anyway.
    if (store.lastScanFull) state.realPaths.clear();
    const key = (path: string, present: boolean): string => {
      let real = present ? state.realPaths.get(path) : path;
      if (real === undefined) {
        real = path;
        try {
          // 8.3 short names are the one that actually bit: TEMP reads C:\Users\EXAMPL~1 in a
          // transcript's cwd and C:/Users/ExampleUser in git's own pointer file. Only resolving
          // the real path makes those the same folder.
          real = realpathSync.native(path);
        } catch {
          /* gone, or unreachable: fall back to what was written */
        }
        state.realPaths.set(path, real);
      }
      return real.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    };
    linkWorktrees(projects, mainCheckoutOf, key);
  }
  // After the worktrees, which keep their repository: a folder of headless runs goes under the
  // project whose session started them (core/spawned.ts). It does not wait for git.
  linkSpawned(projects, (file, cwd, time) => state.mentions.names(file, cwd, time));
  return projects;
}
