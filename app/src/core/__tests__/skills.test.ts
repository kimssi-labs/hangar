import { describe, expect, it } from "vitest";

import { enabledPlugins, parseSkill, pluginInstalls, sameDir, SKILL_NAME, skillMatches, withSkillName } from "../skills.js";

describe("parseSkill", () => {
  it("reads a plain name and description", () => {
    expect(parseSkill("---\nname: wiki\ndescription: Search the wiki\n---\n# body")).toEqual({ name: "wiki", description: "Search the wiki" });
  });

  it("reads quoted values, a BOM and CRLF line ends", () => {
    expect(parseSkill("\uFEFF---\r\nname: \"commit\"\r\ndescription: 'It''s for commits'\r\n---\r\n")).toEqual({ name: "commit", description: "It's for commits" });
  });

  it("joins a folded block description into one line", () => {
    expect(parseSkill("---\nname: drawio\ndescription: >\n  Create diagrams\n  and edit them.\nlicense: MIT\n---\n")?.description).toBe("Create diagrams and edit them.");
  });

  it("is null without front matter or a name", () => {
    expect(parseSkill("# just a heading")).toBeNull();
    expect(parseSkill("---\ndescription: nameless\n---\n")).toBeNull();
  });
});

describe("plugins", () => {
  it("lists only plugins that are installed and switched on, by their short name", () => {
    const enabled = enabledPlugins({ enabledPlugins: { "superpowers@official": true, "github@official": false } });
    const installed = { plugins: {
      "superpowers@official": [{ installPath: "C:/p/superpowers/6.3.0" }],
      "github@official": [{ installPath: "C:/p/github" }],
      "atlassian@official": [{ installPath: "C:/p/atlassian" }],
    } };
    expect(pluginInstalls(installed, enabled)).toEqual([{ plugin: "superpowers", path: "C:/p/superpowers/6.3.0" }]);
  });

  it("copes with files that are missing or not what they should be", () => {
    expect([...enabledPlugins(null)]).toEqual([]);
    expect(pluginInstalls("nonsense", new Set(["x@y"]))).toEqual([]);
  });
});

describe("skillMatches", () => {
  const skill = { command: "superpowers:brainstorming", name: "brainstorming", description: "Explore intent before building", file: "" };
  it("matches the command or the description, in any case", () => {
    expect(skillMatches(skill, "BRAIN")).toBe(true);
    expect(skillMatches(skill, "intent")).toBe(true);
    expect(skillMatches(skill, "deploy")).toBe(false);
    expect(skillMatches(skill, "  ")).toBe(true);
  });
});

describe("sameDir", () => {
  it("finds the user's skills folder in a project at the home folder, so it is listed once", () => {
    expect(sameDir("C:\\Users\\me\\.claude\\skills", "c:/users/me/.claude/skills/", true)).toBe(true);
    expect(sameDir("/home/me/.claude/skills", "/home/Me/.claude/skills", false)).toBe(false);
    expect(sameDir("C:/work/app/.claude/skills", "C:/Users/me/.claude/skills", true)).toBe(false);
  });
});

describe("withSkillName", () => {
  it("sets the name in the front matter and leaves the rest as it was", () => {
    const text = "---\r\nname: deploy\r\ndescription: d\r\n---\r\nname: in the body\r\n";
    const renamed = withSkillName(text, "ship")!;
    expect(parseSkill(renamed)).toEqual({ name: "ship", description: "d" });
    expect(renamed).toBe("---\r\nname: ship\r\ndescription: d\r\n---\r\nname: in the body\r\n");
  });

  it("replaces a quoted or folded old name whole, and refuses a file that names nothing", () => {
    expect(withSkillName("---\nname: \"old one\"\n---\n", "new")).toBe("---\nname: new\n---\n");
    expect(withSkillName("---\nname: >\n  old\n  one\ndescription: d\n---\n", "new")).toBe("---\nname: new\ndescription: d\n---\n");
    expect(withSkillName("---\ndescription: d\n---\n", "new")).toBeNull();
    expect(withSkillName("no front matter", "new")).toBeNull();
  });

  it("takes only what Claude Code takes as a name", () => {
    expect(SKILL_NAME.test("ship-it-2")).toBe(true);
    for (const bad of ["Ship", "ship it", "-ship", "", "a".repeat(65), "../x"]) expect(SKILL_NAME.test(bad)).toBe(false);
  });
});
