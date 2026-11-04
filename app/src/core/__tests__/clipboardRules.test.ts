/**
 * Core: when a copied screenshot gets a path, and which saved ones are thrown away.
 *
 * The rule that matters is the loop: adding a path is itself a clipboard write, so a watcher that
 * did not recognise its own work would rewrite the clipboard forever.
 */
import { describe, expect, it } from "vitest";
import { CLIP_KEEP, clipsToPrune, shouldAddPath, isTerminalHost, TERMINAL_HOSTS } from "../clipboardRules.js";

const IMAGE = ["image/png"];
const IMAGE_AND_PATH = ["text/plain", "image/png"];

describe("shouldAddPath", () => {
  it("adds a path to a freshly copied screenshot", () => {
    expect(shouldAddPath({ formats: IMAGE, sequence: 7 }, 6)).toBe(true);
  });

  it("leaves the clipboard alone once the path is on it", () => {
    // Our own write. Reacting to it would put us in a loop, writing a file every poll.
    expect(shouldAddPath({ formats: IMAGE_AND_PATH, sequence: 8 }, 7)).toBe(false);
  });

  it("ignores a clipboard nothing has touched", () => {
    expect(shouldAddPath({ formats: IMAGE, sequence: 7 }, 7)).toBe(false);
  });

  it("ignores copied text", () => {
    expect(shouldAddPath({ formats: ["text/plain", "text/html"], sequence: 9 }, 8)).toBe(false);
  });

  it("adds a path to an image copied from a web view, which comes with an HTML copy of itself", () => {
    // New Teams (WebView2), browsers and Electron chat apps put the picture on the clipboard
    // together with HTML holding an <img> of it, and no plain text. Electron reports that as
    // text/html + image/png (measured on a Teams copy), and treating the HTML as text skipped it.
    expect(shouldAddPath({ formats: ["text/html", "image/png"], sequence: 9 }, 8)).toBe(true);
  });

  it("still leaves an image alone when plain text comes with it", () => {
    // A range of spreadsheet cells is a picture, HTML and plain text: the text is what is meant.
    expect(shouldAddPath({ formats: ["text/plain", "text/html", "text/rtf", "image/png"], sequence: 9 }, 8)).toBe(false);
  });

  it("only HTML is let through: rich text or a file reference beside the picture still count", () => {
    // A WordPad/Office object, and a file copied with its thumbnail (pasting it into Explorer must
    // keep working), are not pictures to be flattened.
    expect(shouldAddPath({ formats: ["text/rtf", "image/png"], sequence: 9 }, 8)).toBe(false);
    expect(shouldAddPath({ formats: ["text/uri-list", "image/png"], sequence: 9 }, 8)).toBe(false);
    expect(shouldAddPath({ formats: ["text/uri-list"], sequence: 9 }, 8)).toBe(false);
    expect(shouldAddPath({ formats: ["text/html"], sequence: 9 }, 8)).toBe(false);
  });

  it("leaves an Office chart or shape alone, even when it offers only a picture and HTML", () => {
    expect(shouldAddPath({ formats: ["text/html", "image/png"], sequence: 9, officeObject: true }, 8)).toBe(false);
  });

  it("ignores an empty clipboard", () => {
    expect(shouldAddPath({ formats: [], sequence: 9 }, 8)).toBe(false);
  });
});

describe("clipsToPrune", () => {
  const named = (count: number): string[] =>
    Array.from({ length: count }, (_, i) => `clip-2026083${i % 10}-1200${String(i).padStart(2, "0")}-000.png`);

  it("keeps everything while there is room", () => {
    expect(clipsToPrune(named(CLIP_KEEP))).toEqual([]);
  });

  it("throws away the oldest when there is not", () => {
    const all = named(CLIP_KEEP + 3).sort();
    expect(clipsToPrune(all)).toEqual(all.slice(0, 3));
  });

  it("touches nothing else in the folder", () => {
    expect(clipsToPrune(["notes.txt", "clip-keep.png.bak", ...named(2)], 0))
      .toEqual(named(2).sort());
  });
});

describe("isTerminalHost", () => {
  it("knows the terminals by executable, whatever the case", () => {
    expect(isTerminalHost("WindowsTerminal.exe")).toBe(true);
    expect(isTerminalHost("CONHOST.EXE")).toBe(true);
    expect(isTerminalHost("OpenConsole.exe")).toBe(true);
  });

  it("does not count an editor, a browser, Word, or nothing at all", () => {
    for (const exe of ["Code.exe", "msedge.exe", "WINWORD.EXE", "explorer.exe", "", null, undefined]) {
      expect(isTerminalHost(exe), String(exe)).toBe(false);
    }
  });

  it("lists file names only, no paths and no duplicates", () => {
    expect(TERMINAL_HOSTS.every((h) => /^[\w.-]+\.exe$/.test(h))).toBe(true);
    expect(new Set(TERMINAL_HOSTS.map((h) => h.toLowerCase())).size).toBe(TERMINAL_HOSTS.length);
  });
});
