/**
 * Main: the updater's own log, so a failed update elsewhere can still be read.
 */
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { updateLogger } from "../updateLog.js";

describe("updateLogger", () => {
  it("writes each level with a time, and keeps what came before", () => {
    const file = join(mkdtempSync(join(tmpdir(), "hangar-log-")), "cache", "hangar-update.log");
    const log = updateLogger(file);
    log.info("checking for update");
    log.error(new Error("elevation refused"));

    const text = readFileSync(file, "utf8");
    expect(text).toContain("info  checking for update");
    expect(text).toContain("error elevation refused");
    expect(text.split("\n").filter(Boolean).length).toBeGreaterThanOrEqual(2);
    expect(text).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("rolls over instead of growing without end", () => {
    const file = join(mkdtempSync(join(tmpdir(), "hangar-log-")), "hangar-update.log");
    writeFileSync(file, "x".repeat(300 * 1024));
    updateLogger(file).info("after the rollover");
    expect(statSync(`${file}.old`).size).toBeGreaterThan(256 * 1024);
    expect(readFileSync(file, "utf8")).toContain("after the rollover");
  });

  it("says nothing and throws nothing when the file cannot be written", () => {
    expect(() => updateLogger("").info("nowhere")).not.toThrow();
  });
});
