/**
 * Core: reading a repository's head, and the one line a row shows for it.
 *
 * The parsing has to survive the shapes .git/HEAD actually takes — a branch with slashes in it, a
 * detached head, and a file that is not either.
 */
import { describe, expect, it } from "vitest";

import { countDirty, gitTitle, parseHead, type GitInfo } from "../git.js";

const CLEAN: GitInfo = { head: "main", detached: false, dirty: 0 };

describe("parseHead", () => {
  it("reads a branch, including one with slashes in its name", () => {
    expect(parseHead("ref: refs/heads/main\n")).toEqual({ head: "main", detached: false });
    expect(parseHead("ref: refs/heads/feature/dock-band\n"))
      .toEqual({ head: "feature/dock-band", detached: false });
  });

  it("reads a detached head as the short commit it is", () => {
    expect(parseHead("a1b2c3d4e5f60718293a4b5c6d7e8f9012345678\n"))
      .toEqual({ head: "a1b2c3d", detached: true });
  });

  it("says nothing rather than guessing at a file it does not recognise", () => {
    expect(parseHead("")).toBeNull();
    expect(parseHead("ref: refs/tags/v1\n")).toBeNull();
    expect(parseHead("garbage")).toBeNull();
  });
});

describe("counting", () => {
  it("counts a porcelain line per changed file, ignoring the trailing newline", () => {
    expect(countDirty(" M src/a.ts\n?? new.txt\nA  src/b.ts\n")).toBe(3);
    expect(countDirty("")).toBe(0);
    expect(countDirty("\n")).toBe(0);
  });
});

describe("the tooltip on a row", () => {
  it("spells out where the head is and what is uncommitted, including when nothing counted it", () => {
    expect(gitTitle(CLEAN)).toBe("Git: on main, nothing uncommitted");
    expect(gitTitle({ ...CLEAN, dirty: 2 })).toBe("Git: on main, 2 uncommitted");
    expect(gitTitle({ ...CLEAN, dirty: null })).toBe("Git: on main, changes not counted");
    expect(gitTitle({ ...CLEAN, head: "a1b2c3d", detached: true }))
      .toBe("Git: detached at a1b2c3d, nothing uncommitted");
  });

  it("says the same thing through a translator, in that language's own order", () => {
    // The tooltip is assembled from keys, so a language that words it differently is free to.
    const ko: Record<string, string> = {
      "git.on": "Git: {branch} 브랜치",
      "git.dirty": "변경 파일 {count}개",
    };
    const t = (key: string, vars: Record<string, string | number> = {}): string =>
      (ko[key] ?? key).replace(/\{(\w+)\}/g, (whole, name: string) => String(vars[name] ?? whole));
    expect(gitTitle({ ...CLEAN, dirty: 1 }, t)).toBe("Git: main 브랜치, 변경 파일 1개");
  });
});
