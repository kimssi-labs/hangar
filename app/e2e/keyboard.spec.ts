/**
 * End-to-end: the keyboard — Tab between the areas, the arrow keys inside each list, and a docked
 * band that does not take the keyboard away from the terminal.
 *
 * Reported on 2.17.1: clicking the band turned the taskbar's input indicator into an X and Korean
 * keystrokes meant for the terminal went nowhere. The band answers the mouse, so it does not need
 * the keyboard — except while the page has a field open, a search box included.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

import { mainWindow } from "./appWindow.js";

/** A project with one session and a few files: a folder, and two files beside it. */
function fixture(): { home: string; workspace: string } {
  const root = mkdtempSync(join(tmpdir(), "hangar-keyboard-"));
  const home = join(root, ".claude");
  const workspace = join(root, "workspace");
  const dir = workspace.replace(/[^A-Za-z0-9]/g, "-");
  mkdirSync(join(home, "projects", dir), { recursive: true });
  mkdirSync(join(home, "sessions"), { recursive: true });
  mkdirSync(join(workspace, "docs"), { recursive: true });
  for (const name of ["a.txt", "b.txt", "docs/guide.md"]) writeFileSync(join(workspace, name), "text");
  const id = "aaaaaaaa-1111-2222-3333-444444444444";
  writeFileSync(join(home, "projects", dir, `${id}.jsonl`), [
    JSON.stringify({ type: "user", cwd: workspace, sessionId: id, message: { content: "세션" }, origin: { kind: "human" } }),
    JSON.stringify({ type: "assistant", message: { content: "…" } }),
  ].join("\n") + "\n");
  writeFileSync(join(root, ".claude.json"), JSON.stringify({ projects: { [workspace]: {} } }));
  // The band is a real reservation on this desk; the desktop's icons are not the test's to move.
  mkdirSync(join(home, "config"), { recursive: true });
  writeFileSync(join(home, "config", "manager.json"), JSON.stringify({ ui: { keepIcons: false } }));
  return { home, workspace };
}

async function launch(home: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [".", "--lang=en-US"],
    cwd: process.cwd(),
    env: { ...process.env, CLAUDE_HOME: home },
  });
  const page = await mainWindow(app);
  await page.waitForLoadState("domcontentloaded");
  await page.locator(".row").first().waitFor({ state: "visible", timeout: 30_000 });
  return { app, page };
}

const focusable = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) =>
  BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes("index.html"))?.isFocusable());

/** What the focused element is: its role or tag, its accessible label or title, and its own text. */
const focused = (page: Page) => page.evaluate(() => {
  const el = document.activeElement as HTMLElement | null;
  return {
    role: el?.getAttribute("role") ?? el?.tagName.toLowerCase() ?? "",
    name: el?.getAttribute("aria-label") ?? el?.getAttribute("title") ?? "",
    row: el?.hasAttribute("data-row") ?? false,
    expanded: el?.getAttribute("aria-expanded") ?? null,
  };
});

/** Dock the window as a band on the right edge of the first monitor. */
async function dock(page: Page): Promise<void> {
  const display = await page.evaluate(async () => (await window.hangar.displays())[0]);
  const docked = await page.evaluate((device) =>
    window.hangar.applyDock({ enabled: true, device, edge: "right", percent: 20 }), display?.id ?? "");
  expect(docked.ok, "the band could not be applied").toBe(true);
  await page.waitForTimeout(600);
}

test("the band gives the keyboard back, and asks for it only while a field is open", async () => {
  const { home } = fixture();
  const { app, page } = await launch(home);
  try {
    expect(await focusable(app), "an undocked window is an ordinary window").toBe(true);
    await dock(page);
    expect(await focusable(app), "a docked band still takes the keyboard").toBe(false);

    // Settings has fields in it; the band must take the keyboard back for as long as it is open.
    await page.evaluate(() => window.hangar.holdKeyboard(true));
    await page.waitForTimeout(300);
    expect(await focusable(app), "the band did not take the keyboard for a field").toBe(true);

    await page.evaluate(() => window.hangar.holdKeyboard(false));
    await page.waitForTimeout(300);
    expect(await focusable(app), "the band kept the keyboard after the field closed").toBe(false);

    await page.evaluate(() => window.hangar.releaseDock());
    await page.waitForTimeout(600);
    expect(await focusable(app), "an undocked window must be focusable again").toBe(true);
  } finally {
    await page.evaluate(() => window.hangar.releaseDock()).catch(() => undefined);
    await app.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("a search box takes the keyboard in a band, and gives it back when it is left", async () => {
  const { home } = fixture();
  const { app, page } = await launch(home);
  try {
    // Every hold the page asks for, as main receives it: the side pane's searches ask as the
    // project search does, wherever the window is.
    await app.evaluate(({ ipcMain }) => {
      const seen = globalThis as unknown as { holds: boolean[] };
      seen.holds = [];
      ipcMain.on("dock:keyboard", (_event, wanted: boolean) => seen.holds.push(wanted));
    });
    const lastHold = () => app.evaluate(() => (globalThis as unknown as { holds: boolean[] }).holds.at(-1));
    await page.getByTestId("pane-tab-skills").click();
    await page.getByLabel("Search skills").click();
    await expect.poll(lastHold).toBe(true);
    await page.getByRole("listbox", { name: "Projects" }).focus();
    await expect.poll(lastHold).toBe(false);

    await dock(page);
    expect(await focusable(app)).toBe(false);
    const search = page.getByPlaceholder("Search projects");
    await search.click();
    await expect.poll(() => focusable(app), { message: "the band did not take the keyboard for the search box" }).toBe(true);
    await page.keyboard.type("work");
    await expect(search).toHaveValue("work");
    await search.press("Escape");                        // clears the box and leaves it
    await expect.poll(() => focusable(app), { message: "the band kept the keyboard after the search box was left" }).toBe(false);
  } finally {
    await page.evaluate(() => window.hangar.releaseDock()).catch(() => undefined);
    await app.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("the search finds a session and shows its project with only the matching sessions beside it", async () => {
  const { home, workspace } = fixture();
  const dir = workspace.replace(/[^A-Za-z0-9]/g, "-");
  const id = "bbbbbbbb-1111-2222-3333-444444444444";
  writeFileSync(join(home, "projects", dir, `${id}.jsonl`), [
    JSON.stringify({ type: "user", cwd: workspace, sessionId: id, message: { content: "fix the splash screen" }, origin: { kind: "human" } }),
    JSON.stringify({ type: "assistant", message: { content: "…" } }),
  ].join("\n") + "\n");
  const { app, page } = await launch(home);
  try {
    const preview = page.getByRole("listbox", { name: "Sessions" }).getByRole("option");
    await page.getByRole("listbox", { name: "Projects" }).getByRole("option").first().click();
    await expect(preview).toHaveCount(2);
    await page.getByPlaceholder("Search projects").fill("splash");
    await expect(page.getByRole("listbox", { name: "Projects" }).getByRole("option")).toHaveCount(1);
    await expect(page.getByTestId("session-matches")).toHaveText("1 of 2 sessions");
    await expect(preview).toHaveCount(1);
    await expect(preview.first()).toContainText("splash");
  } finally {
    await app.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("headless runs a session started fold under its project, and its own runs fold at the end", async () => {
  const { home, workspace } = fixture();
  const dir = workspace.replace(/[^A-Za-z0-9]/g, "-");
  // A folder named nothing like the project, filled by `claude -p` runs the workspace's session started.
  const batch = join(workspace, "..", "out-7");
  const batchDir = batch.replace(/[^A-Za-z0-9]/g, "-");
  mkdirSync(join(home, "projects", batchDir), { recursive: true });
  const run = (folder: string, cwd: string, id: string) => writeFileSync(join(home, "projects", folder, `${id}.jsonl`), [
    JSON.stringify({ type: "user", entrypoint: "sdk-cli", cwd, sessionId: id, message: { content: "Record: a.md" }, origin: { kind: "human" } }),
    JSON.stringify({ type: "assistant", entrypoint: "sdk-cli", message: { content: "…" } }),
  ].join("\n") + "\n");
  const starter = join(home, "projects", dir, "aaaaaaaa-1111-2222-3333-444444444444.jsonl");
  writeFileSync(starter, [
    JSON.stringify({ type: "user", cwd: workspace, timestamp: new Date(Date.now() - 120_000).toISOString(), message: { content: "세션" }, origin: { kind: "human" } }),
    JSON.stringify({ type: "assistant", timestamp: new Date(Date.now() - 60_000).toISOString(), message: { content: [{ type: "tool_use", input: { command: `python bundle.py "${batch}"` } }] } }),
  ].join("\n") + "\n");
  run(batchDir, batch, "cccccccc-1111-2222-3333-444444444444");
  run(batchDir, batch, "dddddddd-1111-2222-3333-444444444444");
  run(dir, workspace, "eeeeeeee-1111-2222-3333-444444444444");
  // The starting session was still running when the runs began.
  const later = new Date(Date.now() + 5_000);
  utimesSync(starter, later, later);
  const { app, page } = await launch(home);
  try {
    const projects = page.getByRole("listbox", { name: "Projects" }).getByRole("option");
    const preview = page.getByRole("listbox", { name: "Sessions" }).getByRole("option");
    await expect(projects).toHaveCount(1);                        // the runs' folder is folded under it
    await projects.first().click();
    await expect(preview).toHaveCount(1);                         // its own run waits behind the switch
    await page.getByTestId("runs-row").click();
    await expect(preview).toHaveCount(2);
    await page.getByTestId("fold-chip").click();
    await expect(projects).toHaveCount(2);
    await expect(projects.nth(1)).toContainText("out-7");
    await page.getByRole("listbox", { name: "Projects" }).focus();
    await page.keyboard.press("ArrowLeft");                       // ← folds it again
    await expect(projects).toHaveCount(1);
  } finally {
    await app.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("Tab walks the areas in order, and the keys work inside each one", async () => {
  const { home, workspace } = fixture();
  const { app, page } = await launch(home);
  try {
    // Opening a file is counted where main serves it, and the native menu is stood in for where it
    // is built: neither the bridge nor the OS's menu can be driven from here.
    await app.evaluate(({ ipcMain, Menu }) => {
      type Handler = (...args: unknown[]) => unknown;
      type Item = { label?: string; click?: () => void };
      const seen = globalThis as unknown as { opened: string[]; menu: string[] };
      seen.opened = [];
      seen.menu = [];
      (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers.set("files:open",
        (_event: unknown, request: unknown) => { seen.opened.push((request as { dir: string }).dir); return { ok: true }; });
      (Menu as unknown as { buildFromTemplate: (t: Item[]) => unknown }).buildFromTemplate = (template: Item[]) => {
        seen.menu = template.map((item) => item.label ?? "-");
        return { popup: () => template.find((item) => item.label === "Rename…")?.click?.() };
      };
    });
    const seen = () => app.evaluate(() => {
      const g = globalThis as unknown as { opened: string[]; menu: string[] };
      return { opened: g.opened, menu: g.menu };
    });

    // Tall enough that the detail panel above the tabs does not overflow: an overflowing scroller is
    // a Tab stop of its own in Chromium (so it can be scrolled from the keyboard), between these two.
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes("index.html"))?.setContentSize(1180, 1000);
    });

    // The project list has the keyboard from the start; Tab goes on to the sessions, which enters them.
    const projects = page.getByRole("listbox", { name: "Projects" });
    await expect(projects).toBeFocused();
    await expect(page.getByTitle("a.txt", { exact: true })).toBeVisible();     // the folder has been read
    // The top bar comes before it, though the list is drawn to its left.
    await page.keyboard.press("Shift+Tab");
    await expect(page.getByRole("button", { name: "Settings" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(projects).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("listbox", { name: "Sessions" })).toBeFocused();
    await expect(page.getByText("1 sessions").first()).toBeVisible();

    // Then the side pane's tabs: one stop, ← → switch them as a click does.
    await page.keyboard.press("Tab");
    await expect(page.getByTestId("pane-tab-files")).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByTestId("pane-tab-skills")).toBeFocused();
    await expect(page.getByTestId("pane-tab-skills")).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("ArrowLeft");
    await expect(page.getByTestId("pane-tab-files")).toHaveAttribute("aria-selected", "true");

    // Then the pane's own button, then its list, which hands the focus to its first row.
    await page.keyboard.press("Tab");
    expect((await focused(page)).role).toBe("button");
    await page.keyboard.press("Tab");
    await expect.poll(() => focused(page)).toMatchObject({ row: true, name: "docs", expanded: "false" });

    // ↓ to the next row; → opens a folder and ← closes it; Enter opens a file.
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => focused(page)).toMatchObject({ name: "docs", expanded: "true" });
    await expect(page.getByTitle("docs/guide.md", { exact: true })).toBeVisible();
    await page.keyboard.press("ArrowLeft");
    await expect(page.getByTitle("docs/guide.md", { exact: true })).toHaveCount(0);
    await page.keyboard.press("ArrowDown");
    await expect.poll(() => focused(page)).toMatchObject({ row: true, name: "a.txt" });
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await seen()).opened).toEqual(["a.txt"]);

    // The menu key opens the row's own menu; its rename asks in the app's dialog, and a letter typed
    // there is a letter — "s" once opened the settings from any field.
    await page.keyboard.press("Shift+F10");
    await expect.poll(async () => (await seen()).menu).toContain("Rename…");
    const field = page.getByRole("dialog").getByRole("textbox");
    await expect(field).toBeFocused();
    await page.keyboard.type("s");
    await expect(field).toHaveValue("s");
    await expect(page.getByText("Appearance")).toHaveCount(0);

    // Enter on a focused button presses that button: Cancel, not the dialog's confirm.
    await page.keyboard.press("Tab");
    await expect(page.getByRole("dialog").getByRole("button", { name: "Cancel" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(existsSync(join(workspace, "a.txt")), "nothing was renamed").toBe(true);
    // And the keyboard is back on the row it left.
    await expect.poll(() => focused(page)).toMatchObject({ row: true, name: "a.txt" });

    // Escape in the session list goes back to the projects, with the keyboard in their list.
    await page.getByRole("listbox", { name: "Sessions" }).focus();
    await page.keyboard.press("Escape");
    await expect(projects).toBeFocused();
    await expect(page.getByText("1 projects").first()).toBeVisible();

    // Settings opens on its Back button, and closing it hands the keyboard back to the button.
    const settings = page.getByRole("button", { name: "Settings" });
    await settings.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Back", exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(settings).toBeFocused();
  } finally {
    await app.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("with no application menu, the default accelerators are gone and a text field keeps its editing keys", async () => {
  const { home } = fixture();
  const { app, page } = await launch(home);
  try {
    expect(await app.evaluate(({ Menu }) => Menu.getApplicationMenu())).toBeNull();
    // Chromium handles a field's editing keys itself on Windows and Linux — Ctrl+A and Ctrl+Z here,
    // Ctrl+C/V/X below — so they work with no menu to carry their accelerators.
    const search = page.getByPlaceholder("Search projects");
    await search.focus();
    await page.keyboard.type("abc");
    await page.keyboard.press("Control+A");
    expect(await search.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd])).toEqual([0, 3]);
    await page.keyboard.press("Control+Z");
    await expect(search).not.toHaveValue("abc");
    await search.fill("");

    // Copy and paste go through the system clipboard, which a run on a desk with a clipboard watcher
    // (the installed Hangar among them) may not be given; they are exercised where it is.
    const text = `hangar-paste-${Date.now()}`;
    const writable = await app.evaluate(({ clipboard }, value) => {
      clipboard.writeText(value);
      return clipboard.readText() === value;
    }, text);
    if (!writable) {
      test.info().annotations.push({ type: "clipboard", description: "the system clipboard is not available to this run: Ctrl+C/V/X not exercised" });
      return;
    }
    await page.keyboard.press("Control+V");
    await expect(search).toHaveValue(text);
    await page.keyboard.press("Control+A");
    await page.keyboard.press("Control+X");
    await expect(search).toHaveValue("");
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(text);
  } finally {
    await app.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  }
});
