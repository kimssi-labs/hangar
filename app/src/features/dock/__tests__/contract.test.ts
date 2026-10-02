import { describe, expect, it } from "vitest";

import { chosenMonitor, type DisplayInfo } from "../contract.js";

const screen = (id: string, primary: boolean): DisplayInfo =>
  ({ id, label: id, bounds: { x: 0, y: 0, width: 1, height: 1 }, primary, saved: false });
const DISPLAYS = [screen("side", false), screen("main", true)];

describe("chosenMonitor", () => {
  it("is the saved monitor when there is one", () => {
    expect(chosenMonitor("side", DISPLAYS)).toBe("side");
  });

  it("is the primary — the one the list highlights — when none is saved, so Apply has a monitor", () => {
    expect(chosenMonitor(null, DISPLAYS)).toBe("main");
  });
});
