/**
 * Core: a folder of headless runs goes under the project whose session started them, found by that
 * session's transcript naming the folder, whatever the folder is called or wherever it is.
 */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { linkSpawned, MentionIndex, offsetAt, spellings } from "../spawned.js";

const temp = mkdtempSync(join(tmpdir(), "hangar-spawned-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

const T0 = 1_700_000_000_000;
const MIN = 60_000;
const EOL = String.fromCharCode(10);

function transcript(name: string, text: string): string {
  const file = join(temp, name);
  writeFileSync(file, text);
  return file;
}

/** A transcript line written at `at`, carrying `text` (JSON doubles each backslash, as Claude Code's does). */
const line = (at: number, text: string): string => JSON.stringify({ timestamp: new Date(at).toISOString(), text }) + EOL;
/** Padding so the binary search has something to search: one 2 KB line a minute for `minutes`. */
const filler = (from: number, minutes: number): string =>
  Array.from({ length: minutes }, (_, i) => line(from + i * MIN, "x".repeat(2000))).join("");

const session = (file: string, headless: boolean, startedAt: number, modifiedAt: number) =>
  ({ file, headless, startedAt, modifiedAt });

describe("spellings", () => {
  it("covers the JSON, forward-slash and Git Bash forms of a Windows path", () => {
    expect(spellings("C:\\work\\runs\\b7")).toEqual(["C:\\\\work\\\\runs\\\\b7", "C:/work/runs/b7", "/c/work/runs/b7"]);
  });
});

describe("offsetAt", () => {
  it("lands at or before the first line written at a time, and close to it", () => {
    const file = transcript("time.jsonl", filler(T0, 600));
    const at = offsetAt(file, statSync(file).size, T0 + 300 * MIN);
    const target = readFileSync(file, "utf8").indexOf(new Date(T0 + 300 * MIN).toISOString());
    expect(at).toBeLessThanOrEqual(target);
    expect(target - at).toBeLessThan(200 * 1024);
  });
});

describe("MentionIndex", () => {
  it("finds a folder however the transcript spells it, and not a longer name it begins", () => {
    const file = transcript("a.jsonl", line(T0, "cd /c/work/out-1 && claude -p x") + line(T0, "C:\\work\\app-old"));
    const index = new MentionIndex();
    expect(index.names(file, "C:\\work\\out-1", T0 + MIN)).toBe(true);
    expect(index.names(file, "C:\\work\\app-old", T0 + MIN)).toBe(true);
    expect(index.names(file, "C:\\work\\app", T0 + MIN)).toBe(false);
  });

  it("looks only in the half hour before the run", () => {
    const file = transcript("b.jsonl", line(T0, "mkdir C:/work/early") + filler(T0 + MIN, 120) + line(T0 + 121 * MIN, "mkdir C:/work/late"));
    const index = new MentionIndex();
    expect(index.names(file, "C:\\work\\late", T0 + 122 * MIN)).toBe(true);
    expect(index.names(file, "C:\\work\\early", T0 + 122 * MIN)).toBe(false);
  });
});

describe("linkSpawned", () => {
  const starterFile = transcript("starter.jsonl",
    filler(T0, 9) + line(T0 + 9 * MIN, 'python make_bundle.py "D:\\tmp\\batch-x"') + filler(T0 + 10 * MIN, 50));
  const otherFile = transcript("other.jsonl", filler(T0, 60));
  const project = (dir: string, cwd: string, sessions: ReturnType<typeof session>[]) =>
    ({ dir, cwd, parentDir: null as string | null, sessions });
  const index = new MentionIndex();
  const names = (file: string, cwd: string, time: number) => index.names(file, cwd, time);

  it("tucks a folder of headless runs under the running session that named it", () => {
    const starter = project("main", "C:\\src\\main", [session(starterFile, false, T0, T0 + 60 * MIN)]);
    const other = project("other", "C:\\src\\other", [session(otherFile, false, T0, T0 + 60 * MIN)]);
    const runs = project("runs", "D:\\tmp\\batch-x", [session(join(temp, "r1"), true, T0 + 10 * MIN, T0 + 11 * MIN)]);
    linkSpawned([other, starter, runs], names);
    expect(runs.parentDir).toBe("main");
  });

  it("leaves a folder a person opened, or one no running session named, where it is", () => {
    const starter = project("main", "C:\\src\\main", [session(starterFile, false, T0, T0 + 60 * MIN)]);
    const typed = project("typed", "D:\\tmp\\batch-x", [session(join(temp, "t1"), false, T0 + 10 * MIN, T0 + 11 * MIN)]);
    const later = project("later", "D:\\tmp\\batch-x", [session(join(temp, "l1"), true, T0 + 90 * MIN, T0 + 91 * MIN)]);
    linkSpawned([starter, typed, later], names);
    expect(typed.parentDir).toBeNull();
    expect(later.parentDir).toBeNull();
  });
});
