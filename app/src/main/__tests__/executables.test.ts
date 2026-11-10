/**
 * Looking a program up on PATH: read here, never by starting `where` / `which`.
 *
 * A process start blocks the thread that draws the window until the OS has made it, and on a
 * machine whose endpoint agent inspects every start one `where git` held the window for 0.6 s.
 */
import * as childProcess from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

import { lookPath, which } from "../executables.js";

vi.mock("node:child_process", async (original) => {
  const real = await original<typeof childProcess>();
  return { ...real, execFile: vi.fn(real.execFile), execFileSync: vi.fn(real.execFileSync) };
});

const root = mkdtempSync(join(tmpdir(), "hangar-which-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function tool(dir: string, name: string): string {
  mkdirSync(join(root, dir), { recursive: true });
  const path = join(root, dir, name);
  writeFileSync(path, "", { mode: 0o755 });
  return path;
}

const windows = process.platform === "win32";

describe("which", () => {
  it("finds a program on PATH without starting a process", () => {
    expect(which(windows ? "node.exe" : "node")).toBeTruthy();
    expect(childProcess.execFileSync).not.toHaveBeenCalled();
    expect(childProcess.execFile).not.toHaveBeenCalled();
  });
});

describe("lookPath", () => {
  it("answers in where's order: directory by directory, the name as written before an extension", () => {
    mkdirSync(join(root, "empty"), { recursive: true });
    mkdirSync(join(root, "dirs", "x.exe"), { recursive: true });       // a folder is not a program
    const plain = tool("b", "x");
    tool("b", "x.cmd");
    const env = { PATH: [join(root, "empty"), join(root, "dirs"), join(root, "b")].join(delimiter), PATHEXT: ".EXE;.CMD" };
    expect(lookPath("x", env)).toBe(plain);
  });

  it("adds PATHEXT on Windows, and is null when nothing matches", () => {
    const cmd = tool("c", "y.cmd");
    const env = { PATH: join(root, "c"), PATHEXT: ".EXE;.CMD" };
    expect(lookPath("y", env)).toBe(windows ? cmd : null);
    expect(lookPath("absent", env)).toBeNull();
  });
});
