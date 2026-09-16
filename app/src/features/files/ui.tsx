/**
 * The project's folder — the page side.
 *
 * Two shapes of the same data, chosen by how much width the panel actually has (the screen decides,
 * not this file): a tree where there is room for one, and a list of what changed where there is
 * not. A narrow column of deeply indented names is a worse answer than a short list of the files
 * the agent touched, which is the question a session manager is usually asked anyway.
 *
 * Read-only on purpose. Nothing here creates, renames, deletes or opens an editor: benchmarked
 * against orca's explorer, those are the parts that belong to an editor rather than to a launcher.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { nameOf, type DirEntry, type DirListing, type FileStatus } from "@core/fileTree";

import { api } from "../../renderer/api";
import { Choice } from "../../renderer/components/SettingsCard";
import { Truncated } from "../../renderer/components/Truncated";
import { useText } from "../../renderer/useText";
import { api as bridge, MENU_SEPARATOR, type ActionResult, type MenuItemSpec } from "../../renderer/api";
import type { Ask, AskResult } from "../../renderer/components/Modal";
import type { Translate } from "@core/i18n";
import type { ChangedFiles } from "./contract";

/** How deep one level indents a row. Enough to read the shape, little enough to keep the name. */
const INDENT = 14;

/**
 * The drag payload's type, which is also the check that a drop came from this panel.
 *
 * A type of our own rather than "text/plain": a path dragged out of a text editor is not a file of
 * this project, and a drop that moved something because the string looked like a path would be a
 * surprise nobody asked for.
 */
const DRAG_TYPE = "application/x-hangar-file";

/** The mark and colour git's verdict gets, so a change is visible without reading the name. */
const MARKS: Record<FileStatus, { mark: string; tone: string }> = {
  conflicted: { mark: "!", tone: "text-bad" },
  staged: { mark: "●", tone: "text-accent" },
  modified: { mark: "✎", tone: "text-warn" },
  untracked: { mark: "+", tone: "text-ok" },
};

/** The two things the panel can show: the whole folder, or only what git says changed. */
export type FilesView = "tree" | "changed";

export interface Files {
  /** The root listing and every expanded directory, keyed by path from the project's root. */
  listings: Map<string, DirListing>;
  expanded: Set<string>;
  changed: ChangedFiles;
  loading: Set<string>;
  toggle(dir: string): void;
  /** Read the root, every open directory and the changed list again. */
  refresh(): void;
  /** What the panel was asked to show, or null while it is following the room it has. */
  view: FilesView | null;
  choose(view: FilesView | null): void;
  /** Hand one file to whatever the machine opens it with. */
  open(path: string): Promise<ActionResult>;
  /** Show it in the machine's own file manager. */
  reveal(path: string): Promise<ActionResult>;
  /** Give it a new name where it is. */
  rename(path: string, name: string): Promise<ActionResult>;
  /** Move it into another folder of this project. */
  move(path: string, toDir: string): Promise<ActionResult>;
  /** Put it in the recycle bin. */
  trash(path: string): Promise<ActionResult>;
}

/**
 * The folder of one project, as far as it has been opened.
 *
 * Nothing is read until there is a project and the setting is on, and a directory is read when it
 * is expanded — never a walk of the tree. What is already open is read again on `refresh`, which
 * the screen calls on its own fifteen-second tick, so a file the agent just wrote appears without
 * anyone pressing anything.
 */
export function useFiles(cwd: string | null, enabled: boolean): Files {
  const [listings, setListings] = useState<Map<string, DirListing>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [changed, setChanged] = useState<ChangedFiles>({ items: [], hidden: 0 });
  const [loading, setLoading] = useState<Set<string>>(new Set());
  // Asked for by hand; null means "whatever the width suggests". Kept across a change of project:
  // it is a preference about the panel, not something about one folder.
  const [view, choose] = useState<FilesView | null>(null);
  // What is open right now, for the refresh that runs on a timer: it must not re-run whenever the
  // set changes, or every expand would restart the timer.
  const openDirs = useRef<Set<string>>(new Set());
  openDirs.current = expanded;

  const read = useCallback(async (dir: string): Promise<void> => {
    if (!cwd) return;
    setLoading((was) => new Set(was).add(dir));
    try {
      const listing = await api.listDir({ cwd, dir });
      setListings((was) => new Map(was).set(dir, listing));
    } finally {
      setLoading((was) => {
        const next = new Set(was);
        next.delete(dir);
        return next;
      });
    }
  }, [cwd]);

  const refresh = useCallback(() => {
    if (!cwd || !enabled) return;
    // The changed list first, and only then the directories: it is the call that warms git's cache,
    // so the rows come back already coloured rather than plain and coloured a tick later.
    void (async () => {
      setChanged(await api.changedFiles(cwd));
      await read("");
      for (const dir of openDirs.current) await read(dir);
    })();
  }, [cwd, enabled, read]);

  // A different project is a different folder: nothing of the last one may show while this one loads.
  useEffect(() => {
    setListings(new Map());
    setExpanded(new Set());
    setChanged({ items: [], hidden: 0 });
    openDirs.current = new Set();
    refresh();
  }, [cwd, enabled, refresh]);

  const toggle = useCallback((dir: string) => {
    setExpanded((was) => {
      const next = new Set(was);
      if (next.has(dir)) next.delete(dir);
      else {
        next.add(dir);
        void read(dir);
      }
      return next;
    });
  }, [read]);

  const open = useCallback(
    async (path: string): Promise<ActionResult> => (cwd
      ? api.openFile({ cwd, dir: path })
      : { ok: false }),
    [cwd],
  );

  const reveal = useCallback(
    async (path: string): Promise<ActionResult> => (cwd ? api.revealFile({ cwd, dir: path }) : { ok: false }),
    [cwd],
  );
  const rename = useCallback(
    async (path: string, name: string): Promise<ActionResult> => (cwd ? api.renameFile({ cwd, path, name }) : { ok: false }),
    [cwd],
  );
  const move = useCallback(
    async (path: string, toDir: string): Promise<ActionResult> => (cwd ? api.moveFile({ cwd, path, toDir }) : { ok: false }),
    [cwd],
  );
  const trash = useCallback(
    async (path: string): Promise<ActionResult> => (cwd ? api.trashFile({ cwd, dir: path }) : { ok: false }),
    [cwd],
  );

  return { listings, expanded, changed, loading, toggle, refresh, view, choose, open, reveal, rename, move, trash };
}

/**
 * Double-click opens a file the way Explorer would.
 *
 * On a folder it is the single click that does the work (open and close), so a double-click there
 * would only toggle twice; opening is for files. A failure — a type with nothing registered to it,
 * a file that has since gone — is reported, because silence looks like a broken double-click.
 */
function useOpen(files: Files, report?: (result: ActionResult) => void): (path: string) => void {
  return (path: string) => void files.open(path).then((result) => {
    if (!result.ok) report?.(result);
  });
}

/** What an operation on a row needs from the app around it — the same three the other rows use. */
export interface FilesUi {
  askUser(ask: Ask): Promise<AskResult>;
  notify(result: ActionResult): void;
  t: Translate;
}

export const FILE_ACTIONS = ["open", "reveal", "rename", "copyPath", "delete"] as const;
export type FileAction = (typeof FILE_ACTIONS)[number];

export function isFileAction(id: string | null): id is FileAction {
  return (FILE_ACTIONS as readonly string[]).includes(id ?? "");
}

/** The right-click menu of a file or folder row. */
export function fileMenuItems(entry: { directory: boolean }, t: Translate): MenuItemSpec[] {
  return [
    { id: "open", label: t("menu.file.open"), enabled: !entry.directory },
    { id: "reveal", label: t("menu.showFolder") },
    { id: MENU_SEPARATOR, label: "" },
    { id: "rename", label: t("menu.rename") },
    { id: "copyPath", label: t("menu.file.copyPath") },
    { id: MENU_SEPARATOR, label: "" },
    { id: "delete", label: t("menu.file.delete") },
  ];
}

/**
 * One row's menu, from the click to the change on disk.
 *
 * Renaming asks for the name in the same dialog the rest of the app asks in, and deleting asks
 * first — it is the one operation people do by accident, even into a recycle bin. Every answer is
 * reported; a refusal explains itself (a name that is not a name, something already there) rather
 * than leaving a row that did not change.
 */
async function runFileMenu(entry: DirEntry, files: Files, ui: FilesUi): Promise<void> {
  const { askUser, notify, t } = ui;
  const choice = await bridge.contextMenu(fileMenuItems(entry, t));
  if (!isFileAction(choice)) return;
  switch (choice) {
    case "open": {
      const result = await files.open(entry.path);
      if (!result.ok) notify(result);
      break;
    }
    case "reveal":
      notifyIfFailed(notify, await files.reveal(entry.path));
      break;
    case "copyPath":
      await navigator.clipboard.writeText(entry.path);
      notify({ ok: true, message: t("files.copied", { name: entry.path }) });
      break;
    case "rename": {
      const name = await askUser({
        title: t("dialog.renameFile", { name: entry.name }),
        input: { initial: entry.name },
        confirm: t("dialog.rename"),
      });
      if (typeof name !== "string" || !name.trim()) return;
      const result = await files.rename(entry.path, name);
      notifyIfFailed(notify, result);
      if (result.ok) files.refresh();
      break;
    }
    case "delete": {
      const yes = await askUser({
        title: t(entry.directory ? "dialog.deleteFolder" : "dialog.deleteFile", { name: entry.name }),
        detail: t("dialog.deleteFile.detail"),
        confirm: t("dialog.delete"),
        danger: true,
      });
      if (!yes) return;
      const result = await files.trash(entry.path);
      notifyIfFailed(notify, result);
      if (result.ok) files.refresh();
      break;
    }
  }
}

/** Say nothing when it worked: a row that changed says it better than a message would. */
function notifyIfFailed(notify: (result: ActionResult) => void, result: ActionResult): void {
  if (!result.ok) notify(result);
}

function Mark({ status }: { status: FileStatus | null }) {
  if (!status) return null;
  const { mark, tone } = MARKS[status];
  return <span className={`shrink-0 text-[10px] tabular-nums ${tone}`}>{mark}</span>;
}

/** What every row in the tree needs beyond its own entry. */
interface RowTools {
  files: Files;
  onOpen(path: string): void;
  onMenu(entry: DirEntry): void;
  /** A drop landed on this folder; null means the project's root. */
  onDrop(path: string, toDir: string): void;
}

/** One directory's rows, and under each open one its own. */
function Rows({ files, dir, depth, tools }: { files: Files; dir: string; depth: number; tools: RowTools }) {
  const t = useText();
  const [over, setOver] = useState<string | null>(null);
  const listing = files.listings.get(dir);
  if (!listing) return null;
  return (
    <>
      {listing.entries.map((entry) => {
        const isOpen = entry.directory && files.expanded.has(entry.path);
        return (
          <div key={entry.path}>
            <button
              type="button"
              className={`w-full flex items-center gap-1 rounded px-1 py-0.5 text-left text-xs hover:bg-ink-700/60 ${
                over === entry.path ? "bg-accent/20 ring-1 ring-accent/60" : ""}`}
              style={{ paddingLeft: depth * INDENT + 4 }}
              title={entry.path}
              onClick={() => entry.directory && files.toggle(entry.path)}
              onDoubleClick={() => { if (!entry.directory) tools.onOpen(entry.path); }}
              onContextMenu={() => tools.onMenu(entry)}
              draggable
              onDragStart={(event) => {
                event.dataTransfer.setData(DRAG_TYPE, entry.path);
                event.dataTransfer.effectAllowed = "move";
              }}
              // Only a folder takes a drop, and only of something from this same panel.
              onDragOver={(event) => {
                if (!entry.directory || !event.dataTransfer.types.includes(DRAG_TYPE)) return;
                event.preventDefault();
                // The tree's own background is a drop target too (it means the project's root), and
                // a drop handled here would otherwise bubble into it and be moved a second time —
                // to the root, which for a file already in the root reads as "cannot go there".
                event.stopPropagation();
                event.dataTransfer.dropEffect = "move";
                setOver(entry.path);
              }}
              onDragLeave={() => setOver((was) => (was === entry.path ? null : was))}
              onDrop={(event) => {
                setOver(null);
                if (!entry.directory) return;
                const path = event.dataTransfer.getData(DRAG_TYPE);
                if (!path) return;
                event.preventDefault();
                event.stopPropagation();
                tools.onDrop(path, entry.path);
              }}
            >
              <span className={`w-3 shrink-0 text-[10px] ${entry.directory ? "text-bone-400" : "text-transparent"}`}>
                {entry.directory ? (isOpen ? "▾" : "▸") : "·"}
              </span>
              {/* The mark sits with the name, not at the far edge: in a 320 px column a mark
                  pushed right is a mark nobody reads next to the name it belongs to. */}
              <Truncated as="span" className={entry.directory ? "text-bone-200" : "text-bone-300"}>
                {entry.name}
              </Truncated>
              <Mark status={entry.status} />
            </button>
            {isOpen ? <Rows files={files} dir={entry.path} depth={depth + 1} tools={tools} /> : null}
          </div>
        );
      })}
      {listing.hidden ? (
        <div className="px-1 py-0.5 text-[11px] text-bone-500" style={{ paddingLeft: depth * INDENT + 20 }}>
          {t("files.more", { count: listing.hidden })}
        </div>
      ) : null}
    </>
  );
}

/** The whole folder, as a tree — for a panel with the width to draw one. */
export function FileTree({ files, tools }: { files: Files; tools: RowTools }) {
  const t = useText();
  const root = files.listings.get("");
  if (!root) return <div className="p-2 text-[11px] text-bone-500">{t("files.reading")}</div>;
  if (root.error) return <div className="p-2 text-[11px] text-bone-500">{t("files.unreadable")}</div>;
  if (!root.entries.length) return <div className="p-2 text-[11px] text-bone-500">{t("files.empty")}</div>;
  // The space below the rows is the project's root: dragging a file there moves it out of
  // whatever folder it was in, which is the only way back up without a folder row to aim at.
  return (
    <div
      className="p-1 min-h-full"
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes(DRAG_TYPE)) event.preventDefault();
      }}
      onDrop={(event) => {
        const path = event.dataTransfer.getData(DRAG_TYPE);
        if (path) tools.onDrop(path, "");
      }}
    >
      <Rows files={files} dir="" depth={0} tools={tools} />
    </div>
  );
}

/**
 * Only what changed, as a flat list — for a panel too narrow for a tree.
 *
 * The path is shown whole rather than indented: at this width an indented name is mostly indent,
 * and "core/status.ts" says where the file is in the same space the tree would spend on arrows.
 */
export function ChangedList({ files, tools }: { files: Files; tools: RowTools }) {
  const t = useText();
  if (!files.changed.items.length) {
    return <div className="px-2 py-1 text-[11px] text-bone-500">{t("files.noChanges")}</div>;
  }
  return (
    <div className="p-1">
      {files.changed.items.map((item) => (
        <button
          key={item.path}
          type="button"
          className="w-full flex items-center gap-1 rounded px-1 py-0.5 text-left text-xs hover:bg-ink-700/60"
          title={item.path}
          onDoubleClick={() => tools.onOpen(item.path)}
          onContextMenu={() => tools.onMenu({ name: nameOf(item.path), path: item.path, directory: false, status: item.status })}
        >
          <Mark status={item.status} />
          <Truncated as="span" className="text-bone-300">{item.path}</Truncated>
        </button>
      ))}
      {files.changed.hidden ? (
        <div className="px-1 py-0.5 text-[11px] text-bone-500">{t("files.more", { count: files.changed.hidden })}</div>
      ) : null}
    </div>
  );
}

/**
 * The panel: a heading that says what is being shown, and the thing itself.
 *
 * `roomy` is the width's opinion — a tree where there is room for one, the changed files where
 * there is not. It is only the default: the button beside the heading switches to the other, which
 * is how a narrow panel gets to the files that did not change and a wide one gets a short list of
 * the ones that did.
 */
export function FilesPane({ files, roomy, ui }: {
  files: Files;
  roomy: boolean;
  /** How a row asks a question, says how it went, and reads the words it shows. */
  ui: FilesUi;
}) {
  const t = useText();
  const onOpen = useOpen(files, ui.notify);
  const tools: RowTools = {
    files,
    onOpen,
    onMenu: (entry) => void runFileMenu(entry, files, ui),
    onDrop: (path, toDir) => void files.move(path, toDir).then((result) => {
      if (!result.ok) ui.notify(result);
      else files.refresh();
    }),
  };
  const view: FilesView = files.view ?? (roomy ? "tree" : "changed");
  const other: FilesView = view === "tree" ? "changed" : "tree";
  return (
    <>
      <div className="flex items-baseline gap-2 px-2 py-1 border-b border-ink-600">
        <span className="text-[11px] text-bone-400">{t("files.title")}</span>
        {files.changed.items.length ? (
          <span className="text-[11px] text-warn">{t("files.changedCount", { count: files.changed.items.length })}</span>
        ) : null}
        <div className="flex-1" />
        <button
          type="button"
          className="text-[11px] text-bone-400 hover:text-bone-100 px-1 rounded hover:bg-ink-700/60"
          title={t(other === "tree" ? "files.showAll.title" : "files.showChanged.title")}
          onClick={() => files.choose(other)}
        >
          {t(other === "tree" ? "files.showAll" : "files.showChanged")}
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        {view === "tree" ? <FileTree files={files} tools={tools} /> : <ChangedList files={files} tools={tools} />}
      </div>
    </>
  );
}

/**
 * The settings card's body: whether the folder is shown at all.
 *
 * Off is not only a matter of taste. A project on a network share can take seconds to answer one
 * `readdir`, and the app asks for one per folder opened; somebody working that way should be able
 * to stop it asking rather than wait for it.
 */
export function FilesSettings({ on, onChange }: { on: boolean; onChange(on: boolean): void }) {
  const t = useText();
  return (
    <>
      <Choice
        label={t("settings.files.on")}
        note={t("settings.files.on.note")}
        selected={on}
        onSelect={() => { if (!on) onChange(true); }}
      />
      <Choice
        label={t("settings.files.off")}
        note={t("settings.files.off.note")}
        selected={!on}
        onSelect={() => { if (on) onChange(false); }}
      />
    </>
  );
}
