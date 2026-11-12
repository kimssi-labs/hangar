/**
 * How large the window draws everything: a zoom factor, as a browser's Ctrl + / Ctrl -.
 *
 * The whole page scales rather than the text alone, because most sizes in it are pixels: text that
 * grew inside boxes that did not would overflow them. A fixed set of steps, so Ctrl + and Ctrl -
 * always land on the same values the settings list.
 */
export const ZOOM_LEVELS = [0.8, 0.9, 1, 1.1, 1.25, 1.5] as const;
export const DEFAULT_ZOOM = 1;

/** A saved value, or the default when it is not one of the steps. */
export function zoomFrom(raw: unknown): number {
  const value = Number(raw);
  return (ZOOM_LEVELS as readonly number[]).includes(value) ? value : DEFAULT_ZOOM;
}

/** One step larger (+1) or smaller (-1), held at the ends; 0 goes back to the default. */
export function stepZoom(current: number, direction: -1 | 0 | 1): number {
  if (direction === 0) return DEFAULT_ZOOM;
  const levels = ZOOM_LEVELS as readonly number[];
  const at = levels.indexOf(zoomFrom(current));
  return levels[Math.max(0, Math.min(levels.length - 1, at + direction))] as number;
}

/** The step a key asks for: Ctrl with +/=, - or 0 (the top row or the number pad), else null. */
export function zoomKey(input: { control: boolean; meta: boolean; alt: boolean; key: string }): -1 | 0 | 1 | null {
  if (!(input.control || input.meta) || input.alt) return null;
  if (input.key === "+" || input.key === "=") return 1;
  if (input.key === "-" || input.key === "_") return -1;
  if (input.key === "0") return 0;
  return null;
}
