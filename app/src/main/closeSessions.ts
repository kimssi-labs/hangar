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
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;

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

  // The process and everything it started, ended; then waited for, so the shell has its console back.
  static void End(uint pid) {
    var info = new ProcessStartInfo("taskkill", "/PID " + pid + " /T /F");
    info.CreateNoWindow = true; info.UseShellExecute = false;
    using (var p = Process.Start(info)) { p.WaitForExit(5000); }
    try { Process.GetProcessById((int)pid).WaitForExit(3000); } catch (Exception) { }
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
    int ended = 0, closed = 0;
    foreach (string arg in args) {
      uint pid;
      if (!uint.TryParse(arg, out pid)) continue;
      if (Array.IndexOf(CLAUDES, NameOf(pid)) < 0) continue;
      uint parent = ParentOf(pid);
      string shell = parent == 0 ? "" : NameOf(parent);
      End(pid);
      ended++;
      if (Array.IndexOf(SHELLS, shell) >= 0 && Type(parent, "exit\r")) closed++;
    }
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
    let ended = 0;
    for (const pid of pids) {
      try {
        // Still a claude, as on Windows: not a pid the system has since handed to another program.
        if (!readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("claude")) continue;
        process.kill(pid);
        ended += 1;
      } catch {
        /* already gone */
      }
    }
    return { ended, closed: 0 };
  }
  const exe = await helperExecutable(cacheDir, CLOSE_HELPER);
  if (!exe) return { ended: 0, closed: 0 };
  return new Promise((resolve) => {
    execFileOffThread(exe, pids.map(String), { windowsHide: true, timeout: CLOSE_TIMEOUT_MS }, (_error, stdout) => resolve(parseClose(stdout)));
  });
}
