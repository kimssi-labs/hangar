/**
 * The Stop hook earlier versions installed, and how it is taken back out.
 *
 * Up to 2.15.1 the app could add a Stop hook to Claude Code's settings.json that was meant to copy
 * `rate_limits` from the hook's stdin into a cache file. Claude Code hands no such field to any
 * hook — checked against 2.1.263, where none of the 33 hook input schemas carries it — so the hook
 * ran at the end of every turn and wrote nothing. The figures come from the usage endpoint now
 * (usageEndpoint.ts).
 *
 * What is left here recognises the entry an older version wrote and removes exactly that, leaving
 * every other hook in the user's file alone. A machine that had switched collection on would
 * otherwise keep the entry for good, and once its script is gone Claude Code would report a failing
 * hook at the end of every turn.
 */

/** Base name of the script older versions wrote into the home's hooks folder. */
export const HOOK_BASE = "hangar-usage";

export function hookFileName(platform: NodeJS.Platform): string {
  return platform === "win32" ? `${HOOK_BASE}.cmd` : `${HOOK_BASE}.sh`;
}

/** Recognises our own entry however the path was spelled when it was written. */
function isOurs(command: string | undefined): boolean {
  return typeof command === "string" && command.includes(HOOK_BASE);
}

interface HookEntry { type?: string; command?: string; shell?: string }
interface HookGroup { matcher?: string; hooks?: HookEntry[] }

function stopGroups(settings: Record<string, unknown>): HookGroup[] {
  const hooks = settings["hooks"];
  if (!hooks || typeof hooks !== "object") return [];
  const stop = (hooks as Record<string, unknown>)["Stop"];
  return Array.isArray(stop) ? (stop as HookGroup[]) : [];
}

/** True when this settings object still runs the hook an older version installed. */
export function hookInstalled(settings: Record<string, unknown>): boolean {
  return stopGroups(settings).some((group) => (group.hooks ?? []).some((hook) => isOurs(hook.command)));
}

/** The settings with our hook removed, and any group we emptied removed with it. */
export function withoutHook(settings: Record<string, unknown>): Record<string, unknown> {
  const groups = stopGroups(settings)
    .map((group) => ({ ...group, hooks: (group.hooks ?? []).filter((h) => !isOurs(h.command)) }))
    .filter((group) => (group.hooks ?? []).length > 0);
  const hooks = { ...(settings["hooks"] as Record<string, unknown> ?? {}) };
  if (groups.length) hooks["Stop"] = groups;
  else delete hooks["Stop"];
  const next: Record<string, unknown> = { ...settings, hooks };
  if (Object.keys(hooks).length === 0) delete next["hooks"];
  return next;
}
