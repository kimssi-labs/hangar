/**
 * Backend: a project's own skill made global, by copy or by move, never over another skill and
 * never through a link.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

import { promote } from "../main.js";

const root = mkdtempSync(join(tmpdir(), "hangar-promote-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
/** A project with one skill folder (SKILL.md and a helper beside it), and an empty user folder. */
function setup(name = "deploy") {
  const base = join(root, String(n++));
  const skill = join(base, "project", ".claude", "skills", name);
  const user = join(base, "home", "skills");
  mkdirSync(join(skill, "scripts"), { recursive: true });
  mkdirSync(user, { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), `---\nname: ${name}\ndescription: d\n---\n`);
  writeFileSync(join(skill, "scripts", "run.ps1"), "echo hi");
  return { skill, user, target: join(user, name) };
}

const noTrash = vi.fn(async () => undefined);

describe("promote", () => {
  it("copies the whole folder and leaves the project's own", async () => {
    const { skill, user, target } = setup();
    expect(await promote(skill, user, "copy", noTrash)).toMatchObject({ ok: true });
    expect(readFileSync(join(target, "scripts", "run.ps1"), "utf8")).toBe("echo hi");
    expect(existsSync(join(skill, "SKILL.md"))).toBe(true);
  });

  it("moves it: the project no longer has it", async () => {
    const { skill, user, target } = setup();
    expect(await promote(skill, user, "move", noTrash)).toMatchObject({ ok: true });
    expect(existsSync(join(target, "SKILL.md"))).toBe(true);
    expect(existsSync(skill)).toBe(false);
  });

  it("refuses to replace a global skill of the same name, either way", async () => {
    const { skill, user, target } = setup();
    mkdirSync(target);
    writeFileSync(join(target, "SKILL.md"), "mine");
    for (const mode of ["copy", "move"] as const) {
      expect(await promote(skill, user, mode, noTrash)).toMatchObject({ ok: false });
    }
    expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe("mine");
    expect(existsSync(join(skill, "SKILL.md"))).toBe(true);
  });

  it("refuses a link to a folder kept elsewhere", async () => {
    const { skill, user } = setup("real");
    const link = join(skill, "..", "linked");
    symlinkSync(skill, link, "junction");
    expect(await promote(link, user, "move", noTrash)).toMatchObject({ ok: false });
    expect(existsSync(join(skill, "SKILL.md"))).toBe(true);
  });
});
