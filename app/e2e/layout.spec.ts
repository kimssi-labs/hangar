/**
 * The two things a docked window must get right: it follows the chosen theme, and at either thin
 * shape it fits — no page scrolling, nothing pushed off the side.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

const SESSION = "cccccccc-1111-2222-3333-444444444444";

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

function fixture(workspaceName = "workspace"): string {
  const root = mkdtempSync(join(tmpdir(), "hangar-layout-"));
  roots.push(root);
  const home = join(root, ".claude");
  const workspace = join(root, workspaceName);
  const projectDir = workspace.replace(/[^A-Za-z0-9]/g, "-");
  mkdirSync(join(home, "projects", projectDir), { recursive: true });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(
    join(home, "projects", projectDir, `${SESSION}.jsonl`),
    `${JSON.stringify({ type: "user", cwd: workspace, sessionId: SESSION })}\n`,
  );
  writeFileSync(join(home, "history.jsonl"), `${JSON.stringify({ display: "프롬프트", sessionId: SESSION })}\n`);
  writeFileSync(join(root, ".claude.json"), JSON.stringify({ projects: { [workspace]: {} } }));
  return home;
}

async function launch(home: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    // --lang pins what app.getLocale() reports, and the window follows the machine unless told
    // otherwise: without this the suite reads in the language of whoever is running it.
    args: [".", "--lang=en-US"],
    cwd: process.cwd(),
    env: { ...process.env, CLAUDE_HOME: home },
  });
  const page = await mainWindow(app);
  await page.waitForLoadState("domcontentloaded");
  return { app, page };
}

/** The app's own window — `firstWindow()` can hand back the splash, which then closes. */
export async function mainWindow(app: ElectronApplication): Promise<Page> {
  for (;;) {
    const found = app.windows().find((w) => w.url().includes("index.html"));
    if (found) return found;
    await app.waitForEvent("window");
  }
}

async function resize(app: ElectronApplication, page: Page, width: number, height: number): Promise<void> {
  // The app's own window, found by its page: right after launch the first window can still be the splash.
  await app.evaluate(({ BrowserWindow }, size) => {
    BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes("index.html"))?.setContentSize(size.width, size.height);
  }, { width, height });
  // Within a few pixels: the window frame and the viewport do not agree to the pixel on Windows,
  // and this test is about the shape of the layout, not about that arithmetic.
  await expect
    .poll(() => page.evaluate(() => window.innerWidth), { timeout: 8000 })
    .toBeGreaterThan(width - 8);
  await expect
    .poll(() => page.evaluate(() => window.innerWidth), { timeout: 8000 })
    .toBeLessThan(width + 8);
}

/** What "no scroll" means here: the page itself never scrolls, in either direction. */
async function overflow(page: Page): Promise<{ x: number; y: number }> {
  return page.evaluate(() => ({
    x: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    y: document.documentElement.scrollHeight - document.documentElement.clientHeight,
  }));
}

test("the theme choice applies at once and survives a restart", async () => {
  const home = fixture();
  const first = await launch(home);
  try {
    await expect(first.page.getByText("workspace", { exact: false }).first()).toBeVisible();
    await first.page.getByRole("button", { name: "Settings" }).click();
    await expect(first.page.getByText("Appearance").first()).toBeVisible();
    await first.page.getByText("Dark", { exact: true }).first().click();

    await expect
      .poll(() => first.page.evaluate(() => document.documentElement.dataset["theme"]))
      .toBe("dark");
    await expect.poll(() => {
      try {
        return JSON.parse(readFileSync(join(home, "config", "manager.json"), "utf8")).ui?.theme;
      } catch {
        return null;
      }
    }).toBe("dark");
  } finally {
    await first.app.close();
  }

  const second = await launch(home);
  try {
    // Read back from the file, before anything is clicked.
    await expect
      .poll(() => second.page.evaluate(() => document.documentElement.dataset["theme"]))
      .toBe("dark");
  } finally {
    await second.app.close();
  }
});

/**
 * The reset time is the second half of a usage reading: a percentage without it does not say
 * whether to keep working or wait. The docked band dropped it for want of room — and the band is
 * the shape the app is left in all day, so the layout that needed the answer most never gave it.
 */
test("every shape says when the usage window resets", async () => {
  const home = fixture();
  mkdirSync(join(home, "cache"), { recursive: true });
  const resetsAt = Math.floor(Date.now() / 1000) + 2 * 3600 + 15 * 60;   // 2h 15m from now
  writeFileSync(join(home, "cache", "hangar-usage.json"), JSON.stringify({
    five_hour: { used_percentage: 19, resets_at: resetsAt },
    seven_day: { used_percentage: 100, resets_at: resetsAt + 86400 },
  }));

  const { app, page } = await launch(home);
  try {
    await expect(page.getByText("workspace", { exact: false }).first()).toBeVisible();
    // By handle, not by wording: a card that stands up says "↻ 2h 15m" where a wide one says
    // "2h 15m left · 01:30", and the test is about the answer being there, not how it is phrased.
    const reset = page.getByTestId("usage-reset").first();

    // Wide: the full column.
    await resize(app, page, 1200, 800);
    await expect(reset).toBeVisible();
    await expect(reset).toContainText("2h 1");                  // 2h 15m, give or take a minute

    // Docked as a band along an edge: the same answer, upright beside the machine graphs.
    await resize(app, page, 1200, 300);
    await expect(page.getByTestId("usage-reset").first()).toBeVisible();
    await expect(page.getByTestId("usage-reset").first()).toContainText("2h 1");
    expect(await overflow(page)).toEqual({ x: 0, y: 0 });
  } finally {
    await app.close();
  }
});

/**
 * Stacked, with a divider remembered from a taller window: the sessions must still be on screen.
 *
 * Reported from a docked band — the project list was remembered at 661 px, the band was 762 px
 * tall, and entering a project showed nothing at all below the divider.
 */
test("stacked: entering a project shows its sessions, even with a tall remembered divider", async () => {
  const home = fixture();
  mkdirSync(join(home, "config"), { recursive: true });
  writeFileSync(join(home, "config", "manager.json"), JSON.stringify({
    ui: { layout: "vertical", stackTop: 0.94 },
  }));

  const { app, page } = await launch(home);
  try {
    await resize(app, page, 1080, 762);
    await expect(page.getByText("workspace", { exact: false }).first()).toBeVisible();
    await expect(page.getByRole("listbox", { name: "Projects" })).toBeFocused();

    await page.keyboard.press("Enter");                       // into the project's sessions
    const session = page.getByText("프롬프트").first();
    await expect(session).toBeVisible();

    // "Visible" is not enough: with the divider left where it was, the sessions were squeezed into
    // a sliver that read as empty. The pane has to be a list.
    const pane = await page.getByTestId("stack-sessions").boundingBox();
    expect(pane, "the stacked sessions pane is there").not.toBeNull();
    expect(pane!.height, "the sessions pane is a list, not a sliver").toBeGreaterThanOrEqual(120);

    const box = await session.boundingBox();
    expect(box, "the session row has a box").not.toBeNull();
    expect(box!.y + box!.height).toBeLessThanOrEqual(await page.evaluate(() => window.innerHeight));
    expect(await overflow(page)).toEqual({ x: 0, y: 0 });
  } finally {
    await app.close();
  }
});

/**
 * The usage gauges sit with the machine graphs now, in every shape.
 *
 * They were in the title bar, where a narrow window cut them off. Moving them meant adding them to
 * four places, and the stacked strip — the shape this app is usually left in — was the one that got
 * missed: the window showed CPU and memory and no usage at all.
 */
/**
 * The two halves of the gauge strip are independent: "This PC" (CPU, memory, clock) comes and goes
 * with monitoring; "Claude usage" comes and goes with the usage settings. Monitoring off used to
 * take the Claude gauges — and the whole side panel — down with it.
 */
test("monitoring off hides the machine gauges and leaves the Claude usage gauges", async () => {
  const home = fixture();
  mkdirSync(join(home, "cache"), { recursive: true });
  mkdirSync(join(home, "config"), { recursive: true });
  const now = Math.floor(Date.now() / 1000);
  writeFileSync(join(home, "cache", "hangar-usage.json"), JSON.stringify({ five_hour: { used_percentage: 16, resets_at: now + 3600 } }));
  writeFileSync(join(home, "config", "manager.json"), JSON.stringify({ ui: { monitor: false } }));

  const { app, page } = await launch(home);
  try {
    const labels = async (): Promise<string[]> =>
      page.evaluate(() => [...document.querySelectorAll(".card")]
        .map((c) => ((c as HTMLElement).innerText.trim().split(String.fromCharCode(10))[0] ?? "")));
    for (const [width, height] of [[430, 900], [1200, 800]] as const) {
      await resize(app, page, width, height);
      await expect(page.getByText("workspace", { exact: false }).first()).toBeVisible();
      await expect.poll(labels, { timeout: 8000 }).toEqual(expect.arrayContaining(["5h"]));
      expect((await labels()).filter((label) => /cpu|memory/i.test(label)), `${width}x${height}: no machine gauge while monitoring is off`).toEqual([]);
    }
  } finally {
    await app.close();
  }
});

test("every shape draws the usage gauges beside the machine graphs", async () => {
  const home = fixture();
  mkdirSync(join(home, "cache"), { recursive: true });
  const now = Math.floor(Date.now() / 1000);
  writeFileSync(join(home, "cache", "hangar-usage.json"), JSON.stringify({
    five_hour: { used_percentage: 16, resets_at: now + 3600 },
    seven_day: { used_percentage: 7, resets_at: now + 500_000 },
  }));

  const { app, page } = await launch(home);
  try {
    // The first line of a card is its label — that is what says whether a gauge is drawn.
    const labels = async (): Promise<string[]> =>
      page.evaluate(() => [...document.querySelectorAll(".card")]
        .map((c) => ((c as HTMLElement).innerText.trim().split(String.fromCharCode(10))[0] ?? "")));

    // Stacked, as a docked band is: the gauges share the bottom strip with CPU and memory.
    // 430, not narrower: the window has a 420 px minimum and will not shrink past it.
    await resize(app, page, 430, 900);
    await expect(page.getByText("workspace", { exact: false }).first()).toBeVisible();
    await expect.poll(labels, { timeout: 8000 }).toEqual(expect.arrayContaining(["5h", "1w"]));

    // Wide, where the graphs live in the side panel.
    await resize(app, page, 1200, 800);
    await expect.poll(labels, { timeout: 8000 }).toEqual(expect.arrayContaining(["5h", "1w"]));
  } finally {
    await app.close();
  }
});

test("neither thin shape makes the page scroll", async () => {
  const home = fixture();
  const { app, page } = await launch(home);
  try {
    await expect(page.getByText("workspace", { exact: false }).first()).toBeVisible();

    // Docked to the top edge: short and wide.
    await resize(app, page, 1200, 300);
    expect(await overflow(page)).toEqual({ x: 0, y: 0 });
    await expect(page.getByText("workspace", { exact: false }).first()).toBeVisible();

    // Docked to the left edge: tall and narrow. The project list is the main pane here.
    await resize(app, page, 420, 900);
    expect(await overflow(page)).toEqual({ x: 0, y: 0 });
    await expect(page.getByText("workspace", { exact: false }).first()).toBeVisible();
    await expect(page.getByPlaceholder("Search projects", { exact: false })).toBeVisible();

    // ...and the sessions screen inside it, too. The stack draws the list anew, so it is given the
    // keyboard again first, once the stack is really drawn: focused any earlier (a slow runner),
    // the list that took the focus is the one the stack then replaces.
    await expect(page.getByTestId("stack-sessions")).toBeVisible();
    const projects = page.getByRole("listbox", { name: "Projects" });
    await projects.focus();
    await expect(projects).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("listbox", { name: "Sessions" })).toBeFocused();
    await expect(page.getByText("1 sessions").first()).toBeVisible();
    expect(await overflow(page)).toEqual({ x: 0, y: 0 });

    // Settings has to fit in the narrow shape as well.
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.getByText("Appearance").first()).toBeVisible();
    expect(await overflow(page)).toEqual({ x: 0, y: 0 });
  } finally {
    await app.close();
  }
});

/**
 * The gauges draw when their samples or their box change, not on every render, so the canvas has
 * to follow its box on its own: its backing store matches the box in device pixels, and something
 * is drawn in it, in both shapes.
 */
test("a gauge's canvas follows its box, and is drawn in", async () => {
  const { app, page } = await launch(fixture());
  try {
    const sized = (): Promise<boolean> => page.evaluate(() => {
      const canvas = document.querySelector(".card canvas") as HTMLCanvasElement | null;
      if (!canvas || !canvas.clientWidth) return false;
      const ratio = window.devicePixelRatio || 1;
      const close = (pixels: number, css: number): boolean => Math.abs(pixels - css * ratio) <= 1;
      if (!close(canvas.width, canvas.clientWidth) || !close(canvas.height, canvas.clientHeight)) return false;
      const data = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
      for (let i = 3; i < data.length; i += 4) if (data[i]) return true;   // the grid at least
      return false;
    });
    for (const [width, height] of [[1200, 800], [430, 900]] as const) {
      await resize(app, page, width, height);
      await expect.poll(sized, { timeout: 8000, message: `${width}x${height}` }).toBe(true);
    }
  } finally {
    await app.close();
  }
});

/**
 * A row too narrow for its name and its numbers puts the numbers on a line of their own — decided
 * by a container query on the row now, not by the row measuring itself.
 */
test("a narrow row puts its numbers under the name, a wide one beside it", async () => {
  const { app, page } = await launch(fixture());
  try {
    const row = page.locator(".row").filter({ hasText: "workspace" }).first();
    const below = (): Promise<boolean> => row.evaluate((el) => {
      const name = el.querySelector(".min-w-0")!.getBoundingClientRect();
      const figures = el.querySelector(".row-figures")!.getBoundingClientRect();
      return figures.top >= name.bottom - 1;
    });
    // Wide, the project list is its default 288 px column: a row there is under its 300 px.
    await resize(app, page, 1200, 800);
    await expect(row).toBeVisible();
    await expect.poll(below).toBe(true);
    // Stacked, the list spans the window and the row has room for both on one line.
    await resize(app, page, 430, 900);
    await expect.poll(below).toBe(false);
  } finally {
    await app.close();
  }
});

test("text that does not fit says the whole of itself on hover", async () => {
  // A name long enough to be cut in any window, on any platform: the CI runner's temp paths are
  // short, and a test that only clips on one machine proves nothing on the other.
  const longName = `workspace-${"long-project-name-".repeat(4)}end`;
  const { app, page } = await launch(fixture(longName));
  try {
    await expect(page.getByText(longName, { exact: false }).first()).toBeVisible();

    const clipping = () => page.evaluate(() => {
      const all = [...document.querySelectorAll("div,span")]
        .filter((n) => typeof n.className === "string" && n.className.includes("truncate"));
      const cut = all.filter((n) => n.scrollWidth > n.clientWidth + 1);
      return {
        cut: cut.length,
        titled: cut.filter((n) => (n.getAttribute("title") ?? "").length > 0).length,
        // Named, not counted: a failure should say which label went quiet.
        silent: cut.filter((n) => !(n.getAttribute("title") ?? "").length)
          .map((n) => (n.textContent ?? "").slice(0, 40)),
      };
    });

    // Narrow: the name cannot fit, and every cut label carries its full self.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes("index.html"))?.setContentSize(430, 800));
    await expect.poll(async () => (await clipping()).cut, { timeout: 8000 }).toBeGreaterThan(0);
    // Polled, not sampled: a label is measured after layout, and the assertion should not race the
    // frame in which it happens.
    await expect
      .poll(async () => (await clipping()).silent, { timeout: 8000 })
      .toEqual([]);
  } finally {
    await app.close();
  }
});

/**
 * Every settings section survives a restart.
 *
 * Reported as "rebase cannot be selected": the save call listed the sections by hand and two of
 * them — git and updates — were never in the list, so those choices reverted the moment the main
 * process pushed the settings back. A list that has to be remembered is one that gets forgotten,
 * so this asserts the whole payload rather than the section of the day.
 */
test("a choice in any settings section is still there after a restart", async () => {
  const home = fixture();
  const { app, page } = await launch(home);
  try {
    await expect(page.getByText("workspace", { exact: false }).first()).toBeVisible();
    await page.getByRole("button", { name: "Settings" }).click();

    // One choice from each of the sections added late, plus one that always worked as a control.
    await page.getByText("Merge", { exact: true }).click();
    await page.getByText("Only when I ask", { exact: true }).click();
    await page.getByText("Stacked", { exact: true }).click();
    await page.waitForTimeout(400);                 // the save is a round trip
  } finally {
    await app.close();
  }

  const saved = JSON.parse(readFileSync(join(home, "config", "manager.json"), "utf8")) as {
    git?: { strategy?: string };
    updates?: { automatic?: boolean };
    ui?: { layout?: string };
  };
  expect(saved.git?.strategy).toBe("merge");
  expect(saved.updates?.automatic).toBe(false);
  expect(saved.ui?.layout).toBe("vertical");
});

/** Drag a divider by (dx, dy) in small steps, the way a hand does. */
async function drag(page: Page, index: number, dx: number, dy: number): Promise<void> {
  const box = (await page.getByRole("separator", { name: "Resize" }).nth(index).boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let step = 1; step <= 10; step += 1) await page.mouse.move(x + (dx * step) / 10, y + (dy * step) / 10);
  await page.mouse.up();
}

/** Where every divider is: what the pane sizes come to, read off the screen. */
async function dividers(page: Page): Promise<number[]> {
  const boxes = await page.getByRole("separator", { name: "Resize" }).evaluateAll((all) =>
    all.map((el) => { const r = el.getBoundingClientRect(); return Math.round(r.width > r.height ? r.y : r.x); }));
  return boxes;
}

/**
 * Every size the dividers set comes back after a restart, in both shapes: side by side (the project
 * list's width, the side column's width) and stacked (the project list's height, the side pane's).
 */
for (const shape of [
  { layout: "horizontal", width: 1400, height: 900, moves: [[80, 0], [-80, 0]] },
  { layout: "vertical", width: 430, height: 900, moves: [[0, 60], [0, -100]] },
] as const) {
  test(`${shape.layout}: every divider dragged is where it was after a restart`, async () => {
    const home = fixture();
    mkdirSync(join(home, "config"), { recursive: true });
    writeFileSync(join(home, "config", "manager.json"), JSON.stringify({ ui: { layout: shape.layout } }));
    let dragged: number[] = [];
    const first = await launch(home);
    try {
      await resize(first.app, first.page, shape.width, shape.height);
      const before = await dividers(first.page);
      expect(before.length, "both dividers are there to drag").toBeGreaterThanOrEqual(2);
      for (const [index, [dx, dy]] of shape.moves.entries()) await drag(first.page, index, dx, dy);
      await first.page.waitForTimeout(500);
      dragged = await dividers(first.page);
      expect(dragged, "the drags moved the dividers").not.toEqual(before);
    } finally {
      await first.app.close();
    }
    const { app, page } = await launch(home);
    try {
      await resize(app, page, shape.width, shape.height);
      await expect.poll(async () => (await dividers(page)).every((at, i) => Math.abs(at - dragged[i]!) <= 2), { timeout: 8000 })
        .toBe(true);
    } finally {
      await app.close();
    }
  });
}

/**
 * Stacked and too narrow for a file column, the side pane sits under the sessions — and used to be
 * stuck at its cap, with no divider to drag (reported). It has one now, and keeps the height.
 */
test("stacked: the side pane under the sessions can be dragged taller, and stays that tall", async () => {
  const home = fixture();
  mkdirSync(join(home, "config"), { recursive: true });
  writeFileSync(join(home, "config", "manager.json"), JSON.stringify({ ui: { layout: "vertical" } }));
  const { app, page } = await launch(home);
  try {
    await resize(app, page, 430, 900);
    const pane = page.getByTestId("files-section");
    await expect(pane).toBeVisible();
    const before = (await pane.boundingBox())!.height;
    const grip = page.getByRole("separator").last();
    const box = (await grip.boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (let step = 1; step <= 10; step += 1) await page.mouse.move(x, y - 12 * step);
    await page.mouse.up();
    await expect.poll(async () => (await pane.boundingBox())!.height).toBeGreaterThan(before + 80);
    await expect.poll(async () => (await page.evaluate(() => window.hangar.loadSettings())).ui.stackPane).toBeGreaterThan(0);
  } finally {
    await app.close();
  }
});

test("the pin keeps the window above the others, and is remembered", async () => {
  const home = fixture();
  const onTop = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes("index.html"))?.isAlwaysOnTop());
  const first = await launch(home);
  try {
    expect(await onTop(first.app), "off until asked").toBe(false);
    await first.page.getByRole("button", { name: "Keep on top of other windows" }).click();
    await expect.poll(() => onTop(first.app)).toBe(true);
    await expect(first.page.getByRole("button", { name: "Stop keeping on top" })).toHaveAttribute("aria-pressed", "true");
  } finally {
    await first.app.close();
  }
  const { app, page } = await launch(home);
  try {
    await expect.poll(() => onTop(app), { message: "still on top after a restart" }).toBe(true);
    await page.getByRole("button", { name: "Stop keeping on top" }).click();
    await expect.poll(() => onTop(app)).toBe(false);
  } finally {
    await app.close();
  }
});

/** The top bar splits where the panes below do: the search, + and New end where the lists end. */
const NEW_LABEL = "New";
test("the project search spans the lists, and follows the side panel's divider", async () => {
  const home = fixture();
  mkdirSync(join(home, "config"), { recursive: true });
  writeFileSync(join(home, "config", "manager.json"), JSON.stringify({ ui: { layout: "horizontal" } }));
  const { app, page } = await launch(home);
  try {
    await resize(app, page, 1400, 900);
    const plus = page.getByRole("button", { name: NEW_LABEL, exact: true });
    const panelLeft = async (): Promise<number> => page.locator("aside").first().evaluate((el) => el.getBoundingClientRect().left);
    const plusRight = async (): Promise<number> => (await plus.boundingBox())!.x + (await plus.boundingBox())!.width;
    await expect.poll(async () => Math.abs((await panelLeft()) - (await plusRight())), { timeout: 5000 }).toBeLessThanOrEqual(16);
    await drag(page, 1, -120, 0);                              // widen the side panel
    await expect.poll(async () => Math.abs((await panelLeft()) - (await plusRight())), { timeout: 5000 }).toBeLessThanOrEqual(16);
  } finally {
    await app.close();
  }
});

/** A project's sessions are all in the list, reached by scrolling — no "show all" button at its end. */
test("every session of the selected project is listed, with nothing to press to see the rest", async () => {
  const home = fixture();
  const projectDir = readdirSync(join(home, "projects"))[0]!;
  const cwd = join(home, "..", "workspace");
  for (let i = 0; i < 12; i += 1) {
    const id = `ffffffff-0000-0000-0000-${String(i).padStart(12, "0")}`;
    writeFileSync(join(home, "projects", projectDir, `${id}.jsonl`), [
      JSON.stringify({ type: "user", cwd, sessionId: id, message: { content: `topic ${i}` }, origin: { kind: "human" } }),
      JSON.stringify({ type: "assistant", message: { content: "…" } }),
    ].join(String.fromCharCode(10)) + String.fromCharCode(10));
  }
  mkdirSync(join(home, "config"), { recursive: true });
  writeFileSync(join(home, "config", "manager.json"), JSON.stringify({ ui: { layout: "vertical" } }));
  const { app, page } = await launch(home);
  try {
    await resize(app, page, 430, 900);
    const list = page.getByTestId("stack-sessions");
    for (const i of [0, 5, 11]) await expect(list).toContainText(`topic ${i}`);
    await expect(page.getByRole("button", { name: /Show all/ })).toHaveCount(0);
  } finally {
    await app.close();
  }
});

/**
 * A newer version found as the app opens is asked about once: in words that fit what is happening
 * with it, a yes that updates in place, and a box that keeps the question away for a week.
 */
test("the update question appears once, and 'not for a week' is remembered", async () => {
  const home = fixture();
  const push = (app: ElectronApplication, phase: string) => app.evaluate(({ BrowserWindow }, p) => {
    const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes("index.html"))!;
    win.webContents.send("update:push", { phase: p, current: "2.20.2", latest: "9.9.9", percent: 0, error: null, checkedAt: Date.now() });
  }, phase);
  const first = await launch(home);
  try {
    await push(first.app, "ready");
    const dialog = first.page.getByRole("dialog", { name: "A new version of Hangar" });
    await expect(dialog).toContainText("Hangar 9.9.9 has been downloaded. Restart now to update?");
    await dialog.getByLabel("Don't show this for a week").check();
    await dialog.getByRole("button", { name: "No" }).click();
    await expect(dialog).toHaveCount(0);
    await push(first.app, "available");                       // asked once a run
    await first.page.waitForTimeout(500);
    await expect(dialog).toHaveCount(0);
    const until = (await first.page.evaluate(() => window.hangar.loadSettings())).ui.updateSnoozeUntil;
    expect(until - Date.now(), "a week from now").toBeGreaterThan(6 * 24 * 3600 * 1000);
  } finally {
    await first.app.close();
  }
  const { app, page } = await launch(home);
  try {
    await push(app, "available");
    await page.waitForTimeout(500);
    await expect(page.getByRole("dialog", { name: "A new version of Hangar" }), "snoozed across a restart").toHaveCount(0);
  } finally {
    await app.close();
  }
});

/**
 * The stacked dividers still move after the window turned into a stack behind the settings screen.
 *
 * Reported from a docked band: docking from the settings card makes the window a stack while no
 * stack is on screen, its height was read as 0, and back in the list both dividers were pinned at
 * their minimum, so neither pane could be resized until the shape changed again.
 */
test("stacked: the divider drags after the window became a stack while settings was open", async () => {
  const home = fixture();
  const { app, page } = await launch(home);
  try {
    await resize(app, page, 1080, 762);                          // side by side
    await page.getByRole("button", { name: "Settings" }).click();
    await resize(app, page, 480, 900);                           // a stack, as docking to a side makes it
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await expect(page.getByTestId("stack-sessions")).toBeVisible();

    const [before = 0] = await dividers(page);
    await drag(page, 0, 0, 120);
    const [after = 0] = await dividers(page);
    expect(after - before, "the divider follows the drag").toBeGreaterThan(60);
  } finally {
    await app.close();
  }
});

/**
 * Full layout in a short window: the side pane keeps its tabs and a few rows, and the gauges below
 * it never cover them.
 *
 * At 1100 x 620 the details and the gauges did not give way, the side pane was squeezed to one
 * pixel, and the CPU card was drawn over the Files / Skills / Artifacts tabs (seen in 2.22.0 too).
 */
test("full layout, short window: the gauges do not cover the side pane's tabs", async () => {
  const { app, page } = await launch(fixture());
  try {
    await resize(app, page, 1100, 620);
    await expect(page.getByText("workspace", { exact: false }).first()).toBeVisible();
    const tabs = await page.getByRole("tablist").boundingBox();
    const gauges = await page.getByTestId("aside-gauges").boundingBox();
    const pane = await page.getByTestId("files-section").boundingBox();
    expect(tabs && gauges && pane, "tabs, gauges and the pane are all drawn").toBeTruthy();
    expect(tabs!.y + tabs!.height, "the tabs end above the gauges").toBeLessThanOrEqual(gauges!.y + 1);
    expect(pane!.height, "the pane keeps room for its tabs and a few rows").toBeGreaterThanOrEqual(110);
  } finally {
    await app.close();
  }
});

/**
 * A band as narrow as the owner's (about 230 px) keeps every caption button and a usable search box.
 *
 * At 230 px the maximise and close buttons were pushed out of the window, and the search box was
 * squeezed to 26 px under the New button so it could not be clicked (2.22.0 too; CI, docking at
 * 20 % of a 1024 px screen, could not click it either).
 */
test("a narrow band keeps its close button and a search box that can be clicked", async () => {
  const { app, page } = await launch(fixture());
  try {
    for (const width of [205, 230, 300]) {
      await app.evaluate(({ BrowserWindow }, w) => {
        const win = BrowserWindow.getAllWindows().find((b) => b.webContents.getURL().includes("index.html"));
        win?.setMinimumSize(100, 100);                       // a docked band is pinned narrower than a window may be
        win?.setContentSize(w, 900);
      }, width);
      await expect.poll(() => page.evaluate(() => window.innerWidth), { timeout: 8000 }).toBeLessThan(width + 8);
      const close = (await page.getByRole("button", { name: "Close" }).boundingBox())!;
      const search = page.getByPlaceholder("Search projects");
      const box = (await search.boundingBox())!;
      const fresh = (await page.getByRole("button", { name: "New", exact: true }).boundingBox())!;
      const inner = await page.evaluate(() => window.innerWidth);
      expect(close.x + close.width, `${width}: the close button is inside the window`).toBeLessThanOrEqual(inner + 0.5);
      // 44 px on Linux's fonts at 205 px, 50 on Windows': either is a box that takes a click and text.
      expect(box.width, `${width}: the search box has room to type in`).toBeGreaterThanOrEqual(40);
      expect(box.x + box.width <= fresh.x || fresh.y >= box.y + box.height,
        `${width}: New does not sit on the search box`).toBe(true);
      await search.click();
      await page.keyboard.type("wo");
      await expect(search).toHaveValue("wo");
      await search.press("Escape");
    }
  } finally {
    await app.close();
  }
});
