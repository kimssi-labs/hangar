/**
 * Skills — the main side: finding the folders Claude Code reads skills from (core/skills.ts reads
 * each SKILL.md). Disk only, nothing cached: a list is a few dozen small reads, and a skill added a
 * minute ago should be there the next time the tab is opened.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { shell } from "electron";

import type { Wire } from "../../bridge/build.js";
import { homePaths } from "../../core/paths.js";
import { enabledPlugins, parseSkill, pluginInstalls, sameDir, type SkillGroup, type SkillInfo, sortSkills } from "../../core/skills.js";
import { readStatusJson } from "../../core/status.js";
import type { ActionResult } from "../../main/ipc.js";
import { skillsContract } from "./contract.js";

/** Every `<dir>/<skill>/SKILL.md` that names itself; `prefix` makes `plugin:name`. */
function skillsIn(dir: string, prefix = ""): SkillInfo[] {
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return sortSkills(names.flatMap((name) => {
    const file = join(dir, name, "SKILL.md");
    try {
      const parsed = parseSkill(readFileSync(file, "utf8"));
      return parsed ? [{ ...parsed, command: prefix + parsed.name, file }] : [];
    } catch {
      return [];                                     // not a skill folder, or unreadable: not listed
    }
  }));
}

function listSkills(cwd: string | null): SkillGroup[] {
  const paths = homePaths();
  const groups: SkillGroup[] = [];
  // Always a project group once a project is picked, empty or not, so the page can say "none here".
  // A project at the home folder has the user's skills as its own `.claude/skills`: those are the
  // global ones, listed once, under global.
  const projectDir = cwd ? join(cwd, ".claude", "skills") : null;
  if (projectDir) {
    const own = sameDir(projectDir, paths.skills, process.platform === "win32") ? [] : skillsIn(projectDir);
    groups.push({ source: "project", plugin: "", skills: own });
  }
  groups.push({ source: "user", plugin: "", skills: skillsIn(paths.skills) });
  const enabled = enabledPlugins(readStatusJson<unknown>(paths.settings, null));
  for (const { plugin, path } of pluginInstalls(readStatusJson<unknown>(paths.installedPlugins, null), enabled)) {
    groups.push({ source: "plugin", plugin, skills: skillsIn(join(path, "skills"), `${plugin}:`) });
  }
  return groups.filter((group) => group.source === "project" || group.skills.length > 0);
}

export function register(wire: Wire): void {
  /** What the last list named: only those files are opened, whatever the page asks for. */
  let listed = new Set<string>();
  wire.bind(skillsContract, {
    listSkills: (cwd) => {
      const groups = listSkills(cwd);
      listed = new Set(groups.flatMap((group) => group.skills.map((skill) => skill.file)));
      return groups;
    },
    openSkill: async (file): Promise<ActionResult> => {
      if (!listed.has(file)) return { ok: false, message: "That skill is not in the list." };
      const problem = await shell.openPath(file);
      return problem ? { ok: false, message: problem } : { ok: true };
    },
  });
}
