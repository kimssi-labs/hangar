/**
 * Core: taking an older version's usage hook back out of someone else's settings file.
 *
 * The file belongs to the user and usually already has hooks in it. Removing ours must put the
 * file back exactly as it was, and must do nothing to a file that never had it.
 */
import { describe, expect, it } from "vitest";

import { hookFileName, hookInstalled, withoutHook } from "../usageHook.js";

const MINE = { type: "command", command: '"C:\\Users\\me\\.claude\\hooks\\hangar-usage.cmd"' };

const OTHERS = {
  hooks: {
    Stop: [{ hooks: [{ type: "command", command: "bash ~/.claude/hooks/stop/mine.sh", shell: "bash" }] }],
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "guard.sh" }] }],
  },
  statusLine: { type: "command", command: "bash ~/.claude/statusline/command.sh" },
};

/** What a 2.15.x install left behind: our entry in a group of its own, after the user's. */
const WITH_MINE = {
  ...OTHERS,
  hooks: { ...OTHERS.hooks, Stop: [...OTHERS.hooks.Stop, { hooks: [MINE] }] },
};

describe("the hook an older version installed", () => {
  it("is recognised however its path was spelled", () => {
    expect(hookInstalled(WITH_MINE)).toBe(true);
    expect(hookInstalled({ hooks: { Stop: [{ hooks: [{ type: "command", command: "/home/me/.claude/hooks/hangar-usage.sh" }] }] } })).toBe(true);
    expect(hookInstalled(OTHERS)).toBe(false);
    expect(hookInstalled({})).toBe(false);
  });

  it("is removed alone, restoring the file it was added to", () => {
    const next = withoutHook(WITH_MINE);
    expect(next).toEqual(OTHERS);
    // Everything else in the file is left exactly as it was — a status line above all, since that
    // is the other place Claude Code reports usage and users have their own.
    expect(next.statusLine).toEqual(OTHERS.statusLine);
  });

  it("leaves no empty scaffolding behind in a file that had no other hooks", () => {
    const bare = { statusLine: { type: "command", command: "x" }, hooks: { Stop: [{ hooks: [MINE] }] } };
    expect(withoutHook(bare)).toEqual({ statusLine: { type: "command", command: "x" } });
    expect(withoutHook(bare)).not.toHaveProperty("hooks");
  });

  it("takes removal of a hook that is not there as nothing to do", () => {
    expect(withoutHook(OTHERS)).toEqual(OTHERS);
    expect(withoutHook({})).toEqual({});
  });

  it("knows the script's name on each platform, so the file can be deleted with the entry", () => {
    expect(hookFileName("win32")).toBe("hangar-usage.cmd");
    expect(hookFileName("linux")).toBe("hangar-usage.sh");
    expect(hookFileName("darwin")).toBe("hangar-usage.sh");
  });
});
