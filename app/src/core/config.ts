/**
 * The one settings file, `config/manager.json`, with a section per feature.
 *
 * The terminal version of this app wrote the same file and the same section names, so an existing
 * setup keeps its dock, status-line and launch choices when it moves to the desktop app.
 */
import { statSync } from "node:fs";
import { dirname } from "node:path";

import { DEFAULT_PASTE_HOTKEY, DOCK_EDGES, DOCK_PERCENT, EDGE_AXIS, LAYOUT_MODES, PERMISSION_MODES, SHELL_CHOICES, SIDE_PANE_TABS, STACK_BELOW, THEME_MODES } from "./constants.js";
import { AUTO_DEFAULTS, AUTO_MODES, type AutoConfig } from "./gitAuto.js";
import { MERGE_STRATEGIES, SYNC_DEFAULTS } from "./gitSync.js";
import { LANGUAGES, type Language } from "./i18n.js";
import { readJson, writeJson } from "./json.js";
import { homePaths } from "./paths.js";
import type { DockConfig, DockEdge, GitConfig, LaunchConfig, LayoutMode, PermissionMode, ShellChoice, SidePaneTab, StatusConfig, ThemeMode, UiConfig, UpdateConfig } from "./types.js";
import { ARTIFACT_SCOPES, type ArtifactScope } from "./artifactOrigins.js";

export const SECTION = { dock: "dock", status: "status", launch: "launch", ui: "ui", projects: "projects", pins: "pins", updates: "updates", git: "git" } as const;
export const DOCK_MONITORS_KEY = "monitors";
export const DOCK_SETUPS_KEY = "setups";
export const DOCK_FLOOR_KEY = "floor";

type Json = Record<string, unknown>;

/** How long a just-written file's mtime is not trusted: two writes in one clock tick share it. */
const SETTLE_MS = 2_000;

/**
 * A cheap "has this file changed" answer: size and mtime, `-` when it is not there, and null when
 * the file was written so recently that a second write in the same clock tick would not show.
 */
export function fileSignature(file: string): string | null {
  try {
    const st = statSync(file, { throwIfNoEntry: false });
    if (!st) return "-";
    if (Date.now() - st.mtimeMs < SETTLE_MS) return null;
    return `${st.size}:${st.mtimeMs}`;
  } catch {
    return null;
  }
}

/**
 * Parsed settings files, by path, against their signature.
 *
 * The scan alone asked for these four times every fifteen seconds, each a read and a parse. Module
 * level, not per instance: any two ConfigStores on the same file — the tests make them — must see
 * each other's writes. Handed out as copies, because callers edit what they get.
 */
const parsed = new Map<string, { signature: string; value: Json }>();

function readJsonCached(file: string): Json {
  const signature = fileSignature(file);
  const hit = parsed.get(file);
  if (signature !== null && hit?.signature === signature) return structuredClone(hit.value);
  const value = asRecord(readJson<unknown>(file, {}));   // absent or hand-edited into nonsense: defaults
  if (signature === null) parsed.delete(file);
  else parsed.set(file, { signature, value: structuredClone(value) });
  return value;
}

/** A settings file is one a person may open, so it is written indented. */
function writeSettings(file: string, value: unknown): void {
  parsed.delete(file);
  writeJson(file, value, 2);
}

function asRecord(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
}

/**
 * A remembered pane size as a fraction of the window, or 0 for "let the layout decide".
 *
 * Sizes used to be kept in pixels, which is only right until the window changes: a divider set in
 * a tall window put the pane below it eight pixels tall in a docked band. Anything above 1 is a
 * pixel count from an older settings file and is dropped — the layout picks again, once.
 */
function fraction(value: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number >= 1) return 0;
  return Math.round(number * 1000) / 1000;
}

/** A remembered window rectangle, or null when there is none worth restoring. */
function windowBounds(value: unknown): UiConfig["window"] {
  const raw = asRecord(value);
  const numbers = ["x", "y", "width", "height"].map((key) => Number(raw[key]));
  if (numbers.some((n) => !Number.isFinite(n))) return null;
  const [x, y, width, height] = numbers as [number, number, number, number];
  // A zero-sized window is not a position anyone wants restored.
  return width > 0 && height > 0 ? { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) } : null;
}

/** More open groups than anyone keeps open is a list that only ever grew. */
const PANE_OPEN_MAX = 500;

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

export class ConfigStore {
  readonly file: string;

  constructor(home?: string) {
    this.file = homePaths(home).managerConfig;
  }

  private all(): Json {
    return readJsonCached(this.file);
  }

  section(name: string): Json {
    return asRecord(this.all()[name]);
  }

  saveSection(name: string, value: Json): void {
    const config = this.all();
    config[name] = value;
    writeSettings(this.file, config);
  }

  // -- dock -------------------------------------------------------------------------------------
  /**
   * Dock settings for `device`, or for the monitors currently attached.
   *
   * Two levels, because both questions matter. Each monitor keeps its own edge, size and on/off —
   * a band that suits a portrait panel is wrong on a wide one. And each ARRANGEMENT of monitors
   * (`setup`: every attached monitor, sorted) remembers which of them was docked, so plugging the
   * laptop into its two screens brings back the screen you had it on, not just its size.
   */
  dock(device?: string | null, setup?: string | null): DockConfig {
    const raw = this.section(SECTION.dock);
    const perDevice = asRecord(raw[DOCK_MONITORS_KEY]);
    const perSetup = setup ? asRecord(asRecord(raw[DOCK_SETUPS_KEY])[setup]) : {};
    const chosen = device
      ?? (typeof perSetup["device"] === "string" ? (perSetup["device"] as string) : null)
      ?? (typeof raw["device"] === "string" ? (raw["device"] as string) : null);
    const merged = { ...raw, ...(chosen ? asRecord(perDevice[chosen]) : {}), ...perSetup };
    const percent = Number(merged["percent"]);
    const edge = merged["edge"];
    return {
      enabled: merged["enabled"] === true,
      device: chosen,
      edge: DOCK_EDGES.includes(edge as DockEdge) ? (edge as DockEdge) : "top",
      percent: Number.isFinite(percent) ? clamp(Math.round(percent), DOCK_PERCENT.min, DOCK_PERCENT.max) : DOCK_PERCENT.default,
    };
  }

  saveDock(config: DockConfig, setup?: string | null): void {
    const raw = this.section(SECTION.dock);
    const perDevice = asRecord(raw[DOCK_MONITORS_KEY]);
    const setups = asRecord(raw[DOCK_SETUPS_KEY]);
    if (config.device) {
      perDevice[config.device] = { edge: config.edge, percent: config.percent, enabled: config.enabled };
    }
    if (setup) {
      setups[setup] = { device: config.device, edge: config.edge, percent: config.percent, enabled: config.enabled };
    }
    this.saveSection(SECTION.dock, {
      ...raw, ...config, [DOCK_MONITORS_KEY]: perDevice, [DOCK_SETUPS_KEY]: setups,
    });
  }

  /** Monitors with remembered settings — shown as "saved" so the list is not a guess. */
  dockDevices(): string[] {
    return Object.keys(asRecord(this.section(SECTION.dock)[DOCK_MONITORS_KEY]));
  }

  /** Smallest band the window manager accepted on this axis, 0 when never measured. */
  dockFloor(edge: DockEdge): number {
    const floors = asRecord(this.section(SECTION.dock)[DOCK_FLOOR_KEY]);
    const value = Number(floors[EDGE_AXIS[edge]]);
    return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
  }

  saveDockFloor(edge: DockEdge, pixels: number): void {
    const raw = this.section(SECTION.dock);
    const floors = asRecord(raw[DOCK_FLOOR_KEY]);
    floors[EDGE_AXIS[edge]] = Math.round(pixels);
    this.saveSection(SECTION.dock, { ...raw, [DOCK_FLOOR_KEY]: floors });
  }

  // -- status line -------------------------------------------------------------------------------
  status(): StatusConfig {
    const { enabled, windows } = this.section(SECTION.status);
    // On unless switched off. A file from an older version holds a list of windows instead: an empty
    // list was off, and any other (a few windows ticked included) is on.
    return { enabled: typeof enabled === "boolean" ? enabled : !Array.isArray(windows) || windows.length > 0 };
  }

  saveStatus(config: StatusConfig): void {
    this.saveSection(SECTION.status, { ...config });
  }

  // -- git --------------------------------------------------------------------------------------
  git(): GitConfig {
    const raw = this.section(SECTION.git);
    const auto = asRecord(raw["auto"]);
    return {
      enabled: raw["enabled"] !== false,          // on unless it was turned off
      // Off by default: it runs `git status`, and on a big repository that is not free.
      countChanges: raw["countChanges"] === true,
      strategy: MERGE_STRATEGIES.includes(raw["strategy"] as GitConfig["strategy"])
        ? raw["strategy"] as GitConfig["strategy"]
        : SYNC_DEFAULTS.strategy,
      base: typeof raw["base"] === "string" ? (raw["base"] as string).trim() : SYNC_DEFAULTS.base,
      auto: {
        mode: AUTO_MODES.includes(auto["mode"] as AutoConfig["mode"]) ? auto["mode"] as AutoConfig["mode"] : AUTO_DEFAULTS.mode,
        everyMinutes: Number.isFinite(Number(auto["everyMinutes"])) && Number(auto["everyMinutes"]) > 0
          ? Math.round(Number(auto["everyMinutes"]))
          : AUTO_DEFAULTS.everyMinutes,
      },
    };
  }

  saveGit(config: GitConfig): void {
    this.saveSection(SECTION.git, { ...config });
  }

  // -- updating ---------------------------------------------------------------------------------
  updates(): UpdateConfig {
    const raw = this.section(SECTION.updates);
    return { automatic: raw["automatic"] !== false };      // on unless it was turned off
  }

  saveUpdates(config: UpdateConfig): void {
    this.saveSection(SECTION.updates, { ...config });
  }

  // -- launching sessions --------------------------------------------------------------------------
  launch(): LaunchConfig {
    const raw = this.section(SECTION.launch);
    const shell = raw["shell"];
    const permission = raw["permission"];
    return {
      shell: SHELL_CHOICES.includes(shell as ShellChoice) ? (shell as ShellChoice) : "auto",
      permission: PERMISSION_MODES.includes(permission as PermissionMode) ? (permission as PermissionMode) : "default",
      terminal: typeof raw["terminal"] === "string" ? (raw["terminal"] as string) : "",
      customShell: typeof raw["customShell"] === "string" ? (raw["customShell"] as string) : "",
      pasteHotkey: typeof raw["pasteHotkey"] === "string"
        ? (raw["pasteHotkey"] as string)
        : DEFAULT_PASTE_HOTKEY,
      autoClipPath: raw["autoClipPath"] !== false,      // on unless it has been turned off
    };
  }

  saveLaunch(config: LaunchConfig): void {
    this.saveSection(SECTION.launch, { ...config });
  }

  // -- where the user was ---------------------------------------------------------------------------
  ui(): UiConfig {
    const raw = this.section(SECTION.ui);
    const cursor = Number(raw["cursor"]);
    const theme = raw["theme"];
    return {
      project: typeof raw["project"] === "string" ? (raw["project"] as string) : null,
      cursor: Number.isFinite(cursor) && cursor > 0 ? Math.round(cursor) : 0,
      theme: THEME_MODES.includes(theme as ThemeMode) ? (theme as ThemeMode) : "system",
      // Unset means follow the machine, which is what a first run on a Korean PC should do.
      language: LANGUAGES.some((l) => l.key === raw["language"]) ? raw["language"] as Language : "system",
      monitor: raw["monitor"] !== false,          // on unless it was explicitly turned off
      files: raw["files"] !== false,              // same: shown unless it was turned off
      keepIcons: raw["keepIcons"] !== false,      // same: kept unless it was turned off
      skills: raw["skills"] !== false,
      alwaysOnTop: raw["alwaysOnTop"] === true,             // off unless it was switched on
      updateSnoozeUntil: Number.isFinite(Number(raw["updateSnoozeUntil"])) ? Math.max(0, Number(raw["updateSnoozeUntil"])) : 0,
      artifacts: raw["artifacts"] !== false,
      sidePane: SIDE_PANE_TABS.includes(raw["sidePane"] as SidePaneTab) ? (raw["sidePane"] as SidePaneTab) : "files",
      paneOpen: Array.isArray(raw["paneOpen"])
        ? (raw["paneOpen"] as unknown[]).filter((key): key is string => typeof key === "string").slice(0, PANE_OPEN_MAX)
        : [],
      artifactScope: ARTIFACT_SCOPES.includes(raw["artifactScope"] as ArtifactScope) ? (raw["artifactScope"] as ArtifactScope) : "all",
      layout: LAYOUT_MODES.includes(raw["layout"] as LayoutMode) ? (raw["layout"] as LayoutMode) : "auto",
      stackBelow: Number.isFinite(Number(raw["stackBelow"])) && Number(raw["stackBelow"]) > 0
        ? clamp(Math.round(Number(raw["stackBelow"])), STACK_BELOW.min, STACK_BELOW.max)
        : STACK_BELOW.default,
      window: windowBounds(raw["window"]),
      navWidth: fraction(raw["navWidth"]),
      asideWidth: fraction(raw["asideWidth"]),
      stackTop: fraction(raw["stackTop"]),
      stackPane: fraction(raw["stackPane"]),
    };
  }

  saveUi(config: UiConfig): void {
    this.saveSection(SECTION.ui, { ...config });
  }

  // -- projects added by hand -------------------------------------------------------------------
  /**
   * Folders added through the app, keyed by their encoded directory name.
   *
   * A project normally exists because Claude Code wrote a transcript into it, and the transcript
   * says which folder it is. One added here has no transcript yet, so this is the only place its
   * path is written down — until Claude Code has run there once and the transcript takes over.
   */
  addedProjects(): Record<string, string> {
    const raw = asRecord(this.section(SECTION.projects)["added"]);
    return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, String(v)]));
  }

  saveAddedProject(dir: string, cwd: string): void {
    const raw = this.section(SECTION.projects);
    this.saveSection(SECTION.projects, { ...raw, added: { ...asRecord(raw["added"]), [dir]: cwd } });
  }

  // -- pinned rows ----------------------------------------------------------------------------------
  /** Rows kept at the top of their list: project directory names, and session ids. */
  pins(): { projects: string[]; sessions: string[] } {
    const raw = this.section(SECTION.pins);
    const list = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : []);
    return { projects: list(raw["projects"]), sessions: list(raw["sessions"]) };
  }

  /** Pin `key` if it is not pinned, unpin it if it is; true when it ends up pinned. */
  togglePin(kind: "projects" | "sessions", key: string): boolean {
    const pins = this.pins();
    const index = pins[kind].indexOf(key);
    if (index >= 0) pins[kind].splice(index, 1);
    else pins[kind].push(key);
    this.saveSection(SECTION.pins, pins);
    return index < 0;
  }

  // -- project aliases ------------------------------------------------------------------------------
  aliases(): Record<string, string> {
    const file = homePaths(dirname(dirname(this.file))).aliases;
    const raw = readJsonCached(file);
    return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, String(v)]));
  }

  saveAliases(aliases: Record<string, string>): void {
    writeSettings(homePaths(dirname(dirname(this.file))).aliases, aliases);
  }
}

/**
 * Smallest percentage that still clears a measured floor, rounded up: below it every value produces
 * the same window, which is indistinguishable from the setting being broken.
 */
export function percentFloor(floorPx: number, spanPx: number): number {
  if (floorPx <= 0 || spanPx <= 0) return DOCK_PERCENT.min;
  return clamp(Math.ceil((floorPx * 100) / spanPx), DOCK_PERCENT.min, DOCK_PERCENT.max);
}
