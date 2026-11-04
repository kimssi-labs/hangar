/**
 * Watching the clipboard so a copied screenshot arrives with its path attached — in a terminal.
 *
 * A terminal cannot paste a bitmap, but it can paste a path. Word can paste a bitmap, and given a
 * bitmap with a text beside it Word pastes the TEXT (measured), as do its relatives. So the path is
 * not simply added next to the picture: it is there only while a terminal is the window in front,
 * and the clipboard goes back to the bare picture the moment another kind of window is. Nothing
 * intercepts anyone's keys; the only thing that changes is the text part of the clipboard, and
 * only for whoever is looking at a terminal.
 */
import { clipboard, type NativeImage } from "electron";
import { readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { clipsToPrune, HTML_FORMAT, IMAGE_READ_TRIES, isTerminalHost, shouldAddPath } from "../core/clipboardRules.js";
import { foregroundExecutable } from "./foreground.js";

/** Cheap enough to run often; a person notices a screenshot taking a second to be ready. */
const POLL_MS = 600;
/** For the tests, which cannot choose the window in front: `terminal` counts it as one, `other` as none. */
export const FOCUS_OVERRIDE_ENV = "HANGAR_CLIP_FOCUS";

type SequenceNumber = () => number;

/** The screenshot last copied: kept so the clipboard can be given the picture back, or the path. */
interface Clip {
  image: NativeImage;
  /** The HTML `<img>` a web view copied with the picture, carried through so nothing is lost. */
  html: string | null;
  file: string;
  /** The clipboard holds the path beside the picture right now. */
  pathShown: boolean;
}

/** The format an OLE object (an Office chart or shape) puts on the clipboard. */
const OBJECT_DESCRIPTOR = "Object Descriptor";

let timer: NodeJS.Timeout | null = null;
let lastHandled = 0;
let sequenceNumber: SequenceNumber | null | undefined;
let clip: Clip | null = null;
/** The copy whose image read back empty, and how many times; see IMAGE_READ_TRIES. */
let emptyRead = { sequence: 0, count: 0 };

/**
 * Windows' clipboard sequence number: one call, no clipboard opened, changes on every write.
 *
 * Reading the formats every poll would be far more expensive, and reading the image itself would
 * be absurd — this is the cheap way to know nothing has happened.
 */
function loadSequenceNumber(): SequenceNumber | null {
  if (sequenceNumber !== undefined) return sequenceNumber;
  if (process.platform !== "win32") return (sequenceNumber = null);
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const koffi = require("koffi") as typeof import("koffi");
    const user32 = koffi.load("user32.dll");
    return (sequenceNumber = user32.func("__stdcall", "GetClipboardSequenceNumber", "uint32", []));
  } catch (error) {
    console.error("[hangar] clipboard watch unavailable:", (error as Error).message);
    return (sequenceNumber = null);
  }
}

export interface ClipboardWatchOptions {
  /** Writes the image to a file and returns its path; the existing save, shared with the shortcut. */
  save: (image: NativeImage) => string | null;
  /** Where the saved screenshots live, so the old ones can be cleared out. */
  clipsDir: string;
  /** Whether the window in front is a terminal. Injected by tests; the default asks Windows. */
  terminalInFront?: () => boolean;
}

/** Whether a paste right now would land in a terminal. */
export function terminalInFront(): boolean {
  const override = process.env[FOCUS_OVERRIDE_ENV];
  if (override === "terminal") return true;
  if (override === "other") return false;
  return isTerminalHost(foregroundExecutable());
}

/** Start watching, or stop and start again with different options. */
export function startClipboardWatch(options: ClipboardWatchOptions): void {
  stopClipboardWatch();
  const sequence = loadSequenceNumber();
  if (!sequence) return;                       // no cheap way to watch: leave the clipboard alone
  lastHandled = sequence();                    // whatever is on there now was not copied for us
  timer = setInterval(() => tick(sequence, options), POLL_MS);
  timer.unref?.();
}

export function stopClipboardWatch(): void {
  if (timer) clearInterval(timer);
  timer = null;
  clip = null;
}

/** Whether an OLE object came with the copy; asked only when an image is there to be taken. */
function hasOfficeObject(): boolean {
  try {
    return clipboard.has(OBJECT_DESCRIPTOR);
  } catch {
    return false;
  }
}

function tick(sequence: SequenceNumber, options: ClipboardWatchOptions): void {
  const now = sequence();
  if (now !== lastHandled) {
    // Someone has written to the clipboard since we last looked: whatever we were minding is gone.
    clip = null;
    const formats = clipboard.availableFormats();
    const officeObject = formats.some((format) => format.startsWith("image/")) && hasOfficeObject();
    if (!shouldAddPath({ formats, sequence: now, officeObject }, lastHandled)) {
      lastHandled = now;                       // not ours, but we have seen it
      return;
    }
    const image = clipboard.readImage();
    if (image.isEmpty()) {
      // Held open by someone else for the moment (clipboard history, sync): look again next tick.
      // ponytail: one counter for the one copy in flight; a newer copy simply starts it again.
      if (emptyRead.sequence !== now) emptyRead = { sequence: now, count: 0 };
      if (++emptyRead.count < IMAGE_READ_TRIES) return;
    }
    lastHandled = now;
    if (image.isEmpty()) return;
    const file = options.save(image);
    if (!file) return;
    const html = formats.includes(HTML_FORMAT) ? clipboard.readHTML() || null : null;
    clip = { image, html, file, pathShown: false };
    prune(options.clipsDir);
  }
  if (!clip) return;
  // The path rides along only while a terminal is in front; anywhere else the picture is on its own.
  const inFront = (options.terminalInFront ?? terminalInFront)();
  if (inFront && !clip.pathShown) {
    clipboard.write({ text: clip.file, image: clip.image, ...(clip.html ? { html: clip.html } : {}) });
    clip.pathShown = true;
    lastHandled = sequence();                  // our own write, so we do not react to it
  } else if (!inFront && clip.pathShown) {
    clipboard.write({ image: clip.image, ...(clip.html ? { html: clip.html } : {}) });
    clip.pathShown = false;
    lastHandled = sequence();
  }
}

function prune(clipsDir: string): void {
  try {
    for (const name of clipsToPrune(readdirSync(clipsDir))) unlinkSync(join(clipsDir, name));
  } catch {
    /* the folder may not exist yet, and a screenshot is not worth failing over */
  }
}
