/**
 * Core: the order rows appear in, the cap, and git's verdict per path.
 *
 * The parsing is the part worth pinning. Porcelain is terse, and every field of it means something
 * different in the two columns — an "A" in the first is a new file staged, an "A" in both is a
 * conflict, and getting that wrong paints a row the wrong colour in exactly the moment it matters.
 */
import { describe, expect, it } from "vitest";

import {
  canMoveInto, capEntries, changedPaths, childPath, type DirEntry, ENTRY_CAP, isInsideProject,
  isValidName, moveTarget, nameOf, parentOf, parsePorcelain, renameTarget, sortEntries, statusOf,
  statusOfDirectory, worseOf,
} from "../fileTree.js";

const entry = (name: string, directory = false): DirEntry => ({ name, path: name, directory, status: null });

describe("the order of a directory", () => {
  it("puts directories first, then reads numbers the way a person does", () => {
    const sorted = sortEntries([
      entry("readme.md"), entry("100.log"), entry("9.log"), entry("99.log"), entry("src", true), entry("Assets", true),
    ]);
    expect(sorted.map((e) => e.name)).toEqual(["Assets", "src", "9.log", "99.log", "100.log", "readme.md"]);
  });

  it("ignores case rather than sorting every capital ahead of every lowercase", () => {
    expect(sortEntries([entry("beta"), entry("Alpha"), entry("gamma")]).map((e) => e.name))
      .toEqual(["Alpha", "beta", "gamma"]);
  });
});

describe("the cap", () => {
  it("leaves a normal folder alone and says how many it left out of a huge one", () => {
    const few = [entry("a"), entry("b")];
    expect(capEntries(few)).toEqual({ entries: few, hidden: 0 });

    const many = Array.from({ length: ENTRY_CAP + 42 }, (_, i) => entry(`f${i}`));
    const capped = capEntries(many);
    expect(capped.entries).toHaveLength(ENTRY_CAP);
    expect(capped.hidden).toBe(42);
  });
});

describe("git's two letters", () => {
  it("tells a new file from an edited one, a staged one, and a conflict", () => {
    expect(statusOf("?", "?")).toBe("untracked");
    expect(statusOf(" ", "M")).toBe("modified");
    expect(statusOf("M", " ")).toBe("staged");
    expect(statusOf("M", "M")).toBe("modified");     // staged AND edited since: the edit is the news
    expect(statusOf("A", " ")).toBe("staged");
    expect(statusOf("U", "U")).toBe("conflicted");
    expect(statusOf("A", "A")).toBe("conflicted");
    expect(statusOf("D", "D")).toBe("conflicted");
    expect(statusOf(" ", " ")).toBeNull();
    expect(statusOf("!", "!")).toBeNull();           // ignored files are not news either
  });

  it("ranks one verdict against another", () => {
    expect(worseOf(null, "modified")).toBe("modified");
    expect(worseOf("untracked", "modified")).toBe("modified");
    expect(worseOf("staged", "conflicted")).toBe("conflicted");
    expect(worseOf(null, null)).toBeNull();
  });
});

describe("parsing porcelain", () => {
  it("reads the whole block, keeping the name a rename ends at", () => {
    const statuses = parsePorcelain([
      " M src/core/status.ts",
      "?? docs/new.md",
      "M  package.json",
      "UU src/conflict.ts",
      'R  old/name.ts -> src/new name.ts',
      "!! ignored.log",
      "",
    ].join("\n"));

    expect(statuses.get("src/core/status.ts")).toBe("modified");
    expect(statuses.get("docs/new.md")).toBe("untracked");
    expect(statuses.get("package.json")).toBe("staged");
    expect(statuses.get("src/conflict.ts")).toBe("conflicted");
    expect(statuses.get("src/new name.ts")).toBe("staged");
    expect(statuses.has("old/name.ts")).toBe(false);
    expect(statuses.has("ignored.log")).toBe(false);
  });

  it("unquotes a path git felt the need to quote", () => {
    const statuses = parsePorcelain('?? "src/\\355\\225\\234 \\352\\270\\200.ts"\n');
    expect([...statuses.keys()][0]).not.toMatch(/^"/);
  });

  it("has nothing to say about an empty or truncated answer", () => {
    expect(parsePorcelain("").size).toBe(0);
    expect(parsePorcelain("M\n?\n").size).toBe(0);
  });
});

describe("a directory's own mark", () => {
  it("is the worst of anything beneath it, and nothing when it is clean", () => {
    const statuses = parsePorcelain([" M src/a.ts", "?? src/deep/new.ts", " M docs/x.md"].join("\n"));
    expect(statusOfDirectory("src", statuses)).toBe("modified");
    expect(statusOfDirectory("src/deep", statuses)).toBe("untracked");
    expect(statusOfDirectory("build", statuses)).toBeNull();
    // "src" must not be matched by a folder whose name merely starts the same way.
    expect(statusOfDirectory("sr", statuses)).toBeNull();
  });
});

describe("the changed list a narrow panel shows", () => {
  it("is worst first, then by name, and says what it left out", () => {
    const statuses = parsePorcelain([
      "?? z-new.ts", " M b.ts", "UU conflict.ts", "M  staged.ts", " M a.ts",
    ].join("\n"));
    expect(changedPaths(statuses).items.map((i) => i.path))
      .toEqual(["conflict.ts", "staged.ts", "a.ts", "b.ts", "z-new.ts"]);

    const many = new Map([...Array(10).keys()].map((i) => [`f${i}.ts`, "modified" as const]));
    expect(changedPaths(many, 4)).toMatchObject({ hidden: 6 });
  });
});

describe("the paths the panel asks for", () => {
  it("spells a child the one way, whatever the platform", () => {
    expect(childPath("", "src")).toBe("src");
    expect(childPath("src", "core")).toBe("src/core");
  });

  it("refuses anything that climbs out of the project", () => {
    expect(isInsideProject("")).toBe(true);
    expect(isInsideProject("src/core")).toBe(true);
    expect(isInsideProject("../secrets")).toBe(false);
    expect(isInsideProject("src/../..")).toBe(false);
    expect(isInsideProject("C:\\Windows")).toBe(false);
    expect(isInsideProject("/etc")).toBe(false);
  });
});

describe("renaming", () => {
  it("takes a name, never a path and never a way out", () => {
    expect(isValidName("notes.md")).toBe(true);
    expect(isValidName(" spaced.md ")).toBe(true);           // trimmed before it is judged
    expect(isValidName("한글 이름.txt")).toBe(true);
    expect(isValidName("")).toBe(false);
    expect(isValidName("   ")).toBe(false);
    expect(isValidName("..")).toBe(false);
    expect(isValidName("src/deep.ts")).toBe(false);
    expect(isValidName("src\\deep.ts")).toBe(false);
    expect(isValidName("what?.ts")).toBe(false);
    expect(isValidName("C:file")).toBe(false);
    expect(isValidName("trailing.")).toBe(false);            // Windows strips it and means something else
  });

  it("keeps the folder and changes only the name", () => {
    expect(renameTarget("src/core/status.ts", "state.ts")).toBe("src/core/state.ts");
    expect(renameTarget("readme.md", "README.md")).toBe("README.md");
    expect(renameTarget("src/a.ts", "  b.ts  ")).toBe("src/b.ts");
  });

  it("knows a path's folder and its name", () => {
    expect(parentOf("src/core/status.ts")).toBe("src/core");
    expect(parentOf("readme.md")).toBe("");
    expect(nameOf("src/core/status.ts")).toBe("status.ts");
    expect(nameOf("readme.md")).toBe("readme.md");
  });
});

describe("moving", () => {
  it("puts the same name in the new folder", () => {
    expect(moveTarget("src/core/status.ts", "docs")).toBe("docs/status.ts");
    expect(moveTarget("readme.md", "docs")).toBe("docs/readme.md");
    expect(moveTarget("src/a.ts", "")).toBe("a.ts");
  });

  it("refuses the three moves that mean nothing or lose the folder", () => {
    expect(canMoveInto("src/core/status.ts", "docs")).toBe(true);
    expect(canMoveInto("src/a.ts", "")).toBe(true);
    expect(canMoveInto("src/core/status.ts", "src/core")).toBe(false);   // already there
    expect(canMoveInto("src", "src")).toBe(false);                        // into itself
    expect(canMoveInto("src", "src/core")).toBe(false);                   // into its own child
    expect(canMoveInto("src", "../elsewhere")).toBe(false);               // out of the project
    expect(canMoveInto("", "docs")).toBe(false);                          // the root is not a thing to move
  });
});
