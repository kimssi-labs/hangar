/**
 * Where an undocked window opens: the rectangle it was left at, fitted to a screen that is here now.
 *
 * Reopening exactly where it was is the courtesy; reopening past the edge of the screen is the bug
 * (reported: the window opened taller than the monitor, its buttons out of reach). The remembered
 * rectangle comes from whatever arrangement of monitors was attached when it was saved — a 1440-row
 * desktop monitor, say — and the screen it lands on next time may be a 912-row laptop panel. So it
 * is fitted into the work area of the screen it overlaps most, and a rectangle on no screen at all
 * gives way to the default size, centred on the primary one.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** How many pixels two rectangles share. */
export function overlapArea(a: Rect, b: Rect): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width > 0 && height > 0 ? width * height : 0;
}

/** `rect` moved and, if need be, shrunk until the whole of it is inside `area`. */
export function clampInto(rect: Rect, area: Rect): Rect {
  const width = Math.min(rect.width, area.width);
  const height = Math.min(rect.height, area.height);
  return {
    width, height,
    x: Math.min(Math.max(rect.x, area.x), area.x + area.width - width),
    y: Math.min(Math.max(rect.y, area.y), area.y + area.height - height),
  };
}

/**
 * The window's rectangle for this start: `saved` fitted into the work area it overlaps most, or
 * `size` centred in `primary` when it overlaps none (or there is nothing saved).
 */
export function openingRect(saved: Rect | null, workAreas: Rect[], primary: Rect, size: { width: number; height: number }): Rect {
  if (saved) {
    let best: Rect | null = null;
    let most = 0;
    for (const area of workAreas) {
      const shared = overlapArea(area, saved);
      if (shared > most) { most = shared; best = area; }
    }
    if (best) return clampInto(saved, best);
  }
  return clampInto({
    width: size.width,
    height: size.height,
    x: primary.x + Math.round((primary.width - size.width) / 2),
    y: primary.y + Math.round((primary.height - size.height) / 2),
  }, primary);
}
