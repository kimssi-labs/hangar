/**
 * Core: the app writes down which session replaced which, from the registry it reads anyway.
 *
 * Measured on this machine with a throwaway session: typing /clear left `sessions/<pid>.json` on the
 * same pid and swapped the session id (1752: 8fb045e6 → e317e73d). That swap is the only exact
 * statement that two transcripts are one conversation.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { MAX_CHAINS, observe, replacedBy, SessionLinks } from "../sessionLinks.js";

const START = "134341177201652422";

describe("observe", () => {
  it("records the same terminal moving to a new session", () => {
    const seen = { "1752": { sessionId: "old", procStart: START } };
    const result = observe(seen, [{ pid: 1752, sessionId: "new", procStart: START }]);
    expect(result.chains).toEqual([{ from: "old", to: "new" }]);
    expect(result.seen["1752"]).toEqual({ sessionId: "new", procStart: START });
  });

  it("says nothing about a session that has not changed, or one it sees for the first time", () => {
    const seen = { "1752": { sessionId: "old", procStart: START } };
    expect(observe(seen, [{ pid: 1752, sessionId: "old", procStart: START }]).chains).toEqual([]);
    expect(observe({}, [{ pid: 1752, sessionId: "old", procStart: START }]).chains).toEqual([]);
  });

  it("never links across a recycled pid: another process, another start time", () => {
    const seen = { "1752": { sessionId: "old", procStart: START } };
    const result = observe(seen, [{ pid: 1752, sessionId: "new", procStart: "134341999999999999" }]);
    expect(result.chains).toEqual([]);
  });

  it("forgets a pid the registry no longer lists", () => {
    const seen = { "1752": { sessionId: "old", procStart: START } };
    expect(observe(seen, []).seen).toEqual({});
  });

  it("maps a successor to what it replaced", () => {
    expect(replacedBy([{ from: "a", to: "b" }, { from: "b", to: "c" }]).get("c")).toBe("b");
  });
});

describe("SessionLinks", () => {
  it("keeps what it saw across a restart, and nothing about who is running now", () => {
    const file = join(mkdtempSync(join(tmpdir(), "links-")), "cache", "hangar-chains.json");
    const links = new SessionLinks(file);
    links.observe([{ pid: 7, sessionId: "old", procStart: START }]);
    links.observe([{ pid: 7, sessionId: "new", procStart: START }]);
    expect(links.map().get("new")).toBe("old");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ chains: [{ from: "old", to: "new" }] });
    expect(new SessionLinks(file).map().get("new")).toBe("old");
  });

  it("starts clean on a file that is not ours, and caps what it keeps", () => {
    const dir = mkdtempSync(join(tmpdir(), "links-"));
    const broken = join(dir, "broken.json");
    writeFileSync(broken, "not json at all");
    expect(new SessionLinks(broken).map().size).toBe(0);

    const file = join(dir, "many.json");
    const chains = Array.from({ length: MAX_CHAINS + 20 }, (_, i) => ({ from: `f${i}`, to: `t${i}` }));
    writeFileSync(file, JSON.stringify({ chains }));
    const links = new SessionLinks(file);
    links.observe([{ pid: 1, sessionId: "a", procStart: START }]);
    links.observe([{ pid: 1, sessionId: "b", procStart: START }]);
    const kept = JSON.parse(readFileSync(file, "utf8")).chains as { to: string }[];
    expect(kept.length).toBe(MAX_CHAINS);
    expect(kept[kept.length - 1]).toEqual({ from: "a", to: "b" });
  });
});
