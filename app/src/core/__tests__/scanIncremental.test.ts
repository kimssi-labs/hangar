/**
 * The incremental scan must say exactly what a full scan says.
 *
 * Every step below is checked against a brand-new Store, whose first scan is necessarily a full one.
 * The incremental store's clock is put well past the files' mtimes, so its folder listings are
 * trusted rather than re-read because they are fresh — otherwise these would pass without a cache.
 */
import { appendFileSync, closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { encodeProjectPath } from "../paths.js";
import { FULL_RESCAN_MS, scanSignature, Store } from "../store.js";
import type { ProjectInfo } from "../types.js";

const OLD = new Date(Date.now() - 3_600_000);
const line = (value: unknown): string => `${JSON.stringify(value)}\n`;
const ID = (n: number): string => `${String(n).repeat(8)}-1111-2222-3333-444444444444`;

function makeHome() {
  const root = mkdtempSync(join(tmpdir(), "cp-incr-"));
  const home = join(root, ".claude");
  const cwd = join(root, "Work", "Demo");
  const dir = encodeProjectPath(cwd);
  const project = join(home, "projects", dir);
  mkdirSync(project, { recursive: true });
  mkdirSync(join(home, "sessions"), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(root, ".claude.json"), JSON.stringify({ projects: { [cwd]: {} } }));
  const transcript = (id: string, prompt: string): string => {
    const file = join(project, `${id}.jsonl`);
    writeFileSync(file, line({ type: "user", cwd, sessionId: id, message: { content: prompt }, origin: { kind: "human" } })
      + line({ type: "assistant", message: { content: "…" } }));
    return file;
  };
  return { home, cwd, dir, project, transcript };
}

/** A clock that starts a minute ahead, so nothing on disk looks freshly written to the store. */
function clock() {
  let at = Date.now() + 60_000;
  return { now: () => at, advance: (ms: number) => { at += ms; } };
}

/** Compared as plain data, the way the page receives them. */
const rows = (projects: ProjectInfo[]): unknown => JSON.parse(JSON.stringify(projects));

describe("the incremental scan", () => {
  it("matches a full scan across new, deleted, renamed and retitled sessions and liveness changes", () => {
    const { home, project, transcript } = makeHome();
    let alive = new Set<number>();
    const isAlive = (pid: number): boolean => alive.has(pid);
    const time = clock();
    const incremental = new Store(home, { isAlive, folderExists: () => true, now: time.now });
    const fresh = (): ProjectInfo[] => new Store(home, { isAlive, folderExists: () => true }).scan();
    const same = (): void => {
      time.advance(15_000);
      expect(rows(incremental.scan())).toEqual(rows(fresh()));
    };

    const first = transcript(ID(1), "첫 세션");
    expect(rows(incremental.scan())).toEqual(rows(fresh()));

    transcript(ID(2), "새 세션");                                           // added
    same();

    unlinkSync(first);                                                      // deleted
    same();

    const second = incremental.scan()[0]!.sessions.find((s) => s.id === ID(2))!;
    incremental.renameSession(second, "붙인 이름");                          // renamed through the app
    same();

    // Running: the registry names it, then it retitles itself and is renamed from inside Claude Code.
    writeFileSync(join(home, "sessions", "77.json"), JSON.stringify({ pid: 77, sessionId: ID(2), status: "busy" }));
    alive = new Set([77]);
    same();
    appendFileSync(join(project, `${ID(2)}.jsonl`), line({ type: "ai-title", aiTitle: "생성된 제목" }));
    same();
    writeFileSync(join(project, ID(2), "custom-title.json"), JSON.stringify({ customTitle: "다시 붙인 이름" }));
    same();

    // It ends, and its last lines land after the scan that last saw it running.
    alive = new Set();
    appendFileSync(join(project, `${ID(2)}.jsonl`), line({ type: "ai-title", aiTitle: "마지막 제목" }));
    same();
    rmSync(join(project, ID(2)), { recursive: true, force: true });           // its custom title goes
    same();
  });

  it("re-reads everything every FULL_RESCAN_MS, catching what no running session wrote", () => {
    const { home, project, transcript } = makeHome();
    const time = clock();
    const store = new Store(home, { isAlive: () => false, folderExists: () => true, now: time.now });
    const file = transcript(ID(3), "조용한 세션");
    utimesSync(file, OLD, OLD);
    utimesSync(project, OLD, OLD);
    expect(store.scan()[0]?.sessions[0]?.title).toBe("조용한 세션");

    // Not running, folder untouched: the incremental pass keeps what it knew.
    appendFileSync(file, line({ type: "ai-title", aiTitle: "밖에서 쓴 제목" }));
    utimesSync(project, OLD, OLD);
    time.advance(15_000);
    expect(store.scan()[0]?.sessions[0]?.title).toBe("조용한 세션");
    expect(store.lastScanFull).toBe(false);

    time.advance(FULL_RESCAN_MS);
    expect(store.scan()[0]?.sessions[0]?.title).toBe("밖에서 쓴 제목");
    expect(store.lastScanFull).toBe(true);
  });

  it("gives an unchanged list the same signature, and a changed one another", () => {
    const { home, transcript } = makeHome();
    transcript(ID(4), "서명");
    const time = clock();
    const store = new Store(home, { isAlive: () => false, folderExists: () => true, now: time.now });
    const before = scanSignature(store.scan());
    time.advance(15_000);
    expect(scanSignature(store.scan())).toBe(before);
    transcript(ID(5), "하나 더");
    time.advance(15_000);
    expect(scanSignature(store.scan())).not.toBe(before);
  });
});

describe("history.jsonl", () => {
  const entry = (sessionId: string, display: string): string => line({ sessionId, display });

  it("parses only what was appended, keeping the first prompt per session", () => {
    const { home } = makeHome();
    const file = join(home, "history.jsonl");
    writeFileSync(file, entry("a", "에이 첫째") + entry("b", "비 첫째"));
    const store = new Store(home, { isAlive: () => false });
    expect([...store.historyTitles()]).toEqual([["a", "에이 첫째"], ["b", "비 첫째"]]);

    // Bytes already read are not read again: changing them in place (same length) shows nothing.
    writeFileSync(file, entry("a", "에이 바뀜") + entry("b", "비 첫째"));
    appendFileSync(file, entry("a", "에이 둘째") + entry("c", "씨 첫째"));
    expect([...store.historyTitles()]).toEqual([["a", "에이 첫째"], ["b", "비 첫째"], ["c", "씨 첫째"]]);
  });

  it("reads a line being written once it is whole", () => {
    const { home } = makeHome();
    const file = join(home, "history.jsonl");
    writeFileSync(file, entry("a", "에이"));
    const store = new Store(home, { isAlive: () => false });
    store.historyTitles();
    const whole = entry("d", "디");
    appendFileSync(file, whole.slice(0, 10));
    expect(store.historyTitles().has("d")).toBe(false);
    appendFileSync(file, whole.slice(10));
    expect(store.historyTitles().get("d")).toBe("디");
  });

  it("starts over when the file shrank", () => {
    const { home } = makeHome();
    const file = join(home, "history.jsonl");
    writeFileSync(file, entry("a", "에이 아주 긴 첫 프롬프트") + entry("b", "비"));
    const store = new Store(home, { isAlive: () => false });
    store.historyTitles();
    writeFileSync(file, entry("z", "새 파일"));
    expect([...store.historyTitles()]).toEqual([["z", "새 파일"]]);
  });
});

describe("a growing transcript's facts", () => {
  const KB = 1024;
  /** One assistant line of about `bytes` bytes. */
  const filler = (bytes: number): string => line({ type: "assistant", message: { content: "x".repeat(bytes) } });

  function grow(): { home: string; file: string; check: (store: Store) => void } {
    const { home, project, cwd } = makeHome();
    const file = join(project, `${ID(6)}.jsonl`);
    writeFileSync(file, line({ type: "user", cwd, message: { content: "처음 질문" }, origin: { kind: "human" } })
      + line({ type: "ai-title", aiTitle: "머리 제목" }));
    const check = (store: Store): void => {
      const st = statSync(file);
      const reference = new Store(home, { isAlive: () => false }).transcriptFacts(file, st);
      expect(store.transcriptFacts(file, st)).toEqual(reference);
    };
    return { home, file, check };
  }

  it("stays what a fresh read says, through the head window, the tail window and past it", () => {
    const { home, file, check } = grow();
    const store = new Store(home, { isAlive: () => false });
    check(store);
    appendFileSync(file, filler(100 * KB));                        // past the head window
    check(store);
    appendFileSync(file, line({ type: "ai-title", aiTitle: "중간 제목" }));   // between 64 KB and 512 KB
    check(store);
    // Claude Code rewrites the title as the talk grows; a mid-size session must show the newer one.
    expect(store.transcriptFacts(file, statSync(file)).aiTitle).toBe("중간 제목");
    appendFileSync(file, filler(500 * KB));                        // the tail window begins
    check(store);
    appendFileSync(file, line({ type: "ai-title", aiTitle: "꼬리 제목" }));
    check(store);
    expect(store.transcriptFacts(file, statSync(file)).aiTitle).toBe("꼬리 제목");
    const half = line({ type: "ai-title", aiTitle: "쓰는 중" });
    appendFileSync(file, half.slice(0, 12));                       // half a line: not yet
    check(store);
    appendFileSync(file, half.slice(12));
    check(store);
    appendFileSync(file, filler(600 * KB));                        // the title scrolls out of the window
    check(store);
    expect(store.transcriptFacts(file, statSync(file)).aiTitle).toBe("머리 제목");
  });
});

describe("a transcript past its head window", () => {
  it("is not read from the start again as it grows: its head facts are final", () => {
    const { home, project, cwd } = makeHome();
    const file = join(project, `${ID(7)}.jsonl`);
    writeFileSync(file, line({ type: "user", cwd, message: { content: "처음 질문" }, origin: { kind: "human" } })
      + line({ type: "assistant", message: { content: "x".repeat(100 * 1024) } }));
    const store = new Store(home, { isAlive: () => false });
    expect(store.transcriptFacts(file, statSync(file)).firstPrompt).toBe("처음 질문");

    // Rewrite the head in place, same length: only a store that reads the head again would notice.
    const handle = openSync(file, "r+");
    const at = readFileSync(file).indexOf(Buffer.from("처음"));
    writeSync(handle, Buffer.from("다른"), 0, Buffer.byteLength("다른"), at);
    closeSync(handle);
    appendFileSync(file, line({ type: "assistant", message: { content: "더" } }));
    expect(store.transcriptFacts(file, statSync(file)).firstPrompt).toBe("처음 질문");
  });
});
