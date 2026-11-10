/**
 * `execFile`, started on a worker thread.
 *
 * Starting a process blocks the calling thread until the OS has made it (CreateProcess on Windows),
 * and that thread here is the one drawing the window. Usually ~100 ms; with an endpoint agent that
 * inspects every process start, measured at 0.2 s each and up to 1.9 s, so a `git status` every
 * refresh froze the window every fifteen seconds and Windows marked it "Not Responding". On a
 * worker the wait lands on nobody.
 *
 * The worker's code is inline so packaging cannot put it where `new Worker()` will not follow. It
 * ends itself after a minute with nothing to run, so a hidden window keeps no extra thread.
 */
import { execFile, type ExecFileOptions } from "node:child_process";
import { Worker } from "node:worker_threads";

/** A worker with nothing to run for this long is ended; the next run starts another. */
const IDLE_MS = 60_000;

const WORKER_SOURCE = `
const { parentPort } = require("node:worker_threads");
const { execFile } = require("node:child_process");
const reply = (id, error, stdout, stderr) => parentPort.postMessage({
  id,
  error: error ? { message: error.message, code: error.code, killed: error.killed, signal: error.signal } : null,
  stdout: String(stdout),
  stderr: String(stderr),
});
parentPort.on("message", ({ id, file, args, options, input }) => {
  try {
    const child = execFile(file, args, options, (error, stdout, stderr) => reply(id, error, stdout, stderr));
    if (input !== undefined) {
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(input);
    }
  } catch (error) {
    reply(id, error, "", "");
  }
});`;

type Done = (error: (Error & { code?: number | string | null; killed?: boolean }) | null, stdout: string, stderr: string) => void;

interface Reply {
  id: number;
  error: { message: string; code?: number | string; killed?: boolean; signal?: string } | null;
  stdout: string;
  stderr: string;
}

let worker: Worker | null = null;
let idle: NodeJS.Timeout | null = null;
let nextId = 0;
const pending = new Map<number, Done>();

function settle(reply: Reply): void {
  const done = pending.get(reply.id);
  pending.delete(reply.id);
  done?.(reply.error ? Object.assign(new Error(reply.error.message), reply.error) : null, reply.stdout, reply.stderr);
}

/** Every run still waiting is answered by the main thread itself, so no caller waits forever. */
function lose(failed: Worker): void {
  if (worker === failed) worker = null;
  for (const [id, done] of pending) {
    pending.delete(id);
    done(Object.assign(new Error("git worker ended"), { code: 1 }), "", "");
  }
}

function start(): Worker | null {
  if (worker) return worker;
  try {
    const started = new Worker(WORKER_SOURCE, { eval: true });
    started.on("message", settle);
    started.on("error", () => lose(started));
    started.on("exit", () => lose(started));
    started.unref();                               // never what holds the app open
    worker = started;
  } catch {
    worker = null;
  }
  return worker;
}

function restartIdleClock(): void {
  if (idle) clearTimeout(idle);
  idle = setTimeout(() => {
    idle = null;
    if (pending.size) restartIdleClock();         // a slow run: look again once it has had time
    else if (worker) void worker.terminate();
  }, IDLE_MS);
  idle.unref();
}

/**
 * Like `execFile` with a callback, plus `input` written to the program's stdin. Falls back to the
 * real thing if no worker can be started.
 */
export function execFileOffThread(file: string, args: string[], options: ExecFileOptions, done: Done, input?: string): void {
  const running = start();
  if (!running) {
    try {
      const child = execFile(file, args, options, (error, stdout, stderr) => done(error, String(stdout), String(stderr)));
      if (input !== undefined) {
        child.stdin?.on("error", () => undefined);
        child.stdin?.end(input);
      }
    } catch (error) {
      done(error as Error, "", "");
    }
    return;
  }
  const id = ++nextId;
  pending.set(id, done);
  running.postMessage({ id, file, args, options, input });
  restartIdleClock();
}
