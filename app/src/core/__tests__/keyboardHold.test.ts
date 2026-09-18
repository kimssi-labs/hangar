/**
 * Core: a docked band leaves the keyboard where the user is typing.
 *
 * Measured on this machine: with the band focused, Windows draws the taskbar's input indicator as an
 * X — the focused window takes no text — and Korean keystrokes meant for the terminal went nowhere.
 */
import { describe, expect, it } from "vitest";

import { windowTakesKeyboard } from "../keyboardHold.js";

describe("windowTakesKeyboard", () => {
  it("leaves the keyboard alone while docked", () => {
    expect(windowTakesKeyboard(true, false)).toBe(false);
  });

  it("takes it while the page has a field open, docked or not", () => {
    expect(windowTakesKeyboard(true, true)).toBe(true);
    expect(windowTakesKeyboard(false, true)).toBe(true);
  });

  it("leaves an undocked window as ordinary as any other", () => {
    expect(windowTakesKeyboard(false, false)).toBe(true);
  });
});
