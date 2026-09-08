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
    ...over,
  };
}

/** The measured case: a named session, /clear, the same name on the new transcript, the old one finished. */
const OLD = session({ id: "old", title: "번역기", named: true, prompt: "아래 내용을 영어 메시지로 번역해줘", startedAt: T0, modifiedAt: T0 + 5 * 3600_000 });
const NEW = session({ id: "new", title: "번역기", named: true, startedAt: T0 + 5 * 3600_000 + 1000, modifiedAt: T0 + 6 * 3600_000, live: true, pid: 4242, startedByClear: true });

describe("foldClears", () => {
  it("folds a finished session under the /clear successor of the same name, keeping the list's order", () => {
    const rows = foldClears([NEW, OLD]);                        // newest first, as the store hands them over
    expect(rows.map((r) => r.id)).toEqual(["new"]);
    expect(rows[0]!.continues).toBe(1);
    expect(rows[0]!.live).toBe(true);
    expect("startedByClear" in rows[0]!).toBe(false);
  });

  it("lends the predecessor's first prompt to a head that has none yet", () => {
    expect(foldClears([NEW, OLD])[0]!.prompt).toBe("아래 내용을 영어 메시지로 번역해줘");
    const typed = { ...NEW, prompt: "새 질문" };
    expect(foldClears([typed, OLD])[0]!.prompt).toBe("새 질문");
  });

  it("counts a chain of clears on its newest head", () => {
    const oldest = session({ id: "oldest", title: "번역기", named: true, startedAt: T0 - 3600_000, modifiedAt: T0 - 1000 });
    const middle = { ...OLD, startedByClear: true };
    const rows = foldClears([NEW, middle, oldest]);
    expect(rows.map((r) => r.id)).toEqual(["new"]);
    expect(rows[0]!.continues).toBe(2);
  });

  it("leaves a predecessor that is still running, or of another name, or unnamed", () => {
    expect(foldClears([NEW, { ...OLD, live: true, pid: 7 }]).map((r) => r.id)).toEqual(["new", "old"]);
    expect(foldClears([NEW, { ...OLD, title: "다른 이름" }]).map((r) => r.id)).toEqual(["new", "old"]);
    expect(foldClears([NEW, { ...OLD, named: false }]).map((r) => r.id)).toEqual(["new", "old"]);
    expect(foldClears([{ ...NEW, named: false }, OLD]).map((r) => r.id)).toEqual(["new", "old"]);
  });

  it("does not fold a session written long after the successor was born, nor one that was not started by /clear", () => {
    const late = { ...OLD, modifiedAt: NEW.startedAt + CLEAR_TOLERANCE_MS + 1 };
    expect(foldClears([NEW, late]).map((r) => r.id)).toEqual(["new", "old"]);
    expect(foldClears([{ ...NEW, startedByClear: false }, OLD]).map((r) => r.id)).toEqual(["new", "old"]);
  });
});
