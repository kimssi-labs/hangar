import { describe, expect, it, vi } from "vitest";

import type { MetricsSnapshot } from "@core/types";

import { appendCapped, createMetricsStore, HISTORY_LIMIT, NO_SAMPLES } from "../store.js";

const snapshot = (at: number, sessions: Record<string, number> = {}): MetricsSnapshot => ({
  at,
  system: { cpu: at, memoryBytes: at * 10, memoryTotalBytes: 1000, cpuGhz: 3.2 },
  sessions: Object.fromEntries(Object.entries(sessions).map(([id, cpu]) => [id, { cpu, memoryBytes: cpu, pid: 1 }])),
});

describe("appendCapped", () => {
  it("adds to the end and drops the oldest past the limit, without touching the input", () => {
    const input = [1, 2, 3].map((at) => ({ at, cpu: 0, memoryBytes: 0 }));
    const out = appendCapped(input, { at: 4, cpu: 0, memoryBytes: 0 }, 3);
    expect(out.map((s) => s.at)).toEqual([2, 3, 4]);
    expect(input.map((s) => s.at)).toEqual([1, 2, 3]);
  });
});

describe("metrics store", () => {
  it("tells its subscribers about a sample, and stops once they unsubscribe", () => {
    const store = createMetricsStore();
    const listener = vi.fn();
    const off = store.subscribe(listener);
    store.push(snapshot(1));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.get().system.map((s) => s.at)).toEqual([1]);
    expect(store.get().cpuGhz).toBe(3.2);
    off();
    store.push(snapshot(2));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("keeps at most HISTORY_LIMIT samples a series", () => {
    const store = createMetricsStore();
    for (let at = 0; at < HISTORY_LIMIT + 5; at += 1) store.push(snapshot(at, { a: at }));
    expect(store.get().system).toHaveLength(HISTORY_LIMIT);
    expect(store.get().system[0]?.at).toBe(5);
    expect(store.sessionSamples("a")).toHaveLength(HISTORY_LIMIT);
  });

  it("caps the history it loads too", () => {
    const store = createMetricsStore();
    const many = Array.from({ length: HISTORY_LIMIT + 1 }, (_, at) => ({ at, cpu: 0, memoryBytes: 0 }));
    store.load({ system: many, sessions: { a: many } });
    expect(store.get().system).toHaveLength(HISTORY_LIMIT);
    expect(store.sessionSamples("a")).toHaveLength(HISTORY_LIMIT);
  });

  it("ignores samples while the window is hidden, and takes them again once it is not", () => {
    let hidden = true;
    const store = createMetricsStore(() => hidden);
    const listener = vi.fn();
    store.subscribe(listener);
    expect(store.push(snapshot(1))).toBe(false);
    expect(listener).not.toHaveBeenCalled();
    expect(store.get().system).toEqual([]);
    hidden = false;
    expect(store.push(snapshot(2))).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("hands a session's series back as the same array until that series changes", () => {
    const store = createMetricsStore();
    store.push(snapshot(1, { a: 5 }));
    const first = store.sessionSamples("a");
    expect(store.sessionSamples("a")).toBe(first);
    store.push(snapshot(2, { a: 6 }));
    expect(store.sessionSamples("a")).not.toBe(first);
    expect(store.sessionSamples("a").map((s) => s.cpu)).toEqual([5, 6]);
    expect(store.sessionSamples("gone")).toBe(NO_SAMPLES);
    expect(store.sessionSamples(null)).toBe(NO_SAMPLES);
  });

  it("forgets a session that is no longer running", () => {
    const store = createMetricsStore();
    store.push(snapshot(1, { a: 5 }));
    store.push(snapshot(2, {}));
    expect(store.sessionSamples("a")).toBe(NO_SAMPLES);
  });

  it("reads as nothing while monitoring is off, and notifies only on a real change", () => {
    const store = createMetricsStore();
    store.push(snapshot(1, { a: 5 }));
    const listener = vi.fn();
    store.subscribe(listener);
    store.setOn(false);
    store.setOn(false);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.sessionSamples("a")).toBe(NO_SAMPLES);
    store.setOn(true);
    expect(store.sessionSamples("a")).toHaveLength(1);
  });
});
