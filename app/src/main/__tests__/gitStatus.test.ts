/**
 * Backend: reading a checkout whose `.git` is a pointer file, and telling a linked worktree from the
 * other checkouts that have one.
 *
 * A `--separate-git-dir` checkout is an ordinary repository whose store is kept elsewhere, and a
 * submodule's `.git` is a pointer too. Taking those for worktrees named such a repository by its
 * branch alone and offered to remove it as a worktree.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { headOf, isLinkedWorktree } from "../gitStatus.js";

const root = mkdtempSync(join(tmpdir(), "hangar-pointer-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/**
 * A folder whose `.git` file says `gitdir: <pointer>`, with the git directory it names at `store`:
 * on `main`, and holding a `commondir` when it is a linked worktree's.
 */
function checkout(folder: string, pointer: string, store: string, linked: boolean): string {
  const dir = join(root, folder);
  mkdirSync(dir, { recursive: true });
  mkdirSync(store, { recursive: true });
  writeFileSync(join(store, "HEAD"), "ref: refs/heads/main\n");
  if (linked) writeFileSync(join(store, "commondir"), "../..\n");
  writeFileSync(join(dir, ".git"), `gitdir: ${pointer}\n`);
  return dir;
}

describe("isLinkedWorktree", () => {
  it("is true for a linked worktree, whose git directory names the repository it shares", () => {
    const store = join(root, "repo", ".git", "worktrees", "feature");
    expect(isLinkedWorktree(checkout("repo-feature", store.replace(/\\/g, "/"), store, true))).toBe(true);
  });

  it("is true when the pointer is relative, as `worktree.useRelativePaths` writes it", () => {
    const store = join(root, "rel", ".git", "worktrees", "x");
    expect(isLinkedWorktree(checkout("rel-x", "../rel/.git/worktrees/x", store, true))).toBe(true);
  });

  it("is false for a checkout whose store is kept elsewhere (`--separate-git-dir`)", () => {
    const store = join(root, "stores", "vault.git");
    expect(isLinkedWorktree(checkout("vault", store, store, false))).toBe(false);
  });

  it("is false for a submodule, for a repository's own checkout, and for no repository at all", () => {
    const store = join(root, "super", ".git", "modules", "sub");
    expect(isLinkedWorktree(checkout(join("super", "sub"), "../.git/modules/sub", store, false))).toBe(false);
    const own = join(root, "own");
    mkdirSync(join(own, ".git"), { recursive: true });
    expect(isLinkedWorktree(own)).toBe(false);
    expect(isLinkedWorktree(join(root, "nowhere"))).toBe(false);
  });
});

describe("headOf", () => {
  it("follows a relative pointer from the folder that holds it, not from wherever the app runs", () => {
    const store = join(root, "outer", ".git", "modules", "inner");
    const inner = checkout(join("outer", "inner"), "../.git/modules/inner", store, false);
    expect(headOf(inner)).toMatchObject({ head: "main", detached: false });
  });
});
