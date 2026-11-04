/**
 * Core: a JSON save is atomic when it can be, and never lost when it cannot.
 *
 * Settings, session titles and caches are written beside the file and renamed over it. On Windows
 * that rename fails while a scanner holds the file open without sharing delete (this machine runs
 * a DLP agent), where the old in-place write still worked — so a busy target falls back to it.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { writeJson } from "../json.js";

// vi.mock is hoisted above the imports, so json.ts gets this fs; the state it reads is hoisted with it.
const failRename = vi.hoisted(() => ({ code: null as string | null, times: 0 }));

vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    renameSync: (from: string, to: string) => {
      if (failRename.code && failRename.times > 0) {
        failRename.times -= 1;
        throw Object.assign(new Error(`${failRename.code}: rename`), { code: failRename.code });
      }
      fs.renameSync(from, to);
    },
  };
});

const dirs: string[] = [];
afterEach(() => {
  failRename.code = null;
  failRename.times = 0;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), "hangar-json-"));
  dirs.push(dir);
  return dir;
}

describe("writeJson", () => {
  it("renames the finished file into place and leaves nothing beside it", () => {
    const dir = folder();
    writeJson(join(dir, "a.json"), { a: 1 });
    expect(JSON.parse(readFileSync(join(dir, "a.json"), "utf8"))).toEqual({ a: 1 });
    expect(readdirSync(dir)).toEqual(["a.json"]);
  });

  it("tries the rename again when the target is busy for a moment", () => {
    const dir = folder();
    failRename.code = "EBUSY";
    failRename.times = 1;
    writeJson(join(dir, "b.json"), { b: 2 });
    expect(JSON.parse(readFileSync(join(dir, "b.json"), "utf8"))).toEqual({ b: 2 });
    expect(readdirSync(dir)).toEqual(["b.json"]);
  });

  it("writes in place when the target stays held open, rather than losing the save", () => {
    const dir = folder();
    failRename.code = "EPERM";
    failRename.times = 99;
    writeJson(join(dir, "c.json"), { c: 3 }, 2);
    expect(JSON.parse(readFileSync(join(dir, "c.json"), "utf8"))).toEqual({ c: 3 });
    expect(readdirSync(dir), "no temp file left behind").toEqual(["c.json"]);
  });

  it("still throws for a failure that is not a busy target", () => {
    const dir = folder();
    failRename.code = "ENOSPC";
    failRename.times = 99;
    expect(() => writeJson(join(dir, "d.json"), { d: 4 })).toThrow(/ENOSPC/);
    expect(readdirSync(dir)).toEqual([]);
  });
});
