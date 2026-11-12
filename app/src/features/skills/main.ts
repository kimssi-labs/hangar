/**
 * Skills — the main side: finding the folders Claude Code reads skills from (core/skills.ts reads
 * each SKILL.md). Disk only, nothing cached: a list is a few dozen small reads, and a skill added a
 * minute ago should be there the next time the tab is opened.
 */
import { cpSync, existsSync, lstatSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { shell } from "electron";

import type { Wire } from "../../bridge/build.js";
import { homePaths } from "../../core/paths.js";
import { enabledPlugins, parseSkill, pluginInstalls, sameDir, type SkillGroup, type SkillInfo, sortSkills } from "../../core/skills.js";
import { readJson } from "../../core/json.js";
import type { ActionResult } from "../../main/ipc.js";
import { skillsContract, type PromoteMode } from "./contract.js";

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
  const enabled = enabledPlugins(readJson<unknown>(paths.settings, null));
  for (const { plugin, path } of pluginInstalls(readJson<unknown>(paths.installedPlugins, null), enabled)) {
    groups.push({ source: "plugin", plugin, skills: skillsIn(join(path, "skills"), `${plugin}:`) });
  }
  return groups.filter((group) => group.source === "project" || group.skills.length > 0);
}

/**
 * Copy or move one skill's folder into `userSkills`, under the same folder name.
 *
 * Never over anything: a global skill of that name is refused, not replaced. A link (a junction or
 * symlink to a folder kept elsewhere) is refused too, since copying it copies someone else's files
 * and moving it can leave the target behind. A move is a rename where it can be; across drives it is
 * a copy, checked, and only then is the project's folder sent to the recycle bin, so a failure part
 * way leaves the original where it was.
 */
export async function promote(
  skillDir: string,
  userSkills: string,
  mode: PromoteMode,
  trash: (path: string) => Promise<void>,
): Promise<ActionResult> {
  const name = basename(skillDir);
  const target = join(userSkills, name);
  if (existsSync(target)) return { ok: false, message: `A global skill named ${name} already exists.` };
  try {
    if (lstatSync(skillDir).isSymbolicLink()) return { ok: false, message: `${name} is a link to a folder elsewhere; copy or move that folder instead.` };
    if (mode === "move") {
      try {
        renameSync(skillDir, target);
        return { ok: true, message: `Moved ${name} to the global skills.` };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EXDEV" && code !== "EPERM") throw error;   // another drive: copy, then trash
      }
    }
    cpSync(skillDir, target, { recursive: true, errorOnExist: true, force: false });
    if (!existsSync(join(target, "SKILL.md"))) return { ok: false, message: `${name} was not copied whole; the project's copy is untouched.` };
    if (mode === "copy") return { ok: true, message: `Copied ${name} to the global skills.` };
    await trash(skillDir);
    return { ok: true, message: `Moved ${name} to the global skills.` };
  } catch (error) {
    return { ok: false, message: `Could not ${mode} ${name}: ${(error as Error).message}` };
  }
}

export function register(wire: Wire): void {
  /** What the last list named: only those files are opened, whatever the page asks for. */
  let listed = new Set<string>();
  /** Of those, the project's own: the only ones that can be made global. */
  let ownSkills = new Set<string>();
  wire.bind(skillsContract, {
    listSkills: (cwd) => {
      const groups = listSkills(cwd);
      listed = new Set(groups.flatMap((group) => group.skills.map((skill) => skill.file)));
      ownSkills = new Set(groups.filter((group) => group.source === "project").flatMap((group) => group.skills.map((skill) => skill.file)));
      return groups;
    },
    openSkill: async (file): Promise<ActionResult> => {
      if (!listed.has(file)) return { ok: false, message: "That skill is not in the list." };
      const problem = await shell.openPath(file);
      return problem ? { ok: false, message: problem } : { ok: true };
    },
    promoteSkill: ({ file, mode }) => {
      if (!ownSkills.has(file)) return Promise.resolve({ ok: false, message: "That is not one of this project's skills." });
      return promote(dirname(file), homePaths().skills, mode, (path) => shell.trashItem(path));
    },
  });
}
