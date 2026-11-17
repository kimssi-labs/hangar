/**
 * Backend: renaming a skill (its folder and the name in its SKILL.md) and deleting one, never over
 * another skill and never through a link into a folder kept elsewhere.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

import { parseSkill } from "../../../core/skills.js";
import { deleteSkill, renameSkill } from "../main.js";

const root = mkdtempSync(join(tmpdir(), "hangar-skill-manage-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
/** A skills folder with one skill in it (SKILL.md and a helper beside it). */
function setup(name = "deploy") {
  const dir = join(root, String(n++));
  const skill = join(dir, name);
  mkdirSync(join(skill, "scripts"), { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), `---\nname: ${name}\ndescription: d\n---\nbody\n`);
  writeFileSync(join(skill, "scripts", "run.ps1"), "echo hi");
  return { dir, skill };
}

describe("renameSkill", () => {
  it("renames the folder and the name Claude Code reads, keeping everything else", () => {
    const { dir, skill } = setup();
    expect(renameSkill(skill, "ship")).toMatchObject({ ok: true });
    expect(existsSync(skill)).toBe(false);
    expect(parseSkill(readFileSync(join(dir, "ship", "SKILL.md"), "utf8"))).toEqual({ name: "ship", description: "d" });
    expect(readFileSync(join(dir, "ship", "scripts", "run.ps1"), "utf8")).toBe("echo hi");
  });

  it("refuses a name Claude Code would not take, and a folder already there", () => {
    const { dir, skill } = setup();
    mkdirSync(join(dir, "taken"));
    expect(renameSkill(skill, "Not Valid")).toMatchObject({ ok: false });
    expect(renameSkill(skill, "taken")).toMatchObject({ ok: false });
    expect(parseSkill(readFileSync(join(skill, "SKILL.md"), "utf8"))?.name).toBe("deploy");
  });

  it("refuses a link, whose SKILL.md is kept elsewhere", () => {
    const { dir, skill } = setup("real");
    const link = join(dir, "linked");
    symlinkSync(skill, link, "junction");
    expect(renameSkill(link, "other")).toMatchObject({ ok: false });
    expect(parseSkill(readFileSync(join(skill, "SKILL.md"), "utf8"))?.name).toBe("real");
  });
});

describe("deleteSkill", () => {
  it("sends the folder to the recycle bin", async () => {
    const { skill } = setup();
    const trash = vi.fn(async () => undefined);
    expect(await deleteSkill(skill, trash)).toMatchObject({ ok: true });
    expect(trash).toHaveBeenCalledWith(skill);
  });

  it("takes a link away by itself and leaves the folder it points to", async () => {
    const { dir, skill } = setup("real");
    const link = join(dir, "linked");
    symlinkSync(skill, link, "junction");
    const trash = vi.fn(async () => undefined);
    expect(await deleteSkill(link, trash)).toMatchObject({ ok: true });
    expect(trash).not.toHaveBeenCalled();
    expect(existsSync(link)).toBe(false);
    expect(readFileSync(join(skill, "scripts", "run.ps1"), "utf8")).toBe("echo hi");
  });
});
