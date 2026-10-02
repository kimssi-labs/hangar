import { describe, expect, it } from "vitest";

import { movedByUser, placeAround } from "../deskIcons.js";

const MONITOR = { x: 0, y: 0, width: 1920, height: 1200 };
const SPACING = { x: 95, y: 102 };
const LEFT_BAND = { x: 0, y: 0, width: 576, height: 1200 };

describe("placeAround", () => {
  it("puts back every icon the band does not cover — Explorer shifted them all (measured)", () => {
    const icons = [{ id: "a", x: 665, y: 410 }, { id: "b", x: 760, y: 410 }];
    expect(placeAround(icons, LEFT_BAND, "left", MONITOR, SPACING)).toEqual(icons);
  });

  it("moves a covered icon just clear of the band, keeping its offset", () => {
    expect(placeAround([{ id: "a", x: 27, y: 2 }], LEFT_BAND, "left", MONITOR, SPACING))
      .toEqual([{ id: "a", x: 603, y: 2 }]);
  });

  it("steps past an icon already sitting where a covered one would go", () => {
    const icons = [{ id: "under", x: 27, y: 2 }, { id: "there", x: 603, y: 2 }];
    expect(placeAround(icons, LEFT_BAND, "left", MONITOR, SPACING))
      .toEqual([{ id: "under", x: 698, y: 2 }, { id: "there", x: 603, y: 2 }]);
  });

  it("moves the other way for the other edges", () => {
    const right = { x: 1344, y: 0, width: 576, height: 1200 };
    expect(placeAround([{ id: "a", x: 1800, y: 2 }], right, "right", MONITOR, SPACING)).toEqual([{ id: "a", x: 1224, y: 2 }]);
    const top = { x: 0, y: 0, width: 1920, height: 300 };
    expect(placeAround([{ id: "a", x: 27, y: 2 }], top, "top", MONITOR, SPACING)).toEqual([{ id: "a", x: 27, y: 302 }]);
  });

  it("leaves an icon to Windows rather than push it onto another monitor", () => {
    const wide = { x: 0, y: 0, width: 1800, height: 1200 };
    expect(placeAround([{ id: "a", x: 300, y: 2 }], wide, "left", MONITOR, SPACING)).toEqual([]);
  });

  it("does not touch icons on another monitor", () => {
    const elsewhere = { id: "far", x: -1500, y: 40 };
    expect(placeAround([elsewhere], LEFT_BAND, "left", MONITOR, SPACING)).toEqual([elsewhere]);
  });
});

describe("movedByUser", () => {
  it("names icons that are no longer where they were placed, or are gone", () => {
    const placed = [{ id: "a", x: 10, y: 10 }, { id: "b", x: 100, y: 10 }, { id: "c", x: 200, y: 10 }];
    const now = [{ id: "a", x: 11, y: 10 }, { id: "b", x: 400, y: 300 }];
    expect([...movedByUser(placed, now)].sort()).toEqual(["b", "c"]);
  });
});
