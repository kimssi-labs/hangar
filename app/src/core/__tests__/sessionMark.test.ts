/**
 * Core: what a session row shows about itself.
 *
 * Claude Code writes the state into its registry entry; measured on this machine, all three of
 * "busy", "waiting" and "idle" appear in `sessions/<pid>.json`.
 */
import { describe, expect, it } from "vitest";

import { sessionMark } from "../sessionMark.js";

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
