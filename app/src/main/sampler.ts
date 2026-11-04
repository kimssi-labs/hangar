/**
 * Where the CPU and memory numbers come from.
 *
 * Everything is read in-process (see nativeMetrics): one snapshot of the process table, then two
 * cheap queries per pid we actually track. A percentage is a rate, so each reading is the
 * difference from the previous one — which is also why the first sample of a process reads 0.
 */
import { cpuTotals, machineMemory, processTable, processUsage } from "./nativeMetrics.js";
import { childrenOf, processTree } from "../core/metrics.js";
import type { MetricsSnapshot } from "../core/types.js";

export const SAMPLE_INTERVAL_MS = 1000;
/**
 * How often the whole process table is walked to learn each session's tree.
 *
 * Walking it means a step per process on the machine — hundreds — to find the dozen we measure. In
 * between, the known pids are read directly: a child a session starts shows up within this long.
 * ponytail: a tree pid that ended and was handed to another process inside the window is measured
 * as that stranger until the next walk; Windows recycles pids slowly enough that it is not seen.
 */
export const TREE_REFRESH_MS = 5000;

export interface SessionTarget {
  sessionId: string;
  pid: number;
}

/** Busy milliseconds and wall-clock, per pid, from the previous sample. */
interface Previous {
  busyMs: number;
  at: number;
}

const lastProcess = new Map<number, Previous>();
let lastCpu: { busy: number; total: number } | null = null;
/** Root pid -> the pids of its tree (root first), as of the last walk of the table. */
let trees = new Map<number, number[]>();
let treesAt = Number.NEGATIVE_INFINITY;

/** Walk the table once and keep every target's tree from it. */
function walkTrees(targets: SessionTarget[], now: number): void {
  const rows = processTable();
  const children = childrenOf(rows);
  trees = new Map(targets.map((t) => [t.pid, processTree(rows, t.pid, children).map((row) => row.pid)]));
  treesAt = now;
}

/** Busy time over elapsed time, as a percentage of the whole machine. */
export function ratePercent(busyDeltaMs: number, elapsedMs: number, cores: number): number {
  if (elapsedMs <= 0 || cores <= 0) return 0;
  const percent = (busyDeltaMs / (elapsedMs * cores)) * 100;
  return Math.max(0, Math.min(100, Math.round(percent * 10) / 10));
}

/** Machine load from two readings of the same counters; 0 when there is no previous one. */
export function loadPercent(
  previous: { busy: number; total: number } | null,
  current: { busy: number; total: number },
): number {
  if (!previous) return 0;
  const total = current.total - previous.total;
  const busy = current.busy - previous.busy;
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((busy / total) * 1000) / 10));
}

export async function sample(targets: SessionTarget[], now = Date.now()): Promise<MetricsSnapshot> {
  const totals = cpuTotals();
  const cores = totals.cores;
  const cpu = loadPercent(lastCpu, totals);
  lastCpu = { busy: totals.busy, total: totals.total };

  const memory = machineMemory();
  const sessions: MetricsSnapshot["sessions"] = {};

  // The table is only needed when something is running; with no live session there is nothing to
  // attribute and the snapshot is two OS calls in total.
  if (targets.length) {
    // A fresh walk when the last is old, or a session is new to it; otherwise the trees it found.
    let walked = now - treesAt >= TREE_REFRESH_MS || targets.some((t) => !trees.has(t.pid));
    if (walked) walkTrees(targets, now);
    const alive = new Set<number>();
    for (const target of targets) {
      let tree = trees.get(target.pid) ?? [];
      let usages = tree.map((pid) => processUsage(pid));
      // A root that no longer answers may have ended: ask the table, exactly as a walk this second would.
      if (tree.length && !usages[0] && !walked) {
        walkTrees(targets, now);
        walked = true;
        tree = trees.get(target.pid) ?? [];
        usages = tree.map((pid) => processUsage(pid));
      }
      if (!tree.length) continue;                  // ended between the scan and this sample
      let busyMs = 0;
      let memoryBytes = 0;
      for (const usage of usages) {
        if (!usage) continue;
        busyMs += usage.busyMs;
        memoryBytes += usage.memoryBytes;
      }
      alive.add(target.pid);
      const previous = lastProcess.get(target.pid);
      lastProcess.set(target.pid, { busyMs, at: now });
      sessions[target.sessionId] = {
        cpu: previous ? ratePercent(busyMs - previous.busyMs, now - previous.at, cores) : 0,
        memoryBytes,
        pid: target.pid,
      };
    }
    for (const pid of lastProcess.keys()) if (!alive.has(pid)) lastProcess.delete(pid);
  } else {
    if (lastProcess.size) lastProcess.clear();
    trees.clear();
  }

  return {
    at: now,
    system: {
      cpu,
      memoryBytes: memory.used,
      memoryTotalBytes: memory.total,
      cpuGhz: totals.ghz,
    },
    sessions,
  };
}

/** Test seam: forget what the last sample saw. */
export function resetSampler(): void {
  lastProcess.clear();
  lastCpu = null;
  trees = new Map();
  treesAt = Number.NEGATIVE_INFINITY;
}
