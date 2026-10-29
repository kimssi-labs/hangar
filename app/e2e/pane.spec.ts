/**
 * End-to-end: the side pane's tabs — files, the skills a project can use, the account's Artifacts.
 *
 * Skills come from three places on disk, and the fixture has one of each: a project skill, a user
 * skill, and a skill of a plugin that is installed and switched on (beside one that is installed and
 * switched off, which must not show). The fixture home has no login, so the Artifacts tab says so
 * and nothing is asked of claude.ai — the suite never touches the network.
 */
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

const SESSION = "eeeeeeee-1111-2222-3333-444444444444";
const roots: string[] = [];
test.afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

function skill(dir: string, name: string, description: string): void {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`);
}

function fixture(ui: Record<string, unknown> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "hangar-pane-"));
  roots.push(root);
  const home = join(root, ".claude");
  const workspace = join(root, "workspace");
  const dir = workspace.replace(/[^A-Za-z0-9]/g, "-");
  mkdirSync(join(home, "projects", dir), { recursive: true });
  mkdirSync(join(home, "config"), { recursive: true });
  mkdirSync(join(home, "plugins"), { recursive: true });
  skill(join(workspace, ".claude", "skills"), "deploy-here", "Ships this project");
  skill(join(home, "skills"), "my-report", "Writes my monthly report");
  const onPlugin = join(root, "plugins", "helper");
  const offPlugin = join(root, "plugins", "quiet");
  skill(join(onPlugin, "skills"), "brainstorm", "Explores an idea first");
  skill(join(offPlugin, "skills"), "hidden", "Must not be listed");
  writeFileSync(join(home, "settings.json"), JSON.stringify({ enabledPlugins: { "helper@market": true, "quiet@market": false } }));
  writeFileSync(join(home, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: {
    "helper@market": [{ installPath: onPlugin }],
    "quiet@market": [{ installPath: offPlugin }],
  } }));
  writeFileSync(join(home, "projects", dir, `${SESSION}.jsonl`), `${JSON.stringify({ type: "user", cwd: workspace, sessionId: SESSION })}\n`);
  writeFileSync(join(root, ".claude.json"), JSON.stringify({ projects: { [workspace]: {} } }));
  writeFileSync(join(home, "config", "manager.json"), JSON.stringify({ ui: { layout: "vertical", ...ui } }));
  return home;
}

async function launch(home: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ args: [".", "--lang=en-US"], cwd: process.cwd(), env: { ...process.env, CLAUDE_HOME: home } });
  const page = await app.waitForEvent("window", { predicate: (w) => w.url().includes("index.html") })
    .catch(() => app.windows().find((w) => w.url().includes("index.html")) as Page);
  await page.waitForLoadState("domcontentloaded");
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.setContentSize(1400, 900); });
  await expect(page.getByText("workspace", { exact: false }).first()).toBeVisible();
  return { app, page };
}

test("the skills tab lists the project's, the user's and the switched-on plugins' skills", async () => {
  const { app, page } = await launch(fixture());
  try {
    await page.getByTestId("pane-tab-skills").click();
    const list = page.getByTestId("skills-list");
    // Two sections: the project's own skills, then the global ones every project gets.
    await expect(page.getByTestId("skills-section-project")).toContainText("Project skills");
    await expect(page.getByTestId("skills-section-global")).toContainText("Global skills");
    // Everything starts closed; the one button opens it all.
    await expect(list).not.toContainText("deploy-here");
    await page.getByTestId("pane-expand-all").click();
    await expect(list).toContainText("deploy-here");
    const order = (await list.innerText()).toLowerCase();
    expect(order.indexOf("deploy-here"), "the project's skill is listed before the global section").toBeLessThan(order.indexOf("global skills"));
    await expect(list).toContainText("Your skills (1)");
    await expect(list).toContainText("my-report");
    await expect(list).toContainText("Plugin · helper (1)");
    await expect(list).toContainText("helper:brainstorm");
    await expect(list).not.toContainText("hidden");

    await page.getByLabel("Search skills").fill("report");
    await expect(list).toContainText("my-report");
    await expect(list).not.toContainText("deploy-here");

    // The tab is remembered.
    await expect.poll(async () => (await page.evaluate(() => window.hangar.loadSettings())).ui.sidePane).toBe("skills");
  } finally {
    await app.close();
  }
});

test("a group opened by hand is still open after a restart, and the rest stay closed", async () => {
  const home = fixture({ sidePane: "skills" });
  const first = await launch(home);
  try {
    await first.page.getByTestId("skills-section-project").click();
    await expect(first.page.getByTestId("skills-list")).toContainText("deploy-here");
    await expect.poll(async () => (await first.page.evaluate(() => window.hangar.loadSettings())).ui.paneOpen).toContain("skills:project");
  } finally {
    await first.app.close();
  }
  const { app, page } = await launch(home);
  try {
    const list = page.getByTestId("skills-list");
    await expect(list).toContainText("deploy-here");
    await expect(list).not.toContainText("Your skills");          // inside the global section, still closed
  } finally {
    await app.close();
  }
});

test("the Artifacts tab, with no login, says so and asks nothing of claude.ai", async () => {
  const { app, page } = await launch(fixture());
  try {
    await page.getByTestId("pane-tab-artifacts").click();
    await expect(page.getByRole("status")).toContainText("Sign in to Claude Code");
    await expect(page.getByTestId("artifacts-list")).toContainText("Press refresh");
  } finally {
    await app.close();
  }
});

/**
 * Where an Artifact came from is read from the transcripts: the fixture's session published one, and
 * the cached list (no login, so nothing is fetched) has that one and one made elsewhere.
 */
test("the Artifacts tab groups by project, and narrows to the project and the session", async () => {
  const home = fixture({ sidePane: "artifacts" });
  const mine = "11111111-2222-3333-4444-555555555555";
  const web = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const project = readdirSync(join(home, "projects"))[0]!;
  appendFileSync(join(home, "projects", project, `${SESSION}.jsonl`), [
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_1", name: "Artifact", input: { file_path: "r.html" } }] } }),
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: `Published r.html at https://claude.ai/code/artifact/${mine}` }] } }),
  ].join(String.fromCharCode(10)) + String.fromCharCode(10));
  mkdirSync(join(home, "cache"), { recursive: true });
  const day = 86_400_000;
  writeFileSync(join(home, "cache", "hangar-artifacts.json"), JSON.stringify({ fetchedAt: Date.now() - day, failure: null, items: [
    { slug: mine, title: "Session report", description: "", icon: "chart", shared: false, updatedAt: new Date(Date.now() - 2 * day).toISOString(), url: `https://claude.ai/code/artifact/${mine}` },
    { slug: web, title: "Made on the web", description: "", icon: "doc", shared: false, updatedAt: new Date(Date.now() - 45 * day).toISOString(), url: `https://claude.ai/code/artifact/${web}` },
  ] }));
  const { app, page } = await launch(home);
  try {
    const list = page.getByTestId("artifacts-list");
    await expect(page.getByTestId("artifacts-group")).toHaveCount(2);
    await expect(list).toContainText("workspace (1)");
    await expect(list).toContainText("Not from a Claude Code session (1)");
    await page.getByTestId("pane-expand-all").click();
    await expect(list).toContainText("2 d ago");
    await expect(list).toContainText("2 mo ago");                    // relative, never a date

    await page.getByTestId("artifacts-scope-project").click();
    await expect(page.getByTestId("artifacts-group")).toHaveCount(1);
    await expect(list).not.toContainText("Made on the web");

    await page.getByTestId("artifacts-scope-session").click();
    await expect(list).toContainText("Pick a session");
  } finally {
    await app.close();
  }
});

test("a tab switched off in Settings is not offered", async () => {
  const { app, page } = await launch(fixture({ artifacts: false }));
  try {
    await expect(page.getByTestId("pane-tab-skills")).toBeVisible();
    await expect(page.getByTestId("pane-tab-artifacts")).toHaveCount(0);
  } finally {
    await app.close();
  }
});
