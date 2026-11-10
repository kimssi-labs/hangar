/**
 * Backend: git runs off the thread that draws the window.
 *
 * Starting a process is synchronous on the calling thread (CreateProcess on Windows), and on a
 * machine whose endpoint agent inspects every process start it measured 0.2 s each and up to 1.9 s.
 * The file panel and the change count start `git status` every refresh, so on the main thread the
 * window froze every fifteen seconds and Windows marked it "Not Responding".
 */
import * as childProcess from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

import { countChanges } from "../gitStatus.js";

vi.mock("node:child_process", async (original) => {
  const real = await original<typeof childProcess>();
  return { ...real, execFile: vi.fn(real.execFile) };
});

const repo = mkdtempSync(join(tmpdir(), "hangar-offthread-"));
afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe("git status", () => {
  it("is started on a worker thread, never on the window's thread", async () => {
    childProcess.spawnSync("git", ["init", "-q"], { cwd: repo, windowsHide: true });
    writeFileSync(join(repo, "new.txt"), "x");
    const dirty = await new Promise<number>((done) => countChanges(repo, done));
    expect(dirty).toBe(1);
    expect(childProcess.execFile).not.toHaveBeenCalled();
  });
});
