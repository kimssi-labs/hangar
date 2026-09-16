/**
 * End-to-end: the project's folder, in the three shapes the window can give it.
 *
 * The shape is chosen by how wide the window actually is, not by which layout the settings name —
 * "stacked" is a choice about the lists, and a stacked window 1400 px wide has room for a column of
 * files beside them. That is the case this file exists for: it was invisible before, because the
 * stacked branch drew nothing at all to the right of the lists.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

const SESSION = "dddddddd-1111-2222-3333-444444444444";

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

/**
 * A project that is a real repository with one edited file and one new one, so the marks have
 * something true to say, and names that sort three ways: directories, numbers, letters.
 */
function fixture(layout: "auto" | "vertical"): string {
  const root = mkdtempSync(join(tmpdir(), "hangar-files-"));
  roots.push(root);
  const home = join(root, ".claude");
  const workspace = join(root, "workspace");
  const dir = workspace.replace(/[^A-Za-z0-9]/g, "-");
  mkdirSync(join(home, "projects", dir), { recursive: true });
  mkdirSync(join(home, "config"), { recursive: true });
  mkdirSync(join(workspace, "src", "core"), { recursive: true });
  mkdirSync(join(workspace, "docs"), { recursive: true });
  for (const name of ["src/core/status.ts", "src/main.ts", "docs/guide.md", "package.json", "9.log", "99.log", "100.log"]) {
    writeFileSync(join(workspace, name), "first");
  }
  const git = (...args: string[]): void => { execFileSync("git", args, { cwd: workspace, stdio: "ignore" }); };
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  git("add", ".");
  git("commit", "-qm", "first");
  writeFileSync(join(workspace, "src", "core", "status.ts"), "edited");
  writeFileSync(join(workspace, "docs", "new.md"), "new");

  writeFileSync(
    join(home, "projects", dir, `${SESSION}.jsonl`),
    `${JSON.stringify({ type: "user", cwd: workspace, sessionId: SESSION })}\n`,
  );
  writeFileSync(join(home, "history.jsonl"), `${JSON.stringify({ display: "프롬프트", sessionId: SESSION })}\n`);
  writeFileSync(join(root, ".claude.json"), JSON.stringify({ projects: { [workspace]: {} } }));
  writeFileSync(join(home, "config", "manager.json"), JSON.stringify({ ui: { layout } }));
  return home;
}

async function launch(home: string, width: number, height: number): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ args: [".", "--lang=en-US"], cwd: process.cwd(), env: { ...process.env, CLAUDE_HOME: home } });
  const page = await app.waitForEvent("window", { predicate: (w) => w.url().includes("index.html") })
    .catch(() => app.windows().find((w) => w.url().includes("index.html")) as Page);
  await page.waitForLoadState("domcontentloaded");
  await app.evaluate(({ BrowserWindow }, size) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(size.width, size.height);
  }, { width, height });
  await expect(page.getByText("workspace", { exact: false }).first()).toBeVisible();
  return { app, page };
}

test("a wide stacked window draws the folder in a column of its own, beside the two lists", async () => {
  const { app, page } = await launch(fixture("vertical"), 1400, 900);
  try {
    const column = page.getByTestId("files-column");
    await expect(column).toBeVisible();
    await expect(page.getByTestId("files-section")).toHaveCount(0);

    // Directories first, then numbers the way a person reads them.
    await expect.poll(async () => (await column.innerText()).replace(/[\s▸▾·]+/g, " ").trim(), { timeout: 8000 })
      .toMatch(/docs \+ src ✎ 9\.log 99\.log 100\.log package\.json/);

    // Three panes, and the two lists still have most of the width.
    const [projects, sessions, files] = await Promise.all([
      page.getByTestId("stack-sessions").boundingBox(),
      page.getByText("프롬프트").first().boundingBox(),
      column.boundingBox(),
    ]);
    expect(projects, "the stacked sessions pane is there").not.toBeNull();
    expect(sessions, "a session row is drawn").not.toBeNull();
    expect(files!.width).toBeGreaterThan(160);
    expect(files!.width).toBeLessThan(700);
  } finally {
    await app.close();
  }
});

test("a folder opens where it is clicked, and only that folder is read", async () => {
  const { app, page } = await launch(fixture("vertical"), 1400, 900);
  try {
    const column = page.getByTestId("files-column");
    const src = column.getByRole("button").filter({ hasText: "src" }).first();
    await expect(src).toBeVisible();
    // Nothing of the second level is drawn until the folder is opened.
    await expect(column.getByRole("button").filter({ hasText: "main.ts" })).toHaveCount(0);

    await src.click();
    await expect(column.getByRole("button").filter({ hasText: "main.ts" })).toBeVisible();
    await expect(column.getByRole("button").filter({ hasText: "core" })).toBeVisible();
    // docs was never opened, so its contents were never read.
    await expect(column.getByRole("button").filter({ hasText: "guide.md" })).toHaveCount(0);

    await src.click();
    await expect(column.getByRole("button").filter({ hasText: "main.ts" })).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test("a narrow window shows what changed instead of a tree", async () => {
  const { app, page } = await launch(fixture("vertical"), 700, 900);
  try {
    const section = page.getByTestId("files-section");
    await expect(section).toBeVisible();
    await expect(page.getByTestId("files-column")).toHaveCount(0);
    await expect.poll(async () => (await section.innerText()).replace(/\s+/g, " ").trim(), { timeout: 8000 })
      .toMatch(/src\/core\/status\.ts.*docs\/new\.md/);
    // The untouched files are not in this list — that is the whole point of it.
    await expect(section.getByText("package.json")).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test("a narrow panel can still be asked for the whole folder, and asked back", async () => {
  const { app, page } = await launch(fixture("vertical"), 700, 900);
  try {
    const section = page.getByTestId("files-section");
    await expect(section).toBeVisible();
    // It opens on what changed; package.json did not, so it is not in the list.
    await expect(section.getByText("package.json")).toHaveCount(0);

    await section.getByRole("button", { name: "All" }).click();
    await expect(section.getByRole("button").filter({ hasText: "package.json" })).toBeVisible();
    await expect(section.getByRole("button").filter({ hasText: "docs" })).toBeVisible();

    await section.getByRole("button", { name: "Changed" }).click();
    await expect(section.getByText("package.json")).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test("turning the folder off in settings stops it being drawn at all", async () => {
  const { app, page } = await launch(fixture("vertical"), 1400, 900);
  try {
    await expect(page.getByTestId("files-column")).toBeVisible();
    await page.keyboard.press("s");
    await page.getByText("Hide", { exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("files-column")).toHaveCount(0);
    await expect(page.getByTestId("files-section")).toHaveCount(0);
  } finally {
    await app.close();
  }
});
