/**
 * End-to-end: a clicked row ends up whole on screen, without the list moving under a double-click.
 *
 * Reported against 2.17.1, in a docked band: a double-click on a session bounced the list upwards.
 * A double-click selects first, and selecting scrolled the row into view — which, for the row the
 * top edge clips, pulls the whole list down a row (measured against the real transcripts: scrollTop
 * 308 -> 286), so the second click landed on another row. Then the owner showed the other half: a
 * clicked row the pane's edge cut off stayed cut off. So a click waits out the double-click time and
 * only then shows the row whole; the keyboard scrolls at once. All of it is pinned here.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";

import { mainWindow } from "./appWindow.js";

/** As narrow as the user's band, which is where the jump was seen. */
const BAND = { x: 40, y: 40, width: 230, height: 1400 };
const SESSIONS = 40;
/** Inside the double-click time (Lists.tsx waits 500 ms): the list must not have moved yet. */
const DURING_MS = 200;
/** Past the double-click time and a smooth scroll's few hundred milliseconds. */
const AFTER_MS = 1500;
const roots: string[] = [];

test.afterAll(() => {
  for (const root of roots) {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* the OS will clear %TEMP% eventually */
    }
  }
});

/** One project with enough sessions to scroll, and a launcher that opens nothing. */
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "hangar-scroll-"));
  roots.push(root);
  const home = join(root, ".claude");
  const workspace = join(root, "workspace");
  const dir = workspace.replace(/[^A-Za-z0-9]/g, "-");
  mkdirSync(join(home, "projects", dir), { recursive: true });
  mkdirSync(join(home, "sessions"), { recursive: true });
  mkdirSync(join(home, "config"), { recursive: true });
  mkdirSync(workspace, { recursive: true });
  for (let i = 0; i < SESSIONS; i++) {
    const id = `${String(i).padStart(8, "0")}-1111-2222-3333-444444444444`;
    writeFileSync(join(home, "projects", dir, `${id}.jsonl`), [
      JSON.stringify({ type: "user", cwd: workspace, sessionId: id, message: { content: `세션 ${i}` }, origin: { kind: "human" } }),
      JSON.stringify({ type: "assistant", message: { content: "…" } }),
    ].join("\n") + "\n");
  }
  writeFileSync(join(home, "config", "manager.json"), JSON.stringify({
    // A double-click must open nothing on the machine running the suite.
    launch: { shell: "custom", customShell: "C:\\Windows\\System32\\whoami.exe" },
    dock: { enabled: false },
    ui: { keepIcons: false },                       // its band is real; the desktop's icons are not the test's
  }));
  writeFileSync(join(root, ".claude.json"), JSON.stringify({ projects: { [workspace]: {} } }));
  return home;
}

async function bandWindow(): Promise<{ app: ElectronApplication; page: Page; list: Locator }> {
  const app = await electron.launch({
    args: [".", "--lang=en-US"],
    cwd: process.cwd(),
    env: { ...process.env, CLAUDE_HOME: fixture() },
  });
  const page = await mainWindow(app);           // firstWindow() can hand back the splash
  await page.waitForLoadState("domcontentloaded");
  await app.evaluate(({ BrowserWindow }, bounds) => {
    const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes("index.html"));
    win?.setBounds(bounds);
  }, BAND);
  await page.locator(".row").first().waitFor({ state: "visible", timeout: 30_000 });
  // The band's stack draws the project list anew, so the keyboard is put back in it before Enter.
  await page.getByRole("listbox", { name: "Projects" }).focus();
  await page.keyboard.press("Enter");           // into the project's sessions
  const list = page.getByTestId("stack-sessions");
  await expect(list).toBeFocused();
  await expect(page.getByText("세션 0").first()).toBeVisible();
  // The rows the sessions screen mounts settle over a frame or two (measured: the list 2791 px tall,
  // then 2217, then 2186, within 20 ms of Enter); a scrollTop set in between is pulled back to the
  // new end. So the list is left to hold still first.
  const height = (): Promise<number> => list.evaluate((el) => el.scrollHeight);
  await expect.poll(async () => {
    const was = await height();
    await page.waitForTimeout(250);
    return (await height()) === was;
  }).toBe(true);
  return { app, page, list };
}

/**
 * Scroll the list 9 px short of its end (its top edge then cuts a row) or 9 px past its start (its
 * bottom edge does), and say where it came to rest. A row cut in two is the one a person clicks
 * after scrolling, and the one "scroll it into view" would move.
 */
async function scrollTo(list: Locator, at: "bottom-cut" | "top-nudged"): Promise<number> {
  return list.evaluate((el, where) => {
    el.scrollTop = where === "bottom-cut" ? el.scrollHeight - 9 - el.clientHeight : 9;
    return el.scrollTop;
  }, at);
}

/** The id of the row under a point, and whether the list's edge cuts it. */
async function rowAt(page: Page, list: Locator, x: number, y: number): Promise<{ id: string; clipped: boolean }> {
  return page.evaluate(({ x: px, y: py, listId }) => {
    const box = (document.querySelector(`[data-testid="${listId}"]`) as HTMLElement).getBoundingClientRect();
    const row = document.elementFromPoint(px, py)?.closest("[role='option']") as HTMLElement | null;
    const r = row?.getBoundingClientRect();
    return { id: row?.id ?? "", clipped: Boolean(r && (r.top < box.top || r.bottom > box.bottom)) };
  }, { x, y, listId: await list.getAttribute("data-testid") });
}

/** Whether the selected row lies wholly inside the list's box. */
async function selectedWhole(list: Locator): Promise<boolean> {
  return list.evaluate((el) => {
    const row = el.querySelector("[aria-selected='true']");
    if (!row) return false;
    const r = row.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    return r.top >= box.top - 0.5 && r.bottom <= box.bottom + 0.5;
  });
}

for (const edge of ["top", "bottom"] as const) {
  test(`a click on a row the ${edge} edge cuts holds the list still, then shows the row whole`, async () => {
    const { app, page, list } = await bandWindow();
    try {
      const before = await scrollTo(list, edge === "top" ? "bottom-cut" : "top-nudged");
      expect(before, "the fixture must be long enough to scroll").toBeGreaterThan(0);
      const box = (await list.boundingBox())!;
      const x = box.x + box.width / 2;
      const y = edge === "top" ? box.y + 3 : box.y + box.height - 3;
      const target = await rowAt(page, list, x, y);
      expect(target.clipped, `the ${edge} edge must cut the row clicked`).toBe(true);

      await page.mouse.click(x, y);
      await page.waitForTimeout(DURING_MS);
      expect(await list.evaluate((el) => el.scrollTop), "the list moved inside the double-click time").toBe(before);

      await page.waitForTimeout(AFTER_MS);
      expect(await list.locator("[aria-selected='true']").getAttribute("id")).toBe(target.id);
      expect(await selectedWhole(list), "the clicked row is still cut off").toBe(true);
    } finally {
      await app.close();
    }
  });
}

test("a double-click on a row the edge cuts opens that row", async () => {
  const { app, page, list } = await bandWindow();
  try {
    // The open request is counted where main serves it: the bridge the page holds is a frozen copy.
    await app.evaluate(({ ipcMain }) => {
      type Handler = (...args: unknown[]) => unknown;
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers;
      const seen = globalThis as unknown as { opened: string[] };
      seen.opened = [];
      handlers.set("session:open", (_event: unknown, request: unknown) => {
        seen.opened.push((request as { sessionId: string }).sessionId);
        return { ok: true };
      });
    });
    const before = await scrollTo(list, "bottom-cut");
    const box = (await list.boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + 3;
    const target = await rowAt(page, list, x, y);
    expect(target.clipped, "the top edge must cut the row double-clicked").toBe(true);

    await page.mouse.dblclick(x, y);
    expect(await list.evaluate((el) => el.scrollTop), "the list moved between the two clicks").toBe(before);
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { opened: string[] }).opened))
      .toEqual([target.id.replace(/^session-/, "")]);
  } finally {
    await app.close();
  }
});

/** Thirty projects of one session each: a project list long enough to scroll. */
function manyProjects(): string {
  const root = mkdtempSync(join(tmpdir(), "hangar-scroll-projects-"));
  roots.push(root);
  const home = join(root, ".claude");
  const known: Record<string, object> = {};
  for (let i = 0; i < 30; i++) {
    const workspace = join(root, `project-${String(i).padStart(2, "0")}`);
    const dir = workspace.replace(/[^A-Za-z0-9]/g, "-");
    const id = `${String(i).padStart(8, "0")}-aaaa-2222-3333-444444444444`;
    mkdirSync(join(home, "projects", dir), { recursive: true });
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(home, "projects", dir, `${id}.jsonl`),
      `${JSON.stringify({ type: "user", cwd: workspace, sessionId: id, message: { content: `p${i}` }, origin: { kind: "human" } })}\n`);
    known[workspace] = {};
  }
  mkdirSync(join(home, "config"), { recursive: true });
  writeFileSync(join(home, "config", "manager.json"), JSON.stringify({ dock: { enabled: false }, ui: { keepIcons: false } }));
  writeFileSync(join(root, ".claude.json"), JSON.stringify({ projects: known }));
  return home;
}

// The project list scrolls in the box that takes its focus (App.tsx), not in the pane inside it:
// the clicked row must still end up whole, in the stack and in the column beside the sessions.
for (const shape of [{ name: "stacked", width: 230, height: 1400 }, { name: "side by side", width: 1180, height: 700 }] as const) {
  test(`${shape.name}: a clicked project row the bottom edge cuts ends up whole`, async () => {
    const app = await electron.launch({ args: [".", "--lang=en-US"], cwd: process.cwd(), env: { ...process.env, CLAUDE_HOME: manyProjects() } });
    try {
      const page = await mainWindow(app);
      await page.waitForLoadState("domcontentloaded");
      await app.evaluate(({ BrowserWindow }, size) => {
        BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes("index.html"))?.setBounds({ x: 40, y: 40, ...size });
      }, { width: shape.width, height: shape.height });
      await page.locator(".row").first().waitFor({ state: "visible", timeout: 30_000 });
      const list = page.getByRole("listbox", { name: "Projects" });
      await list.evaluate((el) => { el.scrollTop = 9; });
      const before = await list.evaluate((el) => el.scrollTop);
      expect(before, "the project list must be long enough to scroll").toBe(9);
      const box = (await list.boundingBox())!;
      const x = box.x + box.width / 2;
      const y = box.y + box.height - 3;
      const cut = await page.evaluate(({ px, py, top, bottom }) => {
        const r = document.elementFromPoint(px, py)?.closest("[role='option']")?.getBoundingClientRect();
        return Boolean(r && (r.top < top || r.bottom > bottom));
      }, { px: x, py: y, top: box.y, bottom: box.y + box.height });
      expect(cut, "the bottom edge must cut the row clicked").toBe(true);

      await page.mouse.click(x, y);
      await page.waitForTimeout(DURING_MS);
      expect(await list.evaluate((el) => el.scrollTop), "the list moved inside the double-click time").toBe(before);
      await page.waitForTimeout(AFTER_MS);
      expect(await list.evaluate((el) => {
        const row = el.querySelector("[aria-selected='true']")!.getBoundingClientRect();
        const shown = el.getBoundingClientRect();
        return row.top >= shown.top - 0.5 && row.bottom <= shown.bottom + 0.5;
      }), "the clicked project row is still cut off").toBe(true);
    } finally {
      await app.close();
    }
  });
}

test("the keyboard still brings the selected row into view at once", async () => {
  const { app, page, list } = await bandWindow();
  try {
    await list.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    const bottom = await list.evaluate((el) => el.scrollTop);
    expect(bottom).toBeGreaterThan(50);

    // The selection sits on the first row, far above: walking it down must pull the list back up.
    for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(DURING_MS);

    const after = await list.evaluate((el) => el.scrollTop);
    expect(after, `the list stayed at ${after} instead of following the selection`).toBeLessThan(bottom);
    expect(await selectedWhole(list), "the row the keys moved to is cut off").toBe(true);
  } finally {
    await app.close();
  }
});
