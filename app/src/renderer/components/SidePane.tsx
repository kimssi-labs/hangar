/**
 * The side pane: the project's files, the skills it can use, the account's Artifacts — one at a
 * time, under a row of tabs. It sits wherever the file panel used to (a column of its own, under the
 * detail panel, or under the sessions); the features draw the contents, this only switches them.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { SidePaneTab } from "@core/types";

import { api } from "../api";
import { useText } from "../useText";

const GLYPH: Record<SidePaneTab, string> = { files: "▤", skills: "⚡", artifacts: "◧" };

export function SidePane({ tabs, active, compact, onPick, children }: {
  /** The tabs switched on in Settings, in order. */
  tabs: SidePaneTab[];
  active: SidePaneTab;
  /** Too narrow for words: the tabs are their glyphs, named on hover. */
  compact: boolean;
  onPick(tab: SidePaneTab): void;
  children: ReactNode;
}) {
  const t = useText();
  return (
    <>
      <div role="tablist" className="flex items-stretch gap-0.5 px-1 border-b border-ink-600">
        {tabs.map((tab) => {
          const name = t(`pane.${tab}` as "pane.files");
          return (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={tab === active}
              aria-label={name}
              title={name}
              data-testid={`pane-tab-${tab}`}
              onClick={() => onPick(tab)}
              className={`px-2 py-1 text-[11px] border-b-2 -mb-px ${tab === active
                ? "border-accent text-bone-100"
                : "border-transparent text-bone-400 hover:text-bone-100"}`}
            >
              {compact ? GLYPH[tab] : name}
            </button>
          );
        })}
      </div>
      {children}
    </>
  );
}

/** Which of the side pane's groups are open, and the ways to change that. */
export interface PaneOpen {
  isOpen(key: string): boolean;
  toggle(key: string): void;
  /** Open or close all of `keys` at once — the expand-all button. */
  setAll(keys: string[], open: boolean): void;
}

/**
 * The side pane's open groups, remembered across runs (`ui.paneOpen`). Everything starts closed; a
 * group stays open once opened, until it is closed again — in either tab, in any project.
 */
export function usePaneOpen(saved: string[] | undefined): PaneOpen {
  const [open, setOpen] = useState<Set<string> | null>(null);
  // The settings arrive after the first render; take them once, and from then on this is the truth.
  useEffect(() => { if (open === null && saved) setOpen(new Set(saved)); }, [open, saved]);
  const current = useRef<Set<string>>(new Set());
  current.current = open ?? new Set(saved ?? []);
  const commit = useCallback((next: Set<string>) => {
    setOpen(next);
    void api.saveUi({ paneOpen: [...next] });
  }, []);
  return useMemo(() => ({
    isOpen: (key: string) => current.current.has(key),
    toggle: (key: string) => {
      const next = new Set(current.current);
      if (next.has(key)) next.delete(key); else next.add(key);
      commit(next);
    },
    setAll: (keys: string[], wanted: boolean) => {
      const next = new Set(current.current);
      for (const key of keys) if (wanted) next.add(key); else next.delete(key);
      commit(next);
    },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [open, saved, commit]);
}

/** One button for both: opens every group while any is closed, and closes them all once all are open. */
export function ExpandAll({ keys, open }: { keys: string[]; open: PaneOpen }) {
  const t = useText();
  if (keys.length === 0) return null;
  const allOpen = keys.every((key) => open.isOpen(key));
  const label = t(allOpen ? "pane.collapseAll" : "pane.expandAll");
  return (
    <button type="button" data-testid="pane-expand-all" title={label} aria-label={label}
      onClick={() => open.setAll(keys, !allOpen)}
      className="shrink-0 text-[12px] px-1 rounded text-bone-400 hover:text-bone-100 hover:bg-ink-700/60">
      {allOpen ? "⊟" : "⊞"}
    </button>
  );
}
