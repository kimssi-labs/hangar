/**
 * End-to-end: a session says what it is doing, before its name.
 *
 * Claude Code writes that into its registry entry — "busy" while answering, "waiting" while asking
 * the person something, "idle" once the turn is theirs (all three measured in `sessions/<pid>.json`).
 * The row draws a pulsing dot for the first and a bell for the other two, so a glance across the list
 * says which session is waiting for you.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

import { mainWindow } from "./appWindow.js";

const WORKING = "aaaaaaaa-1111-2222-3333-444444444444";
const ASKING = "bbbbbbbb-1111-2222-3333-444444444444";
const DONE = "cccccccc-1111-2222-3333-444444444444";
const FINISHED = "dddddddd-1111-2222-3333-444444444444";

/**
 * A home whose registry says one session is busy, one is waiting and one is idle.
 *
 * The pids are this test's own process, because the app asks the operating system whether a pid is
 * alive and a made-up number is not.
 */
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "hangar-status-"));
  const home = join(root, ".claude");
  const workspace = join(root, "workspace");
  const dir = workspace.replace(/[^A-Za-z0-9]/g, "-");
  mkdirSync(join(home, "projects", dir), { recursive: true });
  mkdirSync(join(home, "sessions"), { recursive: true });
  mkdirSync(workspace, { recursive: true });

  const named: [string, string][] = [[WORKING, "답변 중"], [ASKING, "확인 요청"], [DONE, "끝난 대화"], [FINISHED, "닫힌 대화"]];
  for (const [id, title] of named) {
    writeFileSync(join(home, "projects", dir, `${id}.jsonl`), [
      JSON.stringify({ type: "user", cwd: workspace, sessionId: id, message: { content: title }, origin: { kind: "human" } }),
      JSON.stringify({ type: "assistant", message: { content: "…" } }),
    ].join("\n") + "\n");
  }
  const states: [string, string, number][] = [[WORKING, "busy", 1], [ASKING, "waiting", 2], [DONE, "idle", 3]];
  for (const [id, status, n] of states) {
    writeFileSync(join(home, "sessions", `${process.pid + n * 0}${n}.json`), JSON.stringify({
      pid: process.pid, sessionId: id, status, cwd: workspace, procStart: `13434000000000000${n}`,
    }));
  }
  writeFileSync(join(root, ".claude.json"), JSON.stringify({ projects: { [workspace]: {} } }));
  return home;
}

test("a busy session shows a dot, one waiting for you shows a bell, a closed one neither", async () => {
  const home = fixture();
  const app = await electron.launch({
    args: [".", "--lang=en-US"],
    cwd: process.cwd(),
    env: { ...process.env, CLAUDE_HOME: home },
  });
  const page = await mainWindow(app);
  await page.waitForLoadState("domcontentloaded");
  await page.locator(".row").first().waitFor({ state: "visible", timeout: 30_000 });

  try {
    await page.keyboard.press("Enter");                       // into the project's sessions
    await expect(page.getByText("답변 중").first()).toBeVisible();

    const markOf = async (title: string): Promise<string> => {
      const row = page.locator(".row").filter({ hasText: title }).first();
      const bell = row.locator("span[title]").filter({ has: page.locator("svg") });
      if (await bell.count()) return String(await bell.first().getAttribute("title"));
      return String(await row.locator("span[title]").first().getAttribute("title"));
    };

    expect(await markOf("답변 중"), "the busy session").toBe("running");
    expect(await markOf("확인 요청"), "the session asking something").toContain("Your turn");
    expect(await markOf("끝난 대화"), "the session that finished").toContain("Your turn");
    expect(await markOf("닫힌 대화"), "the session that is not running").toBe("idle");
  } finally {
    await app.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  }
});
