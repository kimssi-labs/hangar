/**
 * Looking a program up on PATH: windowless, and asked once while the answer stands.
 */
import { describe, expect, it, vi } from "vitest";

// Answers as `where` does — the first match first — with a file that really exists, so a found path
// is one the cache may keep.
const execFileSync = vi.hoisted(() => vi.fn((..._args: unknown[]) => `${process.execPath}\r\nC:\\elsewhere\\twin.exe\r\n`));
vi.mock("node:child_process", () => ({ execFileSync }));

import { which } from "../executables.js";

describe("which", () => {
  it("asks without opening a console window", () => {
    // `where.exe` is a console program, and Hangar is not one: started without windowsHide, each
    // lookup could flash a console window over whatever the person was doing.
    expect(which("found-once")).toBe(process.execPath);
    expect(execFileSync.mock.calls[0]?.[2]).toMatchObject({ windowsHide: true });
  });

  it("keeps a path it found while the file is still there", () => {
    const before = execFileSync.mock.calls.length;
    which("kept");
    which("kept");
    expect(execFileSync.mock.calls.length - before).toBe(1);
  });
});
