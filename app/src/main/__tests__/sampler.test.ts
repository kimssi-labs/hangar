import { beforeEach, describe, expect, it, vi } from "vitest";

// The process table and per-pid readings, as the test decides them; `walks` counts table walks.
const machine = vi.hoisted(() => ({
  rows: [] as { pid: number; parentPid: number; cpu: number; memoryBytes: number }[],
  dead: new Set<number>(),
  walks: 0,
}));

vi.mock("../nativeMetrics.js", () => ({
  cpuTotals: () => ({ busy: 0, total: 0, ghz: null, cores: 4 }),
  machineMemory: () => ({ used: 1, total: 2 }),
  processTable: () => { machine.walks += 1; return machine.rows.filter((r) => !machine.dead.has(r.pid)); },
  processUsage: (pid: number) => (machine.dead.has(pid) ? null : { busyMs: 10, memoryBytes: pid }),
}));

import { resetSampler, sample, TREE_REFRESH_MS } from "../sampler.js";

const row = (pid: number, parentPid: number) => ({ pid, parentPid, cpu: 0, memoryBytes: 0 });

beforeEach(() => {
  resetSampler();
  machine.rows = [row(1, 0), row(100, 1), row(101, 100), row(102, 101), row(200, 1)];
  machine.dead = new Set();
  machine.walks = 0;
});

describe("the sampler", () => {
  it("walks the process table every few seconds, not every second, and still measures every second", async () => {
    const target = [{ sessionId: "s", pid: 100 }];
    for (let second = 0; second < 10; second += 1) {
      const snapshot = await sample(target, second * 1000);
      expect(snapshot.sessions["s"]?.memoryBytes).toBe(100 + 101 + 102);   // the whole tree, each time
    }
    expect(machine.walks).toBe(Math.ceil(10_000 / TREE_REFRESH_MS));
  });

  it("walks at once for a session it has not seen, and for a root that stopped answering", async () => {
    await sample([{ sessionId: "s", pid: 100 }], 0);
    await sample([{ sessionId: "s", pid: 100 }, { sessionId: "t", pid: 200 }], 1000);
    expect(machine.walks).toBe(2);

    machine.dead.add(100);
    const snapshot = await sample([{ sessionId: "s", pid: 100 }, { sessionId: "t", pid: 200 }], 2000);
    expect(machine.walks).toBe(3);
    expect(snapshot.sessions["s"]).toBeUndefined();                  // ended, as a fresh walk says
    expect(snapshot.sessions["t"]?.memoryBytes).toBe(200);
  });
});
