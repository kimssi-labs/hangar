/**
 * Which program owns the window in front — by executable name, `WindowsTerminal.exe` say.
 *
 * Three cheap user32/kernel32 calls, none of which blocks or sends a message, so this needs no turn
 * in the native queue the dock keeps (chrome.ts). The name is cached per pid: the same window is
 * asked about on every poll while a screenshot is pending, and a process does not change its name.
 */
import { basename } from "node:path";

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const PATH_CHARS = 1024;
/** Pids are recycled; a small cache is cleared rather than kept forever. */
const CACHE_LIMIT = 64;

interface Api {
  GetForegroundWindow: () => unknown;
  GetWindowThreadProcessId: (hwnd: unknown, pid: number[]) => number;
  OpenProcess: (access: number, inherit: boolean, pid: number) => unknown;
  QueryFullProcessImageNameW: (handle: unknown, flags: number, buffer: Buffer, size: number[]) => boolean;
  CloseHandle: (handle: unknown) => boolean;
}

let api: Api | null | undefined;
const names = new Map<number, string>();

function load(): Api | null {
  if (api !== undefined) return api;
  if (process.platform !== "win32") return (api = null);
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const koffi = require("koffi") as typeof import("koffi");
    const user32 = koffi.load("user32.dll");
    const kernel32 = koffi.load("kernel32.dll");
    return (api = {
      GetForegroundWindow: user32.func("__stdcall", "GetForegroundWindow", "void *", []),
      GetWindowThreadProcessId: user32.func("__stdcall", "GetWindowThreadProcessId", "uint32", ["void *", koffi.out(koffi.pointer("uint32"))]),
      OpenProcess: kernel32.func("__stdcall", "OpenProcess", "void *", ["uint32", "bool", "uint32"]),
      QueryFullProcessImageNameW: kernel32.func("__stdcall", "QueryFullProcessImageNameW", "bool", ["void *", "uint32", "void *", koffi.inout(koffi.pointer("uint32"))]),
      CloseHandle: kernel32.func("__stdcall", "CloseHandle", "bool", ["void *"]),
    });
  } catch (error) {
    console.error("[hangar] foreground window unavailable:", (error as Error).message);
    return (api = null);
  }
}

/** The executable name of the window in front, or null when it cannot be known. */
export function foregroundExecutable(): string | null {
  const w = load();
  if (!w) return null;
  const hwnd = w.GetForegroundWindow();
  if (!hwnd) return null;
  const pidOut = [0];
  w.GetWindowThreadProcessId(hwnd, pidOut);
  const pid = pidOut[0] ?? 0;
  if (!pid) return null;
  const cached = names.get(pid);
  if (cached) return cached;
  const handle = w.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
  if (!handle) return null;
  try {
    const buffer = Buffer.alloc(PATH_CHARS * 2);
    const size = [PATH_CHARS];
    if (!w.QueryFullProcessImageNameW(handle, 0, buffer, size)) return null;
    const exe = basename(buffer.toString("utf16le", 0, (size[0] ?? 0) * 2));
    if (names.size >= CACHE_LIMIT) names.clear();
    names.set(pid, exe);
    return exe;
  } finally {
    w.CloseHandle(handle);
  }
}
