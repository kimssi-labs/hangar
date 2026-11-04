/**
 * Native calls through koffi, bound on first use.
 *
 * Never off Windows, and never fatal: a binding that does not load — a missing native dependency, an
 * entry point this Windows lacks — costs the feature that wanted it, not the app, and is not tried
 * again. Free of electron on purpose: the sampler's worker thread binds through this too.
 */
import type { IKoffiLib } from "koffi";

type Koffi = typeof import("koffi");

/** `bind`, run once on Windows; null elsewhere, and null (said once in the log) if it threw. */
export function nativeBinding<T>(what: string, bind: (koffi: Koffi) => T): () => T | null {
  let bound: T | null | undefined;
  return () => {
    if (bound !== undefined) return bound;
    if (process.platform !== "win32") return (bound = null);
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      bound = bind(require("koffi") as Koffi);
    } catch (error) {
      console.error(`[hangar] ${what} unavailable:`, (error as Error).message);
      bound = null;
    }
    return bound;
  };
}

/** The access every process reader here asks OpenProcess for. */
export const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

/** OpenProcess and CloseHandle, declared once: a HANDLE is an integer, as an HWND is in dock.ts. */
export function handleCalls(kernel32: IKoffiLib): {
  OpenProcess: (access: number, inherit: boolean, pid: number) => number;
  CloseHandle: (handle: number) => boolean;
} {
  return {
    OpenProcess: kernel32.func("__stdcall", "OpenProcess", "intptr", ["uint32", "bool", "uint32"]),
    CloseHandle: kernel32.func("__stdcall", "CloseHandle", "bool", ["intptr"]),
  };
}
