/**
 * The two lists — projects and their sessions — and the detail panel beside them.
 *
 * A row is a row whichever list it is in: a live mark, a name, and the few numbers worth scanning.
 * Selection is a value passed in, not internal state, because the keyboard drives it.
 */
import { useEffect, useRef } from "react";

import { NOT_RUNNING, projectState, sessionMark, statusLabel } from "@core/sessionMark";
import type { ProjectInfo, SessionInfo } from "@core/types";

import { Sparkline } from "./Chart";
import { Truncated } from "./Truncated";
import { formatBytes, formatTime, sinceParts } from "../format";
import { useText } from "../useText";
import { gitTitle, type GitInfo } from "@core/git";
import { treeName, type Worktree } from "@core/worktree";
import { useSessionSamples } from "../../features/metrics/ui";

// How narrow a row has to be before its numbers drop to a second line is a container query on the
// row itself (index.css, `.row-figures`), not a measurement in here: a row that measured itself
// re-rendered on every frame of a divider drag, and drew its first frame in the wrong shape.

/**
 * The state for the pointer to rest on, in the language the window is in.
 *
 * One word, not two languages at once: `대기 중` in Korean, `idle` in English. A state this app has
 * no wording for — the registry may learn new ones — is shown exactly as it came.
 */
function stateTitle(state: string, t: ReturnType<typeof useText>): string {
  const key = `state.${state}`;
  const said = t(key as Parameters<typeof t>[0]);
  return said === key ? state : said;
}

/**
 * The mark of something answering right now: the running dot with a ring around it.
 *
 * It used to pulse. A pulse is an animation, and an animation that runs for as long as a session
 * works — hours — kept the compositor drawing at the display's refresh rate the whole time. A ring
 * says "busy" as plainly to a glance, and costs nothing once it is drawn.
 */
const BUSY_MARK = "bg-ok shadow-[0_0_6px] shadow-ok/60 outline outline-1 outline-offset-2 outline-ok/80";

/** A project's own mark: the busiest thing happening inside it. */
function ProjectMark({ project }: { project: ProjectInfo }) {
  const t = useText();
  const state = projectState(project.sessions);
  return (
    <span
      className={`w-2 h-2 rounded-full shrink-0 ${state === NOT_RUNNING
        ? "bg-ink-500"
        : state === "busy" ? BUSY_MARK : "bg-ok shadow-[0_0_6px] shadow-ok/60"}`}
      title={stateTitle(state, t)}
    />
  );
}

/** The bell a session rings when the answer is in and the turn is the person's. */
function Bell() {
  return (
    <svg viewBox="0 0 16 16" className="w-3 h-3 shrink-0 text-warn" fill="currentColor" aria-hidden="true">
      <path d="M8 1.5a.9.9 0 0 1 .9.9v.4a4 4 0 0 1 3.1 3.9v2.2l1 1.6a.6.6 0 0 1-.5.9H3.5a.6.6 0 0 1-.5-.9l1-1.6V6.7a4 4 0 0 1 3.1-3.9v-.4a.9.9 0 0 1 .9-.9zM6.4 12.2h3.2a1.6 1.6 0 0 1-3.2 0z" />
    </svg>
  );
}

/**
 * What the session is doing, before its name.
 *
 * A ringed dot while it is answering, so a glance says something is happening, and a bell once
 * the turn is the person's, whether Claude Code finished or stopped to ask something. A session that
 * is not running shows the quiet dot it always did: it is a transcript, waiting for nobody.
 */
function StatusMark({ session }: { session: SessionInfo }) {
  const t = useText();
  const mark = sessionMark(session.live, session.status);
  const label = stateTitle(statusLabel(session.live, session.status), t);
  if (mark === "turn") return <span title={label}><Bell /></span>;
  return (
    <span
      className={`w-2 h-2 rounded-full shrink-0 ${mark === "working" ? BUSY_MARK : "bg-ink-500"}`}
      title={label}
    />
  );
}

/** The mark of a pinned row: a pushpin, drawn rather than an emoji so it takes the theme's colour. */
function Pin() {
  const t = useText();
  return (
    <svg viewBox="0 0 16 16" className="w-3 h-3 shrink-0 text-accent" fill="currentColor" aria-label={t("list.pinned")} role="img">
      <path d="M9.6 1.2 14.8 6.4l-1.9.5-2.5 2.5.4 3.2-1.2 1.2-3-3-4 4-.9-.9 4-4-3-3 1.2-1.2 3.2.4 2.5-2.5z" />
    </svg>
  );
}

/**
 * The mark of a worktree: a fork, drawn like the pin, in git's own colour (the `tree` token) rather
 * than the orange a pin or a selection wears.
 */
function Fork({ className = "w-3 h-3 shrink-0" }: { className?: string }) {
  const t = useText();
  return (
    <svg viewBox="0 0 16 16" className={`${className} text-tree`} fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" aria-label={t("list.worktree")} role="img">
      <path d="M4 1.5v4a4 4 0 0 0 8 0v-4M8 9.5V15" />
    </svg>
  );
}

/** The branch on a repository's line: the fork's colour and weight, git's usual drawing. */
function BranchMark() {
  return (
    <svg viewBox="0 0 16 16" className="w-3 h-3 shrink-0 text-tree" fill="none" stroke="currentColor"
      strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      <circle cx="4.5" cy="3.5" r="1.75" />
      <circle cx="4.5" cy="12.5" r="1.75" />
      <circle cx="11.5" cy="4.5" r="1.75" />
      <path d="M4.5 5.25v5.5M11.5 6.25c0 3-7 2-7 4.5" />
    </svg>
  );
}

/**
 * A worktree's branch beside its name, in brackets: `app [feature/x]`. A worktree is called by its
 * repository, so the branch is what tells it from the repository's own row and from the worktrees
 * beside it. A repository's own branch keeps its line under the path (GitLine).
 *
 * It keeps up to 60% of the name line, so a narrow list cuts the name first; the repository's row
 * above says it anyway. Only the branch itself is cut, inside brackets that stay.
 */
function Branch({ git }: { git: GitInfo }) {
  const t = useText();
  return (
    <span className="inline-flex max-w-[60%] shrink-0 text-xs text-tree" data-testid="project-branch">
      [<span className="truncate" title={gitTitle(git, t)}>
        {git.detached ? `${git.head} ${t("list.detached")}` : git.head}
      </span>]
    </span>
  );
}

/**
 * What is uncommitted, once something counted it: the selected project's own request, or the file
 * panel's. No row asks for its own count.
 */
function Uncommitted({ git }: { git: GitInfo }) {
  const t = useText();
  return git.dirty ? <span className="tree-chip" title={gitTitle(git, t)}>●{git.dirty}</span> : null;
}

/** A repository row's count of the worktrees listed under it: the fork, and how many. */
function TreeCount({ count }: { count: number }) {
  const t = useText();
  return <span className="tree-chip" title={t("list.trees", { count })}><Fork />{count}</span>;
}

/**
 * The repository line: the branch, and what is uncommitted. Only the branch gives way when the row
 * is narrow, so a docked band still shows the mark and the count beside whatever fits of the name.
 */
function GitLine({ git }: { git: GitInfo }) {
  const t = useText();
  return (
    <div className="flex items-center gap-1 text-[11px] text-bone-400" title={gitTitle(git, t)} data-testid="project-git">
      <BranchMark />
      <span className="truncate">{git.detached ? `${git.head} ${t("list.detached")}` : git.head}</span>
      <Uncommitted git={git} />
    </div>
  );
}

/**
 * A project's name in the sessions screen's top bar. A worktree reads the way its row does,
 * `⑂ <repository> [<branch>]`: there is no row above it there to say which repository it belongs to.
 * A line of its own, so the name gives way before the branch here too.
 */
export function ProjectTitle({ project, projects }: { project: ProjectInfo; projects: ProjectInfo[] }) {
  if (!project.worktree) return <>{project.name}</>;
  const parent = project.parentDir ? projects.find((p) => p.dir === project.parentDir) : undefined;
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <Fork className="w-3.5 h-3.5 shrink-0" />
      <Truncated as="span">{treeName(project, parent?.name ?? null)}</Truncated>
      {project.git ? <Branch git={project.git} /> : null}
    </span>
  );
}

/** "3 min ago" in whichever language the window is in, or a date once that stops meaning much. */
function since(t: ReturnType<typeof useText>, ms: number): string {
  const { key, vars } = sinceParts(ms);
  return key === "since.absolute" ? formatTime(ms) : t(key, vars as Record<string, number>);
}

/**
 * How long a clicked row waits before the list moves to show all of it: Windows' default
 * double-click time. A click selects, and moving the list then put a different row under the second
 * click of a double-click (measured: scrollTop 308 -> 286 in a band-width window), so the open went
 * to the wrong row; once a second click can no longer make a double-click, the list may move.
 */
const DOUBLE_CLICK_MS = 500;

/** When the pointer last pressed a row: a selection made within the double-click time is a click's. */
let pressedAt = -Infinity;

export function notePointerSelect(): void {
  pressedAt = performance.now();
}

/**
 * Whether the list the row scrolls in cuts any of it off — the nearest box with more in it than it
 * shows, which for the project list is the list itself rather than the pane inside it.
 */
function clipped(row: HTMLElement): boolean {
  let list = row.parentElement;
  while (list && list.scrollHeight <= list.clientHeight) list = list.parentElement;
  if (!list) return false;
  const shown = list.getBoundingClientRect();
  const box = row.getBoundingClientRect();
  return box.top < shown.top || box.bottom > shown.bottom;
}

/**
 * Keeps the selected row whole on screen: at once when the keyboard selected it, and after the
 * double-click time when a click did — smoothly, and only if the list cuts it off and it is still the
 * selected, mounted row by then.
 */
function useScrollIntoView(selected: boolean): React.RefObject<HTMLDivElement> {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const row = ref.current;
    if (!selected || !row) return;
    if (performance.now() - pressedAt > DOUBLE_CLICK_MS) {
      row.scrollIntoView({ block: "nearest" });
      return;
    }
    const timer = setTimeout(() => {
      if (clipped(row)) row.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }, DOUBLE_CLICK_MS);
    return () => clearTimeout(timer);
  }, [selected]);
  return ref;
}

/** The ids the rows carry, which their list's `aria-activedescendant` names for the selected one. */
export const projectRowId = (dir: string): string => `project-${dir}`;
export const sessionRowId = (id: string): string => `session-${id}`;

export function ProjectRow({
  project, selected, depth = 0, parent = null, trees = 0, matched = null, onSelect, onOpen, onContextMenu,
}: {
  project: ProjectInfo;
  selected: boolean;
  /** 1 for a worktree shown under the repository it belongs to. */
  depth?: number;
  /** That repository's row, when the worktree is shown under it. */
  parent?: ProjectInfo | null;
  /** How many worktrees are shown under this row. */
  trees?: number;
  /** While searching: how many of its sessions match, which is what the preview beside it lists. */
  matched?: number | null;
  onSelect: () => void;
  onOpen: () => void;
  onContextMenu?: () => void;
}) {
  const t = useText();
  const ref = useScrollIntoView(selected);
  const { git } = project;
  // A worktree goes by its repository, its branch beside the name: its folder, `<repo>-<branch>`,
  // would say the branch twice and lose it first to a narrow list.
  const name = project.worktree ? treeName(project, parent?.name ?? null) : project.name;
  return (
    <div
      ref={ref}
      id={projectRowId(project.dir)}
      role="option"
      aria-selected={selected}
      className={`row ${selected ? "row-selected" : "hover:bg-ink-700/60"}`}
      style={depth ? { marginLeft: depth * 14 } : undefined}
      onMouseDown={notePointerSelect}
      onClick={onSelect}
      onDoubleClick={onOpen}
      onContextMenu={(event) => { event.preventDefault(); onContextMenu?.(); }}
    >
      {/* A rule down the left, in git's colour, so an indented row reads as part of the one above. */}
      {depth ? <span className="self-stretch w-px bg-tree/70 shrink-0" aria-hidden="true" /> : null}
      <ProjectMark project={project} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {project.pinned ? <Pin /> : null}
          {project.worktree ? <Fork /> : null}
          <Truncated
            as="span"
            testId="project-name"
            // A worktree's folder name stays findable: first in its tooltip, above the path.
            title={project.worktree && project.cwd
              ? `${project.cwd.split(/[\\/]/).pop()}\n${project.cwd}`
              : project.cwd ?? project.dir}
            className={`text-sm ${project.exists ? "text-bone-100" : "text-bad"}`}
          >
            {name}
          </Truncated>
          {project.worktree && git ? <Branch git={git} /> : null}
          {project.worktree && git ? <Uncommitted git={git} /> : null}
          {/* No memory mark here: Claude Code makes a memory folder for every project, so it marked
              every row with a session. The detail panel and the delete question still say it. */}
          {trees ? <TreeCount count={trees} /> : null}
        </div>
        <Truncated className="text-[11px] text-bone-500">{project.cwd ?? t("list.folderUnknown")}</Truncated>
        {/* One line, and only where there is a repository: the branch is the thing you check before
            resuming a session, and opening a terminal to find it out is the friction this removes.
            A worktree says its branch beside its name already, with its count. */}
        {git && !project.worktree ? <GitLine git={git} /> : null}
      </div>
      <div className="row-figures">
        {matched === null
          ? <div>{t("list.sessions", { count: project.sessions.length })}</div>
          : <div data-testid="session-matches" className={matched ? "text-accent" : ""}>{t("list.matches", { count: matched, total: project.sessions.length })}</div>}
        <div>{since(t, project.lastUsed)}</div>
      </div>
    </div>
  );
}

export function SessionRow({
  session, selected, onSelect, onOpen, onContextMenu,
}: {
  session: SessionInfo;
  selected: boolean;
  onSelect: () => void;
  onOpen: () => void;
  onContextMenu?: () => void;
}) {
  const t = useText();
  const ref = useScrollIntoView(selected);
  return (
    <div
      ref={ref}
      id={sessionRowId(session.id)}
      role="option"
      aria-selected={selected}
      className={`row ${session.live ? "row-live" : "row-session"} ${selected ? "row-selected" : "hover:bg-ink-700/60"}`}
      onMouseDown={notePointerSelect}
      onClick={onSelect}
      onDoubleClick={onOpen}
      onContextMenu={(event) => { event.preventDefault(); onContextMenu?.(); }}
    >
      <StatusMark session={session} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          {session.pinned ? <Pin /> : null}
          <Truncated as="span" className="text-sm text-bone-100">{session.title}</Truncated>
        </div>
        <Truncated className="text-[11px] text-bone-500">
          {session.named && session.prompt ? session.prompt : session.id}
        </Truncated>
      </div>
      {session.live ? <RowUsage sessionId={session.id} /> : null}
      <div className="row-figures">
        <div>{formatBytes(session.bytes)}</div>
        <div>{formatTime(session.modifiedAt)}</div>
      </div>
    </div>
  );
}

/**
 * A live row's CPU and memory, subscribed on its own: a sample re-renders these two readings, not
 * the row, the list or the window around them.
 */
function RowUsage({ sessionId }: { sessionId: string }) {
  const t = useText();
  const samples = useSessionSamples(sessionId);
  const latest = samples[samples.length - 1] ?? null;
  return (
    // CPU and memory are different questions, so each gets its own line and its own number.
    <div className="row-usage flex items-center gap-3 shrink-0">
      <span className="flex items-center gap-1.5" title={t("tip.rowCpu")}>
        <Sparkline samples={samples} field="cpu" className="w-16" />
        <span className="text-[11px] text-bone-400 tabular-nums">
          {latest ? `${latest.cpu.toFixed(0)}%` : "—"}
        </span>
      </span>
      <span className="flex items-center gap-1.5" title={t("tip.rowMemory")}>
        <Sparkline samples={samples} field="memoryBytes" className="w-16" />
        <span className="text-[11px] text-bone-400 tabular-nums">
          {latest ? formatBytes(latest.memoryBytes) : "—"}
        </span>
      </span>
    </div>
  );
}

function Field({ label, children, tone = "" }: { label: string; children: React.ReactNode; tone?: string }) {
  // Stacked, not two columns: the panel is narrow, and a value column that narrow turns a path
  // into one character per line. The label reads as a caption above its value instead.
  return (
    <div className="py-1 text-xs">
      <div className="text-[11px] text-bone-500">{label}</div>
      <div className={`break-all ${tone || "text-bone-200"}`}>{children}</div>
    </div>
  );
}

export function ProjectDetail({ project, worktrees = [] }: {
  project: ProjectInfo;
  /** Every checkout of this project's repository, the main one included. */
  worktrees?: Worktree[];
}) {
  const t = useText();
  return (
    <div className="p-4">
      <h2 className="text-sm font-medium text-bone-100 mb-2">{project.name}</h2>
      {project.alias ? <Field label={t("detail.folderName")}>{project.cwd?.split(/[\\/]/).pop()}</Field> : null}
      <Field label={t("detail.path")} tone={project.exists ? "" : "text-bad"}>
        {project.cwd ?? t("detail.pathUnknown")}
        {project.cwd && !project.exists ? t("detail.folderGone") : ""}
      </Field>
      <Field label={t("detail.sessions")}>
        {project.sessions.length}
        {project.liveCount ? ` · ${t("app.running", { count: project.liveCount })}` : ""}
        {project.sessions.length ? ` · ${formatBytes(project.totalBytes)}` : ""}
      </Field>
      {project.git ? (
        <Field label={t("detail.git")}>{gitTitle(project.git, t).replace(/^Git: /, "")}</Field>
      ) : null}
      <Field label={t("detail.lastUsed")}>{formatTime(project.lastUsed)}</Field>
      <Field label={t("detail.memory")} tone={project.hasMemory ? "text-warn" : ""}>
        {project.hasMemory ? t("detail.memory.yes") : t("detail.memory.no")}
      </Field>
      <Field label={t("detail.directory")}>{project.dir}</Field>
      {/* Only worth a section when there is more than the repository's own checkout. */}
      {worktrees.length > 1 ? (
        <Field label={t("detail.worktrees")}>
          <div className="space-y-1">
            {worktrees.map((tree) => (
              <div key={tree.path} className="leading-tight">
                <span className={tree.path === project.cwd ? "text-accent" : "text-bone-200"}>
                  {tree.branch ?? tree.head.slice(0, 7)}
                </span>
                {tree.path === project.cwd ? (
                  <span className="text-bone-500"> · {t("detail.worktreeHere")}</span>
                ) : null}
                <div className="text-[11px] text-bone-500 break-all">{tree.path}</div>
              </div>
            ))}
          </div>
        </Field>
      ) : null}
    </div>
  );
}

/** The detail panel's one live line, subscribed on its own like a row's readings. */
function SessionUsing({ sessionId }: { sessionId: string }) {
  const t = useText();
  const samples = useSessionSamples(sessionId);
  const latest = samples[samples.length - 1];
  return latest ? (
    <Field label={t("detail.using")}>{`${latest.cpu.toFixed(0)}% CPU · ${formatBytes(latest.memoryBytes)}`}</Field>
  ) : null;
}

export function SessionDetail({ session }: { session: SessionInfo }) {
  const t = useText();
  return (
    <div className="p-4">
      <h2 className="text-sm font-medium text-bone-100 mb-2">{session.title}</h2>
      <Field label={t("detail.titleFrom")}>{session.named ? t("detail.titleFrom.named") : t("detail.titleFrom.prompt")}</Field>
      {session.named && session.prompt ? <Field label={t("detail.firstPrompt")}>{session.prompt}</Field> : null}
      <Field label={t("detail.id")}>{session.id}</Field>
      <Field label={t("detail.started")}>{formatTime(session.startedAt)}</Field>
      <Field label={t("detail.lastWritten")}>{formatTime(session.modifiedAt)}</Field>
      <Field label={t("detail.transcript")}>{formatBytes(session.bytes)}</Field>
      <Field label={t("detail.state")} tone={session.live ? "text-ok" : ""}>
        {session.live ? t("detail.state.running", { pid: String(session.pid) }) : t("detail.state.idle")}
      </Field>
      {session.continues ? <Field label={t("detail.continues")}>{t("detail.continues.value", { count: session.continues })}</Field> : null}
      {session.live ? <SessionUsing sessionId={session.id} /> : null}
      <Field label={t("detail.file")}>{session.file}</Field>
    </div>
  );
}
