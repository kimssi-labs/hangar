/**
 * Backend: the sampler thread's lifetime. Leaving while it is inside a native call aborts the whole
 * process (koffi throws into the terminating isolate, exit 134), so the way out waits for it to end,
 * however long that takes, and nothing may start it again once the app is leaving.
 */
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const workers: FakeWorker[] = [];

class FakeWorker extends EventEmitter {
  messages: unknown[] = [];
  constructor() {
    super();
    workers.push(this);
  }
  postMessage(message: unknown): void { this.messages.push(message); }
  unref(): void { /* nothing holds the test open */ }
}

vi.mock("node:worker_threads", () => ({ Worker: FakeWorker }));

const { register } = await import("../main.js");

function feature() {
  const ctx = { config: { ui: () => ({ monitor: true }) }, window: () => null };
  const wire = { bind: () => undefined, emit: () => undefined };
  return register(ctx as never, wire as never, { targets: () => [] });
}

beforeEach(() => { workers.length = 0; });

describe("the sampler's lifetime", () => {
  it("is not left behind: shutdown resolves only once the thread has ended, without a time limit", async () => {
    vi.useFakeTimers();
    const metrics = feature();
    metrics.start();
    let done = false;
    const leaving = metrics.shutdown().then(() => { done = true; });
    expect(workers[0]?.messages).toContainEqual({ stop: true });
    await vi.advanceTimersByTimeAsync(60_000);                // a busy desk: the sample is still in flight
    expect(done).toBe(false);
    workers[0]?.emit("exit", 0);
    await leaving;
    expect(done).toBe(true);
    vi.useRealTimers();
  });

  it("is not started again once the app is leaving, but a plain stop may be followed by a start", async () => {
    const metrics = feature();
    metrics.start();
    const stopped = metrics.stop();
    workers[0]?.emit("exit", 0);
    await stopped;
    metrics.start();
    expect(workers).toHaveLength(2);                          // the monitor switched back on

    const leaving = metrics.shutdown();
    workers[1]?.emit("exit", 0);
    await leaving;
    metrics.start();                                          // a settings change arriving on the way out
    expect(workers).toHaveLength(2);
  });
});
