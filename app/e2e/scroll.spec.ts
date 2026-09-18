/**
 * End-to-end: picking a row with the mouse does not move the list.
 *
 * Reported against 2.17.1, in a docked band: a double-click on a session bounced the list upwards.
 * A double-click selects first, and selecting scrolled the row into view — which, for the row the
 * top edge clips, pulls the whole list down a row (measured against the real transcripts: scrollTop
 * 308 -> 286). The keyboard still needs that, so both halves are pinned here.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

import { mainWindow } from "./appWindow.js";

/** As narrow as the user's band, which is where the jump was seen. */
const BAND = { x: 40, y: 40, width: 230, height: 1400 };
const SESSIONS = 40;
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
  }));
  writeFileSync(join(root, ".claude.json"), JSON.stringify({ projects: { [workspace]: {} } }));
  return home;
}

async function bandWindow(): Promise<{ app: ElectronApplication; page: Page }> {
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
  await page.keyboard.press("Enter");           // into the project's sessions
  await expect(page.getByText("세션 0").first()).toBeVisible();
  return { app, page };
}

test("a click on the row the top edge clips leaves the list where it was", async () => {
  const { app, page } = await bandWindow();
  try {
    const list = page.getByTestId("stack-sessions");
    // Half a row up from the bottom, so the top edge really does cut a row in two — that is the row
    // "scroll it into view" would pull down, and the one a person clicks after scrolling.
    const before = await list.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
      el.scrollTop -= 9;
      return el.scrollTop;
    });
    expect(before, "the fixture must be long enough to scroll").toBeGreaterThan(50);

    const box = await list.boundingBox();
    await page.mouse.click((box?.x ?? 0) + (box?.width ?? 0) / 2, (box?.y ?? 0) + 3);
    await page.waitForTimeout(500);

    const after = await list.evaluate((el) => el.scrollTop);
    expect(after, `the list moved from ${before} to ${after}`).toBe(before);
  } finally {
    await app.close();
  }
});

test("the keyboard still brings the selected row into view", async () => {
  const { app, page } = await bandWindow();
  try {
    const list = page.getByTestId("stack-sessions");
    await list.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    const bottom = await list.evaluate((el) => el.scrollTop);
    expect(bottom).toBeGreaterThan(50);

    // The selection sits on the first row, far above: walking it down must pull the list back up.
    for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(500);

    const after = await list.evaluate((el) => el.scrollTop);
    expect(after, `the list stayed at ${after} instead of following the selection`).toBeLessThan(bottom);
  } finally {
    await app.close();
  }
});
