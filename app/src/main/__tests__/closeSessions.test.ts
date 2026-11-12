/**
 * Backend: what the close helper reports, and that nothing is started for no sessions.
 */
import { describe, expect, it } from "vitest";

import { closeSessions, parseClose } from "../closeSessions.js";

describe("the close helper", () => {
  it("reads the helper's last line, and nothing for output it does not recognise", () => {
    expect(parseClose('noise\r\n{"ended":2,"closed":1}')).toEqual({ ended: 2, closed: 1 });
    expect(parseClose("not json")).toEqual({ ended: 0, closed: 0 });
  });

  it("does nothing at all when there is nothing to close", async () => {
    expect(await closeSessions([], "unused")).toEqual({ ended: 0, closed: 0 });
  });
});

describe("gone", () => {
  it("is false for a process that runs, true for a pid that does not", async () => {
    const { gone } = await import("../closeSessions.js");
    expect(gone(process.pid)).toBe(false);
    expect(gone(2 ** 22 + 12345)).toBe(true);
  });
});
