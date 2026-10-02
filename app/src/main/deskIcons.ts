/**
 * Keeping the desktop's icons where the user put them while a band is docked.
 *
 * Explorer re-flows the desktop whenever an edge is reserved — on a monitor to the left of others it
 * shifted every icon by the band's width and pushed the far column onto the next screen. So around
 * every reservation change: the icons are read first (the first read is the arrangement to keep),
 * and once Explorer has finished moving them they are put back (see core/deskIcons.ts). Undocking
 * puts back the original arrangement. An icon the user moved while docked is theirs and is left alone.
 *
 * Explorer's own interface does the reading and the placing — the desktop's IFolderView, the same
 * one a shell extension would use — through a small C# helper built on first use like the focus
 * helper. "Auto arrange" makes Explorer ignore positions, so with it on nothing is touched.
 */
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { type Box, type DeskIcon, movedByUser, placeAround } from "../core/deskIcons.js";
import type { DockEdge } from "../core/types.js";
import { helperExecutable, type HelperSpec } from "./liveSession.js";

/** How long Explorer is given to finish re-flowing after a reservation changes (measured: < 2.5 s). */
const SETTLE_MS = 1500;
const RUN_TIMEOUT_MS = 5000;
/** On the way out there is no time to spare: a read that is not back by then is skipped. */
const QUIT_TIMEOUT_MS = 1500;
/** The build waits this long after start-up, like the focus helper's: a compiler run is not start-up work. */
const WARMUP_MS = 10_000;

/**
 * The helper. `read` prints `auto <0|1> <spacing x> <spacing y>`, then `<id> <x> <y>` per icon, in
 * physical screen pixels. `place` reads `<id> <x> <y>` lines on stdin, positions those icons, then
 * prints what `read` would. C# 5 (.NET Framework's compiler): no `$""`, no `?.`.
 *
 * The id is the item's id list, base64: stable across reads of the same desktop. IFolderView speaks
 * the desktop list view's client coordinates, so they are moved by the list view's screen origin.
 * The view's window is asked of IShellView itself: across the process boundary Explorer's proxy
 * does not answer for IOleWindow on its own (E_NOINTERFACE, measured).
 * The arrays for SelectAndPositionItems are pinned by hand — handed over as managed arrays the call
 * crashed the process (measured).
 */
export const DESK_SOURCE = String.raw`
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

[StructLayout(LayoutKind.Sequential)] public struct POINT { public int x, y; }

[ComImport, Guid("85CB6900-4D95-11CF-960C-0080C7F4EE85"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IShellWindows {
  void d0(); void d1(); void d2(); void d3();
  void m0(); void m1(); void m2(); void m3(); void m4(); void m5(); void m6(); void m7();
  [PreserveSig] int FindWindowSW([In] ref object loc, [In] ref object locRoot, int swClass, out int hwnd, int options,
    [MarshalAs(UnmanagedType.IDispatch)] out object disp);
}
[ComImport, Guid("6D5140C1-7436-11CE-8034-00AA006009FA"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IServiceProvider {
  [PreserveSig] int QueryService(ref Guid service, ref Guid riid, [MarshalAs(UnmanagedType.IUnknown)] out object ppv);
}
[ComImport, Guid("000214E2-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IShellBrowser {
  void w0(); void w1();
  void b0(); void b1(); void b2(); void b3(); void b4(); void b5(); void b6(); void b7(); void b8(); void b9();
  [PreserveSig] int QueryActiveShellView([MarshalAs(UnmanagedType.IUnknown)] out object view);
}
[ComImport, Guid("000214E3-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IShellView {
  [PreserveSig] int GetWindow(out IntPtr hwnd);
}
[ComImport, Guid("cde725b0-ccc9-4519-917e-325d72fab4ce"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IFolderView {
  void v0(); void v1(); void v2();
  [PreserveSig] int Item(int index, out IntPtr pidl);
  [PreserveSig] int ItemCount(uint flags, out int count);
  void v5(); void v6(); void v7();
  [PreserveSig] int GetItemPosition(IntPtr pidl, out POINT pt);
  [PreserveSig] int GetSpacing(ref POINT pt);
  void v10();
  [PreserveSig] int GetAutoArrange();
  void v12();
  [PreserveSig] int SelectAndPositionItems(uint count, IntPtr pidls, IntPtr pts, uint flags);
}

static class Program {
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindowExW(IntPtr parent, IntPtr after, string cls, string name);
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr hwnd, ref POINT pt);
  [DllImport("shell32.dll")] static extern uint ILGetSize(IntPtr pidl);

  const uint SVSI_POSITIONITEM = 0x80;
  const uint SVGIO_ALLVIEW = 2;

  static IFolderView view;
  static POINT origin;

  static void Open() {
    var windows = (IShellWindows)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("9BA05972-F6A8-11CF-A442-00A0C90A8F39")));
    object loc = 0, root = null; int hwnd; object disp;
    Marshal.ThrowExceptionForHR(windows.FindWindowSW(ref loc, ref root, 8, out hwnd, 1, out disp));
    var service = new Guid("4C96BE40-915C-11CF-99D3-00AA004AE837");
    var iid = typeof(IShellBrowser).GUID; object browser;
    Marshal.ThrowExceptionForHR(((IServiceProvider)disp).QueryService(ref service, ref iid, out browser));
    object shellView;
    Marshal.ThrowExceptionForHR(((IShellBrowser)browser).QueryActiveShellView(out shellView));
    view = (IFolderView)shellView;
    IntPtr defView;
    Marshal.ThrowExceptionForHR(((IShellView)shellView).GetWindow(out defView));
    IntPtr list = FindWindowExW(defView, IntPtr.Zero, "SysListView32", null);
    origin = new POINT();
    if (list != IntPtr.Zero) ClientToScreen(list, ref origin);
  }

  static string Id(IntPtr pidl) {
    var bytes = new byte[ILGetSize(pidl)];
    Marshal.Copy(pidl, bytes, 0, bytes.Length);
    return Convert.ToBase64String(bytes);
  }

  static Dictionary<string, IntPtr> Items() {
    int count; Marshal.ThrowExceptionForHR(view.ItemCount(SVGIO_ALLVIEW, out count));
    var items = new Dictionary<string, IntPtr>();
    for (int i = 0; i < count; i++) {
      IntPtr pidl;
      if (view.Item(i, out pidl) != 0) continue;
      string id = Id(pidl);
      if (items.ContainsKey(id)) Marshal.FreeCoTaskMem(pidl); else items[id] = pidl;
    }
    return items;
  }

  static void Print(Dictionary<string, IntPtr> items) {
    var spacing = new POINT();
    view.GetSpacing(ref spacing);
    var output = new StringBuilder();
    output.AppendFormat("auto {0} {1} {2}\n", view.GetAutoArrange() == 0 ? 1 : 0, spacing.x, spacing.y);
    foreach (var item in items) {
      POINT at;
      if (view.GetItemPosition(item.Value, out at) != 0) continue;
      output.AppendFormat("{0} {1} {2}\n", item.Key, at.x + origin.x, at.y + origin.y);
    }
    Console.Out.Write(output.ToString());
  }

  static void Place(Dictionary<string, IntPtr> items) {
    var pidls = new List<IntPtr>(); var points = new List<POINT>();
    string line;
    while ((line = Console.In.ReadLine()) != null) {
      var parts = line.Trim().Split(' ');
      IntPtr pidl;
      if (parts.Length != 3 || !items.TryGetValue(parts[0], out pidl)) continue;
      var at = new POINT(); at.x = int.Parse(parts[1]) - origin.x; at.y = int.Parse(parts[2]) - origin.y;
      pidls.Add(pidl); points.Add(at);
    }
    if (pidls.Count == 0) return;
    var p = pidls.ToArray(); var a = points.ToArray();
    var hp = GCHandle.Alloc(p, GCHandleType.Pinned); var ha = GCHandle.Alloc(a, GCHandleType.Pinned);
    try { Marshal.ThrowExceptionForHR(view.SelectAndPositionItems((uint)p.Length, hp.AddrOfPinnedObject(), ha.AddrOfPinnedObject(), SVSI_POSITIONITEM)); }
    finally { hp.Free(); ha.Free(); }
  }

  [STAThread]
  static int Main(string[] args) {
    SetProcessDpiAwarenessContext(new IntPtr(-4));
    try {
      Open();
      var items = Items();
      if (args.Length > 0 && args[0] == "place") Place(items);
      Print(items);
      foreach (var pidl in items.Values) Marshal.FreeCoTaskMem(pidl);
      return 0;
    } catch (Exception error) {
      Console.Error.WriteLine(error.Message);
      return 1;
    }
  }
}
`;

const DESK_HELPER: HelperSpec = { source: DESK_SOURCE, kind: "desk", references: "System" };

export interface DeskRead {
  autoArrange: boolean;
  spacing: { x: number; y: number };
  icons: DeskIcon[];
}

/** The helper's output, or null when it is not what the helper prints. */
export function parseRead(stdout: string): DeskRead | null {
  const lines = stdout.trim().split(/\r?\n/);
  const head = /^auto ([01]) (-?\d+) (-?\d+)$/.exec(lines[0] ?? "");
  if (!head) return null;
  const icons: DeskIcon[] = [];
  for (const line of lines.slice(1)) {
    const match = /^(\S+) (-?\d+) (-?\d+)$/.exec(line.trim());
    if (match) icons.push({ id: match[1] as string, x: Number(match[2]), y: Number(match[3]) });
  }
  return { autoArrange: head[1] === "1", spacing: { x: Number(head[2]), y: Number(head[3]) }, icons };
}

const asLines = (icons: DeskIcon[]): string => icons.map((icon) => `${icon.id} ${icon.x} ${icon.y}`).join("\n");

/** What is being kept: the arrangement to come back to, and where the icons were last put. */
interface Kept {
  original: DeskIcon[];
  spacing: { x: number; y: number };
  /** Null while the positions are not ours to judge — on start-up, or while Explorer is still moving them. */
  placed: DeskIcon[] | null;
}

/** Where the docked band is, for the placement that follows a reservation. */
export interface BandAt {
  band: Box;
  edge: DockEdge;
  monitor: Box;
}

export class IconKeeper {
  private kept: Kept | null;
  private timer: NodeJS.Timeout | null = null;
  /**
   * The helper's build, started once. Its promise settles only when the compiler is DONE: starting
   * the file as soon as it exists failed with EBUSY (measured, in the e2e run).
   */
  private build: Promise<string | null> | null = null;
  /** The helper, once that build has settled successfully — for the calls that cannot wait for it. */
  private exe: string | null = null;

  /**
   * `file` keeps the original arrangement across a quit; `enabled` says whether a NEW arrangement may
   * be taken — one already taken is always put back.
   */
  constructor(private readonly helpersDir: string, private readonly file: string, private readonly enabled: () => boolean) {
    this.kept = this.load();
    // Built ahead, off the docking path: a first dock must not wait seconds for the compiler.
    if (process.platform === "win32") setTimeout(() => void this.helper(), WARMUP_MS).unref();
  }

  /**
   * Before the reservation changes: take the arrangement, or forget icons the user has moved.
   * Never throws — the icons are a courtesy, and a failure here must not stand in the way of docking.
   */
  async before(): Promise<void> {
    if (this.timer) {
      // Explorer may still be moving icons from the last change; what it shows now proves nothing.
      clearTimeout(this.timer);
      this.timer = null;
      return;
    }
    if (!this.kept && !this.enabled()) return;
    // Not waited for: docking does not stand still for a compiler. A first dock before the helper is
    // built goes without, which is what `after` then finds — nothing kept, nothing to put back.
    const read = await this.run("read", "", false);
    if (!read || read.autoArrange) return;
    this.take(read);
  }

  /** After the reservation changed: once Explorer is done, put the icons where they belong. */
  after(at: BandAt | null): void {
    if (!this.kept) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.place(at);
    }, SETTLE_MS);
    this.timer.unref?.();
  }

  /** On the way out, still docked: note which icons are the user's now, and keep the rest for next time. */
  quitting(): void {
    if (!this.kept) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    } else {
      const exe = this.exe;
      if (exe && this.kept.placed) {
        try {
          const read = parseRead(String(execFileSync(exe, ["read"], { windowsHide: true, timeout: QUIT_TIMEOUT_MS })));
          if (read) this.take(read);
        } catch { /* no answer in time: keep the arrangement as it was */ }
      }
    }
    this.kept.placed = null;
    this.save();
  }

  /** At start-up, not docked: an arrangement left by a run that ended docked is put back. */
  async leftovers(): Promise<void> {
    if (!this.kept) return;
    await this.place(null);
  }

  private take(read: DeskRead): void {
    if (!this.kept) {
      this.kept = { original: read.icons, spacing: read.spacing, placed: null };
    } else if (this.kept.placed) {
      const theirs = movedByUser(this.kept.placed, read.icons);
      this.kept.original = this.kept.original.filter((icon) => !theirs.has(icon.id));
      this.kept.placed = this.kept.placed.filter((icon) => !theirs.has(icon.id));
    }
    this.save();
  }

  private async place(at: BandAt | null): Promise<void> {
    const kept = this.kept;
    if (!kept) return;
    const wanted = at ? placeAround(kept.original, at.band, at.edge, at.monitor, kept.spacing) : kept.original;
    const read = await this.run("place", asLines(wanted), true);
    if (this.kept !== kept) return;
    // No answer means nothing was placed; the arrangement is kept for the next chance — a release
    // that forgot it here would leave the icons where Explorer pushed them for good.
    if (!read) return;
    if (!at) {
      // Back where they were: nothing is kept any more.
      this.kept = null;
      rmSync(this.file, { force: true });
      return;
    }
    const ids = new Set(wanted.map((icon) => icon.id));
    kept.placed = read.icons.filter((icon) => ids.has(icon.id));
    this.save();
  }

  /** The helper's build, started on first ask; a build that failed is not retried in this run. */
  private helper(): Promise<string | null> {
    this.build ??= helperExecutable(this.helpersDir, DESK_HELPER).then((exe) => (this.exe = exe));
    return this.build;
  }

  /**
   * One helper call; any failure — even one to start it — is no answer. `wait` says whether a build
   * still in progress is waited for, or makes this call go without.
   */
  private async run(command: "read" | "place", input: string, wait: boolean): Promise<DeskRead | null> {
    if (process.platform !== "win32") return null;
    const pending = this.helper();
    const exe = wait ? await pending : this.exe;
    if (!exe) return null;
    return new Promise((resolve) => {
      try {
        const child = execFile(exe, [command], { windowsHide: true, timeout: RUN_TIMEOUT_MS }, (error, stdout, stderr) => {
          if (error) console.error(`[hangar] desktop icons (${command}):`, String(stderr || error.message).trim().slice(0, 200));
          resolve(error ? null : parseRead(String(stdout)));
        });
        child.stdin?.on("error", () => undefined);
        child.stdin?.end(input);
      } catch (error) {
        console.error(`[hangar] desktop icons (${command}):`, (error as Error).message);
        resolve(null);
      }
    });
  }

  private load(): Kept | null {
    try {
      if (!existsSync(this.file)) return null;
      const kept = JSON.parse(readFileSync(this.file, "utf8")) as Kept;
      if (!Array.isArray(kept.original)) return null;
      // Whatever happened since, the positions on screen now are not the ones this file last saw.
      return { original: kept.original, spacing: kept.spacing ?? { x: 0, y: 0 }, placed: null };
    } catch {
      return null;
    }
  }

  private save(): void {
    try {
      if (!this.kept) return;
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.kept));
    } catch (error) {
      console.error("[hangar] desktop icons: could not save", (error as Error).message);
    }
  }
}
