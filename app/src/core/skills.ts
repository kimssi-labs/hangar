/**
 * The skills Claude Code can use for a project, read from where Claude Code keeps them.
 *
 * Three places, in the order the panel lists them: the project's own `.claude/skills`, the user's
 * `skills` folder in the Claude home, and the `skills` folder of every plugin that is installed AND
 * switched on in `settings.json`. Each skill is a folder with a `SKILL.md` whose front matter names
 * it and says when to use it. This file is the reading; finding the folders is the main side's.
 */

export type SkillSource = "project" | "user" | "plugin";

export interface SkillInfo {
  /** What to type after the slash: `name`, or `plugin:name` for a plugin's skill. */
  command: string;
  name: string;
  description: string;
  /** The SKILL.md itself, so the panel can open it. */
  file: string;
}

export interface SkillGroup {
  source: SkillSource;
  /** The plugin's name for a plugin group; empty otherwise. */
  plugin: string;
  skills: SkillInfo[];
}

/** One `key: value` of YAML front matter, including the folded (`>`) and literal (`|`) block forms. */
function frontValue(lines: string[], key: string): string | null {
  const at = lines.findIndex((line) => line.startsWith(`${key}:`));
  if (at < 0) return null;
  const rest = lines[at]!.slice(key.length + 1).trim();
  if (rest === "" || /^[>|][+-]?$/.test(rest)) {
    const block: string[] = [];
    for (const line of lines.slice(at + 1)) {
      if (line.trim() !== "" && !/^\s/.test(line)) break;
      block.push(line.trim());
    }
    return block.join(rest.startsWith("|") ? "\n" : " ").trim();
  }
  const quoted = /^(["'])(.*)\1$/.exec(rest);
  return quoted ? quoted[2]!.replace(/\\"/g, "\"").replace(/''/g, "'") : rest;
}

/** The name and description in a SKILL.md, or null when it has no front matter naming it. */
export function parseSkill(text: string): { name: string; description: string } | null {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return null;
  const lines = match[1]!.split(/\r?\n/);
  const name = frontValue(lines, "name");
  if (!name) return null;
  return { name, description: frontValue(lines, "description") ?? "" };
}

/** The plugins `settings.json` switches on, by name: `"superpowers@claude-plugins-official": true`. */
export function enabledPlugins(settings: unknown): Set<string> {
  const table = (settings as { enabledPlugins?: Record<string, unknown> } | null)?.enabledPlugins ?? {};
  return new Set(Object.entries(table).filter(([, on]) => on === true).map(([key]) => key));
}

/** Where each switched-on plugin is installed, from `plugins/installed_plugins.json`. */
export function pluginInstalls(installed: unknown, enabled: Set<string>): { plugin: string; path: string }[] {
  const table = (installed as { plugins?: Record<string, { installPath?: unknown }[]> } | null)?.plugins ?? {};
  return Object.entries(table).flatMap(([key, installs]) => {
    const path = installs?.[0]?.installPath;
    if (!enabled.has(key) || typeof path !== "string") return [];
    return [{ plugin: key.split("@")[0]!, path }];
  });
}

/** Whether two folder paths are the same folder: separators and a trailing slash aside, and any case on Windows. */
export function sameDir(a: string, b: string, ignoreCase: boolean): boolean {
  const norm = (path: string): string => {
    const flat = path.replace(/\\/g, "/").replace(/\/+$/, "");
    return ignoreCase ? flat.toLowerCase() : flat;
  };
  return norm(a) === norm(b);
}

/** Skills sorted by name, the way a person scans a list. */
export function sortSkills(skills: SkillInfo[]): SkillInfo[] {
  return [...skills].sort((a, b) => a.name.localeCompare(b.name));
}

/** Whether a skill matches what was typed in the search box: name or description, any case. */
export function skillMatches(skill: SkillInfo, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || skill.command.toLowerCase().includes(q) || skill.description.toLowerCase().includes(q);
}
