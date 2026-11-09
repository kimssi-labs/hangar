/**
 * Core: what the search box keeps. A session is found by its title or its first prompt, and its
 * project is kept for it, so the project shows and the session shows beside it.
 */
import { describe, expect, it } from "vitest";

import { filterProjects, filterSessions, foldHeadless } from "../search.js";
import type { ProjectInfo, SessionInfo } from "../types.js";

const session = (id: string, title: string, prompt = title, headless = false): SessionInfo =>
  ({ id, title, prompt, headless } as SessionInfo);
const project = (dir: string, sessions: SessionInfo[]): ProjectInfo =>
  ({ dir, name: dir, cwd: `C:/src/${dir}`, parentDir: null, sessions } as unknown as ProjectInfo);

const named = session("a", "Dock grip", "the orange bar cannot be grabbed");
const plain = session("b", "fix the splash screen");
const app = project("app", [named, plain]);
const other = project("other", [session("c", "unrelated")]);

describe("filterSessions", () => {
  it("finds a renamed session by the prompt its name replaced", () => {
    expect(filterSessions(app, "ORANGE BAR")).toEqual([named]);
  });

  it("finds a session by its title", () => {
    expect(filterSessions(app, "splash")).toEqual([plain]);
  });

  it("keeps every session without a query", () => {
    expect(filterSessions(app, "  ")).toEqual([named, plain]);
    expect(filterSessions(null, "x")).toEqual([]);
  });
});

describe("filterProjects", () => {
  it("keeps the project a matching session belongs to, and only that one", () => {
    expect(filterProjects([app, other], "orange").map((row) => row.item)).toEqual([app]);
  });

  it("still finds a project by its name or folder", () => {
    expect(filterProjects([app, other], "src/other").map((row) => row.item)).toEqual([other]);
  });
});

describe("foldHeadless", () => {
  const typed = session("t", "typed");
  const run1 = session("r1", "run", "run", true);
  const run2 = session("r2", "run", "run", true);

  it("puts the runs behind their switch, after the sessions a person opened", () => {
    expect(foldHeadless([run1, typed, run2], false)).toEqual({ rows: [typed], headless: 2 });
    expect(foldHeadless([run1, typed, run2], true)).toEqual({ rows: [typed, run1, run2], headless: 2 });
  });

  it("shows a project of runs alone as it is, with no switch", () => {
    expect(foldHeadless([run1, run2], false)).toEqual({ rows: [run1, run2], headless: 0 });
    expect(foldHeadless([typed], false)).toEqual({ rows: [typed], headless: 0 });
  });
});

describe("filterProjects folding", () => {
  const parent = { ...project("main", [plain]), parentDir: null };
  const child = { ...project("runs", [session("x", "orange run")]), parentDir: "main" };

  it("folds a closed row's children, but a search shows every match", () => {
    const closed = () => false;
    expect(filterProjects([parent, child], "", closed).map((row) => row.item.dir)).toEqual(["main"]);
    expect(filterProjects([parent, child], "run", closed).map((row) => row.item.dir)).toEqual(["runs"]);
    expect(filterProjects([parent, child], "s", closed).map((row) => row.item.dir)).toEqual(["main", "runs"]);
  });
});
