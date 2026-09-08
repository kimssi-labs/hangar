/**
 * A running session's process, seen from the window: bringing its terminal to the front, and taking
 * the session over when that process has no window to show.
 *
 * A live session is a claude process; what the user sees of it is the window of whatever hosts that
 * process — a Windows Terminal tab, a console window, VS Code. Windows knows the process, not the
 * window, so the helper walks the process's ancestry to the first one that owns a visible top-level
 * window, restores and raises it, and for Windows Terminal selects the tab as well: a tab's name is
 * the console title the session set, read by attaching to its console for a moment.
 *
 * The helper is a small C# program, compiled on first use with the compiler every Windows has (the
 * one behind PowerShell's Add-Type) and kept by source hash, then run directly: it needs EnumWindows
 * callbacks and UI Automation (COM), neither a fit for the one-native-call-at-a-time discipline the
 * dock keeps under koffi, and a PowerShell script doing the same took 7 s a run when started hidden
 * (2 s of that PowerShell's own start-up, 1 s its exit) against a double-click that wants an answer
 * now. Nothing has to be found on disk or unpacked from the archive: the source is this string.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface FocusOutcome {
  /** A window was found and raised. */
  found: boolean;
  /** Process the window belongs to (`WindowsTerminal`, `Code`, or `console` for a plain console window). */
  owner?: string;
  /** Windows Terminal only: the session's tab was selected too. */
  tab?: boolean;
  error?: string;
}

const HELPER_TIMEOUT_MS = 8000;
const COMPILE_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 5000;

/**
 * The helper. Argument: the session's pid; output: one JSON line. Written for the C# 5 compiler of
 * .NET Framework 4 — no interpolated strings, no `?.`, no expression-bodied members. `ShowWindow 9`
 * is SW_RESTORE. The tab is matched on the title less its first token when that token is one or two
 * symbols: the spinner glyph Claude Code puts in front (✳ ◐ ◑ …), which changes between two reads.
 */
export const FOCUS_SOURCE = String.raw`
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Windows.Automation;

static class Program {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("kernel32.dll")] static extern bool FreeConsole();
  [DllImport("kernel32.dll")] static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern uint GetConsoleTitle(StringBuilder s, uint n);
  [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] struct PBI { public IntPtr Reserved1; public IntPtr Peb; public IntPtr Reserved2a; public IntPtr Reserved2b; public IntPtr UniqueProcessId; public IntPtr ParentProcessId; }
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int cls, ref PBI info, int size, out int ret);

  const int SW_RESTORE = 9;
  const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
  const int MAX_HOPS = 8;

  static string ClassOf(IntPtr h) { var sb = new StringBuilder(256); GetClassName(h, sb, 256); return sb.ToString(); }

  // The parent's pid, or 0. Limited query access is enough, even for a packaged app.
  static uint ParentOf(uint pid) {
    IntPtr h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
    if (h == IntPtr.Zero) return 0;
    try {
      var pbi = new PBI(); int ret;
      if (NtQueryInformationProcess(h, 0, ref pbi, Marshal.SizeOf(pbi), out ret) != 0) return 0;
      return (uint)pbi.ParentProcessId.ToInt64();
    } finally { CloseHandle(h); }
  }

  // Visible, captioned top-level windows owned by pid: the ones a person could see.
  static List<IntPtr> WindowsOf(uint pid) {
    var list = new List<IntPtr>();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      uint owner; GetWindowThreadProcessId(h, out owner);
      if (owner == pid && IsWindowVisible(h)) { var t = new StringBuilder(8); GetWindowText(h, t, 8); if (t.Length > 0) list.Add(h); }
      return true;
    }, IntPtr.Zero);
    return list;
  }

  static string Strip(string s) { return Regex.Replace(s ?? "", @"^[^\p{L}\p{N}\s]{1,2}\s+", "").Trim(); }

  static string Quote(string s) { return "\"" + s.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\""; }

  // Where the time goes, when HANGAR_FOCUS_TRACE is set: one "stage=ms" per stage, in the output.
  static readonly Stopwatch Clock = Stopwatch.StartNew();
  static readonly StringBuilder Marks = new StringBuilder();
  static readonly bool Tracing = Environment.GetEnvironmentVariable("HANGAR_FOCUS_TRACE") != null;
  static void Mark(string stage) { if (Tracing) Marks.Append(stage).Append('=').Append(Clock.ElapsedMilliseconds).Append(' '); }

  // The tab row, found breadth-first and shallow: the terminal's own text lives in the same tree, thousands of
  // elements deep, and a depth-first search from the window reads through it before reaching the tabs.
  static AutomationElement TabRow(AutomationElement root) {
    var walker = TreeWalker.ControlViewWalker;
    var level = new List<AutomationElement> { root };
    for (int depth = 0; depth < 8 && level.Count > 0; depth++) {
      var next = new List<AutomationElement>();
      foreach (var element in level) {
        for (var child = walker.GetFirstChild(element); child != null; child = walker.GetNextSibling(child)) {
          if (child.Current.ControlType == ControlType.Tab) return child;
          if (child.Current.ControlType != ControlType.Document && child.Current.ControlType != ControlType.Edit) next.Add(child);
        }
      }
      level = next;
    }
    return null;
  }

  // The tab named 'wanted' in the Windows Terminal window 'hwnd', or null.
  static AutomationElement TabIn(IntPtr hwnd, string wanted) {
    AutomationElement root = AutomationElement.FromHandle(hwnd);
    AutomationElement row = TabRow(root);
    var isTabItem = new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.TabItem);
    foreach (AutomationElement item in (row ?? root).FindAll(TreeScope.Descendants, isTabItem)) {
      if (Strip(item.Current.Name) == wanted) return item;
    }
    return null;
  }

  static int Main(string[] args) {
    uint pid = uint.Parse(args[0]);
    var stdout = new StreamWriter(Console.OpenStandardOutput());
    Mark("start");
    // 1. The console title (what a Windows Terminal tab is named) and the console's own window.
    string title = ""; IntPtr consoleWindow = IntPtr.Zero;
    FreeConsole();                                  // ours, so that the session's can be attached
    if (AttachConsole(pid)) {
      var sb = new StringBuilder(1024); GetConsoleTitle(sb, 1024); title = sb.ToString();
      consoleWindow = GetConsoleWindow();
      FreeConsole();
    }
    Mark("title");
    // 2. The window to raise: a plain console's own, else one of the first ancestor's visible windows.
    // One Windows Terminal process owns every window it has, so with a title to go by the window is
    // the one whose tab row has that tab; the tab is selected there, while the window is still in
    // the background — measured, UI Automation calls against a window that has just been activated
    // wait about two seconds each, against one in the background 60 ms.
    IntPtr target = IntPtr.Zero; string owner = ""; bool tab = false;
    if (consoleWindow != IntPtr.Zero && ClassOf(consoleWindow) == "ConsoleWindowClass" && IsWindowVisible(consoleWindow)) {
      target = consoleWindow; owner = "console";
    } else {
      uint p = pid;
      for (int hops = 0; p != 0 && hops < MAX_HOPS; hops++) {
        var windows = WindowsOf(p);
        if (windows.Count > 0) {
          try { owner = Process.GetProcessById((int)p).ProcessName; } catch (Exception) { owner = ""; }
          target = windows[0];
          if (title.Length > 0) {
            string wanted = Strip(title);
            foreach (IntPtr candidate in windows) {
              if (ClassOf(candidate) != "CASCADIA_HOSTING_WINDOW_CLASS") continue;
              AutomationElement item = TabIn(candidate, wanted);
              if (item == null) continue;
              ((SelectionItemPattern)item.GetCurrentPattern(SelectionItemPattern.Pattern)).Select();
              target = candidate; tab = true;
              break;
            }
          }
          break;
        }
        p = ParentOf(p);
      }
    }
    Mark("window");
    if (target == IntPtr.Zero) { stdout.Write("{\"found\":false}"); stdout.Flush(); return 0; }
    // 3. Raise it.
    if (IsIconic(target)) ShowWindow(target, SW_RESTORE);
    SetForegroundWindow(target);
    Mark("raise");
    stdout.Write("{\"found\":true,\"owner\":" + Quote(owner) + ",\"tab\":" + (tab ? "true" : "false")
      + (Tracing ? ",\"marks\":" + Quote(Marks.ToString().Trim()) : "") + "}");
    stdout.Flush();
    return 0;
  }
}
`;

/** The helper's file name carries its source's hash, so a change in the source is a new build. */
export function helperName(source = FOCUS_SOURCE): string {
  return `hangar-focus-${createHash("sha1").update(source).digest("hex").slice(0, 12)}.exe`;
}

let building: Promise<string | null> | null = null;

/**
 * The compiled helper under `cacheDir`, built on first use. PowerShell's Add-Type is the C# compiler
 * every Windows has; it is only ever run for the build, not for the work.
 */
export function helperExecutable(cacheDir: string): Promise<string | null> {
  const exe = join(cacheDir, helperName());
  if (existsSync(exe)) return Promise.resolve(exe);
  if (building) return building;
  building = new Promise<string | null>((resolve) => {
    try {
      mkdirSync(cacheDir, { recursive: true });
      const source = exe.replace(/\.exe$/, ".cs");
      writeFileSync(source, FOCUS_SOURCE);
      const quote = (path: string): string => `'${path.replace(/'/g, "''")}'`;
      const command = `Add-Type -Path ${quote(source)} -OutputAssembly ${quote(exe)} -OutputType ConsoleApplication -ReferencedAssemblies UIAutomationClient, UIAutomationTypes`;
      execFile(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", command],
        { windowsHide: true, timeout: COMPILE_TIMEOUT_MS },
        (error, _stdout, stderr) => {
          if (error || !existsSync(exe)) {
            console.error("[hangar] the focus helper did not build:", String(stderr || error?.message || "").trim().slice(0, 300));
            resolve(null);
          } else {
            resolve(exe);
          }
        },
      );
    } catch (error) {
      console.error("[hangar] the focus helper did not build:", (error as Error).message);
      resolve(null);
    }
  }).finally(() => {
    building = null;
  });
  return building;
}

/** What the helper's output means; the outcome is its last non-empty line. */
export function parseOutcome(stdout: string): FocusOutcome {
  const line = stdout.trim().split(/\r?\n/).pop() ?? "";
  try {
    const parsed = JSON.parse(line) as Partial<FocusOutcome>;
    return {
      found: parsed.found === true,
      ...(parsed.owner ? { owner: parsed.owner } : {}),
      ...(parsed.tab !== undefined ? { tab: Boolean(parsed.tab) } : {}),
    };
  } catch {
    return { found: false, error: `unexpected helper output: ${line.slice(0, 120)}` };
  }
}

/** Bring the window of the session running as `pid` to the front. Windows only; elsewhere nothing is found. */
export async function focusSession(pid: number, cacheDir: string): Promise<FocusOutcome> {
  if (process.platform !== "win32") return { found: false };
  const exe = await helperExecutable(cacheDir);
  if (!exe) return { found: false, error: "the focus helper is not available" };
  return new Promise((resolve) => {
    execFile(exe, [String(pid)], { windowsHide: true, timeout: HELPER_TIMEOUT_MS }, (error, stdout) => {
      if (error) resolve({ found: false, error: error.message.trim().slice(0, 200) });
      else resolve(parseOutcome(String(stdout)));
    });
  });
}

/** End the session's process and everything it started. True when it is gone. */
export function stopSession(pid: number): boolean {
  if (process.platform !== "win32") {
    try {
      process.kill(pid);
      return true;
    } catch {
      return false;
    }
  }
  const result = spawnSyncTaskkill(pid);
  return result === 0;
}

function spawnSyncTaskkill(pid: number): number | null {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
  return spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: STOP_TIMEOUT_MS }).status;
}
