/**
 * Where the project scan runs: on the scan worker (scanWorker.ts), so no transcript is opened on
 * the thread that draws the window.
 *
 * One scan at a time. A scan asked for while one runs waits for it and then runs once more, so a
 * rename or a delete is in the answer it gets; any number of such asks share that one extra scan.
 * If the worker cannot start, or dies, the scans run on the main thread as they always did: slower
 * to the eye on a machine that scans files on open, never missing.
 */
import { join } from "node:path";
import { Worker } from "node:worker_threads";

import type { ConfigStore } from "../../core/config.js";
import type { Store } from "../../core/store.js";
import type { ProjectInfo } from "../../core/types.js";
import { scanState } from "./scanAll.js";
import { handle, SCAN_WORKER_MARK, type ScanCommand, type Scanner, type ScanReply } from "./scanWorker.js";

const WORKER_SCRIPT = join(__dirname, "scanWorker.js");

export interface ScanResult {
  projects: ProjectInfo[];
  signature: string;
  full: boolean;
  ms: number;
}

export interface ScanHost {
  scan(): Promise<ScanResult>;
  /** Note a session that changed hands — done where the scan runs, whose links file it is. */
  watchRegistry(): void;
}

export function scanHost(store: Store, config: ConfigStore, script = WORKER_SCRIPT): ScanHost {
  const local: Scanner = { store, config, state: scanState(), held: null };
  let held: ScanResult = { projects: [], signature: "", full: false, ms: 0 };
  let worker: Worker | null = null;
  let failed = false;
  let nextId = 0;
  const pending = new Map<number, (reply: ScanReply | null) => void>();
  let running: Promise<ScanResult> | null = null;
  let again: Promise<ScanResult> | null = null;

  function accept(reply: ScanReply | null): ScanResult {
    if (!reply || "error" in reply) {
      if (reply) console.error("[hangar] scan failed:", reply.error);
      return held;                                  // the last good list stands
    }
    held = { projects: reply.projects ?? held.projects, signature: reply.signature, full: reply.full, ms: reply.ms };
    return held;
  }

  function scanHere(): ScanResult {
    local.held = null;                              // the list always comes back from a scan here
    return accept(handle({ kind: "scan", id: 0 }, local));
  }

  function lose(dead: Worker, why: string): void {
    if (worker !== dead) return;
    worker = null;
    failed = true;
    console.error("[hangar] scan worker ended, scanning in-process:", why);
    for (const [id, answer] of pending) {
      pending.delete(id);
      answer(null);
    }
  }

  function start(): Worker | null {
    if (worker || failed) return worker;
    try {
      const started = new Worker(script, { workerData: { [SCAN_WORKER_MARK]: true } });
      started.on("message", (reply: ScanReply) => {
        const answer = pending.get(reply.id);
        pending.delete(reply.id);
        answer?.(reply);
      });
      started.on("error", (error) => lose(started, error.message));
      started.on("exit", (code) => lose(started, `exit ${code}`));
      started.unref();                              // never what holds the app open
      worker = started;
    } catch (error) {
      failed = true;
      console.error("[hangar] scan worker unavailable, scanning in-process:", (error as Error).message);
    }
    return worker;
  }

  function scanOnce(): Promise<ScanResult> {
    const on = start();
    if (!on) return Promise.resolve(scanHere());
    return new Promise((resolve) => {
      const id = ++nextId;
      // A worker lost mid-scan answers null: that scan is then done here, so no caller waits forever.
      pending.set(id, (reply) => resolve(reply ? accept(reply) : scanHere()));
      on.postMessage({ kind: "scan", id } satisfies ScanCommand);
    });
  }

  function scan(): Promise<ScanResult> {
    if (!running) {
      running = scanOnce().finally(() => { running = null; });
      return running;
    }
    again ??= running.then(() => {
      again = null;
      return scan();
    });
    return again;
  }

  function watchRegistry(): void {
    const on = start();
    if (on) on.postMessage({ kind: "watch" } satisfies ScanCommand);
    else store.watchRegistry();
  }

  return { scan, watchRegistry };
}
