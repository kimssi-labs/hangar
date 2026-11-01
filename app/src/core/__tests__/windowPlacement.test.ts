import { describe, expect, it } from "vitest";

import { openingRect } from "../windowPlacement.js";

const DESK = { x: 0, y: 0, width: 2560, height: 1392 };
const LAPTOP = { x: -1920, y: 706, width: 1536, height: 912 };
const SIZE = { width: 1180, height: 760 };

describe("openingRect", () => {
  it("reopens where it was left when that still fits", () => {
    const saved = { x: 613, y: 243, width: 1090, height: 994 };
    expect(openingRect(saved, [DESK, LAPTOP], DESK, SIZE)).toEqual(saved);
  });

  it("fits a rectangle saved on a big monitor into the smaller one it now lands on (reported)", () => {
    const saved = { x: 100, y: 100, width: 1090, height: 994 };
    const laptopAlone = { x: 0, y: 0, width: 1536, height: 912 };
    expect(openingRect(saved, [laptopAlone], laptopAlone, SIZE)).toEqual({ x: 100, y: 0, width: 1090, height: 912 });
  });

  it("uses the screen it overlaps most, and pulls a window hanging off the edge back on", () => {
    const saved = { x: -500, y: 900, width: 1000, height: 600 };     // mostly on the desk monitor, past its bottom
    expect(openingRect(saved, [DESK, LAPTOP], DESK, SIZE)).toEqual({ x: 0, y: 792, width: 1000, height: 600 });
    const onLaptop = { x: -1700, y: 1200, width: 800, height: 600 };  // on the laptop, past its bottom
    expect(openingRect(onLaptop, [DESK, LAPTOP], DESK, SIZE)).toEqual({ x: -1700, y: 1018, width: 800, height: 600 });
  });

  it("opens at the default size, centred on the primary screen, with nothing saved or nowhere to put it", () => {
    expect(openingRect(null, [DESK], DESK, SIZE)).toEqual({ x: 690, y: 316, width: 1180, height: 760 });
    expect(openingRect({ x: 9000, y: 9000, width: 800, height: 600 }, [DESK], DESK, SIZE)).toEqual({ x: 690, y: 316, width: 1180, height: 760 });
  });

  it("shrinks even the default to a screen smaller than it", () => {
    const small = { x: 0, y: 0, width: 1024, height: 600 };
    expect(openingRect(null, [small], small, SIZE)).toEqual({ x: 0, y: 0, width: 1024, height: 600 });
  });
});
