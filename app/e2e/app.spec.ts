/**
 * End-to-end: the built app, driven the way a person drives it — the keyboard in the list that has
 * the focus, the mouse everywhere else.
 *
 * Every run gets its own CLAUDE_HOME fixture, so the test sees a known set of projects and can
 * assert on what a rename actually wrote to disk.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

import { mainWindow } from "./appWindow.js";

const SESSION_ONE = "aaaaaaaa-1111-2222-3333-444444444444";
const SESSION_TWO = "bbbbbbbb-1111-2222-3333-444444444444";

/** Every fixture home made by this file, so the run does not leave temp copies behind. */
const roots: string[] = [];
test.afterAll(() => {
  for (const root of roots) {
    // Best effort: the app may still hold a handle as it exits, and a leftover temp directory is
    // not worth failing a passing test over.
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* the OS will clear %TEMP% eventually */
    }
  }
});

function fixture(): { home: string; projectDir: string } {
  const root = mkdtempSync(join(tmpdir(), "hangar-e2e-"));
  roots.push(root);
  const home = join(root, ".claude");
  const workspace = join(root, "workspace");
  const projectDir = workspace.replace(/[^A-Za-z0-9]/g, "-");
  mkdirSync(join(home, "projects", projectDir), { recursive: true });
  mkdirSync(join(home, "sessions"), { recursive: true });
  mkdirSync(workspace, { recursive: true });
  for (const id of [SESSION_ONE, SESSION_TWO]) {
    writeFileSync(
      join(home, "projects", projectDir, `${id}.jsonl`),
      `${JSON.stringify({ type: "user", cwd: workspace, sessionId: id })}\n`,
    );
  }
  writeFileSync(
    join(home, "history.jsonl"),
    [SESSION_ONE, SESSION_TWO]
      .map((id, index) => JSON.stringify({ display: `프롬프트 ${index + 1}`, sessionId: id }))
      .join("\n") + "\n",
  );
  writeFileSync(join(root, ".claude.json"), JSON.stringify({ projects: { [workspace]: {} } }));
  return { home, projectDir };
}

async function launch(home: string, env: Record<string, string> = {}): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    // --lang pins what app.getLocale() reports, and the window follows the machine unless told
    // otherwise: without this the suite reads in the language of whoever is running it.
    args: [".", "--lang=en-US"],
    cwd: process.cwd(),
    env: { ...process.env, ...env, CLAUDE_HOME: home },
  });
  const page = await mainWindow(app);
  await page.waitForLoadState("domcontentloaded");
  return { app, page };
}

test("shows the fixture's project and its sessions, and moves with the keyboard", async () => {
  const { home } = fixture();
  const { app, page } = await launch(home);
  try {
    await expect(page.getByText("workspace", { exact: false }).first()).toBeVisible();
    // The keyboard starts in the project list, so its keys work without a click first.
    await expect(page.getByRole("listbox", { name: "Projects" })).toBeFocused();

    // Enter opens the project's sessions — the same key the terminal version used.
    await page.keyboard.press("Enter");
    await expect(page.getByText("2 sessions").first()).toBeVisible();
    // The title shows twice — once in the row, once as the detail heading — so match the row.
    await expect(page.getByText("프롬프트 1").first()).toBeVisible();
    await expect(page.getByText("프롬프트 2").first()).toBeVisible();

    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Escape");                     // back to the projects
    await expect(page.getByText("Projects").first()).toBeVisible();
  } finally {
    await app.close();
  }
});

test("F2 renames a session the way /rename does", async () => {
  const { home, projectDir } = fixture();
  const { app, page } = await launch(home);
  try {
    // Wait for the list before typing: keys sent before the first scan lands have nothing to act on.
    await expect(page.getByText("프롬프트 1").first()).toBeVisible();
    await expect(page.getByRole("listbox", { name: "Projects" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByText("2 sessions").first()).toBeVisible();            // the sessions screen is up
    await page.keyboard.press("F2");
    const input = page.getByTestId("rename-input");
    await expect(input).toBeVisible();
    await input.fill("이름 바꾼 세션");
    await input.press("Enter");
    await expect(page.getByText("이름 바꾼 세션").first()).toBeVisible();

    // What matters is the file Claude Code itself reads. Which of the two fixture sessions sits at
    // the top depends on their timestamps, so the assertion is "one of them was renamed properly".
    const renamed = [SESSION_ONE, SESSION_TWO].find((id) => {
      try {
        const sidecar = join(home, "projects", projectDir, id, "custom-title.json");
        return JSON.parse(readFileSync(sidecar, "utf8")).customTitle === "이름 바꾼 세션";
      } catch {
        return false;
      }
    });
    expect(renamed, "a custom-title.json should exist for the renamed session").toBeDefined();
    const lines = readFileSync(join(home, "projects", projectDir, `${renamed}.jsonl`), "utf8").trim().split("\n");
    expect(JSON.parse(lines[lines.length - 1] as string))
      .toMatchObject({ type: "custom-title", customTitle: "이름 바꾼 세션" });
  } finally {
    await app.close();
  }
});

test("settings save to config/manager.json and survive a restart", async () => {
  const { home } = fixture();
  const first = await launch(home);
  try {
    await expect(first.page.getByText("workspace", { exact: false }).first()).toBeVisible();
    await first.page.getByRole("button", { name: "Settings" }).click();
    await expect(first.page.getByText("Permissions").first()).toBeVisible();
    await first.page.getByText("Bypass permissions").first().click();
    await expect.poll(() => {
      try {
        return JSON.parse(readFileSync(join(home, "config", "manager.json"), "utf8")).launch?.permission;
      } catch {
        return null;
      }
    }).toBe("bypass");
  } finally {
    await first.app.close();
  }

  const second = await launch(home);
  try {
    await expect(second.page.getByText("workspace", { exact: false }).first()).toBeVisible();
    await second.page.getByRole("button", { name: "Settings" }).click();
    // The choice is still the one that was made, read back from the file.
    await expect(second.page.locator("text=Bypass permissions").first()).toBeVisible();
  } finally {
    await second.app.close();
  }
});

test("Ctrl + and the text size setting zoom the window, and the size survives a restart", async () => {
  test.setTimeout(120_000);                            // two launches of the app
  const { home } = fixture();
  const zoomOf = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes("index.html"))?.webContents.getZoomFactor());
  const saved = () => JSON.parse(readFileSync(join(home, "config", "manager.json"), "utf8")).ui?.zoom;
  const first = await launch(home);
  try {
    await expect(first.page.getByText("workspace", { exact: false }).first()).toBeVisible();
    await first.page.keyboard.press("Control+=");
    await expect.poll(() => zoomOf(first.app)).toBe(1.1);
    await first.page.keyboard.press("Control+=");
    await expect.poll(() => zoomOf(first.app)).toBe(1.25);
    await first.page.keyboard.press("Control+-");
    await expect.poll(() => zoomOf(first.app)).toBe(1.1);
    // The settings screen shows the size the keys chose; − + and Reset move it, and a typed size is taken.
    await first.page.getByRole("button", { name: "Settings" }).click();
    const value = first.page.getByTestId("zoom-value");
    await expect(value).toHaveValue("110%");
    await first.page.getByTestId("zoom-in").click();
    await expect.poll(() => zoomOf(first.app)).toBe(1.25);
    await first.page.getByTestId("zoom-out").click();
    await expect.poll(() => zoomOf(first.app)).toBe(1.1);
    await first.page.getByTestId("zoom-reset").click();
    await expect.poll(() => zoomOf(first.app)).toBe(1);
    await value.fill("115");
    await value.press("Enter");
    await expect.poll(() => zoomOf(first.app)).toBe(1.15);
    await expect(value).toHaveValue("115%");
    await value.fill("999");                            // out of range: the size in force stays
    await value.press("Enter");
    await expect(value).toHaveValue("115%");
    await expect.poll(saved).toBe(1.15);
  } finally {
    await first.app.close();
  }

  const second = await launch(home);
  try {
    await expect(second.page.getByText("workspace", { exact: false }).first()).toBeVisible();
    expect(await zoomOf(second.app)).toBe(1.15);
    await second.page.keyboard.press("Control+0");
    await expect.poll(() => zoomOf(second.app)).toBe(1);
  } finally {
    await second.app.close();
  }
});

test("the sessions open last time are offered once on start-up, and reopened or let go", async () => {
  test.setTimeout(120_000);                            // two launches of the app
  const { home } = fixture();
  // The last run had one session open; nothing runs it now (there is no registry entry for it).
  // The terminal is a program that only prints a name, so nothing appears on the desk.
  mkdirSync(join(home, "cache"), { recursive: true });
  mkdirSync(join(home, "config"), { recursive: true });
  const openFile = join(home, "cache", "hangar-open-sessions.json");
  writeFileSync(openFile, JSON.stringify({ sessions: [SESSION_ONE] }));
  writeFileSync(join(home, "config", "manager.json"), JSON.stringify({
    launch: { shell: "custom", customShell: "C:\\Windows\\System32\\whoami.exe" },
  }));

  const first = await launch(home);
  try {
    await expect(first.page.getByText("Reopen the sessions open last time (1)?")).toBeVisible();
    await expect(first.page.getByText("· 프롬프트 1")).toBeVisible();
    await first.page.getByRole("button", { name: "Open all" }).click();
    await expect(first.page.getByText("Reopened 1 session.")).toBeVisible();
    // Asked once a run: nothing is offered again.
    expect(await first.page.evaluate(() => window.hangar.restorable())).toEqual([]);
  } finally {
    await first.app.close();
  }

  // Said no to, it is let go: the next start does not ask.
  const second = await launch(home);
  try {
    await expect(second.page.getByText("Reopen the sessions open last time (1)?")).toBeVisible();
    await second.page.keyboard.press("Escape");
    await expect.poll(() => JSON.parse(readFileSync(openFile, "utf8")).sessions).toEqual([]);
  } finally {
    await second.app.close();
  }
});

test("closing Hangar while a session runs asks: stay, close Hangar only, or close the session too", async () => {
  test.setTimeout(180_000);                            // three launches, and the close helper's first build
  const { home } = fixture();
  // A process standing in for a running claude, registered the way Claude Code registers one.
  // Node, named claude on its command line: the close helper ends only a claude (or node) process.
  const stand = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "claude-stand-in"], { stdio: "ignore" });
  const alive = (): boolean => { try { process.kill(stand.pid as number, 0); return true; } catch { return false; } };
  writeFileSync(join(home, "sessions", `${stand.pid}.json`), JSON.stringify({ pid: stand.pid, sessionId: SESSION_ONE }));
  const closeWindow = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes("index.html"))?.close());
  const exited = (app: ElectronApplication) => new Promise<void>((resolve) => {
    if (app.process().exitCode !== null) resolve();
    else app.process().once("exit", () => resolve());
  });
  const question = "1 sessions are running. Close them with Hangar?";
  try {
    // Asked, and staying is an answer: the window is still there.
    let { app, page } = await launch(home);
    await expect(page.getByText("workspace", { exact: false }).first()).toBeVisible();
    await closeWindow(app);
    await expect(page.getByText(question)).toBeVisible();
    await expect(page.getByText("· 프롬프트 1")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByText(question)).toHaveCount(0);
    expect(app.process().exitCode).toBeNull();

    // Hangar only: it leaves, the session keeps running.
    await closeWindow(app);
    await page.getByRole("button", { name: "Close Hangar only" }).click();
    await exited(app);
    expect(alive()).toBe(true);

    // Close all: the session ends with Hangar, and is kept for the next start to offer.
    ({ app, page } = await launch(home));
    await expect(page.getByText("workspace", { exact: false }).first()).toBeVisible();
    await closeWindow(app);
    await page.getByRole("button", { name: "Close all and keep them" }).click();
    await exited(app);
    await expect.poll(alive, { timeout: 30_000 }).toBe(false);
    expect(JSON.parse(readFileSync(join(home, "cache", "hangar-open-sessions.json"), "utf8")).sessions).toContain(SESSION_ONE);
  } finally {
    if (alive()) stand.kill();
  }
});

test("a screenshot on the clipboard becomes a file, with its path ready to paste", async () => {
  const { home } = fixture();
  const { app, page } = await launch(home);
  try {
    await expect(page.getByText("workspace", { exact: false }).first()).toBeVisible();

    // Nothing on the clipboard: say so rather than writing an empty file.
    await app.evaluate(({ clipboard }) => clipboard.clear());
    expect(await page.evaluate(() => window.hangar.pasteImage())).toMatchObject({ ok: false });

    // A real image, put on the clipboard the way a screenshot tool would.
    await app.evaluate(({ clipboard, nativeImage }) => {
      const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAFElEQVR4nGO8WR7OgA0wYRUdtBIATsMBtyGIWZMAAAAASUVORK5CYII=", "base64");
      clipboard.writeImage(nativeImage.createFromBuffer(png));
    });

    const pasted = await page.evaluate(() => window.hangar.pasteImage());
    expect(pasted.ok, pasted.message).toBe(true);
    expect(pasted.file).toMatch(new RegExp(String.raw`hangar-clips[\\/]clip-\d{8}-\d{6}-\d{3}\.png$`));
    expect(existsSync(pasted.file as string), "the file is really there").toBe(true);

    // The path is what a terminal can use, so that is what is on the clipboard now.
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(pasted.file);
  } finally {
    await app.close();
  }
});

/**
 * The watch is what lets the ordinary paste key work, and it is invisible when it is not running —
 * the unit tests know when a screenshot should be given a path, but only this knows that anything
 * is actually watching. It was written after a build shipped with the rules in place and nothing
 * calling them.
 *
 * Windows only: the change is detected through the clipboard sequence number, and no equivalent is
 * used elsewhere, so the setting simply does nothing there.
 */
test("a copied screenshot is given a path without anyone pressing a shortcut", async () => {
  test.skip(process.platform !== "win32", "the clipboard watch is Windows-only");
  const { home } = fixture();
  // The path is for terminals, and the window in front here is the app's own — so the watch is
  // told a terminal is in front (main/clipboardWatch's override for exactly this).
  const { app, page } = await launch(home, { HANGAR_CLIP_FOCUS: "terminal" });
  try {
    await expect(page.getByText("workspace", { exact: false }).first()).toBeVisible();

    await app.evaluate(({ clipboard, nativeImage }) => {
      const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAFElEQVR4nGO8WR7OgA0wYRUdtBIATsMBtyGIWZMAAAAASUVORK5CYII=", "base64");
      clipboard.clear();
      clipboard.writeImage(nativeImage.createFromBuffer(png));
    });

    // Nothing is pressed. Within a poll or two the path should simply be there.
    await expect.poll(
      () => app.evaluate(({ clipboard }) => clipboard.readText()),
      { message: "the watch never added a path", timeout: 8000 },
    ).toMatch(new RegExp(String.raw`hangar-clips[\\/]clip-\d{8}-\d{6}-\d{3}\.png$`));

    const file = await app.evaluate(({ clipboard }) => clipboard.readText());
    expect(existsSync(file), "the file the path points at is really there").toBe(true);
    // And the picture is still on the clipboard, so an image editor is unaffected.
    expect(await app.evaluate(({ clipboard }) => !clipboard.readImage().isEmpty())).toBe(true);
  } finally {
    await app.close();
  }
});

/**
 * A picture copied from a web view comes with an HTML copy of itself.
 *
 * New Teams (WebView2), browsers and Electron chat apps put the bitmap on the clipboard together
 * with HTML holding an `<img>` of it and no plain text. The watch took the HTML for text and left
 * the copy alone, so Ctrl+V in a terminal pasted nothing (reported from a Teams chat, formats
 * measured). The HTML also has to survive the round trip: leaving the terminal gives the picture
 * back with it, so pasting into another chat still gets what was copied.
 */
test("an image copied from a web view, HTML and all, is given a path and keeps its HTML", async () => {
  test.skip(process.platform !== "win32", "the clipboard watch is Windows-only");
  const { home } = fixture();
  const { app, page } = await launch(home, { HANGAR_CLIP_FOCUS: "terminal" });
  try {
    await expect(page.getByText("workspace", { exact: false }).first()).toBeVisible();
    await app.evaluate(({ clipboard, nativeImage }) => {
      const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAFElEQVR4nGO8WR7OgA0wYRUdtBIATsMBtyGIWZMAAAAASUVORK5CYII=";
      clipboard.clear();
      clipboard.write({ html: `<img src="data:image/png;base64,${base64}" alt="">`, image: nativeImage.createFromBuffer(Buffer.from(base64, "base64")) });
    });

    await expect.poll(
      () => app.evaluate(({ clipboard }) => clipboard.readText()),
      { message: "the watch never added a path to the web view's picture", timeout: 8000 },
    ).toMatch(new RegExp(String.raw`hangar-clips[\\/]clip-\d{8}-\d{6}-\d{3}\.png$`));

    // Away from the terminal: the path goes, the picture and its HTML stay.
    await app.evaluate(() => { process.env.HANGAR_CLIP_FOCUS = "other"; });
    await expect.poll(
      () => app.evaluate(({ clipboard }) => clipboard.readText()),
      { message: "the path stayed after the terminal lost the front", timeout: 8000 },
    ).toBe("");
    expect(await app.evaluate(({ clipboard }) => !clipboard.readImage().isEmpty()), "the picture is still there").toBe(true);
    expect(await app.evaluate(({ clipboard }) => clipboard.readHTML()), "the HTML came back with it").toContain("<img");
  } finally {
    await app.close();
  }
});

/**
 * The other half of the same rule: while no terminal is in front, the screenshot is left as it
 * was. Word pastes the text when a clipboard offers both a bitmap and a text (measured), so a path
 * added beside every screenshot turned Ctrl+V in a document into a file name — the report that
 * brought this test.
 */
test("a copied screenshot stays a picture while no terminal is in front", async () => {
  test.skip(process.platform !== "win32", "the clipboard watch is Windows-only");
  const { home } = fixture();
  // Whatever is in front on the desktop running this — a terminal, often — the watch is told it is not one.
  const { app, page } = await launch(home, { HANGAR_CLIP_FOCUS: "other" });
  try {
    await expect(page.getByText("workspace", { exact: false }).first()).toBeVisible();
    await app.evaluate(({ clipboard, nativeImage }) => {
      const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAFElEQVR4nGO8WR7OgA0wYRUdtBIATsMBtyGIWZMAAAAASUVORK5CYII=", "base64");
      clipboard.clear();
      clipboard.writeImage(nativeImage.createFromBuffer(png));
    });
    await page.waitForTimeout(2500);                           // several polls of the watch
    expect(await app.evaluate(({ clipboard }) => clipboard.readText()), "no path was added").toBe("");
    expect(await app.evaluate(({ clipboard }) => !clipboard.readImage().isEmpty()), "the picture is still there").toBe(true);
  } finally {
    await app.close();
  }
});

/**
 * The + beside the search box: a folder that has never had a session becomes a project.
 *
 * The folder picker is the OS's own dialog, which nothing can drive from here, so the test stands
 * in for it and checks everything after the choice — the row appears, is selected, and is a
 * project a session can be started from.
 */
test("the + button adds a folder as a project and lands on it", async () => {
  const { home } = fixture();
  const fresh = join(home, "..", "fresh-folder");
  mkdirSync(fresh, { recursive: true });

  const { app, page } = await launch(home);
  try {
    await expect(page.getByText("workspace", { exact: false }).first()).toBeVisible();
    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [folder] })) as typeof dialog.showOpenDialog;
    }, fresh);

    await page.getByRole("button", { name: "Add a project" }).click();

    await expect(page.getByText("fresh-folder", { exact: true }).first()).toBeVisible();
    // Landed on it: the detail panel names the folder, and New is offered for it.
    await expect(page.getByText(fresh, { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "New" })).toBeEnabled();
    expect(existsSync(join(home, "projects", fresh.replace(/[^A-Za-z0-9]/g, "-")))).toBe(true);
  } finally {
    await app.close();
  }
});

/**
 * A dock that cannot be applied at start-up says why. A band saved for a monitor that is not plugged
 * in is not applied — rightly — but the reason went out on `app:info`, a channel the page only ever
 * invokes and never listens to, so the window came up undocked without a word.
 */
test("a saved dock that cannot be applied at start-up says why", async () => {
  const { home } = fixture();
  mkdirSync(join(home, "config"), { recursive: true });
  writeFileSync(join(home, "config", "manager.json"), JSON.stringify({
    dock: { enabled: true, device: "9999,9999 640x480", edge: "top", percent: 20 },
  }));
  const { app, page } = await launch(home);
  try {
    await expect(page.getByText("Saved monitor 9999,9999 640x480 is not connected", { exact: false })).toBeVisible();
  } finally {
    await app.close();
  }
});
