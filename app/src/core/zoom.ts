/**
 * How large the window draws everything: a zoom factor, as a browser's Ctrl + / Ctrl -.
 *
 * The whole page scales rather than the text alone, because most sizes in it are pixels: text that
 * grew inside boxes that did not would overflow them. Any whole percentage in range can be typed;
 * the − / + buttons and Ctrl + / Ctrl - move between the browser's familiar steps.
 */
export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 2;
export const DEFAULT_ZOOM = 1;
/** Where − and + land: the next of these below or above the current size. */
export const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2] as const;

/** A whole percentage within range, as a factor; null when it is not one. */
function inRange(factor: number): number | null {
  if (!Number.isFinite(factor)) return null;
  const rounded = Math.round(factor * 100) / 100;
  return rounded >= ZOOM_MIN && rounded <= ZOOM_MAX ? rounded : null;
}

/** A saved value, or the default when it is not a zoom this window can draw at. */
export function zoomFrom(raw: unknown): number {
  return inRange(Number(raw)) ?? DEFAULT_ZOOM;
}

/** What a person typed — `115`, `115%`, ` 115 % ` — as a factor, or null when it is not in range. */
export function parseZoom(text: string): number | null {
  const match = /^\s*(\d+(?:\.\d+)?)\s*%?\s*$/.exec(text);
  return match ? inRange(Number(match[1]) / 100) : null;
}

/** `1.1` as `110%`. */
export function zoomLabel(factor: number): string {
  return `${Math.round(factor * 100)}%`;
}

/** The next step above (+1) or below (-1) the current size, held at the ends; 0 goes back to 100 %. */
export function stepZoom(current: number, direction: -1 | 0 | 1): number {
  if (direction === 0) return DEFAULT_ZOOM;
  const now = zoomFrom(current);
  const steps = ZOOM_STEPS as readonly number[];
  const next = direction > 0 ? steps.find((step) => step > now) : [...steps].reverse().find((step) => step < now);
  return next ?? now;
}

/** The step a key asks for: Ctrl with +/=, - or 0 (the top row or the number pad), else null. */
export function zoomKey(input: { control: boolean; meta: boolean; alt: boolean; key: string }): -1 | 0 | 1 | null {
  if (!(input.control || input.meta) || input.alt) return null;
  if (input.key === "+" || input.key === "=") return 1;
  if (input.key === "-" || input.key === "_") return -1;
  if (input.key === "0") return 0;
  return null;
}
