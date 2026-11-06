/**
 * The search box: which projects and which of their sessions a query keeps.
 *
 * A session is found by its title and by its first prompt: a name chosen by hand replaces the
 * prompt as the title, and the prompt is still what the user remembers typing. Both are already
 * in the scan, so a search reads no file.
 */
import type { ProjectInfo, SessionInfo } from "./types";
import { placeWorktrees, type Placed } from "./worktree";

function needleOf(query: string): string {
  return query.trim().toLowerCase();
}

function sessionMatches(session: SessionInfo, needle: string): boolean {
  return session.title.toLowerCase().includes(needle) || session.prompt.toLowerCase().includes(needle);
}

/** A project's sessions: those matching the search, when there is one. */
export function filterSessions(project: ProjectInfo | null, query: string): SessionInfo[] {
  if (!project) return [];
  const needle = needleOf(query);
  return needle ? project.sessions.filter((s) => sessionMatches(s, needle)) : project.sessions;
}

/**
 * The list as it is drawn: matches in order, with each worktree tucked under its repository.
 *
 * One array for both the drawing and the keyboard, or the arrow keys would walk a different list
 * from the one on screen. A project is kept by its name, its folder, or any session it holds.
 */
export function filterProjects(projects: ProjectInfo[], query: string): Placed<ProjectInfo>[] {
  const needle = needleOf(query);
  const matched = needle
    ? projects.filter((project) =>
      project.name.toLowerCase().includes(needle)
      || (project.cwd ?? "").toLowerCase().includes(needle)
      || project.sessions.some((s) => sessionMatches(s, needle)))
    : projects;
  return placeWorktrees(matched);
}
