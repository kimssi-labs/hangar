/**
 * Where the desktop's icons should be while a band is docked — the arithmetic, without Windows.
 *
 * Reserving an edge makes Explorer re-flow the desktop. Measured: a band on the left of a monitor
 * moved every icon on it by the band's width, not just the ones under it, and on a desktop with the
 * primary monitor in the middle the icons that ran off its far side ended up on the next monitor.
 * So the icons are put back: each one where it was, except those the band now covers, which move
 * just clear of it — by the band's thickness, and a cell further for every icon already there.
 *
 * Coordinates are physical screen pixels; an icon's point is the one Explorer reports for it.
 */
import type { DockEdge } from "./types.js";

export interface DeskIcon {
  /** The icon's item id as the helper prints it — the same icon gives the same id on every read. */
  id: string;
  x: number;
  y: number;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Which way an icon under a band on `edge` has to go to clear it. */
const AWAY: Record<DockEdge, { x: number; y: number }> = {
  left: { x: 1, y: 0 },
  right: { x: -1, y: 0 },
  top: { x: 0, y: 1 },
  bottom: { x: 0, y: -1 },
};

const inside = (box: Box, x: number, y: number): boolean =>
  x >= box.x && x < box.x + box.width && y >= box.y && y < box.y + box.height;

/**
 * Where each icon goes with `band` reserved on `edge` of `monitor`. Icons that cannot be cleared of
 * the band without leaving the monitor are left out — Explorer's own placement stands for those.
 *
 * `spacing` is the desktop's grid cell: two icons closer than half a cell on both axes collide.
 */
export function placeAround(icons: DeskIcon[], band: Box, edge: DockEdge, monitor: Box, spacing: { x: number; y: number }): DeskIcon[] {
  const away = AWAY[edge];
  const thickness = away.x ? band.width : band.height;
  const taken: DeskIcon[] = icons.filter((icon) => !inside(band, icon.x, icon.y));
  const covered = icons.filter((icon) => inside(band, icon.x, icon.y))
    // The ones nearest the open face first: they take the nearest free cells, the rest queue behind.
    .sort((a, b) => (b.x - a.x) * away.x + (b.y - a.y) * away.y);
  const collides = (x: number, y: number): boolean =>
    taken.some((other) => Math.abs(other.x - x) < spacing.x / 2 && Math.abs(other.y - y) < spacing.y / 2);
  const moved: DeskIcon[] = [];
  for (const icon of covered) {
    let x = icon.x + away.x * thickness;
    let y = icon.y + away.y * thickness;
    // ponytail: one direction only, along the row; scan the monitor for a free cell if rows fill up.
    while (collides(x, y) && inside(monitor, x, y)) {
      x += away.x * spacing.x;
      y += away.y * spacing.y;
    }
    if (!inside(monitor, x, y)) continue;
    const at = { id: icon.id, x, y };
    taken.push(at);
    moved.push(at);
  }
  const placed = new Map(moved.map((icon) => [icon.id, icon]));
  return icons.flatMap((icon) => {
    if (placed.has(icon.id)) return [placed.get(icon.id) as DeskIcon];
    return inside(band, icon.x, icon.y) ? [] : [icon];
  });
}

/**
 * The icons the user has moved since they were last placed: wherever they are now is theirs, and
 * they are left out of everything that follows. An icon that is gone from the desktop is dropped too.
 */
export function movedByUser(placed: DeskIcon[], now: DeskIcon[], slack = 2): Set<string> {
  const current = new Map(now.map((icon) => [icon.id, icon]));
  const moved = new Set<string>();
  for (const icon of placed) {
    const seen = current.get(icon.id);
    if (!seen || Math.abs(seen.x - icon.x) > slack || Math.abs(seen.y - icon.y) > slack) moved.add(icon.id);
  }
  return moved;
}
