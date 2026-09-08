/**
 * Where Claude Code keeps its state, and where this app keeps its own settings.
 *
 * Everything is derived from one root so a test can point the whole app at a throwaway home, and
 * so Windows and Linux differ in nothing but the root itself.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CLAUDE_HOME_ENV = "CLAUDE_HOME";
/** Claude Code's own override of its home. A machine that set it moved its transcripts, registry and login there. */
export const CLAUDE_CONFIG_DIR_ENV = "CLAUDE_CONFIG_DIR";

/**
 * The single root every other path hangs off: CLAUDE_HOME (this app's own override, for the test
 * suite and a build run beside the installed app), else Claude Code's CLAUDE_CONFIG_DIR, else `~/.claude`.
 */
export function claudeHome(env: NodeJS.ProcessEnv = process.env): string {
  return env[CLAUDE_HOME_ENV] || env[CLAUDE_CONFIG_DIR_ENV]?.trim() || join(homedir(), ".claude");
}

export interface HomePaths {
  root: string;
  projects: string;
  liveSessions: string;
  history: string;
  claudeJson: string;
  config: string;
  managerConfig: string;
  aliases: string;
  rateLimits: string;
  /** Where a pasted screenshot is written, so a terminal session can be given its path. */
  clips: string;
  /** Claude Code's own settings file — where a hook has to be registered to run at all. */
  settings: string;
  /** Directory this app writes its hook script into. */
  hooks: string;
  /** Claude Code's login, kept for its own requests; read here only to ask its usage endpoint. */
  credentials: string;
}

export function homePaths(root = claudeHome()): HomePaths {
  return {
    root,
    projects: join(root, "projects"),
    liveSessions: join(root, "sessions"),
    history: join(root, "history.jsonl"),
    // Claude Code's own state file sits NEXT to a default home — and INSIDE a home CLAUDE_CONFIG_DIR moved.
    claudeJson: existsSync(join(root, ".claude.json")) ? join(root, ".claude.json") : join(root, "..", ".claude.json"),
    config: join(root, "config"),
    managerConfig: join(root, "config", "manager.json"),
    aliases: join(root, "config", "project-aliases.json"),
    rateLimits: join(root, "cache", "rate-limits.json"),
    clips: join(root, "cache", "hangar-clips"),
    settings: join(root, "settings.json"),
    hooks: join(root, "hooks"),
    credentials: join(root, ".credentials.json"),
  };
}

/**
 * Claude Code's project-directory encoding: every non-alphanumeric character becomes `-`.
 * Not reversible — the real folder is read from a transcript's `cwd`, this only matches names.
 */
export function encodeProjectPath(path: string): string {
  return path.replace(/[^A-Za-z0-9]/g, "-");
}
