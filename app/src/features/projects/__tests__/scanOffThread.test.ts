/**
 * Backend: the project scan runs on its worker, never on the thread that draws the window.
 *
 * A scan opens transcripts, and opening a file is synchronous on the thread that asks: on a machine
 * whose endpoint agent scans a large, growing transcript on every open, one open took 1.4 to 2.4 s,
 * and the window froze for as long. The worker is faked here so each answer is in the test's hands.
 */
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { ScanCommand, Scanner } from "../scanWorker.js";

const workers: FakeWorker[] = [];

class FakeWorker extends EventEmitter {
  asked: ScanCommand[] = [];
  constructor() {
    super();
    workers.push(this);
  }
  postMessage(command: ScanCommand): void { this.asked.push(command); }
  unref(): void { /* nothing holds the test open */ }
  /** Answer the oldest scan not yet answered with a list of one project per name. */
  answer(...names: string[]): void {
    const scans = this.asked.filter((c): c is { kind: "scan"; id: number } => c.kind === "scan");
    const id = scans[this.answered++]?.id ?? 0;
    const projects = names.map((dir) => ({ dir, sessions: [] }));
    this.emit("message", { id, signature: names.join(","), projects, full: false, ms: 1 });
  }
  answered = 0;
}

vi.mock("node:worker_threads", () => ({ Worker: FakeWorker, parentPort: null, workerData: null }));

const { ConfigStore } = await import("../../../core/config.js");
const { encodeProjectPath } = await import("../../../core/paths.js");
const { Store } = await import("../../../core/store.js");
const { register } = await import("../main.js");
const { scanState } = await import("../scanAll.js");
const { handle } = await import("../scanWorker.js");

const scratch = mkdtempSync(join(tmpdir(), "hangar-scanhost-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let homes = 0;

function feature() {
  const openFile = join(scratch, `open-${homes++}.json`);
  const store = { scan: vi.fn(() => []), watchRegistry: vi.fn(), paths: { hangarOpenSessions: openFile } };
  const ctx = { config: { git: () => ({ enabled: false }) }, store, window: () => null };
  const wire = { bind: () => undefined, emit: () => undefined };
  return { store, openFile, projects: register(ctx as never, wire as never, { scanned: () => undefined }) };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => { workers.length = 0; });

describe("the project scan", () => {
  it("is asked of the worker, and the window's thread reads no transcript", async () => {
    const { store, projects } = feature();
    const scanned = projects.scan();
    await settle();
    workers[0]?.answer("a", "b");
    expect((await scanned).map((p) => p.dir)).toEqual(["a", "b"]);
    expect(store.scan).not.toHaveBeenCalled();
    projects.watchRegistry();
    expect(workers[0]?.asked.at(-1)).toEqual({ kind: "watch" });
    expect(store.watchRegistry).not.toHaveBeenCalled();
  });

  it("writes down the sessions the worker reports running after a registry watch", async () => {
    const { projects, openFile } = feature();
    projects.watchRegistry();
    await settle();
    workers[0]?.emit("message", { live: ["s1", "s2"] });
    expect(JSON.parse(readFileSync(openFile, "utf8")).sessions).toEqual(["s1", "s2"]);
  });

  it("asked while one runs, answers from a scan that started after it", async () => {
    const { projects } = feature();
    const first = projects.scan();
    const second = projects.scan();                // a rename landed while the first was reading
    const third = projects.scan();
    await settle();
    workers[0]?.answer("before");
    expect((await first).map((p) => p.dir)).toEqual(["before"]);
    await settle();
    expect(workers[0]?.asked.filter((c) => c.kind === "scan")).toHaveLength(2);   // one more, shared
    workers[0]?.answer("after");
    expect((await second).map((p) => p.dir)).toEqual(["after"]);
    expect((await third).map((p) => p.dir)).toEqual(["after"]);
  });

  it("is done on the main thread instead when the worker dies, so nobody waits forever", async () => {
    const { store, projects } = feature();
    const scanned = projects.scan();
    await settle();
    workers[0]?.emit("exit", 1);
    expect(await scanned).toEqual([]);
    expect(store.scan).toHaveBeenCalledTimes(1);
  });
});

describe("the worker's answer", () => {
  const root = mkdtempSync(join(tmpdir(), "hangar-scanworker-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("carries the list only when it changed since the last one sent", () => {
    const home = join(root, ".claude");
    const cwd = join(root, "Work");
    const project = join(home, "projects", encodeProjectPath(cwd));
    mkdirSync(project, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    const id = "11111111-1111-2222-3333-444444444444";
    writeFileSync(join(project, `${id}.jsonl`), `${JSON.stringify({ type: "user", cwd, sessionId: id, message: { content: "hi" } })}\n`);
    const config = new ConfigStore(home);
    const from: Scanner = { store: new Store(home, { config }), config, state: scanState(), held: null };

    const first = handle({ kind: "scan", id: 1 }, from);
    expect(first && "projects" in first && first.projects?.[0]?.sessions).toHaveLength(1);
    const second = handle({ kind: "scan", id: 2 }, from);
    expect(second && "signature" in second && second.signature).toBe(first && "signature" in first && first.signature);
    expect(second && "projects" in second).toBe(false);
  });
});
