/**
 * The app's own window.
 *
 * `firstWindow()` can hand back the splash, which then closes under the test — every spec that
 * launches the app needs this, and Playwright refuses to let one spec import another.
 */
import type { ElectronApplication, Page } from "@playwright/test";

export async function mainWindow(app: ElectronApplication): Promise<Page> {
  for (;;) {
    const found = app.windows().find((w) => w.url().includes("index.html"));
    if (found) return found;
    await app.waitForEvent("window");
  }
}
