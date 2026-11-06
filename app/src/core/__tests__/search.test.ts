/**
 * Core: what the search box keeps. A session is found by its title or its first prompt, and its
 * project is kept for it, so the project shows and the session shows beside it.
 */
import { describe, expect, it } from "vitest";

import { filterProjects, filterSessions } from "../search.js";
import type { ProjectInfo, SessionInfo } from "../types.js";

const session = (id: string, title: string, prompt = title): SessionInfo =>
  ({ id, title, prompt } as SessionInfo);
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
