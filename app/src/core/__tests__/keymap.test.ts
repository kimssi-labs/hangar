import { describe, expect, it } from "vitest";

import { foldKey, listAction, nextIndex } from "../keymap.js";

describe("listAction", () => {
  it("moves with the arrows, a page at a time, and to either end", () => {
    expect(listAction({ key: "ArrowUp" })).toBe("moveUp");
    expect(listAction({ key: "ArrowDown" })).toBe("moveDown");
    expect(listAction({ key: "PageDown" })).toBe("pageDown");
    expect(listAction({ key: "Home" })).toBe("moveFirst");
    expect(listAction({ key: "End" })).toBe("moveLast");
  });

  it("opens, goes back, renames and deletes from the list that has the focus", () => {
    expect(listAction({ key: "Enter" })).toBe("open");
    expect(listAction({ key: "Escape" })).toBe("back");
    expect(listAction({ key: "F2" })).toBe("rename");
    expect(listAction({ key: "Delete" })).toBe("delete");
  });

  it("has no letter shortcuts left: a letter is only ever a letter", () => {
    for (const key of ["o", "n", "v", "s", "/", "?", "F5"]) expect(listAction({ key })).toBeNull();
  });

  it("leaves a modified key to the system — Shift+F10 becomes the browser's contextmenu event", () => {
    expect(listAction({ key: "F10", shiftKey: true })).toBeNull();
    expect(listAction({ key: "ContextMenu" })).toBeNull();
    expect(listAction({ key: "q", ctrlKey: true })).toBeNull();
    expect(listAction({ key: "Enter", altKey: true })).toBeNull();
  });
});

describe("nextIndex", () => {
  it("clamps at both ends", () => {
    expect(nextIndex("moveUp", 0, 5, 10)).toBe(0);
    expect(nextIndex("moveDown", 4, 5, 10)).toBe(4);
    expect(nextIndex("pageDown", 0, 50, 10)).toBe(10);
    expect(nextIndex("pageUp", 5, 50, 10)).toBe(0);
    expect(nextIndex("moveLast", 0, 5, 10)).toBe(4);
    expect(nextIndex("moveFirst", 3, 5, 10)).toBe(0);
  });

  it("stays at zero for an empty list", () => {
    expect(nextIndex("moveDown", 0, 0, 10)).toBe(0);
  });
});

describe("foldKey", () => {
  it("opens with the right arrow and folds with the left, leaving modified keys to the system", () => {
    expect(foldKey({ key: "ArrowRight" })).toBe("open");
    expect(foldKey({ key: "ArrowLeft" })).toBe("close");
    expect(foldKey({ key: "ArrowLeft", altKey: true })).toBeNull();
    expect(foldKey({ key: "ArrowUp" })).toBeNull();
  });
});
