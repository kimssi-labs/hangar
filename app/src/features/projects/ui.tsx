/**
 * Projects and sessions — the page side.
 *
 * The list the window is built around, and everything done to a row from the page: the order the
 * rows are drawn (and walked) in, the right-click menus, the dialogs behind delete, the rename box,
 * the pane the projects sit in and the list a project's sessions sit in. `App` keeps the selection —
 * the keyboard drives it — and hands over what an action needs: a dialog, a toast, a rescan, and
 * the two things only the shell can do, changing screen and opening the rename box.
 */
import { useCallback, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";

import { MENU_SEPARATOR, PERMISSION_MODES, SHELL_CHOICES } from "@core/constants";
import { PERMISSION_ARGS } from "@core/launcher";
import type { LaunchConfig, ProjectInfo, SessionInfo, ShellChoice } from "@core/types";
import { placeWorktrees, type Placed } from "@core/worktree";

import { api, type MenuItemSpec } from "../../renderer/api";
import { ProjectRow, SessionRow } from "../../renderer/components/Lists";
import { Choice } from "../../renderer/components/SettingsCard";
import { Truncated } from "../../renderer/components/Truncated";
import type { Ask, AskResult } from "../../renderer/components/Modal";
import { useText } from "../../renderer/useText";
import type { OpenSessionRequest } from "./contract";

type Translate = ReturnType<typeof useText>;

/** The rows, read and re-read: the list every other part of the window reads. */
export function useProjects() {
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  // The list as main last sent it. An unchanged answer hands this same array back, so React keeps
  // the state as it is and nothing drawn from it recomputes — unless a merged dirty count had made
  // the state a different array, which the rows then lose exactly as a fresh list would take it.
  const received = useRef<{ signature: string; projects: ProjectInfo[] } | null>(null);
  const scan = useCallback(async (): Promise<ProjectInfo[]> => {
    const answer = await api.scan(received.current?.signature ?? null);
    const scanned = answer.projects ?? received.current?.projects ?? [];
    received.current = { signature: answer.signature, projects: scanned };
    setProjects(scanned);
    return scanned;
  }, []);
  const liveSessions = useMemo(() => projects.flatMap((p) => p.sessions.filter((s) => s.live)), [projects]);
  return { projects, setProjects, scan, liveSessions };
}

import { filterSessions } from "@core/search";

export { filterProjects, filterSessions, foldHeadless } from "@core/search";

/**
 * Where `dir` sits in a freshly scanned list — through the same placement it is drawn with. The
 * raw scan order is not what is on screen once a worktree has been tucked under its repository,
 * and selecting by the wrong index lands on a different row.
 */
export function indexOf(
  dir: string,
  scanned: ProjectInfo[],
  isOpen?: (item: ProjectInfo, byDefault: boolean) => boolean,
): number {
  return Math.max(0, placeWorktrees(scanned, isOpen).findIndex((row) => row.item.dir === dir));
}

// ---- actions on a row ----------------------------------------------------------------------------

/** What an action on a row needs from the app around it. */
export interface ProjectsUi {
  askUser(ask: Ask): Promise<AskResult>;
  notify(result: { ok: boolean; message?: string }): void;
  /** Read the rows again and return them. */
  refresh(): Promise<ProjectInfo[]>;
  t: Translate;
}

/**
 * Start or resume a session, say how it went, and read the rows again: a running dot may have lit.
 *
 * A running session's window is brought to the front instead. One running with no window to show
 * is offered a take-over — its process stopped, the session resumed in a new tab — and the dialog
 * says plainly whether a response in progress would be cut off.
 */
export async function openSession(request: OpenSessionRequest, ui: ProjectsUi): Promise<void> {
  const result = await api.openSession(request);
  if (result.background) {
    const { askUser, t } = ui;
    const { pid, title, busy } = result.background;
    const yes = await askUser({
      title: t("dialog.background", { name: title }),
      detail: [t("dialog.background.detail", { pid: String(pid) }), t(busy ? "dialog.background.busy" : "dialog.background.idle")].join("\n"),
      confirm: t("dialog.background.confirm"),
      danger: busy,
    });
    if (!yes) return;
    ui.notify(await api.openSession({ ...request, takeOver: true }));
  } else {
    ui.notify(result);
  }
  void ui.refresh();
}

/** Rename a project or, with a session id, one of its sessions. An empty title takes the name off again. */
export async function rename(target: { projectDir: string; sessionId?: string }, title: string, ui: ProjectsUi): Promise<void> {
  const result = target.sessionId
    ? await api.renameSession({ projectDir: target.projectDir, sessionId: target.sessionId, title })
    : await api.renameProject({ projectDir: target.projectDir, title });
  ui.notify(result);
  await ui.refresh();
}

/** Ask in the app's own dialog, then delete. */
export async function deleteProject(target: ProjectInfo, ui: ProjectsUi): Promise<void> {
  const { askUser, notify, refresh, t } = ui;
  const yes = await askUser({
    title: t("dialog.deleteProject", { name: target.name }),
    detail: [
      t("dialog.deleteProject.detail", { count: target.sessions.length }),
      target.hasMemory ? t("dialog.deleteProject.memory") : "",
    ].filter(Boolean).join("\n"),
    confirm: t("dialog.delete"),
    danger: true,
  });
  if (!yes) return;
  const result = await api.deleteProject({ projectDir: target.dir });
  notify(result);
  if (result.ok) await refresh();
}

export async function deleteSession(projectDir: string, target: SessionInfo, ui: ProjectsUi): Promise<void> {
  const { askUser, notify, refresh, t } = ui;
  const yes = await askUser({
    title: t("dialog.deleteSession", { name: target.title }),
    // A folded row is several transcripts, and all of them go — say so before they do.
    detail: target.continues
      ? t("dialog.deleteSession.detail.chain", { count: String(target.continues + 1) })
      : t("dialog.deleteSession.detail"),
    confirm: t("dialog.delete"),
    danger: true,
  });
  if (!yes) return;
  const result = await api.deleteSession({ projectDir, sessionId: target.id });
  notify(result);
  if (result.ok) await refresh();
}

// ---- right-click menus ---------------------------------------------------------------------------

export const PROJECT_ACTIONS = ["sessions", "new", "newWindow", "pin", "rename", "reveal", "delete"] as const;
export type ProjectAction = (typeof PROJECT_ACTIONS)[number];
export function isProjectAction(id: string | null): id is ProjectAction {
  return (PROJECT_ACTIONS as readonly string[]).includes(id ?? "");
}

export const SESSION_ACTIONS = ["resume", "resumeWindow", "pin", "rename", "delete"] as const;
export type SessionAction = (typeof SESSION_ACTIONS)[number];
export function isSessionAction(id: string | null): id is SessionAction {
  return (SESSION_ACTIONS as readonly string[]).includes(id ?? "");
}

/**
 * The right-click menu of a project row: what the keys do, plus pinning and the folder itself.
 * `extra` is what other features add for this row — git's entries — and goes above the delete line.
 */
export function projectMenuItems(target: ProjectInfo, extra: MenuItemSpec[], t: Translate): MenuItemSpec[] {
  return [
    { id: "sessions", label: t("menu.openSessions") },
    { id: "new", label: t("menu.newSession") },
    { id: "newWindow", label: t("menu.newSessionWindow") },
    { id: MENU_SEPARATOR, label: "" },
    { id: "pin", label: t("menu.pin"), checked: target.pinned },
    { id: "rename", label: t("menu.rename") },
    { id: "reveal", label: t("menu.showFolder"), enabled: Boolean(target.cwd && target.exists) },
    ...extra,
    { id: MENU_SEPARATOR, label: "" },
    { id: "delete", label: t("menu.delete"), enabled: target.liveCount === 0 },
  ];
}

/** The right-click menu of a session row, on either screen it is listed on. */
export function sessionMenuItems(target: SessionInfo, t: Translate): MenuItemSpec[] {
  return [
    { id: "resume", label: t("menu.resume"), enabled: !target.live },
    { id: "resumeWindow", label: t("menu.resumeWindow"), enabled: !target.live },
    { id: MENU_SEPARATOR, label: "" },
    { id: "pin", label: t("menu.pin"), checked: target.pinned },
    { id: "rename", label: t("menu.rename") },
    { id: MENU_SEPARATOR, label: "" },
    { id: "delete", label: t("menu.delete"), enabled: !target.live },
  ];
}

/** What a menu action needs beyond `ProjectsUi`: the two things only the shell can do. */
export interface RowUi extends ProjectsUi {
  /** Show this project's sessions. */
  enterSessions(dir: string): void;
  /** Open the rename box on this row — a project's dir, or a session's id. */
  startRename(id: string): void;
}

/**
 * Every action names its target outright rather than going through the selection, so the menu
 * works the same on a row that was not selected when it was clicked.
 */
export async function runProjectAction(action: ProjectAction, target: ProjectInfo, ui: RowUi): Promise<void> {
  switch (action) {
    case "sessions": ui.enterSessions(target.dir); break;
    case "new": await openSession({ projectDir: target.dir, sessionId: null, target: "sessionsWindow" }, ui); break;
    case "newWindow": await openSession({ projectDir: target.dir, sessionId: null, target: "newWindow" }, ui); break;
    case "pin": ui.notify(await api.togglePin({ kind: "projects", key: target.dir })); await ui.refresh(); break;
    case "rename": ui.startRename(target.dir); break;
    case "reveal": ui.notify(await api.revealProject(target.dir)); break;
    case "delete": await deleteProject(target, ui); break;
  }
}

export async function runSessionAction(action: SessionAction, projectDir: string, target: SessionInfo, ui: RowUi): Promise<void> {
  switch (action) {
    case "resume": await openSession({ projectDir, sessionId: target.id, target: "sessionsWindow" }, ui); break;
    case "resumeWindow": await openSession({ projectDir, sessionId: target.id, target: "newWindow" }, ui); break;
    case "pin": ui.notify(await api.togglePin({ kind: "sessions", key: target.id })); await ui.refresh(); break;
    case "rename": ui.startRename(target.id); break;
    case "delete": await deleteSession(projectDir, target, ui); break;
  }
}

// ---- the markup ----------------------------------------------------------------------------------

/** What `useRef<HTMLInputElement>(null)` hands out; `current` is null until the box is on screen. */
type EditRef = RefObject<HTMLInputElement>;

/**
 * The box a row turns into while it is being renamed. Blur commits, Enter commits explicitly — the
 * difference decides whether an emptied field means "take the name off" — and Escape cancels.
 */
export function RenameInput({ defaultValue, inputRef, onCommit, onCancel }: {
  defaultValue: string;
  inputRef: EditRef;
  onCommit(value: string, explicit: boolean): void;
  onCancel(): void;
}) {
  const t = useText();
  return (
    <input
      ref={inputRef}
      defaultValue={defaultValue}
      onBlur={(event) => onCommit(event.target.value, false)}
      onKeyDown={(event) => {
        if (event.key === "Enter") onCommit((event.target as HTMLInputElement).value, true);
        if (event.key === "Escape") onCancel();
      }}
      data-testid="rename-input"
      aria-label={t("tip.newName")}
      className="w-full bg-ink-700 border border-accent/60 rounded-lg px-3 py-2 text-sm"
    />
  );
}

/**
 * The project search box and the add button — in the window's top bar, beside the project count,
 * so the list below spends its height on rows.
 */
export function ProjectSearch({ query, onQuery, searchRef, onAdd, onDown }: {
  query: string;
  onQuery(query: string): void;
  searchRef: EditRef;
  onAdd(): void;
  /** ↓ in the box: on to the first row of the list it filters. */
  onDown(): void;
}) {
  const t = useText();
  return (
    <div className="flex flex-1 min-w-0 gap-2">
      <input
        ref={searchRef}
        value={query}
        onChange={(event) => onQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") { onQuery(""); searchRef.current?.blur(); }
          if (event.key === "ArrowDown") { event.preventDefault(); onDown(); }
        }}
        placeholder={t("app.search")}
        aria-label={t("app.search")}
        className="flex-1 min-w-0 bg-ink-800 border border-ink-600 rounded-lg px-3 py-1 text-sm placeholder:text-bone-500 focus:border-accent/60"
      />
      {/* A folder that has never had a session has no other way into this list. */}
      <button
        type="button"
        className="btn px-2.5 shrink-0"
        title={t("app.addProject.title")}
        aria-label={t("app.addProject")}
        onClick={onAdd}
      >
        +
      </button>
    </div>
  );
}

/** The project rows — the pane the window is navigated from. */
export function ProjectPane({
  placed, query, editing, editRef, onRename, onCancelEdit, isSelected, onSelect, onOpen, onContextMenu, onToggle, tight,
}: {
  placed: Placed<ProjectInfo>[];
  /** The search, so a row can say how many of its sessions it was kept for. */
  query: string;
  /** The dir of the row being renamed, if any. */
  editing: string | null;
  editRef: EditRef;
  onRename(value: string, explicit: boolean): void;
  onCancelEdit(): void;
  /** Whether this row is the selected one — the shell's to say, since the screen decides it. */
  isSelected(item: ProjectInfo, index: number): boolean;
  onSelect(index: number): void;
  onOpen(dir: string): void;
  onContextMenu(item: ProjectInfo, index: number): void;
  /** Show or fold the rows tucked under a row. */
  onToggle(item: ProjectInfo, index: number): void;
  /** A thin window: less padding around everything. */
  tight: boolean;
}) {
  const t = useText();
  return (
    <>
      <div className={`flex-1 overflow-auto space-y-0.5 ${tight ? "p-1" : "p-2"}`}>
        {placed.map(({ item, depth, parent, trees, open, worktrees }, index) => (
          editing === item.dir ? (
            <RenameInput key={item.dir} inputRef={editRef} defaultValue={item.alias ?? item.name} onCommit={onRename} onCancel={onCancelEdit} />
          ) : (
            <ProjectRow
              key={item.dir}
              project={item}
              depth={depth}
              parent={parent}
              trees={trees}
              open={open}
              worktrees={worktrees}
              onToggle={() => onToggle(item, index)}
              matched={query.trim() ? filterSessions(item, query).length : null}
              selected={isSelected(item, index)}
              onSelect={() => onSelect(index)}
              onOpen={() => onOpen(item.dir)}
              onContextMenu={() => onContextMenu(item, index)}
            />
          )
        ))}
        {placed.length === 0 ? <p className="px-3 py-6 text-xs text-bone-500">{t("app.noMatch")}</p> : null}
      </div>
    </>
  );
}

/** The sessions screen: one project's sessions, with the selected row and the rename box. */
export function SessionList({
  sessions, runs, selected, editing, editRef, onRename, onCancelEdit, onSelect, onOpen, onContextMenu,
}: {
  sessions: SessionInfo[];
  /** The folded headless runs' switch, drawn after the rows. */
  runs: ReactNode;
  selected: number;
  /** The id of the session being renamed, if any. */
  editing: string | null;
  editRef: EditRef;
  onRename(value: string, explicit: boolean): void;
  onCancelEdit(): void;
  onSelect(index: number): void;
  onOpen(): void;
  onContextMenu(item: SessionInfo, index: number): void;
}) {
  return (
    <>
      {sessions.map((item, index) => (
        editing === item.id ? (
          <RenameInput key={item.id} inputRef={editRef} defaultValue={item.title} onCommit={onRename} onCancel={onCancelEdit} />
        ) : (
          <SessionRow
            key={item.id}
            session={item}
            selected={index === selected}
            onSelect={() => onSelect(index)}
            onOpen={onOpen}
            onContextMenu={() => onContextMenu(item, index)}
          />
        )
      ))}
      {runs}
    </>
  );
}

/** The projects screen's glimpse of the selected project: its first sessions, and a way to the rest. */
export function SessionPreview({ sessions, runs, onEnter, onContextMenu }: {
  /** The project's sessions the search keeps: the same list the sessions screen opens on. */
  sessions: SessionInfo[];
  /** The folded headless runs' switch, drawn after the rows. */
  runs: ReactNode;
  /** Any click lands on the sessions screen; the preview is a doorway, not a list to select from. */
  onEnter(): void;
  onContextMenu(item: SessionInfo, index: number): void;
}) {
  // Every session, in the list that scrolls: a "show all" button at the end was one more click to
  // reach what scrolling already reaches.
  return (
    <>
      {sessions.map((item, index) => (
        <SessionRow
          key={item.id}
          session={item}
          selected={false}
          onSelect={onEnter}
          onOpen={onEnter}
          onContextMenu={() => onContextMenu(item, index)}
        />
      ))}
      {runs}
    </>
  );
}

// ---- how a session starts: the settings cards ----------------------------------------------------

/** The shells whose note is the command they run, which is not translated; the rest explain themselves. */
const SHELL_COMMANDS: Partial<Record<ShellChoice, string>> = {
  pwsh: "pwsh", powershell: "powershell.exe", cmd: "cmd.exe /k", bash: "bash -lc",
};

/** The settings card body: which shell hosts a session, and the program when it is a custom one. */
export function LaunchSettings({ launch, onChange }: { launch: LaunchConfig; onChange(launch: LaunchConfig): void }) {
  const t = useText();
  const set = (patch: Partial<LaunchConfig>): void => onChange({ ...launch, ...patch });
  return (
    <>
      {SHELL_CHOICES.map((shell) => (
        <Choice
          key={shell}
          label={t(`settings.shell.${shell}` as const)}
          note={SHELL_COMMANDS[shell] ?? t(`settings.shell.${shell}.note` as "settings.shell.auto.note")}
          selected={launch.shell === shell}
          onSelect={() => set({ shell })}
        />
      ))}

      <div className={`flex items-center gap-2 pt-1 ${launch.shell === "custom" ? "" : "opacity-40"}`}>
        <span className="text-[11px] text-bone-500 shrink-0">{t("settings.launch.program")}</span>
        <input
          type="text"
          spellCheck={false}
          value={launch.customShell}
          disabled={launch.shell !== "custom"}
          placeholder={t("settings.launch.programPlaceholder")}
          onChange={(event) => set({ customShell: event.target.value })}
          className="flex-1 min-w-0 bg-ink-800 border border-ink-600 rounded-lg px-2 py-1 text-xs placeholder:text-bone-500 focus:border-accent/60"
        />
      </div>
      {launch.shell === "custom" && !launch.customShell.trim() ? (
        <div className="text-[11px] text-warn">{t("settings.launch.noPath")}</div>
      ) : null}
      <label className="flex items-center gap-2 px-1 py-1 mt-2 rounded-lg hover:bg-ink-700/60">
        <input
          type="checkbox"
          checked={launch.fileLinks}
          onChange={() => set({ fileLinks: !launch.fileLinks })}
          className="accent-accent"
          data-testid="file-links"
        />
        <Truncated as="span" className="text-sm text-bone-100">{t("settings.launch.fileLinks")}</Truncated>
      </label>
      <div className="text-[11px] text-bone-500">{t("settings.launch.fileLinksNote")}</div>
    </>
  );
}

/** The settings card body: the permission mode a session starts in. */
export function PermissionSettings({ launch, onChange }: { launch: LaunchConfig; onChange(launch: LaunchConfig): void }) {
  const t = useText();
  return (
    <>
      {PERMISSION_MODES.map((mode) => (
        <Choice
          key={mode}
          label={t(`settings.permission.${mode}` as const)}
          // The bypass note is the flag itself, which stays as it is written on the command line.
          note={mode === "bypass" ? PERMISSION_ARGS.bypass.join(" ") : t(`settings.permission.${mode}.note` as const)}
          selected={launch.permission === mode}
          onSelect={() => onChange({ ...launch, permission: mode })}
        />
      ))}
    </>
  );
}
