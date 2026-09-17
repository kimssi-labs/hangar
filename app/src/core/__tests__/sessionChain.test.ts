/**
 * Core: a conversation that moved into a new transcript is one row, not two.
 *
 * The cases here are the shapes measured on this machine. The rule used to ask for a name on both
 * sides and for the two names to match, which almost never held — the list grew a row on every
 * /clear, which is what this replaces.
 */
import { describe, expect, it } from "vitest";

import { CLEAR_TOLERANCE_MS, foldClears, type SessionWithOrigin } from "../sessionChain.js";

const T0 = 1_700_000_000_000;

function session(over: Partial<SessionWithOrigin> & { id: string }): SessionWithOrigin {
  return {
    file: `${over.id}.jsonl`,
    title: over.id,
    named: false,
    prompt: "",
    startedAt: T0,
    modifiedAt: T0,
    bytes: 1,
    live: false,
    pid: null,
    pinned: false,
    continues: 0,
    startedByClear: false,
    carriedTitle: null,
    ...over,
  };
}

/** The measured case: a named session, /clear, the same name carried over, the old one finished. */
const OLD = session({ id: "old", title: "번역기", named: true, prompt: "아래 내용을 영어 메시지로 번역해줘", startedAt: T0, modifiedAt: T0 + 5 * 3600_000 });
const NEW = session({
  id: "new", title: "번역기", named: true, startedAt: T0 + 5 * 3600_000 + 1000, modifiedAt: T0 + 6 * 3600_000,
  live: true, pid: 4242, startedByClear: true, carriedTitle: "번역기",
});

describe("foldClears", () => {
  it("folds the finished session under the one that carried on, keeping the list's order", () => {
    const rows = foldClears([NEW, OLD]);                        // newest first, as the store hands them over
    expect(rows.map((r) => r.id)).toEqual(["new"]);
    expect(rows[0]!.continues).toBe(1);
    expect(rows[0]!.live).toBe(true);
    expect("startedByClear" in rows[0]!).toBe(false);
    expect("carriedTitle" in rows[0]!).toBe(false);
  });

  it("folds a /clear whatever the two are called — the new conversation names itself", () => {
    // Measured: /clear on an unnamed session leaves the old title behind and earns a new one, so
    // waiting for the names to match meant waiting forever, and the rows piled up.
    const cleared = { ...NEW, title: "새 주제", named: false, carriedTitle: null };
    expect(foldClears([cleared, OLD]).map((r) => r.id)).toEqual(["new"]);
  });

  it("folds a transcript that only carried a name in, when it is the same name", () => {
    // Measured: a conversation moved into a new file with "WMX3_ENGINE CreateDevice 오류 268" as its
    // first lines and no /clear echo at all.
    const moved = { ...NEW, startedByClear: false, carriedTitle: "번역기" };
    expect(foldClears([moved, OLD]).map((r) => r.id)).toEqual(["new"]);
  });

  it("never lets a session started with a name of its own swallow the one beside it", () => {
    // Hangar opens a named session with --name, so its transcript carries a name in too. A name
    // that is not the neighbour's is a new session, however close together they were started.
    const named = { ...NEW, startedByClear: false, carriedTitle: "다른 이름", title: "다른 이름" };
    expect(foldClears([named, OLD]).map((r) => r.id)).toEqual(["new", "old"]);
  });

  it("lends the predecessor's first prompt to a head that has none yet", () => {
    expect(foldClears([NEW, OLD])[0]!.prompt).toBe("아래 내용을 영어 메시지로 번역해줘");
    const typed = { ...NEW, prompt: "새 질문" };
    expect(foldClears([typed, OLD])[0]!.prompt).toBe("새 질문");
  });

  it("counts a chain of clears on its newest head", () => {
    const oldest = session({ id: "oldest", title: "번역기", named: true, startedAt: T0 - 3600_000, modifiedAt: T0 - 1000 });
    const middle = { ...OLD, startedByClear: true, carriedTitle: "번역기", startedAt: T0 };
    const rows = foldClears([NEW, middle, oldest]);
    expect(rows.map((r) => r.id)).toEqual(["new"]);
    expect(rows[0]!.continues).toBe(2);
  });

  it("takes the session that ended nearest the new one's birth, not just any of them", () => {
    const earlier = session({ id: "earlier", title: "다른 일", startedAt: T0 - 3600_000, modifiedAt: NEW.startedAt - 40_000 });
    const nearest = session({ id: "nearest", title: "바로 앞", startedAt: T0, modifiedAt: NEW.startedAt - 500 });
    expect(foldClears([NEW, nearest, earlier]).map((r) => r.id)).toEqual(["new", "earlier"]);
  });

  it("folds them even when the filesystem gives both the same birth, to the second", () => {
    // Linux CI kept both rows where Windows folded them: /clear writes the new transcript within a
    // millisecond of the old one's last line, and a clock that only counts seconds cannot tell the
    // two births apart. What orders them then is which one stopped being written.
    const ended = { ...OLD, startedAt: T0, modifiedAt: T0 };          // wrote its last line at T0
    const sameSecond = { ...NEW, startedAt: T0, modifiedAt: T0 + 3600_000 };   // and this one was born at T0 too
    expect(foldClears([sameSecond, ended]).map((r) => r.id)).toEqual(["new"]);
  });

  it("never folds a session that is still being written under one that stopped first", () => {
    const younger = { ...OLD, modifiedAt: NEW.modifiedAt + 1000 };
    expect(foldClears([NEW, younger]).map((r) => r.id)).toEqual(["new", "old"]);
  });

  it("leaves a predecessor that is still running: two processes are two rows", () => {
    expect(foldClears([NEW, { ...OLD, live: true, pid: 7 }]).map((r) => r.id)).toEqual(["new", "old"]);
  });

  it("leaves one written long after the successor was born, and one that carried on from nothing", () => {
    const late = { ...OLD, modifiedAt: NEW.startedAt + CLEAR_TOLERANCE_MS + 1 };
    expect(foldClears([NEW, late]).map((r) => r.id)).toEqual(["new", "old"]);
    const ordinary = { ...NEW, startedByClear: false, carriedTitle: null };
    expect(foldClears([ordinary, OLD]).map((r) => r.id)).toEqual(["new", "old"]);
  });
});
