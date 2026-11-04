/**
 * The whole window: status strip, project list, session list, detail panel, monitor, settings.
 *
 * Selection and screen live here because the keyboard drives them — every list is a controlled
 * view of this state, so a key and a click end up in exactly the same place.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { listAction, nextIndex, PAGE_ROWS } from "@core/keymap";
import type { Language } from "@core/i18n";
import { gitMenuItems, isGitAction, runGitAction, useDirtyPatch, useGit } from "../features/git/ui";
import {
  deleteProject, deleteSession, filterProjects, filterSessions, indexOf, isProjectAction, isSessionAction, openSession,
  ProjectPane, ProjectSearch, projectMenuItems, rename, runProjectAction, runSessionAction, SessionList, sessionMenuItems, SessionPreview,
  useProjects,
} from "../features/projects/ui";
import { useSettings } from "../features/settings/ui";
import { UpdatePrompt, useUpdates } from "../features/updates/ui";
import { shouldPrompt, UPDATE_SNOOZE_MS } from "@core/updates";
import { UsageGauges, useUsage } from "../features/usage/ui";
import { MachineGauges, useMetrics } from "../features/metrics/ui";
import { usePasteResults } from "../features/clipboard/ui";
import type { ProjectInfo, SessionInfo, SidePaneTab, ThemeMode } from "@core/types";
import { MENU_SEPARATOR, SIDE_PANE_TABS } from "@core/constants";

import { api, type AppInfo, type DisplayInfo, type SettingsPayload } from "./api";
import { chosenMonitor } from "../features/dock/contract";
import { DockButton, DockGrip, useDock } from "../features/dock/ui";
import { ProjectDetail, ProjectTitle, projectRowId, SessionDetail, sessionRowId } from "./components/Lists";
import { SettingsView } from "./components/Settings";
import { Modal, type Ask, type AskResult } from "./components/Modal";
import { TitleBar } from "./components/TitleBar";
import { Splitter } from "./components/Splitter";
import { Truncated } from "./components/Truncated";
import { WindowControls } from "./components/WindowControls";
import { FilesPane, useFiles } from "../features/files/ui";
import { SkillsPane, useSkills } from "../features/skills/ui";
import { ArtifactsPane, useArtifacts } from "../features/artifacts/ui";
import { SidePane, usePaneOpen } from "./components/SidePane";
import type { ArtifactScope } from "@core/artifactOrigins";
import { hasFileColumn, STACK_MIN, stackedTopHeight, useLayoutMode, useMeasured } from "./useLayoutMode";
import { useTheme } from "./useTheme";
import { TextProvider, useText } from "./useText";

type Screen = "projects" | "sessions" | "settings";

const REFRESH_MS = 15_000;
/** The project menu's entry for the clipboard feature: an image on the clipboard, saved as a file. */
const PASTE_IMAGE = "pasteImage";
/** Room enough for a path, never so much that the lists it frames disappear. */
const NAV_MIN = 180;
const NAV_MAX = 560;
const ASIDE_MIN = 160;
/** Enough of a stacked pane to be a list rather than a sliver. */
const ASIDE_MAX = 640;

type Toast = { text: string; tone: "ok" | "bad" } | null;

/**
 * The menu key or Shift+F10 on a list: the browser asks the focused list itself for a menu, and the
 * answer is the selected row's. A right-click on the list's empty space is not that question.
 */
function isMenuKey(event: React.MouseEvent): boolean {
  return event.target === event.currentTarget && event.button !== 2;
}

/**
 * The window, wrapped in the language it is read in.
 *
 * Split so everything inside can call useText(): a provider cannot be consumed by the component
 * that renders it.
 */
export function App() {
  const [shell, setShell] = useState<{ language: Language; locale: string }>({ language: "system", locale: "en" });
  return (
    <TextProvider language={shell.language} locale={shell.locale}>
      <Window onLanguage={setShell} />
    </TextProvider>
  );
}

/** The divider between the lists and the right-hand panel (`w-1`), which the top bar's split allows for. */
const HEADER_DIVIDER_PX = 4;
/** The stacked side pane's height before anyone drags it — what its fixed cap used to be. */
const STACK_PANE_DEFAULT = 192;
/** Short enough to keep the sessions, tall enough for the tabs and two rows. */
const STACK_PANE_MIN = 80;

function Window({ onLanguage }: { onLanguage: (next: { language: Language; locale: string }) => void }) {
  const t = useText();
  // The rows are the projects feature's; what is selected among them is this file's.
  const { projects, setProjects, scan, liveSessions } = useProjects();
  const usage = useUsage();
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [screen, setScreen] = useState<Screen>("projects");
  const [projectIndex, setProjectIndex] = useState(0);
  const [sessionIndex, setSessionIndex] = useState(0);
  const [openProject, setOpenProject] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  /** A search box has the focus — the one field a band has outside settings and dialogs. */
  const [searching, setSearching] = useState(false);
  const [toast, setToast] = useState<Toast>(null);
  /** The dialog on screen, and the promise waiting on its answer. */
  const [dialog, setDialog] = useState<{ ask: Ask; settle: (result: AskResult) => void } | null>(null);
  // The payload is the settings feature's; the screen it is edited on is opened from here.
  const { settings, setSettings, load: loadSettings, save: saveSettings } = useSettings();
  const [displays, setDisplays] = useState<DisplayInfo[]>([]);
  const updates = useUpdates(info?.version);
  /** The update question has had its answer this run; it is asked once a run at most. */
  const [updateAsked, setUpdateAsked] = useState(false);
  // Monitoring off means there is nothing to draw — and nothing being measured, which is the point.
  const monitoring = settings?.ui.monitor ?? true;
  // The graphs' series live in the metrics feature's store, not here: a sample re-renders the
  // components that draw a reading, never this whole window.
  const metrics = useMetrics(monitoring);
  // Docked counts as maximised: the band is the window at its full extent, so the middle caption
  // button offers to restore, and restoring is what gives the edge back.
  const [windowState, setWindowState] = useState({ maximized: false, onTop: false });
  // Whether the window is a band is dock's state, pushed on every change; nothing here guesses it.
  const dock = useDock();
  const [theme, setTheme] = useState<ThemeMode>("system");
  /** The side pane's tab picked in this run; until then, the one Settings remembers. */
  const [paneTab, setPaneTab] = useState<SidePaneTab | null>(null);
  /** The Artifacts tab's scope picked in this run; until then, the one Settings remembers. */
  const [artifactScope, setArtifactScope] = useState<ArtifactScope | null>(null);
  // Fractions of the window, not pixels: 0 = the size the layout would have chosen, anything else
  // is where the user left the divider — and it means the same thing when the window changes shape.
  const [navFraction, setNavFraction] = useState(0);
  const [asideFraction, setAsideFraction] = useState(0);
  const [stackFraction, setStackFraction] = useState(0);
  /** The side pane's share of the stack when it sits under the sessions; 0 is its default height. */
  const [paneFraction, setPaneFraction] = useState(0);
  // The room the two stacked panes share, measured rather than guessed from the window: the header
  // and toolbar above them came to 149 px here, which is more than a divider can spare.
  const [stackHeight, stackRef] = useMeasured("height");
  const [fileColumn, setFileColumn] = useState(false);
  const filesRef = useRef<() => void>(() => undefined);
  useTheme(theme);
  const { mode, width: windowWidth, height: windowHeight } = useLayoutMode(settings?.ui.layout ?? "auto", settings?.ui.stackBelow ?? 520);
  const searchRef = useRef<HTMLInputElement>(null);
  const editRef = useRef<HTMLInputElement>(null);
  // The two lists and the settings button: where the keyboard is sent when a screen changes.
  const projectListRef = useRef<HTMLDivElement>(null);
  const sessionListRef = useRef<HTMLDivElement>(null);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  /** The pointer is pressing in the session list — the focus it brings there is a click's. */
  const pointerOnSessions = useRef(false);

  const refresh = useCallback(async () => {
    const [scanned] = await Promise.all([scan(), usage.refresh()]);
    filesRef.current?.();
    return scanned;
  }, [scan, usage.refresh]);

  // First paint: everything the window needs, plus the position the last run ended on.
  useEffect(() => {
    void (async () => {
      const [, appInfo, saved] = await Promise.all([
        scan(), api.appInfo(), loadSettings(), usage.refresh(), metrics.load(),
      ]);
      setTheme(saved.ui.theme);
      setNavFraction(saved.ui.navWidth);
      setAsideFraction(saved.ui.asideWidth);
      setStackFraction(saved.ui.stackTop);
      setPaneFraction(saved.ui.stackPane);
      setInfo(appInfo);
      onLanguage({ language: saved.ui.language, locale: appInfo.locale });
    })();
  }, []);

  // Out of sight — minimised, hidden, or covered by another window — nothing is refreshed and the
  // metrics feature drops its samples; on coming back, one refresh and the history main kept, so
  // what is drawn is as current as if it had never stopped. A docked band stays visible, so it
  // keeps updating.
  useEffect(() => {
    const timer = setInterval(() => { if (!document.hidden) void refresh(); }, REFRESH_MS);
    const onVisibility = (): void => {
      if (document.hidden) return;
      void metrics.load();
      void refresh();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refresh, metrics.load]);

  // Main can save the settings too, so the language follows from wherever it changed. Only the two
  // values it reads: a settings push that changed something else is no reason to set it again.
  const language = settings?.ui.language;
  const locale = info?.locale;
  useEffect(() => {
    if (language && locale) onLanguage({ language, locale });
  }, [language, locale, onLanguage]);
  useEffect(() => api.onWindowState(setWindowState), []);

  // A docked band answers the mouse and leaves the keyboard with whatever the user was typing in
  // (features/dock/main.ts). It asks for the keyboard only while this page has a field open.
  useEffect(() => {
    api.holdKeyboard(Boolean(editing) || screen === "settings" || dialog !== null || searching);
  }, [editing, screen, dialog, searching]);

  useEffect(() => { void api.windowState().then(setWindowState); }, []);

  // How wide the right-hand panel is, whichever shape drew it, so the top bar can split where the
  // panes below split: the project search spans the lists, the buttons sit over the panel.
  const [asidePx, asideRef] = useMeasured("width");

  // The list as it is drawn — one array for both the drawing and the keyboard, or the arrow keys
  // would walk a different list from the one on screen.
  const placed = useMemo(() => filterProjects(projects, query), [projects, query]);
  const filtered = useMemo(() => placed.map((row) => row.item), [placed]);

  const project = filtered[Math.min(projectIndex, Math.max(0, filtered.length - 1))] ?? null;

  // Git's own state for the project in front of the user; the count it finds is merged into that
  // project's row, which is the one thing about git this file still does.
  const patchDirty = useDirtyPatch(setProjects);
  const { worktrees } = useGit(
    openProject ?? project?.dir ?? null,
    settings?.git.enabled ?? false,
    settings?.git.countChanges ?? false,
    patchDirty,
  );
  const openProjectInfo = projects.find((p) => p.dir === openProject) ?? null;
  const sessions = useMemo(() => filterSessions(openProjectInfo, query), [openProjectInfo, query]);
  const session = sessions[Math.min(sessionIndex, Math.max(0, sessions.length - 1))] ?? null;
  // The project row drawn as selected, which the project list's keys move from: the selection on
  // the projects screen, the open project beside its sessions, none on the settings screen.
  const projectCursor = screen === "projects" ? projectIndex
    : screen === "sessions" ? filtered.findIndex((p) => p.dir === openProject) : -1;

  // What the key handlers read. Kept in a ref because a key can arrive before React has
  // re-rendered with the new state, and acting on the previous screen is how F2 renamed the wrong
  // thing. The ref is written during render, so it is never behind.
  const latest = useRef({ screen, project, projectCursor, session, sessions, filtered, openProject });
  latest.current = { screen, project, projectCursor, session, sessions, filtered, openProject };

  /**
   * Ask in the app's own dialog rather than the system's.
   *
   * Electron has no `window.prompt` at all, so asking for a name that way returned nothing and the
   * feature silently did nothing; and a native message box wears the OS's colours, which beside a
   * dark window reads as a different program.
   */
  const askUser = useCallback((ask: Ask): Promise<AskResult> =>
    new Promise<AskResult>((resolve) => {
      setDialog({ ask, settle: (result) => { setDialog(null); resolve(result); } });
    }), []);

  const notify = useCallback((result: { ok: boolean; message?: string }) => {
    if (!result.message) return;
    setToast({ text: result.message, tone: result.ok ? "ok" : "bad" });
    setTimeout(() => setToast(null), 4000);
  }, []);

  /** What an action on a row needs from this window; the features do the rest themselves. */
  const rowUi = useMemo(() => ({ askUser, notify, refresh, t }), [askUser, notify, refresh, t]);

  const open = useCallback(async (target: "sessionsWindow" | "currentWindow" | "newWindow") => {
    const now = latest.current;
    const dir = now.screen === "sessions" ? now.openProject : now.project?.dir;
    if (!dir) return;
    await openSession({
      projectDir: dir,
      sessionId: now.screen === "sessions" ? now.session?.id ?? null : null,
      target,
    }, rowUi);
  }, [rowUi]);

  /** A fresh session in the project on screen — the one open, or the one under the cursor. */
  const startNew = useCallback(async () => {
    const now = latest.current;
    const dir = now.screen === "sessions" ? now.openProject : now.project?.dir;
    if (!dir) return;
    await openSession({ projectDir: dir, sessionId: null, target: "sessionsWindow" }, rowUi);
  }, [rowUi]);

  /** Pick a folder, make it a project, and land on its row. */
  const addProject = useCallback(async () => {
    const result = await api.addProject();
    notify(result);
    if (!result.ok || !result.dir) return;
    const scanned = await refresh();
    setQuery("");                                       // a filter could hide the row just added
    setScreen("projects");
    setProjectIndex(indexOf(result.dir, scanned));
  }, [notify, refresh]);

  const enterSessions = useCallback((dir: string) => {
    setOpenProject(dir);
    setScreen("sessions");
    setSessionIndex(0);
    void api.saveUi({ project: dir, cursor: 0 });
  }, []);

  const back = useCallback(() => {
    if (editing) { setEditing(null); return; }
    if (screen === "settings") { setScreen(openProject ? "sessions" : "projects"); return; }
    if (screen === "sessions") {
      setScreen("projects");
      setOpenProject(null);
      void api.saveUi({ project: null, cursor: projectIndex });
    }
  }, [editing, screen, openProject, projectIndex]);

  /** Select the row for `dir` in a freshly scanned list — through the same placement it is drawn with. */
  const landOn = useCallback((dir: string, scanned: ProjectInfo[]) => {
    setQuery("");
    setScreen("projects");
    setProjectIndex(indexOf(dir, scanned));
  }, []);

  /** The right-click menu of a project row: the projects feature's entries with git's slotted in. */
  const projectMenu = useCallback(async (target: ProjectInfo, index: number) => {
    setProjectIndex(index);
    setScreen("projects");
    const choice = await api.contextMenu(projectMenuItems(target, [
      ...gitMenuItems(target, settings?.git.base, t),
      // The window's own way to the clipboard feature — by mouse, or by the menu key on the list.
      { id: MENU_SEPARATOR, label: "" },
      { id: PASTE_IMAGE, label: t("menu.pasteImage") },
    ], t));
    if (isProjectAction(choice)) await runProjectAction(choice, target, { ...rowUi, enterSessions, startRename: setEditing });
    // Git's entries carry their own dialogs; this file only hands over what they need.
    else if (isGitAction(choice)) await runGitAction(choice, target, { ...rowUi, landOn });
    else if (choice === PASTE_IMAGE) notify(await api.pasteImage());
  }, [rowUi, enterSessions, settings?.git.base, landOn, notify, t]);

  /** The right-click menu of a session row, on either screen it is listed on. */
  const sessionMenu = useCallback(async (projectDir: string, target: SessionInfo, index: number) => {
    if (latest.current.screen === "sessions") setSessionIndex(index);
    const choice = await api.contextMenu(sessionMenuItems(target, t));
    if (!isSessionAction(choice)) return;
    await runSessionAction(choice, projectDir, target, {
      ...rowUi,
      enterSessions,
      // The editor replaces the row on the sessions screen only, so the preview list gets there first.
      startRename: (id) => {
        if (latest.current.screen !== "sessions") enterSessions(projectDir);
        setSessionIndex(index);
        setEditing(id);
      },
    });
  }, [rowUi, enterSessions, t]);

  // The global shortcut can fire while another window has focus; its verdict still belongs here.
  usePasteResults(notify);
  // A sweep runs on a timer in the main process; it speaks only when it changed something.
  useEffect(() => api.onToast((message) => notify({ ok: true, message })), [notify]);

  const applySettings = useCallback(async (next: SettingsPayload) => {
    // Every section, not a list that has to be remembered: a section left out of this call is a
    // setting the screen appears to change and then silently reverts on the next push.
    const saved = await saveSettings({
      dock: next.dock,
      status: next.status,
      launch: next.launch,
      ui: next.ui,
      git: next.git,
      updates: next.updates,
    });
    setTheme(saved.ui.theme);
    await usage.refresh();                          // which windows are shown is a setting
  }, [usage.refresh]);

  const openSettings = useCallback(async () => {
    const [, screens] = await Promise.all([loadSettings(), dock.displays()]);
    setDisplays(screens);
    setScreen("settings");
  }, []);

  const applyDock = useCallback(async (enabled: boolean) => {
    if (!settings) return;
    if (!enabled) {
      setSettings(await dock.release());
      notify({ ok: true, message: t("app.undocked") });
      return;
    }
    const result = await dock.apply({ ...settings.dock, device: chosenMonitor(settings.dock.device, displays), enabled: true });
    if (result.settings) setSettings(result.settings);
    notify({ ok: result.ok, message: result.message ?? t("app.docked") });
  }, [settings, displays, notify, t]);

  // The keyboard starts in the project list, once the layout the settings ask for is drawn — the
  // list it lands in is then the one that stays. Not in a band, which leaves the keyboard with the
  // terminal (features/dock/main.ts).
  const placedFocus = useRef(false);
  useEffect(() => {
    if (!settings || placedFocus.current) return;
    placedFocus.current = true;
    void api.dockState().then((state) => { if (!state.docked) projectListRef.current?.focus(); });
  }, [settings]);

  /** Settings closed by its own Back button or Escape: the keyboard goes back to the button that opened it. */
  const settingsReturn = useRef(false);
  const closeSettings = useCallback(() => {
    settingsReturn.current = true;
    back();
  }, [back]);
  useEffect(() => {
    if (screen === "settings" || !settingsReturn.current) return;
    settingsReturn.current = false;
    settingsButtonRef.current?.focus();
  }, [screen]);

  /**
   * The project list's keys. A key means something only to the list that has the focus, so a letter
   * typed into any field of the window is only ever a letter.
   */
  const projectKeys = useCallback((event: React.KeyboardEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget) return;           // the rename box inside has its own
    const action = listAction(event);
    if (!action) return;
    event.preventDefault();
    const now = latest.current;
    const cursor = Math.max(0, now.projectCursor);
    const target = now.filtered[cursor];
    switch (action) {
      // The session list takes it from here: the focus arriving there is what enters the project.
      // Behind the settings screen there is no session list to arrive at, so it enters directly.
      case "open":
        if (!target) break;
        if (sessionListRef.current) sessionListRef.current.focus();
        else enterSessions(target.dir);
        break;
      case "back": back(); break;
      case "rename": case "delete":
        if (!target) break;
        // On that row of the projects screen, the way its menu does it.
        setProjectIndex(cursor);
        setScreen("projects");
        if (action === "rename") setEditing(target.dir);
        else void deleteProject(target, rowUi);
        break;
      default:
        setProjectIndex(nextIndex(action, cursor, now.filtered.length, PAGE_ROWS));
        setScreen("projects");
    }
  }, [back, rowUi, enterSessions]);

  /** The session list's keys, on the sessions screen: the same keys, meaning the same things. */
  const sessionKeys = useCallback((event: React.KeyboardEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget) return;
    const action = listAction(event);
    const now = latest.current;
    if (!action || now.screen !== "sessions") return;
    event.preventDefault();
    switch (action) {
      case "open": void open("sessionsWindow"); break;
      case "back": back(); projectListRef.current?.focus(); break;
      case "rename": if (now.session) setEditing(now.session.id); break;
      case "delete": if (now.session && now.openProject) void deleteSession(now.openProject, now.session, rowUi); break;
      default: setSessionIndex((index) => nextIndex(action, index, now.sessions.length, PAGE_ROWS));
    }
  }, [open, back, rowUi]);

  // The rename box takes the keyboard, and gives it back to the list it came from when Enter or
  // Escape closes it — not after a blur: that was a click somewhere, which keeps the focus it took.
  const editReturn = useRef<HTMLElement | null>(null);
  const refocusAfterEdit = useRef(false);
  useEffect(() => {
    if (editing) {
      editReturn.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      editRef.current?.focus();
    } else if (refocusAfterEdit.current) {
      refocusAfterEdit.current = false;
      editReturn.current?.focus();
    }
  }, [editing]);
  const cancelEdit = useCallback(() => {
    refocusAfterEdit.current = true;
    setEditing(null);
  }, []);

  const commitRename = useCallback(async (value: string, explicit = false) => {
    const now = latest.current;
    const title = value.trim();
    if (explicit) refocusAfterEdit.current = true;
    setEditing(null);
    // An empty name takes the name off again, which is how the generated title is got back. Only
    // when it was typed and entered, though: blurring a field someone happened to clear, or clicked
    // into and out of, must not quietly rename anything.
    if (!title && !explicit) return;
    // Which thing is being renamed is decided by what is on screen at commit time, not by what was
    // on screen when this callback was created.
    const target = now.screen === "sessions" && now.session
      ? { projectDir: now.openProject as string, sessionId: now.session.id }
      : now.project ? { projectDir: now.project.dir } : null;
    if (target) await rename(target, title, rowUi);
  }, [rowUi]);

  // Stable, so the prompt's Escape listener is added once rather than on every render of this window.
  const answerUpdate = useCallback((yes: boolean, snooze: boolean) => {
    setUpdateAsked(true);
    if (snooze) void api.saveUi({ updateSnoozeUntil: Date.now() + UPDATE_SNOOZE_MS });
    if (yes) {
      updates.act("now");
      notify({ ok: true, message: t("update.prompt.started") });
    }
  }, [updates.act, notify, t]);

  const usageWindows = usage.status?.windows ?? [];

  const showFiles = settings?.ui.files ?? true;
  const paneTabs = SIDE_PANE_TABS.filter((tab) => settings?.ui[tab] ?? true);
  const showPane = paneTabs.length > 0;
  const wantedTab = paneTab ?? settings?.ui.sidePane ?? "files";
  const activeTab: SidePaneTab = paneTabs.includes(wantedTab) ? wantedTab : paneTabs[0] ?? "files";
  const filesCwd = (screen === "sessions" ? openProjectInfo?.cwd : project?.cwd) ?? null;
  const skills = useSkills(filesCwd, showPane && activeTab === "skills");
  const artifacts = useArtifacts(showPane && activeTab === "artifacts");
  const paneOpen = usePaneOpen(settings?.ui.paneOpen);
  const band = mode === "band";
  const column = mode === "column";
  const showDetail = mode === "full";
  // The project's folder is read only while it is on screen: the Files tab is the one picked, and
  // the shape draws a side pane at all (stacked and full do; band and compact draw none). Nothing
  // while the setting is off, nothing while no project is selected — and turning back to the tab
  // reads it again at once (useFiles).
  const filesShown = showFiles && showPane && activeTab === "files" && (column || showDetail);
  const files = useFiles(filesCwd, filesShown);
  // The list refresh runs on a timer that must not restart whenever this callback is rebuilt, so
  // the tick reaches the panel through a ref rather than through the dependency list.
  filesRef.current = files.refresh;
  // Fractions turned back into pixels against what is on screen right now, then clamped so no pane
  // is squeezed out. Saving happens on release, so a drag writes one line, not one per frame.
  const navWidth = navFraction ? Math.round(navFraction * windowWidth) : 0;
  const asideWidth = asideFraction ? Math.round(asideFraction * windowWidth) : 0;
  const topHeight = stackedTopHeight(Math.round(stackFraction * stackHeight), stackHeight);
  // The side pane under the stacked sessions: dragged to a height, never so tall the sessions vanish.
  // An undragged project list is flexible and gives way, down to the same floor the sessions keep.
  const paneMax = Math.max(STACK_PANE_MIN, stackHeight - (topHeight || STACK_MIN) - STACK_MIN);
  const paneHeight = Math.min(paneMax, paneFraction ? Math.round(paneFraction * stackHeight) : STACK_PANE_DEFAULT);
  // Stacked is a choice about the lists, not about the window: a stacked window can be wide, and
  // when it is, the room to its right is a file column rather than nothing (useLayoutMode).
  useLayoutEffect(() => {
    setFileColumn((had) => showPane && column && hasFileColumn(windowWidth, had));
  }, [showPane, column, windowWidth]);
  // Wide enough to draw a tree without it being mostly indentation; the panel's own button can
  // still ask for the other one.
  const filesPane = <FilesPane files={files} roomy={fileColumn || showDetail} ui={rowUi} />;
  const pickTab = useCallback((tab: SidePaneTab) => {
    setPaneTab(tab);
    void api.saveUi({ sidePane: tab });
  }, []);
  const pickScope = useCallback((scope: ArtifactScope) => {
    setArtifactScope(scope);
    void api.saveUi({ artifactScope: scope });
  }, []);
  // The project and session the Artifacts tab scopes to: the ones the window is showing.
  const placeProject = screen === "sessions" ? openProjectInfo : project;
  const placeSessions = useMemo(() => (screen === "sessions" && session ? [session.id, ...session.folded] : []),
    [screen, session]);
  const artifactPlace = useMemo(() => ({
    dir: placeProject?.dir ?? null,
    sessions: placeSessions,
    projectName: (dir: string) => projects.find((p) => p.dir === dir)?.name ?? null,
    sessionTitle: (id: string) => placeProject?.sessions.find((s) => s.id === id || s.folded.includes(id))?.title ?? null,
  }), [placeProject, placeSessions, projects]);
  const sidePane = (
    <SidePane tabs={paneTabs} active={activeTab} compact={mode === "band"} onPick={pickTab}>
      {activeTab === "skills" ? <SkillsPane groups={skills} open={paneOpen} notify={notify} />
        : activeTab === "artifacts" ? (
          <ArtifactsPane artifacts={artifacts} place={artifactPlace} scope={artifactScope ?? settings?.ui.artifactScope ?? "all"}
            onScope={pickScope} open={paneOpen} notify={notify} />
        )
          : filesCwd ? filesPane
            : <div className="flex-1 px-2 py-1 text-[11px] text-bone-500">{t("pane.noProject")}</div>}
    </SidePane>
  );
  // Both thin shapes lose the same things: the labels on buttons, and the space for two panes.
  const tight = band || column;

  // The same four gauges whichever way they are laid out — down a column when the window is narrow,
  // across a row when it is short.
  const machineCards = (
    <>
      <UsageGauges windows={usageWindows} compact />
      {monitoring ? <MachineGauges /> : null}
    </>
  );

  // The two panes the projects feature draws. Which row is selected, and what a click on it does,
  // stay this file's: the keyboard drives both, and the same handlers serve it.
  const projectPane = (
    <ProjectPane
      placed={placed}
      editing={editing}
      editRef={editRef}
      onRename={(value, explicit) => void commitRename(value, explicit)}
      onCancelEdit={cancelEdit}
      isSelected={(item, index) => screen !== "settings" && (screen === "projects" ? index === projectIndex : item.dir === openProject)}
      onSelect={(index) => { setProjectIndex(index); setScreen("projects"); }}
      onOpen={enterSessions}
      onContextMenu={(item, index) => void projectMenu(item, index)}
      tight={tight}
    />
  );
  const sessionRows = screen === "sessions" ? (
    <SessionList
      sessions={sessions}
      selected={sessionIndex}
      editing={editing}
      editRef={editRef}
      onRename={(value, explicit) => void commitRename(value, explicit)}
      onCancelEdit={cancelEdit}
      onSelect={setSessionIndex}
      onOpen={() => void open("sessionsWindow")}
      onContextMenu={(item, index) => void sessionMenu(openProject as string, item, index)}
    />
  ) : project ? (
    <SessionPreview
      project={project}
      onEnter={() => enterSessions(project.dir)}
      onContextMenu={(item, index) => void sessionMenu(project.dir, item, index)}
    />
  ) : null;

  // The two lists, each one stop for Tab wherever the shape draws it. The keys and the menu key go
  // to the list; the selected row is the one `aria-activedescendant` names; the rows stay plain rows.
  const currentProject = filtered[projectCursor];
  const projectBox = {
    ref: projectListRef,
    role: "listbox",
    tabIndex: 0,
    "aria-label": t("app.projects"),
    "aria-activedescendant": currentProject ? projectRowId(currentProject.dir) : undefined,
    onKeyDown: projectKeys,
    onContextMenu: (event: React.MouseEvent<HTMLElement>) => {
      const now = latest.current;
      const target = now.filtered[now.projectCursor];
      if (!isMenuKey(event) || !target) return;
      event.preventDefault();
      void projectMenu(target, now.projectCursor);
    },
  };
  const sessionBox = {
    ref: sessionListRef,
    role: "listbox",
    tabIndex: screen === "sessions" || project ? 0 : -1,
    "aria-label": t("detail.sessions"),
    "aria-activedescendant": screen === "sessions" && session ? sessionRowId(session.id) : undefined,
    onKeyDown: sessionKeys,
    // A click enters the sessions itself, and a right-click on a preview row only opens its menu, so
    // a focus the pointer brought is not the doorway the keyboard's is (onFocus below).
    onPointerDown: () => { pointerOnSessions.current = true; },
    onPointerUp: () => { pointerOnSessions.current = false; },
    onFocus: (event: React.FocusEvent<HTMLElement>) => {
      const byPointer = pointerOnSessions.current;
      pointerOnSessions.current = false;
      const now = latest.current;
      // Reaching the projects screen's preview from the keyboard is a click on it: into the sessions.
      if (event.target === event.currentTarget && !byPointer && now.screen === "projects" && now.project) enterSessions(now.project.dir);
    },
    onContextMenu: (event: React.MouseEvent<HTMLElement>) => {
      const now = latest.current;
      if (!isMenuKey(event) || now.screen !== "sessions" || !now.session || !now.openProject) return;
      event.preventDefault();
      void sessionMenu(now.openProject, now.session, now.sessions.indexOf(now.session));
    },
  };

  // A search box takes the keyboard even in a band. There the click does not focus the window, so
  // no focus event comes until the window takes the keyboard: the press asks for it, and the focus
  // that follows (or a Tab into the box, anywhere) keeps it until the box is left.
  const searchBox = (target: EventTarget): boolean =>
    target === searchRef.current || (target instanceof HTMLInputElement && target.type === "search");

  const prompting = !dialog && settings !== null && shouldPrompt(updates.state, {
    now: Date.now(), snoozedUntil: settings.ui.updateSnoozeUntil, asked: updateAsked,
  });
  // While a question is on screen, nothing behind it takes a click, a key or the focus.
  const behind = dialog || prompting ? { inert: "" } : {};

  return (
    <div
      className="relative h-full flex flex-col bg-ink-900 overflow-hidden"
      onFocus={(event) => { if (searchBox(event.target)) setSearching(true); }}
      onBlur={(event) => { if (searchBox(event.target)) setSearching(false); }}
      onPointerDown={(event) => { if (searchBox(event.target)) setSearching(true); }}
    >
      {/* Docked, the frame does not resize; this is the one side that does. */}
      {dock.docked ? <DockGrip edge={dock.edge} onDrag={dock.drag} /> : null}
      <div className="contents" {...behind}>
        <TitleBar
          version={info?.version ?? "—"}
          draggable={!dock.docked}
          controls={
            <WindowControls
              maximized={windowState.maximized}
              onMinimize={() => void api.windowCommand("minimize")}
              onMaximize={() => void api.windowCommand("maximize")}
              onClose={() => void api.windowCommand("close")}
              onTop={windowState.onTop}
              onPin={() => void api.windowCommand("pin")}
              slot={<DockButton docked={dock.docked} edge={dock.edge} ready={dock.ready} onToggle={() => void dock.toggle()} />}
            />
          }
        />
      </div>

      <div className="flex-1 min-h-0 flex" {...behind}>
        {/* One grid, so the project list can be drawn on the left yet written after the top bar:
            Tab walks the markup, and the order a person expects is the bar, then the lists. */}
        <main
          className="flex-1 min-w-0 grid grid-rows-[auto_minmax(0,1fr)_auto] [&>*]:min-w-0 [&>*]:min-h-0"
          style={{ gridTemplateColumns: column ? "minmax(0,1fr)" : "auto auto minmax(0,1fr)" }}
        >
          {screen === "settings" && settings ? (
            <div className="row-span-2 flex flex-col">
              <SettingsView
                settings={settings}
                displays={displays}
                onChange={(next) => void applySettings(next)}
                onApplyDock={(enabled) => void applyDock(enabled)}
                onOpenPage={(page) => void api.openPage(page)}
                locale={info?.locale ?? "en"}
                updates={updates}
                onClose={closeSettings}
              />
            </div>
          ) : (
            <>
              <div className={`flex items-center border-b border-ink-600 ${tight ? "pl-2 py-1" : "pl-4 py-2"}`}>
                {/* Left: as wide as the lists below it, so the search box grows and shrinks with them. */}
                <div className={`header-left flex flex-1 min-w-0 flex-wrap items-center gap-x-2 gap-y-1 ${tight ? "pr-1" : "pr-2"}`}>
                <Truncated
                  as="span"
                  testId="screen-title"
                  title={screen === "sessions" && openProjectInfo ? openProjectInfo.cwd ?? undefined : undefined}
                  className="text-sm text-bone-200"
                >
                  {screen === "sessions" && openProjectInfo ? <ProjectTitle project={openProjectInfo} projects={projects} /> : t("app.projects")}
                </Truncated>
                <span className="chip shrink-0 whitespace-nowrap">{screen === "sessions"
                  ? t("app.sessions.count", { count: sessions.length })
                  : t("app.projects.count", { count: filtered.length })}</span>
                <div className="header-actions flex flex-1 min-w-0 items-center gap-2">
                <ProjectSearch query={query} onQuery={setQuery} searchRef={searchRef} onAdd={() => void addProject()}
                  onDown={() => {
                    if (screen === "sessions") setSessionIndex(0); else setProjectIndex(0);
                    (screen === "sessions" ? sessionListRef : projectListRef).current?.focus();
                  }} />
                <button
                  type="button"
                  className="btn shrink-0"
                  title={t("app.new.title")}
                  onClick={() => void startNew()}
                  disabled={screen === "sessions" ? !openProject : !project}
                >
                  {t("app.new")}
                </button>
                </div>
                </div>
                {/* Right: over the panel, its width plus the divider's, settings at its far end. */}
                <div
                  className={`flex shrink-0 items-center justify-end gap-2 ${tight ? "pr-2" : "pr-4"}`}
                  style={asidePx ? { width: asidePx + HEADER_DIVIDER_PX } : undefined}
                >
                <button ref={settingsButtonRef} type="button" className="btn" title={t("app.settings.title")} onClick={() => void openSettings()} aria-label={t("app.settings")}>
                  {tight ? "\u2699" : t("app.settings")}
                </button>
                </div>
              </div>
            </>
          )}
          {column ? null : (
            <>
              {/* The list scrolls here, where it takes the focus, so the pane inside it is not a
                  scroller Chromium would make a Tab stop of its own. */}
              <nav
                {...projectBox}
                className={`${navWidth ? "" : band ? "w-56" : "w-72"} col-start-1 row-span-full shrink-0 border-r border-ink-600 overflow-auto`}
                style={navWidth ? { width: navWidth } : undefined}
              >
                {projectPane}
              </nav>
              <div className="col-start-2 row-span-full flex">
                <Splitter
                  width={navWidth || (band ? 224 : 288)}
                  side="left"
                  min={NAV_MIN}
                  max={NAV_MAX}
                  onDrag={(width) => setNavFraction(windowWidth ? width / windowWidth : 0)}
                  onCommit={(width) => void api.saveUi({ navWidth: windowWidth ? width / windowWidth : 0 })}
                />
              </div>
            </>
          )}
          {screen === "settings" && settings ? null : (
            <>
              <div className="flex-1 min-h-0 flex">
                {column ? (
                  // Stacked: the project list, that project's sessions, and the graphs, one under
                  // the other — a tall narrow window has no room for panes side by side.
                  <div ref={stackRef} className="flex-1 min-w-0 flex flex-col">
                    <div
                      {...projectBox}
                      className={`${topHeight ? "" : "flex-1"} min-h-0 overflow-auto border-b border-ink-600`}
                      style={topHeight ? { height: topHeight } : undefined}
                    >
                      {projectPane}
                    </div>
                    <Splitter
                      width={topHeight || Math.round(stackHeight / 2)}
                      side="top"
                      min={STACK_MIN}
                      max={Math.max(STACK_MIN, stackHeight - STACK_MIN)}
                      onDrag={(height) => setStackFraction(stackHeight ? height / stackHeight : 0)}
                      onCommit={(height) => void api.saveUi({ stackTop: stackHeight ? height / stackHeight : 0 })}
                    />
                    <div {...sessionBox} data-testid="stack-sessions" className="flex-1 min-h-0 overflow-auto p-1 space-y-0.5">
                      {sessionRows}
                    </div>
                    {/* Too narrow for a column of its own: what changed, under the sessions. */}
                    {showPane && !fileColumn ? (
                      <>
                        <Splitter
                          width={paneHeight}
                          side="bottom"
                          min={STACK_PANE_MIN}
                          max={paneMax}
                          onDrag={(height) => setPaneFraction(height && stackHeight ? height / stackHeight : 0)}
                          onCommit={(height) => void api.saveUi({ stackPane: height && stackHeight ? height / stackHeight : 0 })}
                        />
                        <div data-testid="files-section" className="shrink-0 flex flex-col border-t border-ink-600" style={{ height: paneHeight }}>
                          {sidePane}
                        </div>
                      </>
                    ) : null}
                  </div>
                ) : (
                <div {...sessionBox} className={`flex-1 min-w-0 overflow-auto space-y-0.5 ${tight ? "p-1" : "p-2"}`}>
                  {sessionRows}
                </div>
                )}

                {column && fileColumn ? (
                  <>
                    <Splitter
                      width={asideWidth || 320}
                      side="right"
                      min={ASIDE_MIN}
                      max={ASIDE_MAX}
                      onDrag={(width) => setAsideFraction(windowWidth ? width / windowWidth : 0)}
                      onCommit={(width) => void api.saveUi({ asideWidth: windowWidth ? width / windowWidth : 0 })}
                    />
                    <aside
                      ref={asideRef}
                      data-testid="files-column"
                      className={`${asideWidth ? "" : "w-80"} shrink-0 border-l border-ink-600 flex flex-col`}
                      style={asideWidth ? { width: asideWidth } : undefined}
                    >
                      {sidePane}
                    </aside>
                  </>
                ) : null}
                {column ? null : (
                  <Splitter
                    width={asideWidth || (showDetail ? 320 : 208)}
                    side="right"
                    min={ASIDE_MIN}
                    max={ASIDE_MAX}
                    onDrag={(width) => setAsideFraction(windowWidth ? width / windowWidth : 0)}
                    onCommit={(width) => void api.saveUi({ asideWidth: windowWidth ? width / windowWidth : 0 })}
                  />
                )}
                {column ? null : showDetail ? (
                <aside
                  ref={asideRef}
                  className={`${asideWidth ? "" : "w-80"} shrink-0 border-l border-ink-600 flex flex-col`}
                  style={asideWidth ? { width: asideWidth } : undefined}
                >
                  {/* Three bands: what is selected, the folder, the gauges, each scrolling on its
                      own — with one scrollbar for the lot, the gauges left the screen. When the
                      window is short the details give way first: the folder keeps room for its tabs
                      and a few rows (at 620 px it was squeezed to nothing and the gauges were drawn
                      over its tabs), and the gauges keep theirs. */}
                  <div className="shrink min-h-0 max-h-[50%] overflow-auto">
                    {screen === "sessions" && session ? (
                      <SessionDetail session={session} />
                    ) : project ? (
                      <ProjectDetail project={project} worktrees={worktrees} />
                    ) : null}
                  </div>
                  {showPane ? (
                    <div data-testid="files-section" className="flex-1 min-h-[7.5rem] overflow-hidden flex flex-col border-t border-ink-600">
                      {sidePane}
                    </div>
                  ) : <div className="flex-1" />}

                  <div data-testid="aside-gauges" className="shrink-0 p-3 space-y-2 border-t border-ink-600">
                    <UsageGauges windows={usageWindows} />
                    {monitoring ? <MachineGauges wide /> : null}
                    <div className="text-[11px] text-bone-500">
                      {liveSessions.length === 0
                        ? t("app.noSessionRunning")
                        : liveSessions.length === 1
                          ? t("app.sessionRunning")
                          : t("app.sessionsRunning", { count: liveSessions.length })}
                    </div>
                  </div>
                </aside>
                ) : (
                  // Band and compact: the machine graphs stay — they are the reason to keep the
                  // window on screen — but with no detail panel behind them.
                  //
                  // A band is short, not narrow: four cards down a column ran off the bottom of a
                  // 320 px strip and the last two were only reachable by scrolling, which for a
                  // gauge is the same as not being drawn. Short means lay them across.
                  <aside
                    ref={asideRef}
                    className={`${asideWidth ? "" : band ? "w-80" : "w-52"} shrink-0 border-l border-ink-600 p-1 ${
                      band ? "flex flex-col gap-1 min-h-0" : "space-y-1 overflow-y-auto no-bar"}`}
                    style={asideWidth ? { width: asideWidth } : undefined}
                  >
                    {/* The row takes what is left and clips: a card is taller than a thin band
                        allows, and without the clip it ran out of the row and was drawn straight
                        through the running count below. */}
                    {band
                      ? <div className="flex-1 min-h-0 overflow-hidden flex items-start gap-1 [&>*]:min-w-0 [&>*]:flex-1">{machineCards}</div>
                      : machineCards}
                    <div data-testid="running-count" className={`text-[11px] text-bone-500 ${band ? "shrink-0 text-center" : ""}`}>
                      {liveSessions.length ? t("app.running", { count: liveSessions.length }) : t("app.running.none")}
                    </div>
                  </aside>
                )}
              </div>

              {/* Everything shares the strip and shrinks to fit: scrolling some of it out of
                  sight is the same as not showing it. */}
              {column && (monitoring || usageWindows.length > 0) ? (
                <div className="shrink-0 border-t border-ink-600 p-1 flex gap-1 [&>*]:min-w-0 [&>*]:flex-1">
                  <UsageGauges windows={usageWindows} compact />
                  {monitoring ? <MachineGauges compact /> : null}
                </div>
              ) : null}
            </>
          )}
        </main>
      </div>

      {dialog ? <Modal ask={dialog.ask} onDone={dialog.settle} /> : null}
      {prompting ? <UpdatePrompt state={updates.state} onAnswer={answerUpdate} /> : null}

      {toast ? (
        <div className={`absolute bottom-4 left-1/2 -translate-x-1/2 px-4 py-2 rounded-lg text-sm shadow-lg ${
          toast.tone === "ok" ? "bg-ink-700 text-bone-100" : "bg-bad/90 text-ink-900"}`}>
          {toast.text}
        </div>
      ) : null}
    </div>
  );
}
