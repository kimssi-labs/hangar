/**
 * Core: what a session opened from Hangar is asked on top of Claude Code's system prompt, so the
 * files it names open with Ctrl+click in the terminal.
 */
import { describe, expect, it } from "vitest";

import { sessionPrompt } from "../sessionPrompt.js";

describe("sessionPrompt", () => {
  it("asks for local files as file:/// links on every platform", () => {
    for (const platform of ["win32", "linux"] as const) {
      expect(sessionPrompt(platform)).toContain("[name](file:///C:/full/path)");
      expect(sessionPrompt(platform)).toContain("code blocks");
    }
  });

  it("is one line, since cmd.exe ends a command at a line break", () => {
    expect(sessionPrompt("win32")).not.toMatch(/[\r\n]/);
    expect(sessionPrompt("linux")).not.toMatch(/[\r\n]/);
  });

  it("on Windows, says how to link a path that ShellExecute would not find as written", () => {
    expect(sessionPrompt("win32")).toContain(".ShortPath");
    expect(sessionPrompt("linux")).not.toContain(".ShortPath");
  });
});
