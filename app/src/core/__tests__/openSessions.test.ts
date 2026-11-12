/**
 * Core: the sessions a run had open, kept through a reboot and dropped when closed by hand.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { CLOSED_GRACE_MS, OpenSessions, restorable } from "../openSessions.js";

const root = mkdtempSync(join(tmpdir(), "hangar-open-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const fileFor = () => join(root, `open-${n++}.json`);

function clock() {
  let at = 1_000_000;
  return { now: () => at, advance: (ms: number) => { at += ms; } };
}

describe("OpenSessions", () => {
  it("adds a session at once, and drops it only after it stayed stopped for the grace", () => {
    const file = fileFor();
    const time = clock();
    const open = new OpenSessions(file, time.now);
    open.observe(["a", "b"]);
    expect(JSON.parse(readFileSync(file, "utf8")).sessions).toEqual(["a", "b"]);
    open.observe(["a"]);
    time.advance(CLOSED_GRACE_MS - 1);
    open.observe(["a"]);
    expect(JSON.parse(readFileSync(file, "utf8")).sessions).toEqual(["a", "b"]);   // b may be a reboot under way
    time.advance(1);
    open.observe(["a"]);
    expect(JSON.parse(readFileSync(file, "utf8")).sessions).toEqual(["a"]);        // closed by hand
  });

  it("keeps what a reboot ended, and the next run starts knowing it", () => {
    const file = fileFor();
    const time = clock();
    const first = new OpenSessions(file, time.now);
    first.observe(["a", "b"]);
    first.observe([]);                                                           // the terminals end...
    time.advance(5_000);                                                         // ...and so does the app
    const next = new OpenSessions(file, time.now);
    expect(next.before).toEqual(["a", "b"]);
  });

  it("lets go at once of sessions the person said no to", () => {
    const file = fileFor();
    const open = new OpenSessions(file, clock().now);
    open.observe(["a", "b"]);
    open.forget(["a"]);
    expect(JSON.parse(readFileSync(file, "utf8")).sessions).toEqual(["b"]);
  });

  it("forgets a stop when the session comes back before the grace is up", () => {
    const file = fileFor();
    const time = clock();
    const open = new OpenSessions(file, time.now);
    open.observe(["a"]);
    open.observe([]);
    time.advance(CLOSED_GRACE_MS / 2);
    open.observe(["a"]);
    time.advance(CLOSED_GRACE_MS);
    open.observe(["a"]);
    expect(JSON.parse(readFileSync(file, "utf8")).sessions).toEqual(["a"]);
  });
});

describe("restorable", () => {
  const session = (id: string, extra: Partial<{ folded: string[]; headless: boolean; live: boolean }> = {}) =>
    ({ id, title: `t-${id}`, folded: [], headless: false, live: false, ...extra });

  it("offers the stopped sessions a person opened, once each, under the row a /clear folded them into", () => {
    const projects = [
      { dir: "p1", sessions: [session("a"), session("b", { live: true }), session("c", { headless: true })] },
      { dir: "p2", sessions: [session("d", { folded: ["old-d"] })] },
    ];
    expect(restorable(["a", "b", "c", "old-d", "d", "gone"], projects)).toEqual([
      { projectDir: "p1", sessionId: "a", title: "t-a" },
      { projectDir: "p2", sessionId: "d", title: "t-d" },
    ]);
  });
});
