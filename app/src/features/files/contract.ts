/** What the page may ask about a project's folder: one directory at a time, and what git changed. */
import { invoke } from "../../bridge/contract.js";
import type { DirListing, FileStatus } from "../../core/fileTree.js";
import type { ActionResult } from "../../main/ipc.js";

export interface DirRequest {
  /** The project's folder. */
  cwd: string;
  /** What inside it the request is about, from the root; "" is the root itself. */
  dir: string;
}

export interface ChangedFiles {
  items: { path: string; status: FileStatus }[];
  /** How many the cap left out. */
  hidden: number;
}

export interface RenameRequest {
  cwd: string;
  /** What to rename, from the project's root. */
  path: string;
  /** Its new name — a name, not a path. */
  name: string;
}

export interface MoveRequest {
  cwd: string;
  /** What to move, from the project's root. */
  path: string;
  /** The directory to move it into, from the project's root; "" is the root itself. */
  toDir: string;
}

export const filesContract = {
  /** One directory's entries, sorted and capped, each with git's verdict. */
  listDir: invoke<DirRequest, DirListing>("files:list"),
  /** Only what git says changed — for a panel too narrow to draw a tree. */
  changedFiles: invoke<string, ChangedFiles>("files:changed"),
  /** Hand one file to whatever the machine opens it with. */
  openFile: invoke<DirRequest, ActionResult>("files:open"),
  /** Show it in the machine's own file manager, selected. */
  revealFile: invoke<DirRequest, ActionResult>("files:reveal"),
  /** Give it a new name, in the folder it is already in. */
  renameFile: invoke<RenameRequest, ActionResult>("files:rename"),
  /** Move it into another folder of the same project — what a drag onto a folder does. */
  moveFile: invoke<MoveRequest, ActionResult>("files:move"),
  /** Put it in the machine's recycle bin, where it can be got back. */
  trashFile: invoke<DirRequest, ActionResult>("files:trash"),
} as const;
