/**
 * What a key means inside a list.
 *
 * Every list in the window answers the same keys: the arrows, Page Up/Down and Home/End move, Enter
 * opens, Escape goes back. None of them is a shortcut — a key means something only to the list that
 * has the focus, so a letter typed into any field is a letter. Keeping the table pure keeps it
 * testable without a browser.
 */
export type Movement = "moveUp" | "moveDown" | "pageUp" | "pageDown" | "moveFirst" | "moveLast";

export type ListAction = Movement | "open" | "back" | "rename" | "delete";

export interface KeyEventLike {
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}

/** How many rows Page Up and Page Down move. */
export const PAGE_ROWS = 10;

export const NAVIGATION: Record<string, Movement> = {
  ArrowUp: "moveUp",
  ArrowDown: "moveDown",
  PageUp: "pageUp",
  PageDown: "pageDown",
  Home: "moveFirst",
  End: "moveLast",
};

const ACTIONS: Record<string, ListAction> = { Enter: "open", Escape: "back", F2: "rename", Delete: "delete" };

/**
 * The action a key means to a project or session list, or null.
 *
 * A modifier leaves the key to the system — Shift+F10 among them: the browser turns it, and the menu
 * key, into the list's `contextmenu` event, which is where the row's menu opens.
 */
export function listAction(event: KeyEventLike): ListAction | null {
  if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return null;
  return NAVIGATION[event.key] ?? ACTIONS[event.key] ?? null;
}

/** Next index for a movement, clamped to the list — `pageSize` is what a page means here. */
export function nextIndex(action: Movement, current: number, count: number, pageSize: number): number {
  if (!count) return 0;
  const last = count - 1;
  switch (action) {
    case "moveUp": return Math.max(0, current - 1);
    case "moveDown": return Math.min(last, current + 1);
    case "pageUp": return Math.max(0, current - pageSize);
    case "pageDown": return Math.min(last, current + pageSize);
    case "moveFirst": return 0;
    case "moveLast": return last;
  }
}
