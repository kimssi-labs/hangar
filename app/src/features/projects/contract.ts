/** What the page may ask about projects and their sessions: the list, and what is done to a row. */
import { event, invoke } from "../../bridge/contract.js";
import type { RestorableSession } from "../../core/openSessions.js";
import type { ProjectInfo } from "../../core/types.js";
import type { ActionResult, AddProjectResult } from "../../main/ipc.js";

export interface OpenSessionRequest {
  projectDir: string;
  sessionId: string | null;
  target: "sessionsWindow" | "currentWindow" | "newWindow";
  /** The window asked and the user agreed: stop the process running this session and resume it here. */
  takeOver?: boolean;
}

/** How opening went. `background` is a running session with no window to show, for the page to ask about. */
export interface OpenSessionResult extends ActionResult {
  background?: { pid: number; title: string; busy: boolean };
}

export interface RenameRequest {
  projectDir: string;
  sessionId?: string;
  title: string;
}

export interface DeleteRequest {
  projectDir: string;
  sessionId?: string;
}

export interface PinRequest {
  kind: "projects" | "sessions";
  key: string;
}

/**
 * A scan's answer. `projects` is left out when the list is the same as the one `signature` was
 * last handed out for — the page passes that signature back and keeps the rows it already has.
 */
export interface ScanAnswer {
  signature: string;
  projects?: ProjectInfo[];
}

/** A session running in a terminal, as the question on closing Hangar names it. */
export interface ClosingSession { sessionId: string; title: string; busy: boolean }

/** What to do with the running sessions when Hangar closes. */
export type CloseChoice = "all" | "hangar" | "cancel";

export const projectsContract = {
  /** Every project with its sessions, read again from disk. Pass the last signature, or null for the full list. */
  scan: invoke<string | null, ScanAnswer>("projects:scan"),
  /** Start or resume a session in a terminal. */
  openSession: invoke<OpenSessionRequest, OpenSessionResult>("session:open"),
  renameSession: invoke<RenameRequest, ActionResult>("session:rename"),
  renameProject: invoke<RenameRequest, ActionResult>("project:rename"),
  deleteSession: invoke<DeleteRequest, ActionResult>("session:delete"),
  deleteProject: invoke<DeleteRequest, ActionResult>("project:delete"),
  /** Show the project's folder in the file manager. */
  revealProject: invoke<string, ActionResult>("project:reveal"),
  /** Opens the folder picker; resolves with the new project's dir, or ok:false when nothing was chosen. */
  addProject: invoke<void, AddProjectResult>("project:add"),
  togglePin: invoke<PinRequest, ActionResult>("pin:toggle"),
  /** The sessions the last run had open that are not running now, asked once a run at most. */
  restorable: invoke<void, RestorableSession[]>("sessions:restorable"),
  /** Open them all again (true), or let them go (false); either way they are not offered again this run. */
  restoreSessions: invoke<boolean, ActionResult>("sessions:restore"),
  /** Hangar is being closed while sessions run: the page asks what to do with them. */
  onClosing: event<ClosingSession[]>("app:closing"),
  /** The answer: close them too (kept for the next start), close Hangar alone, or stay open. */
  answerClosing: invoke<CloseChoice, ActionResult>("app:closing-answer"),
} as const;
