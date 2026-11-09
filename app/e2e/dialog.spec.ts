/**
 * End-to-end: the app's own dialogs, and the worktree list beside a project.
 *
 * Two things this pins down. `window.prompt` does not exist in Electron, so the branch-name question
 * had to become a real dialog before the feature worked at all — and a native message box cannot be
 * themed, so every question the app asks is now drawn inside the window.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
      /* the OS clears %TEMP% eventually */
    }
  }
});

/**
 * A home whose one project is a real git repository, so the git features have something to act on.
 * `separate` keeps the repository's store outside the checkout (`git init --separate-git-dir`), which
 * leaves a `.git` file there, just as a linked worktree has.
 */
function fixture({ separate = false } = {}): { home: string; workspace: string } {
  const root = mkdtempSync(join(tmpdir(), "hangar-dialog-"));
  roots.push(root);
  const home = join(root, ".claude");
  const workspace = join(root, "workspace");
  const projectDir = workspace.replace(/[^A-Za-z0-9]/g, "-");
  mkdirSync(join(home, "projects", projectDir), { recursive: true });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(
    join(home, "projects", projectDir, `${SESSION}.jsonl`),
    `${JSON.stringify({ type: "user", cwd: workspace, sessionId: SESSION })}\n`,
  );
  writeFileSync(join(home, "history.jsonl"), `${JSON.stringify({ display: "prompt", sessionId: SESSION })}\n`);
  writeFileSync(join(root, ".claude.json"), JSON.stringify({ projects: { [workspace]: {} } }));

  const git = (...args: string[]): void => {
    execFileSync("git", args, { cwd: workspace, stdio: "ignore" });
  };
  git("init", "-q", "-b", "main", ...(separate ? ["--separate-git-dir", join(root, "store.git")] : []));
  git("config", "user.email", "t@e.st");
  git("config", "user.name", "Test");
  writeFileSync(join(workspace, "a.txt"), "hi\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  return { home, workspace };
}

async function launch(home: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [".", "--lang=en-US"],
    cwd: process.cwd(),
    env: { ...process.env, CLAUDE_HOME: home },
  });
  for (;;) {
    const page = app.windows().find((w) => w.url().includes("index.html"));
    if (page) {
      await page.waitForLoadState("domcontentloaded");
      return { app, page };
    }
    await app.waitForEvent("window");
  }
}

test("the app asks in its own dialog, and a worktree becomes a project", async () => {
  const { home, workspace } = fixture();
  const { app, page } = await launch(home);
  try {
    await expect(page.getByText("workspace", { exact: true }).first()).toBeVisible();
    // The branch shows on the repository's line without git being asked anything: it is read
    // from .git.
    const parentRow = page.locator(".row").filter({
      has: page.getByTestId("project-name").filter({ hasText: /^workspace$/ }),
    });
    await expect(parentRow.getByTestId("project-git")).toHaveText("main");

    // The menu is the OS's own and cannot be clicked from here, and the bridge the renderer talks
    // through is frozen, so the stand-in goes where the menu is actually built.
    await app.evaluate(({ Menu }) => {
      type Item = { label?: string; click?: () => void };
      (Menu as unknown as { buildFromTemplate: (t: Item[]) => unknown }).buildFromTemplate =
        (template: Item[]) => ({
          popup: () => template.find((item) => item.label === "New worktree…")?.click?.(),
        });
    });
    await page.getByText("workspace", { exact: true }).first().click({ button: "right" });

    // A dialog in the page, not a box the OS drew: it is found in the DOM.
    const field = page.getByPlaceholder("branch name");
    await expect(field).toBeVisible();
    await field.fill("feature/dialog");
    await page.getByRole("button", { name: "Create" }).click();

    // The worktree exists on disk, and its folder is a project row of its own, called by its
    // repository with its branch beside the name: the folder name `<repo>-<branch>` would say the
    // branch twice. The folder is still there, in the tooltip.
    const expected = `${workspace}-feature-dialog`;
    await expect.poll(() => existsSync(expected), { timeout: 15000 }).toBe(true);
    const childRow = page.locator(".row").filter({
      has: page.getByTestId("project-branch").filter({ hasText: "[feature/dialog]" }),
    });
    const childName = childRow.getByTestId("project-name");
    await expect(childName).toHaveText("workspace");
    await expect(childName).toHaveAttribute("title", /workspace-feature-dialog/);
    // Marked by a drawn fork that says what it is, rather than by the word.
    await expect(childRow.getByRole("img", { name: "worktree" })).toBeVisible();
    // The repository's row, which keeps its branch on its own line, counts the worktree under it.
    // Both rows carry the name now; the branch tells them apart.
    await expect(childRow.getByTestId("project-git")).toHaveCount(0);
    const repoRow = page.locator(".row").filter({ has: page.getByTestId("project-git") });
    const count = repoRow.getByTitle("1 worktree(s)");
    // Open by default (worktrees are worth seeing), and the chip is the switch that folds them.
    await expect(count).toHaveText("▾1");
    await expect(count.getByRole("img", { name: "worktree" })).toBeVisible();

    // And the detail panel lists both checkouts of the repository.
    await expect(page.getByText("Worktrees", { exact: true })).toBeVisible();
    await expect(page.getByText("feature/dialog", { exact: false }).first()).toBeVisible();

    // The worktree sits UNDER its repository rather than beside it: indented, and directly after.
    const rows = await page.evaluate(() => Array.from(document.querySelectorAll(".row"))
      .map((row) => ({
        repository: row.querySelector("[data-testid='project-git']") !== null,
        tree: row.querySelector("[data-testid='project-branch']")?.textContent ?? "",
        indent: Number.parseFloat(getComputedStyle(row).marginLeft) || 0,
      })));
    const parent = rows.findIndex((row) => row.repository);
    const child = rows.findIndex((row) => row.tree === "[feature/dialog]");
    expect(child).toBe(parent + 1);
    expect(rows[child]?.indent).toBeGreaterThan(0);
    expect(rows[parent]?.indent).toBe(0);

    // Its sessions screen has no repository row above it, so the top bar says it the row's way.
    await childName.dblclick();
    const title = page.getByTestId("screen-title");
    await expect(title).toHaveText(/workspace\s*\[feature\/dialog\]/);
    await expect(title.getByRole("img", { name: "worktree" })).toBeVisible();
  } finally {
    await app.close();
  }
});

test("a repository whose store is kept elsewhere is a repository, not a worktree", async () => {
  // Its `.git` is a file, as a linked worktree's is. Taken for one, the row lost its name to the
  // branch and its menu offered to remove it as a worktree.
  const { home } = fixture({ separate: true });
  const { app, page } = await launch(home);
  try {
    const row = page.locator(".row").filter({
      has: page.getByTestId("project-name").filter({ hasText: /^workspace$/ }),
    });
    await expect(row.getByTestId("project-git")).toHaveText("main");
    await expect(row.getByTestId("project-branch")).toHaveCount(0);
    await expect(row.getByRole("img", { name: "worktree" })).toHaveCount(0);

    // The menu is the OS's own: keep what it was asked to show, and close it unchosen.
    await app.evaluate(({ Menu }) => {
      type Item = { label?: string; enabled?: boolean };
      (Menu as unknown as { buildFromTemplate: (t: Item[]) => unknown }).buildFromTemplate = (template: Item[]) => {
        (globalThis as { shownMenu?: Item[] }).shownMenu = template;
        return { popup: ({ callback }: { callback?: () => void }) => callback?.() };
      };
    });
    await row.click({ button: "right" });
    await expect.poll(() => app.evaluate(() => (globalThis as { shownMenu?: { label?: string; enabled?: boolean }[] })
      .shownMenu?.find((item) => item.label === "Remove this worktree…")?.enabled)).toBe(false);
  } finally {
    await app.close();
  }
});

test("a delete asks first, in the window, and cancelling deletes nothing", async () => {
  const { home } = fixture();
  const { app, page } = await launch(home);
  try {
    await expect(page.getByText("workspace", { exact: true }).first()).toBeVisible();
    // Delete is the project list's key, and the list has the keyboard from the start.
    await expect(page.getByRole("listbox", { name: "Projects" })).toBeFocused();
    await page.keyboard.press("Delete");

    // The question is in the page — a native box would leave the DOM untouched.
    const dialog = page.getByText("Delete workspace?", { exact: false });
    await expect(dialog).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();

    // Nothing went: the project is still listed.
    await expect(page.getByText("workspace", { exact: true }).first()).toBeVisible();
    expect(existsSync(join(home, "projects"))).toBe(true);
  } finally {
    await app.close();
  }
});
