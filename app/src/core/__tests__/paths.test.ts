import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { claudeHome, homePaths } from "../paths.js";

describe("claudeHome", () => {
  it("is this app's own override first, then Claude Code's, then ~/.claude", () => {
    expect(claudeHome({ CLAUDE_HOME: "C:\a", CLAUDE_CONFIG_DIR: "C:\b" })).toBe("C:\a");
    expect(claudeHome({ CLAUDE_CONFIG_DIR: " C:\b " })).toBe("C:\b");
    expect(claudeHome({})).toBe(join(homedir(), ".claude"));
    expect(claudeHome({ CLAUDE_CONFIG_DIR: "" })).toBe(join(homedir(), ".claude"));
  });
});

describe("homePaths", () => {
  it("finds .claude.json beside a default home and inside a home Claude Code was told to use", () => {
    const beside = join(mkdtempSync(join(tmpdir(), "cp-paths-")), ".claude");
    mkdirSync(beside, { recursive: true });
    expect(homePaths(beside).claudeJson).toBe(join(beside, "..", ".claude.json"));

    const moved = mkdtempSync(join(tmpdir(), "cp-paths-moved-"));
    writeFileSync(join(moved, ".claude.json"), "{}");
    expect(homePaths(moved).claudeJson).toBe(join(moved, ".claude.json"));
    expect(homePaths(moved).credentials).toBe(join(moved, ".credentials.json"));
  });
});
