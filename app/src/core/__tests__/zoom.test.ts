/**
 * Core: the window's zoom steps, and the keys that move between them.
 */
import { describe, expect, it } from "vitest";

import { stepZoom, zoomFrom, zoomKey } from "../zoom.js";

const key = (k: string, mods: Partial<{ control: boolean; meta: boolean; alt: boolean }> = { control: true }) =>
  zoomKey({ control: false, meta: false, alt: false, key: k, ...mods });

describe("zoom", () => {
  it("steps up and down through the fixed levels, held at the ends, and 0 goes back to 100 %", () => {
    expect(stepZoom(1, 1)).toBe(1.1);
    expect(stepZoom(1.1, 1)).toBe(1.25);
    expect(stepZoom(1.5, 1)).toBe(1.5);
    expect(stepZoom(0.9, -1)).toBe(0.8);
    expect(stepZoom(0.8, -1)).toBe(0.8);
    expect(stepZoom(1.25, 0)).toBe(1);
  });

  it("reads anything that is not a step as 100 %", () => {
    expect(zoomFrom("1.25")).toBe(1.25);
    expect(zoomFrom(2)).toBe(1);
    expect(zoomFrom(undefined)).toBe(1);
  });

  it("answers Ctrl with + = - 0, and nothing without Ctrl or with Alt", () => {
    expect(key("=")).toBe(1);
    expect(key("+")).toBe(1);
    expect(key("-")).toBe(-1);
    expect(key("0")).toBe(0);
    expect(key("0", {})).toBeNull();
    expect(key("0", { control: true, alt: true })).toBeNull();
    expect(key("a")).toBeNull();
  });
});
