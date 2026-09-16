/** What the page may ask about a project's folder: one directory at a time, and what git changed. */
import { invoke } from "../../bridge/contract.js";
import type { DirListing, FileStatus } from "../../core/fileTree.js";

export interface DirRequest {
  /** The project's folder. */
  cwd: string;
  /** Which directory inside it to read, from the root; "" is the root itself. */
  dir: string;
}

export interface ChangedFiles {
  items: { path: string; status: FileStatus }[];
  /** How many the cap left out. */
  hidden: number;
}

export const filesContract = {
  /** One directory's entries, sorted and capped, each with git's verdict. */
  listDir: invoke<DirRequest, DirListing>("files:list"),
  /** Only what git says changed — for a panel too narrow to draw a tree. */
  changedFiles: invoke<string, ChangedFiles>("files:changed"),
} as const;
