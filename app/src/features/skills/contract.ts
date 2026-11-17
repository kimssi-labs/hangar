/** The skills a project can use, and opening one's SKILL.md. */
import { invoke } from "../../bridge/contract.js";
import type { SkillGroup } from "../../core/skills.js";
import type { ActionResult } from "../../main/ipc.js";

/** Copy keeps the project's own; move takes it out of the project. */
export type PromoteMode = "copy" | "move";

export const skillsContract = {
  /** Every skill for this project folder (or none in particular, with null), grouped by where it lives. */
  listSkills: invoke<string | null, SkillGroup[]>("skills:list"),
  /** Open a SKILL.md the last list named, with whatever the machine opens Markdown with. */
  openSkill: invoke<string, ActionResult>("skills:open"),
  /** Make a project's own skill a global one, by copying or moving its folder into the user's skills. */
  promoteSkill: invoke<{ file: string; mode: PromoteMode }, ActionResult>("skills:promote"),
  /** Give a project's or the user's skill a new name: its folder and its SKILL.md's name. */
  renameSkill: invoke<{ file: string; name: string }, ActionResult>("skills:rename"),
  /** Send a project's or the user's skill to the recycle bin (a link: only the link goes). */
  deleteSkill: invoke<string, ActionResult>("skills:delete"),
} as const;
