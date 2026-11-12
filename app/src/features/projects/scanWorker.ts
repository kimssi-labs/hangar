/**
 * The project scan, on its own thread.
 *
 * A scan reads transcripts, and opening a file is synchronous on the thread that asks: on a machine
 * whose endpoint agent scans a large, growing transcript on every open, one `openSync` took 1.4 to
 * 2.4 s, and on the main thread the window froze for that long. Here it lands on nobody. The worker
 * keeps its own Store, so the caches that make a scan incremental live here between scans.
 *
 * It answers with the list only when it differs from the last one it sent; otherwise the signature
 * is enough, and a list of a few hundred sessions is not copied across every fifteen seconds.
 */
import { parentPort, workerData } from "node:worker_threads";

import { ConfigStore } from "../../core/config.js";
import { scanSignature, Store } from "../../core/store.js";
import type { ProjectInfo } from "../../core/types.js";
import { scanAll, scanState, type ScanState } from "./scanAll.js";

/** Set in `workerData` by the host, so importing this module anywhere else starts nothing. */
export const SCAN_WORKER_MARK = "hangarScanWorker";

export type ScanCommand = { kind: "scan"; id: number } | { kind: "watch" };

export type ScanReply =
  | { id: number; signature: string; projects?: ProjectInfo[]; full: boolean; ms: number }
  | { id: number; error: string };

/** After a registry watch: the sessions running now, for the list the next start offers (core/openSessions.ts). */
export interface LiveReply { live: string[] }

export interface Scanner {
  store: Store;
  config: ConfigStore;
  state: ScanState;
  /** The signature of the list the main thread holds, so an unchanged one is not sent again. */
  held: string | null;
}

export function scanner(): Scanner {
  const config = new ConfigStore();
  return { store: new Store(undefined, { config }), config, state: scanState(), held: null };
}

/** One command, answered. Never throws. */
export function handle(command: ScanCommand, from: Scanner): ScanReply | LiveReply {
  if (command.kind === "watch") {
    try {
      from.store.watchRegistry();
      return { live: [...from.store.liveSessions().keys()] };
    } catch {
      return { live: [] };                          // the next watch tries again
    }
  }
  const started = Date.now();
  try {
    const projects = scanAll(from.store, from.config, from.state);
    const signature = scanSignature(projects);
    const changed = signature !== from.held;
    from.held = signature;
    return { id: command.id, signature, ...(changed ? { projects } : {}), full: from.store.lastScanFull, ms: Date.now() - started };
  } catch (error) {
    return { id: command.id, error: (error as Error).message };
  }
}

if (parentPort && (workerData as Record<string, unknown> | null)?.[SCAN_WORKER_MARK]) {
  const port = parentPort;
  const own = scanner();
  port.on("message", (command: ScanCommand) => {
    port.postMessage(handle(command, own));
  });
}
