/**
 * Projects and sessions — the main side.
 *
 * Owns the list every other feature reads — the last scan — and everything done to a row: opening
 * a session in a terminal, renaming, deleting, pinning, adding a folder. Reading Claude Code's
 * folders and building the launch command live in `core`; this is where they meet Electron.
 *
 * Nothing here reaches into another feature. The head line on each row comes from `main/gitStatus`,
 * a plain module; whoever measures the running set is told it may have changed and looks itself.
 */
import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { dialog, shell } from "electron";

import type { Wire } from "../../bridge/build.js";
import type { MainContext } from "../../bridge/context.js";
import { launchCommand, sessionEnvironment, WT_EXE } from "../../core/launcher.js";
import { OpenSessions, restorable } from "../../core/openSessions.js";
import { sessionPrompt } from "../../core/sessionPrompt.js";
import type { OpenTarget, ProjectInfo, SessionInfo } from "../../core/types.js";
import { claudeExecutable, detectLinuxTerminal, which } from "../../main/executables.js";
import { helperExecutable, helpersDir } from "../../main/helpers.js";
import { FOCUS_HELPER, focusSession, stopSession } from "../../main/liveSession.js";
import type { ActionResult, AddProjectResult } from "../../main/ipc.js";
import type { SessionTarget } from "../../main/sampler.js";
import { projectsContract, type OpenSessionResult, type ScanAnswer } from "./contract.js";
import { scanHost } from "./scanHost.js";

/**
 * How long one reopened session is given before the next is started. Each one into the sessions
 * window: started together, Windows Terminal can open the named window more than once.
 */
const RESTORE_GAP_MS = 1_500;
/** A scan slower than this is worth a line in the log. */
const SLOW_SCAN_MS = 200;
/** How long after start-up the focus helper is built, so the first double-click on a running session does not wait for it. */
const HELPER_WARMUP_MS = 10_000;

/** What this feature needs from the rest of main. */
export interface ProjectsDeps {
  /** The list was read again; whoever watches the running set should look at it. */
  scanned(): void;
}

/** What the rest of main may do with this feature once it is registered. */
export interface ProjectsFeature {
  /** Read everything again, off the main thread. The list handed back is the one every later answer is about. */
  scan(): Promise<ProjectInfo[]>;
  /** Note a session that changed hands, where the scan runs (scanHost.ts). */
  watchRegistry(): void;
  find(dir: string): ProjectInfo | undefined;
  /** Sessions worth measuring right now: the running ones, from the last scan. */
  liveTargets(): SessionTarget[];
}

export function register(ctx: MainContext, wire: Wire, deps: ProjectsDeps): ProjectsFeature {
  let projects: ProjectInfo[] = [];
  // Built once per version, a few seconds of compiler time: off the start-up path, before anyone asks.
  if (process.platform === "win32") setTimeout(() => void helperExecutable(helpersDir(), FOCUS_HELPER), HELPER_WARMUP_MS).unref();

  const find = (dir: string): ProjectInfo | undefined => projects.find((p) => p.dir === dir);
  /** The scan runs on a worker (scanHost.ts); what is kept here is its last answer. */
  /** The sessions running as the registry is watched, kept so the next start can offer them again. */
  const openSessions = new OpenSessions(ctx.store.paths.hangarOpenSessions);
  /** The last run's sessions, until they are reopened or let go: offered once a run. */
  let offer: string[] = openSessions.before;
  const host = scanHost(ctx.store, ctx.config, (live) => openSessions.observe(live));
  let signature = "";

  async function scan(): Promise<ProjectInfo[]> {
    const result = await host.scan();
    projects = result.projects;
    signature = result.signature;
    if (result.ms > SLOW_SCAN_MS) console.log(`[hangar] scan took ${result.ms} ms for ${projects.length} projects`);
    deps.scanned();                                 // the running set may have changed
    return projects;
  }

  /**
   * The list for the page — or only its signature, when it is the one the page already holds.
   *
   * The page asks every fifteen seconds and the list rarely changes between two asks; sending it
   * anyway cloned every row across the process boundary and re-ran everything drawn from it.
   */
  async function answer(since: string | null): Promise<ScanAnswer> {
    const list = await scan();
    return signature === since ? { signature } : { signature, projects: list };
  }

  /** Start a session — `session` resumed, or a new one when null — in a terminal, as Settings says. */
  function start(project: ProjectInfo, session: SessionInfo | null, target: OpenTarget, exe: string): OpenSessionResult {
    const launch = ctx.config.launch();
    const command = launchCommand({
      cwd: project.cwd as string,
      claudeExe: exe,
      sessionId: session?.id ?? null,
      // Only a name the user chose. --name is persisted as a *custom* title, so passing the title
      // this app happens to be showing overwrites the one Claude Code generated — permanently, in
      // its own tab and /resume picker too. Left alone, it keeps refining that title as the
      // conversation grows, and this app now reads it rather than competing with it. The same
      // name titles the tab; an unnamed session's tab is Claude Code's to name.
      displayName: session?.named ? session.title : null,
      appendPrompt: launch.fileLinks ? sessionPrompt(process.platform) : null,
      config: launch,
      target,
      platform: process.platform,
      hasWindowsTerminal: process.platform === "win32" && Boolean(which(WT_EXE)),
      linuxTerminal: process.platform === "win32" ? null : detectLinuxTerminal(launch.terminal),
    }, (exe) => Boolean(which(exe)));
    try {
      const child = spawn(command.exe, command.args, {
        cwd: command.cwd,
        // Not process.env as it is: started from inside a Claude Code session, this app carries that
        // session's markers, and a claude that inherits them stops saving its transcript.
        env: sessionEnvironment(process.env),
        detached: true,
        stdio: "ignore",
        // Without a terminal of its own the shell needs a console window to appear in.
        windowsHide: false,
        shell: false,
      });
      child.unref();
      const what = session ? session.title : project.name;
      return {
        ok: true,
        message: command.fellBack
          ? `Opened ${what} in ${command.shell} — the shell chosen in Settings is not installed here.`
          : `Opened ${what}`,
      };
    } catch (error) {
      return { ok: false, message: `Could not start: ${(error as Error).message}` };
    }
  }

  wire.bind(projectsContract, {
    scan: (since) => answer(since ?? null),

    openSession: async (request): Promise<OpenSessionResult> => {
      const project = find(request.projectDir);
      if (!project?.cwd) return { ok: false, message: "That project's folder is unknown." };
      if (!project.exists) return { ok: false, message: `Folder is gone: ${project.cwd}` };
      const exe = claudeExecutable();
      if (!exe) return { ok: false, message: "claude is not on PATH — install Claude Code first." };
      const session = request.sessionId ? project.sessions.find((s) => s.id === request.sessionId) : null;
      if (session?.live && session.pid) {
        // Running already: a double-click means "show me", not "start another". The window it lives
        // in is raised — its tab selected, in Windows Terminal — and nothing is launched. A session
        // with no window to show is handed back for the page to ask about; only with the answer does
        // its process end and the session resume here.
        if (!request.takeOver) {
          const focus = await focusSession(session.pid, helpersDir());
          if (focus.found) return { ok: true, message: focus.tab ? `Switched to ${session.title}.` : `Brought ${session.title} to the front.` };
          if (process.platform !== "win32") return { ok: false, message: "That session is already running." };
          return {
            ok: false,
            message: "That session is running without a window.",
            background: { pid: session.pid, title: session.title, busy: ctx.store.sessionStatus(session.pid) === "busy" },
          };
        }
        if (!stopSession(session.pid)) return { ok: false, message: `Could not stop the running session (pid ${session.pid}).` };
      }

      return start(project, session ?? null, request.target, exe);
    },

    renameSession: async (request): Promise<ActionResult> => {
      const project = find(request.projectDir);
      const session = project?.sessions.find((s) => s.id === request.sessionId);
      if (!session) return { ok: false, message: "Session not found." };
      ctx.store.renameSession(session, request.title);
      await scan();
      return { ok: true };
    },

    renameProject: async (request): Promise<ActionResult> => {
      const project = find(request.projectDir);
      if (!project) return { ok: false, message: "Project not found." };
      ctx.store.renameProject(project, request.title);
      await scan();
      return { ok: true };
    },

    // The window asks first, in its own dialog; nothing reaches these without that answer.
    deleteSession: async (request): Promise<ActionResult> => {
      const project = find(request.projectDir);
      const session = project?.sessions.find((s) => s.id === request.sessionId);
      if (!session) return { ok: false, message: "Session not found." };
      if (session.live) return { ok: false, message: "That session is running." };
      ctx.store.deleteSession(session);
      await scan();
      return { ok: true, message: "Session deleted." };
    },

    deleteProject: async (request): Promise<ActionResult> => {
      const project = find(request.projectDir);
      if (!project) return { ok: false, message: "Project not found." };
      if (project.liveCount) return { ok: false, message: "A session in this project is running." };
      ctx.store.deleteProject(project);
      await scan();
      return { ok: true, message: "Project deleted." };
    },

    revealProject: (dir): ActionResult => {
      const project = find(dir);
      if (!project?.cwd || !project.exists) return { ok: false, message: "Folder is not available." };
      void shell.openPath(project.cwd);
      return { ok: true };
    },

    /**
     * A folder chosen in a dialog becomes a project — one with no sessions yet, from which the
     * first can be started. Until now the only way in was to run claude in a terminal there first.
     */
    addProject: async (): Promise<AddProjectResult> => {
      const window = ctx.window();
      if (!window) return { ok: false };
      // Electron 43 changed the default starting folder from "wherever you were last" to Downloads,
      // which is nowhere near where anyone keeps code. Start beside the project used most recently
      // instead — the list is newest first, so that is the first row with a folder still on disk.
      const recent = projects.find((p) => p.cwd && p.exists)?.cwd;
      const picked = await dialog.showOpenDialog(window, {
        title: "Add a project folder",
        properties: ["openDirectory", "createDirectory"],
        ...(recent ? { defaultPath: dirname(recent) } : {}),
      });
      const folder = picked.filePaths[0];
      if (picked.canceled || !folder) return { ok: false };
      const dir = ctx.store.addProject(folder);
      await scan();
      return { ok: true, dir, message: `Added ${folder}` };
    },

    restorable: () => restorable(offer, projects),

    restoreSessions: async (open): Promise<ActionResult> => {
      const wanted = restorable(offer, projects);
      if (!open) openSessions.forget(offer);
      offer = [];
      if (!open || !wanted.length) return { ok: true };
      const exe = claudeExecutable();
      if (!exe) return { ok: false, message: "claude is not on PATH — install Claude Code first." };
      let opened = 0;
      for (const [index, item] of wanted.entries()) {
        const project = find(item.projectDir);
        const session = project?.sessions.find((s) => s.id === item.sessionId);
        if (!project?.cwd || !project.exists || !session) continue;
        if (index > 0) await new Promise((resolve) => setTimeout(resolve, RESTORE_GAP_MS));
        if (start(project, session, "sessionsWindow", exe).ok) opened += 1;
      }
      return opened === wanted.length
        ? { ok: true, message: `Reopened ${opened} session${opened === 1 ? "" : "s"}.` }
        : { ok: false, message: `Reopened ${opened} of ${wanted.length} sessions.` };
    },

    togglePin: async (request): Promise<ActionResult> => {
      const pinned = ctx.config.togglePin(request.kind, request.key);
      await scan();
      return { ok: true, message: pinned ? "Pinned to the top." : "Unpinned." };
    },
  });

  return {
    scan,
    watchRegistry: host.watchRegistry,
    find,
    liveTargets: () => projects.flatMap((project) =>
      project.sessions.filter((s) => s.live && s.pid).map((s) => ({ sessionId: s.id, pid: s.pid as number }))),
  };
}
