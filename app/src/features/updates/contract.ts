/** What the page may ask of the updater, and what the updater tells it. */
import { event, invoke } from "../../bridge/contract.js";
import type { UpdateState } from "../../core/updates.js";

/** What the page can ask of the updater: one step, or "now" — fetch it if need be, then restart into it. */
export type UpdateCommand = "check" | "download" | "install" | "now";

export const updatesContract = {
  /** Check, download, or restart into what was downloaded. Answers with the state as it stands. */
  updateAction: invoke<UpdateCommand, UpdateState>("update:action"),
  /** A check or a download moved on. */
  onUpdate: event<UpdateState>("update:push"),
} as const;
