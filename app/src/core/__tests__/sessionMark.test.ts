/**
 * Core: what a session row shows about itself.
 *
 * Claude Code writes the state into its registry entry; measured on this machine, all three of
 * "busy", "waiting" and "idle" appear in `sessions/<pid>.json`.
 */
import { describe, expect, it } from "vitest";

import { projectState, sessionMark, statusLabel } from "../sessionMark.js";

describe("sessionMark", () => {
  it("is working while the session is answering", () => {
    expect(sessionMark(true, "busy")).toBe("working");
  });

  it("is the person's turn once it has finished, or while it asks them something", () => {
    expect(sessionMark(true, "idle")).toBe("turn");
    expect(sessionMark(true, "waiting")).toBe("turn");
    expect(sessionMark(true, null)).toBe("turn");       // running, and saying nothing about itself
  });

  it("is nothing at all for a session that is not running", () => {
    expect(sessionMark(false, "busy")).toBeNull();
    expect(sessionMark(false, null)).toBeNull();
  });
});

describe("statusLabel", () => {
  it("is the state Claude Code reported, in its own words", () => {
    expect(statusLabel(true, "busy")).toBe("busy");
    expect(statusLabel(true, "waiting")).toBe("waiting");
    expect(statusLabel(true, "idle")).toBe("idle");
  });

  it("calls a session that is not running closed, and one that says nothing idle", () => {
    expect(statusLabel(false, "busy")).toBe("closed");
    expect(statusLabel(false, null)).toBe("closed");
    expect(statusLabel(true, null)).toBe("idle");
    expect(statusLabel(true, "  ")).toBe("idle");
  });

  it("passes a state it has not seen before straight through", () => {
    expect(statusLabel(true, "compacting")).toBe("compacting");
  });
});

describe("projectState", () => {
  const session = (live: boolean, status: string | null) => ({ live, status });

  it("is the busiest thing happening in the project", () => {
    expect(projectState([session(true, "idle"), session(true, "busy")])).toBe("busy");
    expect(projectState([session(true, "idle"), session(true, "waiting")])).toBe("waiting");
    expect(projectState([session(true, "idle"), session(false, "busy")])).toBe("idle");
  });

  it("is closed when nothing in it is running", () => {
    expect(projectState([session(false, "busy"), session(false, null)])).toBe("closed");
    expect(projectState([])).toBe("closed");
  });
});
