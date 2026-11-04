/**
 * Core: finding a worktree's repository, and tucking it under that repository in the list.
 *
 * A worktree is a project of its own — its own folder and its own sessions — but showing it as a
 * sibling of the repository it came from hides the one fact that matters about it.
 */
import { describe, expect, it } from "vitest";

import { linkWorktrees, mainRepoFrom, placeWorktrees, treeName } from "../worktree.js";

describe("mainRepoFrom", () => {
  it("reads the repository out of the pointer git writes", () => {
    expect(mainRepoFrom("gitdir: C:/src/app/.git/worktrees/app-feature\n")).toBe("C:/src/app");
    expect(mainRepoFrom("gitdir: /home/me/app/.git/worktrees/x")).toBe("/home/me/app");
  });

  it("copes with backslashes and with the case git happens to use", () => {
    expect(mainRepoFrom("gitdir: C:\\src\\app\\.git\\worktrees\\x")).toBe("C:\\src\\app");
    expect(mainRepoFrom("gitdir: C:/src/app/.GIT/WORKTREES/x")).toBe("C:/src/app");
  });

  it("says nothing for a pointer that is not a worktree's", () => {
    expect(mainRepoFrom("gitdir: C:/src/app/.git")).toBeNull();   // a submodule, not a worktree
    expect(mainRepoFrom("")).toBeNull();
    expect(mainRepoFrom("nonsense")).toBeNull();
  });
});

describe("placeWorktrees", () => {
  const rows = [
    { dir: "app", parentDir: null },
    { dir: "other", parentDir: null },
    { dir: "app-feature", parentDir: "app" },
    { dir: "app-fix", parentDir: "app" },
  ];

  it("puts each worktree under its repository, indented, keeping the rest in order", () => {
    // The repository's row counts what is under it; each worktree knows the row it sits under.
    expect(placeWorktrees(rows)).toEqual([
      { item: rows[0], depth: 0, parent: null, trees: 2 },
      { item: rows[2], depth: 1, parent: rows[0], trees: 0 },
      { item: rows[3], depth: 1, parent: rows[0], trees: 0 },
      { item: rows[1], depth: 0, parent: null, trees: 0 },
    ]);
  });

  it("leaves a worktree where it was when its repository is not in the list", () => {
    // The repository may be a folder Claude Code has never opened, so it has no row to sit under.
    const orphan = [{ dir: "app-feature", parentDir: "app" }];
    expect(placeWorktrees(orphan)).toEqual([{ item: orphan[0], depth: 0, parent: null, trees: 0 }]);
  });

  it("counts only the worktrees that made it into the list, as a search narrows it", () => {
    const [app, , feature] = rows;
    expect(placeWorktrees([app!, feature!]).map((p) => p.trees)).toEqual([1, 0]);
    expect(placeWorktrees([app!]).map((p) => p.trees)).toEqual([0]);
  });

  it("never loses or repeats a row", () => {
    const placed = placeWorktrees(rows);
    expect(placed).toHaveLength(rows.length);
    expect(new Set(placed.map((p) => p.item.dir)).size).toBe(rows.length);
  });

  it("ignores a row that claims itself as its own parent", () => {
    const odd = [{ dir: "app", parentDir: "app" }];
    expect(placeWorktrees(odd)).toEqual([{ item: odd[0], depth: 0, parent: null, trees: 0 }]);
  });
});

describe("linkWorktrees", () => {
  const row = (dir: string, cwd: string, worktree = false) =>
    ({ dir, cwd, exists: true, worktree, mainRepo: null as string | null, parentDir: null as string | null });
  /** What the `.git` pointer of each checkout says (forward slashes, as git writes it). */
  const pointers: Record<string, string> = {
    "C:\\src\\app-feature": "C:/src/app",
    "C:\\src\\lone-fix": "C:/src/lone",
  };
  const repoOf = (cwd: string): string | null => pointers[cwd] ?? null;
  const key = (path: string): string => path.replace(/\\/g, "/").toLowerCase();

  it("tucks a worktree under its repository's row when that repository is listed", () => {
    const projects = [row("app", "C:\\src\\app"), row("feature", "C:\\src\\app-feature", true)];
    linkWorktrees(projects, repoOf, key);
    expect(projects[1]).toMatchObject({ mainRepo: "C:/src/app", parentDir: "app" });
  });

  it("keeps the repository's folder for a worktree whose repository has no row", () => {
    // Nothing to sit under, yet the window can still say which repository this is.
    const projects = [row("fix", "C:\\src\\lone-fix", true)];
    linkWorktrees(projects, repoOf, key);
    expect(projects[0]).toMatchObject({ mainRepo: "C:/src/lone", parentDir: null });
  });

  it("reads nothing at all for a list without a worktree, and touches no other row", () => {
    let reads = 0;
    const projects = [row("app", "C:\\src\\app")];
    linkWorktrees(projects, (cwd) => { reads += 1; return repoOf(cwd); }, key);
    expect(reads).toBe(0);
    expect(projects[0]).toMatchObject({ mainRepo: null, parentDir: null });
  });
});

describe("treeName", () => {
  const tree = (overrides: Partial<Parameters<typeof treeName>[0]> = {}): Parameters<typeof treeName>[0] => ({
    name: "app-feature-dialog",
    alias: null,
    mainRepo: "C:/src/app",
    git: { head: "feature/dialog", detached: false },
    ...overrides,
  });

  it("calls a worktree by its branch, slashes and all", () => {
    expect(treeName(tree(), "app")).toEqual({ name: "feature/dialog", isBranch: true, repo: "app" });
  });

  it("names the repository by its row when it is listed, else by its folder", () => {
    expect(treeName(tree(), "My App").repo).toBe("My App");
    expect(treeName(tree(), null).repo).toBe("app");
    expect(treeName(tree({ mainRepo: null }), null).repo).toBeNull();
  });

  it("falls back to the folder, less the repository's prefix, for a head with no branch", () => {
    const detached = tree({ git: { head: "a1b2c3d", detached: true } });
    expect(treeName(detached, null)).toEqual({ name: "feature-dialog", isBranch: false, repo: "app" });
    // Whatever the case the transcript wrote the folder in.
    expect(treeName({ ...detached, name: "App-feature-dialog" }, null).name).toBe("feature-dialog");
    // A folder that is not `<repo>-…`, or is the prefix and nothing more, keeps its whole name.
    expect(treeName({ ...detached, name: "elsewhere" }, null).name).toBe("elsewhere");
    expect(treeName({ ...detached, name: "app-" }, null).name).toBe("app-");
  });

  it("keeps a name the user gave the row over the branch", () => {
    expect(treeName(tree({ name: "Dialog work", alias: "Dialog work" }), "app"))
      .toEqual({ name: "Dialog work", isBranch: false, repo: "app" });
  });
});
