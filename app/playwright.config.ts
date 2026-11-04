import { defineConfig } from "@playwright/test";

// Every launch helper passes process.env on, so this reaches each app the suite starts: its window
// appears without taking the foreground from whatever the person at the desk is doing (main.ts).
process.env["HANGAR_NO_ACTIVATE"] = "1";

/** Electron tests drive a real window: one worker, and a build must exist before they run. */
export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",          // no test app left over from an earlier run (see the file)
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 1,
  fullyParallel: false,
  reporter: process.env["CI"] ? [["github"], ["list"]] : [["list"]],
  use: { trace: "retain-on-failure" },
});
