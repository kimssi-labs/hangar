/**
 * The Windows installer keeps the taskbar pin when it runs over an existing install.
 *
 * electron-builder drops its keep-shortcuts path whenever the folder may be changed, so every run of
 * the setup file (anything but the in-app updater, which passes --updated) unpinned Hangar. The fix
 * lives in packaging files, not code; this test keeps those files from losing it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const APP = join(__dirname, "..", "..", "..");

describe("Windows installer", () => {
  const config = readFileSync(join(APP, "electron-builder.yml"), "utf8");

  it("installs for every account, in a folder the user may pick", () => {
    expect(config).toMatch(/^\s+perMachine: true\b/m);
    expect(config).toMatch(/^\s+allowToChangeInstallationDirectory: true\b/m);
  });

  it("restores the keep-shortcuts path after the folder page is declared", () => {
    const include = readFileSync(join(APP, "build", "installer.nsh"), "utf8");
    const header = include.match(/!macro customHeader([\s\S]*?)!macroend/);
    expect(header, "customHeader macro").not.toBeNull();
    expect(header![1]).toMatch(/!undef allowToChangeInstallationDirectory/);
  });
});
