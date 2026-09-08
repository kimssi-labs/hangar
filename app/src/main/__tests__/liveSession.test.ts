import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { FOCUS_SOURCE, focusSession, helperExecutable, helperName, parseOutcome } from "../liveSession.js";

describe("parseOutcome", () => {
  it("reads the helper's last line", () => {
    expect(parseOutcome('noise\n{"found":true,"owner":"WindowsTerminal","tab":true}\n'))
      .toEqual({ found: true, owner: "WindowsTerminal", tab: true });
  });

  it("a session with no window is not found", () => {
    expect(parseOutcome('{"found":false}')).toEqual({ found: false });
  });

  it("says what it could not read", () => {
    expect(parseOutcome("").found).toBe(false);
    expect(parseOutcome("garbage").error).toMatch(/garbage/);
  });
});

describe("the helper's source", () => {
  it("is named by its hash, so a changed source is a new build", () => {
    expect(helperName()).toMatch(/^hangar-focus-[0-9a-f]{12}\.exe$/);
    expect(helperName(`${FOCUS_SOURCE} `)).not.toBe(helperName());
  });

  it("stays within the C# 5 the framework compiler speaks: no interpolated strings, no ?., no => members", () => {
    expect(FOCUS_SOURCE).not.toMatch(/\$"|\?\.|\)\s*=>\s*[^{]/);
  });

  // The same expression as the helper's Strip(), so a change there shows up here.
  it("matches a tab by its title without Claude Code's spinner glyph", () => {
    const strip = (s: string): string => s.replace(/^[^\p{L}\p{N}\s]{1,2}\s+/u, "").trim();
    expect(strip("◑ Hangar Project")).toBe("Hangar Project");
    expect(strip("✳ ETG 문서 Alias 번호")).toBe("ETG 문서 Alias 번호");
    expect(strip("Claude")).toBe("Claude");
    expect(strip("pwsh")).toBe("pwsh");
    expect(FOCUS_SOURCE).toContain(String.raw`@"^[^\p{L}\p{N}\s]{1,2}\s+"`);
  });
});

/**
 * The real thing, on Windows: the source compiles with the framework's C# compiler and the program
 * runs against this very process without an error. Whether a window is found depends on where the
 * tests run (a CI runner's console has none), so only the error is asserted.
 */
describe.runIf(process.platform === "win32")("the compiled helper", () => {
  it("builds and runs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hangar-focus-test-"));
    const exe = await helperExecutable(dir);
    expect(exe, "compiled").toBeTruthy();
    const outcome = await focusSession(process.pid, dir);
    expect(outcome.error).toBeUndefined();
    expect(typeof outcome.found).toBe("boolean");
  }, 90_000);
});
