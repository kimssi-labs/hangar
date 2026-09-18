/**
 * End-to-end: a docked band does not take the keyboard away from the terminal.
 *
 * Reported on 2.17.1: clicking the band turned the taskbar's input indicator into an X and Korean
 * keystrokes meant for the terminal went nowhere. The band answers the mouse, so it does not need
 * the keyboard — except while the page has a field open, which is what the second half checks.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

import { mainWindow } from "./appWindow.js";

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "hangar-keyboard-"));
  const home = join(root, ".claude");
  const workspace = join(root, "workspace");
  const dir = workspace.replace(/[^A-Za-z0-9]/g, "-");
  mkdirSync(join(home, "projects", dir), { recursive: true });
  mkdirSync(join(home, "sessions"), { recursive: true });
  mkdirSync(workspace, { recursive: true });
  const id = "aaaaaaaa-1111-2222-3333-444444444444";
  writeFileSync(join(home, "projects", dir, `${id}.jsonl`), [
    JSON.stringify({ type: "user", cwd: workspace, sessionId: id, message: { content: "세션" }, origin: { kind: "human" } }),
    JSON.stringify({ type: "assistant", message: { content: "…" } }),
  ].join("\n") + "\n");
  writeFileSync(join(root, ".claude.json"), JSON.stringify({ projects: { [workspace]: {} } }));
  return home;
}

test("the band gives the keyboard back, and asks for it only while a field is open", async () => {
  const home = fixture();
  const app = await electron.launch({
    args: [".", "--lang=en-US"],
    cwd: process.cwd(),
    env: { ...process.env, CLAUDE_HOME: home },
  });
  const page = await mainWindow(app);
  await page.waitForLoadState("domcontentloaded");
  await page.locator(".row").first().waitFor({ state: "visible", timeout: 30_000 });
  const focusable = () => app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes("index.html"))?.isFocusable());

  try {
    expect(await focusable(), "an undocked window is an ordinary window").toBe(true);

    const display = await page.evaluate(async () => (await window.hangar.displays())[0]);
    const docked = await page.evaluate((device) =>
      window.hangar.applyDock({ enabled: true, device, edge: "right", percent: 20 }), display?.id ?? "");
    expect(docked.ok, "the band could not be applied").toBe(true);
    await page.waitForTimeout(600);
    expect(await focusable(), "a docked band still takes the keyboard").toBe(false);

    // Settings has fields in it; the band must take the keyboard back for as long as it is open.
    await page.evaluate(() => window.hangar.holdKeyboard(true));
    await page.waitForTimeout(300);
    expect(await focusable(), "the band did not take the keyboard for a field").toBe(true);

    await page.evaluate(() => window.hangar.holdKeyboard(false));
    await page.waitForTimeout(300);
    expect(await focusable(), "the band kept the keyboard after the field closed").toBe(false);

    await page.evaluate(() => window.hangar.releaseDock());
    await page.waitForTimeout(600);
    expect(await focusable(), "an undocked window must be focusable again").toBe(true);
  } finally {
    await page.evaluate(() => window.hangar.releaseDock()).catch(() => undefined);
    await app.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  }
});
