/**
 * Closing the terminals sessions run in, when Hangar is closed with them.
 *
 * A session is a `claude` process inside a shell inside a terminal tab. Ending `claude` alone leaves
 * the shell at its prompt, since Hangar starts it with -NoExit / /k; ending the shell by force leaves
 * the tab open on "process exited with code 1" (measured: Windows Terminal 1.24 keeps such a tab,
 * even for a forced exit with code 0). What closes the tab is the shell leaving by itself, so after
 * `claude` and everything it started have ended, `exit` is typed into the shell's console, as a
 * person would. Windows Terminal itself is never touched.
 *
 * The typing needs the shell's console attached, which a helper can do and this process cannot:
 * one small compiled program, as the focus helper (main/liveSession.ts), run off the main thread.
 */
import { readFileSync } from "node:fs";

import { helperExecutable, type HelperSpec } from "./helpers.js";
import { execFileOffThread } from "./offThread.js";

const CLOSE_TIMEOUT_MS = 30_000;
/** Elsewhere than Windows: how long a session is given to end after SIGTERM, before SIGKILL. */
const TERM_GRACE_MS = 5_000;
const GONE_POLL_MS = 100;

/**
 * Whether the process is gone: no such pid, or on Linux a zombie only its parent has yet to reap.
 * A zombie answers a signal check, so the closing must ask this, not whether the pid is alive.
 */
export function gone(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return true;
  }
  if (process.platform !== "linux") return false;
  try {
    return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.startsWith("Z") ?? false;
  } catch {
    return true;
  }
}

/** Wait until every pid is gone, or the time is up; the ones still there are handed back. */
async function waitGone(pids: number[], ms: number): Promise<number[]> {
  const until = Date.now() + ms;
  let left = pids.filter((pid) => !gone(pid));
  while (left.length && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, GONE_POLL_MS));
    left = left.filter((pid) => !gone(pid));
  }
  return left;
}

/**
 * Arguments: the sessions' pids; output: one JSON line. C# 5 for the .NET Framework 4 compiler. The
 * parent is read before anything is ended, and `exit` is typed only into a parent that is a shell.
 *
 * A pid is ended only while it is still a claude (`claude.exe`, or `node.exe` for an npm install): a
 * registry file a crashed session left behind can name a pid the system has since given to another
 * program, and that program must not be ended in its place.
 */
export const CLOSE_SOURCE = String.raw`
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

static class Program {
  [DllImport("kernel32.dll")] static extern bool FreeConsole();
  [DllImport("kernel32.dll")] static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr sa, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [StructLayout(LayoutKind.Sequential)] struct PBI { public IntPtr Reserved1; public IntPtr Peb; public IntPtr Reserved2a; public IntPtr Reserved2b; public IntPtr UniqueProcessId; public IntPtr ParentProcessId; }
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int cls, ref PBI info, int size, out int ret);
  [StructLayout(LayoutKind.Explicit, CharSet = CharSet.Unicode)] struct KEY {
    [FieldOffset(0)] public ushort Type; [FieldOffset(4)] public int Down; [FieldOffset(8)] public ushort Repeat;
    [FieldOffset(10)] public ushort Vk; [FieldOffset(12)] public ushort Scan; [FieldOffset(14)] public char Ch; [FieldOffset(16)] public uint State;
  }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool WriteConsoleInput(IntPtr h, KEY[] records, uint count, out uint written);

  const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
  const uint GENERIC_READ_WRITE = 0xC0000000;
  const ushort KEY_EVENT = 1;
  const ushort VK_RETURN = 0x0D;
  static readonly IntPtr INVALID = new IntPtr(-1);
  static readonly string[] SHELLS = { "pwsh", "powershell", "cmd", "bash", "sh", "zsh", "fish" };
  static readonly string[] CLAUDES = { "claude", "node" };

  static uint ParentOf(uint pid) {
    IntPtr h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
    if (h == IntPtr.Zero) return 0;
    try {
      var pbi = new PBI(); int ret;
      if (NtQueryInformationProcess(h, 0, ref pbi, Marshal.SizeOf(pbi), out ret) != 0) return 0;
      return (uint)pbi.ParentProcessId.ToInt64();
    } finally { CloseHandle(h); }
  }

  static string NameOf(uint pid) {
    try { return Process.GetProcessById((int)pid).ProcessName.ToLowerInvariant(); } catch (Exception) { return ""; }
  }

  // The processes and everything they started, ended in one call; then waited for, together, so
  // each shell has its console back before anything is typed into it.
  static void End(List<uint> pids) {
    var watched = new List<Process>();
    var args = new StringBuilder("/T /F");
    foreach (uint pid in pids) {
      args.Append(" /PID ").Append(pid);
      try { watched.Add(Process.GetProcessById((int)pid)); } catch (Exception) { }
    }
    var info = new ProcessStartInfo("taskkill", args.ToString());
    info.CreateNoWindow = true; info.UseShellExecute = false;
    using (var p = Process.Start(info)) { p.WaitForExit(10000); }
    var until = DateTime.UtcNow.AddMilliseconds(5000);
    foreach (var p in watched) {
      int left = (int)Math.Max(0, (until - DateTime.UtcNow).TotalMilliseconds);
      try { p.WaitForExit(left); } catch (Exception) { }
    }
  }

  // Keys into the console the process runs in, as if typed there.
  static bool Type(uint pid, string text) {
    if (!AttachConsole(pid)) return false;
    try {
      IntPtr input = CreateFile("CONIN$", GENERIC_READ_WRITE, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
      if (input == INVALID) return false;
      try {
        var keys = new KEY[text.Length * 2];
        for (int i = 0; i < text.Length; i++) {
          ushort vk = text[i] == '\r' ? VK_RETURN : (ushort)0;
          keys[i * 2] = new KEY { Type = KEY_EVENT, Down = 1, Repeat = 1, Vk = vk, Ch = text[i] };
          keys[i * 2 + 1] = new KEY { Type = KEY_EVENT, Down = 0, Repeat = 1, Vk = vk, Ch = text[i] };
        }
        uint written;
        return WriteConsoleInput(input, keys, (uint)keys.Length, out written);
      } finally { CloseHandle(input); }
    } finally { FreeConsole(); }
  }

  static int Main(string[] args) {
    var stdout = new StreamWriter(Console.OpenStandardOutput());
    FreeConsole();                                  // ours, so that each shell's can be attached
    var targets = new List<uint>();
    var shells = new List<uint>();
    foreach (string arg in args) {
      uint pid;
      if (!uint.TryParse(arg, out pid)) continue;
      if (Array.IndexOf(CLAUDES, NameOf(pid)) < 0) continue;
      targets.Add(pid);
      uint parent = ParentOf(pid);
      if (parent != 0 && Array.IndexOf(SHELLS, NameOf(parent)) >= 0) shells.Add(parent);
    }
    if (targets.Count > 0) End(targets);
    int closed = 0;
    foreach (uint shell in shells) { if (Type(shell, "exit\r")) closed++; }
    int ended = targets.Count;
    stdout.Write("{\"ended\":" + ended + ",\"closed\":" + closed + "}");
    stdout.Flush();
    return 0;
  }
}
`;

/** The close helper, for helpers.ts to build. */
export const CLOSE_HELPER: HelperSpec = { source: CLOSE_SOURCE, kind: "close", references: "System" };

/** How many sessions were ended, and how many of their terminals closed with them. */
export interface CloseOutcome { ended: number; closed: number }

export function parseClose(stdout: string): CloseOutcome {
  try {
    const parsed = JSON.parse(stdout.trim().split(/\r?\n/).pop() ?? "") as Partial<CloseOutcome>;
    return { ended: Number(parsed.ended) || 0, closed: Number(parsed.closed) || 0 };
  } catch {
    return { ended: 0, closed: 0 };
  }
}

/** End these sessions and close the terminals they run in. Elsewhere than Windows, the processes only. */
export async function closeSessions(pids: number[], cacheDir: string): Promise<CloseOutcome> {
  if (!pids.length) return { ended: 0, closed: 0 };
  if (process.platform !== "win32") {
    // Still a claude, as on Windows: not a pid the system has since handed to another program.
    const targets = pids.filter((pid) => {
      try {
        return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("claude");
      } catch {
        return false;
      }
    });
    const signal = (list: number[], name: NodeJS.Signals): void => {
      for (const pid of list) {
        try {
          process.kill(pid, name);
        } catch {
          /* already gone */
        }
      }
    };
    // Waited for, as on Windows: a signal is only a request, and the answer is the process gone.
    signal(targets, "SIGTERM");
    const stubborn = await waitGone(targets, TERM_GRACE_MS);
    signal(stubborn, "SIGKILL");
    const left = await waitGone(stubborn, TERM_GRACE_MS);
    return { ended: targets.length - left.length, closed: 0 };
  }
  const exe = await helperExecutable(cacheDir, CLOSE_HELPER);
  if (!exe) return { ended: 0, closed: 0 };
  return new Promise((resolve) => {
    execFileOffThread(exe, pids.map(String), { windowsHide: true, timeout: CLOSE_TIMEOUT_MS }, (_error, stdout) => resolve(parseClose(stdout)));
  });
}
