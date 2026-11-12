/**
 * Core: the window's zoom — the steps − and + move between, a typed percentage, and the keys.
 */
import { describe, expect, it } from "vitest";

import { parseZoom, stepZoom, zoomFrom, zoomKey, zoomLabel } from "../zoom.js";

const key = (k: string, mods: Partial<{ control: boolean; meta: boolean; alt: boolean }> = { control: true }) =>
  zoomKey({ control: false, meta: false, alt: false, key: k, ...mods });

describe("zoom", () => {
  it("steps to the next step up or down, from a typed size too, held at the ends; 0 is 100 %", () => {
    expect(stepZoom(1, 1)).toBe(1.1);
    expect(stepZoom(1.1, 1)).toBe(1.25);
    expect(stepZoom(1.15, 1)).toBe(1.25);              // typed between two steps
    expect(stepZoom(1.15, -1)).toBe(1.1);
    expect(stepZoom(2, 1)).toBe(2);
    expect(stepZoom(0.5, -1)).toBe(0.5);
    expect(stepZoom(1.25, 0)).toBe(1);
  });

  it("takes a typed whole percentage in range, with or without %, and refuses anything else", () => {
    expect(parseZoom("115")).toBe(1.15);
    expect(parseZoom(" 115 % ")).toBe(1.15);
    expect(parseZoom("50%")).toBe(0.5);
    expect(parseZoom("200")).toBe(2);
    expect(parseZoom("201")).toBeNull();
    expect(parseZoom("49")).toBeNull();
    expect(parseZoom("abc")).toBeNull();
    expect(parseZoom("")).toBeNull();
  });

  it("reads a saved value outside the range as 100 %, and labels a factor as a percentage", () => {
    expect(zoomFrom("1.15")).toBe(1.15);
    expect(zoomFrom(3)).toBe(1);
    expect(zoomFrom(undefined)).toBe(1);
    expect(zoomLabel(1.1)).toBe("110%");
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
