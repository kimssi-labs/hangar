/**
 * When a copied screenshot should be given a path, where that path is wanted, and which saved
 * screenshots to throw away.
 *
 * A terminal cannot paste a bitmap, but it can paste a path. Not every window takes the format it
 * understands best when a clipboard holds both: Word, given a bitmap and a text, pastes the text
 * (measured). So rather than intercepting anyone's paste key, the screenshot is written to a file
 * the moment it is copied, and its path is put beside the picture only while a terminal is the
 * window in front — Ctrl+V there gives the path, Ctrl+V anywhere else still gives the picture.
 *
 * The rules live here, away from the clipboard itself, so they can be exercised without one.
 */

/** How many saved screenshots to keep. Copying a screenshot writes a file, so they accumulate. */
export const CLIP_KEEP = 50;

/**
 * Programs whose window IS a terminal, by executable: a paste into one of these wants the path.
 * Console windows belong to conhost/OpenConsole, whatever shell runs inside; editors with a
 * terminal pane (VS Code) are not here — their own paste handles a picture.
 */
export const TERMINAL_HOSTS = ["WindowsTerminal.exe", "OpenConsole.exe", "conhost.exe", "mintty.exe", "wezterm-gui.exe", "alacritty.exe"];

/** Whether `exe` (a file name, any case) is one of TERMINAL_HOSTS. */
export function isTerminalHost(exe: string | null | undefined): boolean {
  if (!exe) return false;
  const name = exe.toLowerCase();
  return TERMINAL_HOSTS.some((host) => host.toLowerCase() === name);
}

export interface ClipboardState {
  /** Formats the clipboard is offering, as Electron reports them. */
  formats: string[];
  /** Windows' clipboard sequence number, which changes on every write by anyone. */
  sequence: number;
}

/**
 * True when this clipboard holds a bare image that we have not already handled.
 *
 * An image that already comes with text is left alone: either someone else put both there, or we
 * did, and writing again would loop.
 */
export function shouldAddPath(state: ClipboardState, lastHandled: number): boolean {
  if (state.sequence === lastHandled) return false;
  const hasImage = state.formats.some((format) => format.startsWith("image/"));
  const hasText = state.formats.some((format) => format.startsWith("text/"));
  return hasImage && !hasText;
}

/**
 * The saved screenshots to delete, oldest first.
 *
 * File names carry their timestamp, so sorting by name is sorting by age.
 */
export function clipsToPrune(names: string[], keep = CLIP_KEEP): string[] {
  const clips = names.filter((name) => name.startsWith("clip-") && name.endsWith(".png")).sort();
  return clips.slice(0, Math.max(0, clips.length - keep));
}
