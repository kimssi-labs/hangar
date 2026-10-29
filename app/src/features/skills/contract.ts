/** The skills a project can use, and opening one's SKILL.md. */
import { invoke } from "../../bridge/contract.js";
import type { SkillGroup } from "../../core/skills.js";
import type { ActionResult } from "../../main/ipc.js";

export const skillsContract = {
  /** Every skill for this project folder (or none in particular, with null), grouped by where it lives. */
  listSkills: invoke<string | null, SkillGroup[]>("skills:list"),
  /** Open a SKILL.md the last list named, with whatever the machine opens Markdown with. */
  openSkill: invoke<string, ActionResult>("skills:open"),
} as const;
