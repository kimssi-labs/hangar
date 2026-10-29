/**
 * Artifacts — the main side: asking claude.ai for the list (core/artifacts.ts says how, and why it
 * is defensive about it) and keeping the last answer in the Claude home's cache folder.
 *
 * Only when asked: the page asks once when the tab is first shown and again on its refresh button.
 * Chromium's network stack, as for the usage figures — the machine's proxy, and a request
 * claude.ai's bot wall lets through, which Node's fetch is not (measured: 403 "Just a moment").
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { net, shell } from "electron";

import type { Wire } from "../../bridge/build.js";
import { ARTIFACTS_ENDPOINT, ARTIFACTS_HEADERS, type ArtifactsState, EMPTY_ARTIFACTS, failureFor, isArtifactUrl, parseArtifacts } from "../../core/artifacts.js";
import { type ArtifactOrigins, PUBLISH_MARK, publishedSlugs } from "../../core/artifactOrigins.js";
import { homePaths } from "../../core/paths.js";
import { readStatusJson } from "../../core/status.js";
import { accessTokenFrom } from "../../core/usageEndpoint.js";
import type { ActionResult } from "../../main/ipc.js";
import { artifactsContract } from "./contract.js";

const REQUEST_TIMEOUT_MS = 15_000;

function cached(): ArtifactsState {
  try {
    const saved = JSON.parse(readFileSync(homePaths().hangarArtifacts, "utf8")) as ArtifactsState;
    return Array.isArray(saved.items) ? { items: saved.items, fetchedAt: saved.fetchedAt ?? null, failure: null } : EMPTY_ARTIFACTS;
  } catch {
    return EMPTY_ARTIFACTS;
  }
}

function keep(state: ArtifactsState): void {
  const file = homePaths().hangarArtifacts;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify(state), "utf8");
    renameSync(`${file}.tmp`, file);
  } catch (error) {
    console.error("[hangar] artifacts: could not save the list", (error as Error).message);
  }
}

async function refresh(): Promise<ArtifactsState> {
  const last = cached();
  const token = accessTokenFrom(readStatusJson<unknown>(homePaths().credentials, null));
  if (!token) return { ...last, failure: "login" };
  let response: Response;
  try {
    response = await net.fetch(ARTIFACTS_ENDPOINT, {
      headers: { ...ARTIFACTS_HEADERS, Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    console.error("[hangar] artifacts:", (error as Error).message);
    return { ...last, failure: "offline" };
  }
  if (!response.ok) {
    console.error(`[hangar] artifacts: HTTP ${response.status}`);
    return { ...last, failure: failureFor(response.status, response.headers.get("content-type")) };
  }
  const items = parseArtifacts(await response.json().catch(() => null));
  if (!items) return { ...last, failure: "changed" };
  const state: ArtifactsState = { items, fetchedAt: Date.now(), failure: null };
  keep(state);
  return state;
}

/** What one transcript published, as of its size and time — so an unchanged file is never read again. */
interface Scanned { size: number; mtime: number; slugs: string[] }

function readJsonFile<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

let scanning: Promise<ArtifactOrigins> | null = null;

/**
 * Every top-level transcript's publishes, from the cache where the file has not changed. The first
 * pass reads them all — a gigabyte on this machine, as seconds of async reads off the main thread —
 * and a transcript that never called the tool is dismissed by one search of its bytes, not parsed.
 */
async function scanOrigins(): Promise<ArtifactOrigins> {
  const paths = homePaths();
  const before = readJsonFile<Record<string, Scanned>>(paths.hangarArtifactOrigins, {});
  const after: Record<string, Scanned> = {};
  const origins: ArtifactOrigins = {};
  const dirs = await readdir(paths.projects).catch(() => [] as string[]);
  for (const dir of dirs) {
    const names = await readdir(join(paths.projects, dir)).catch(() => [] as string[]);
    for (const name of names.filter((n) => n.endsWith(".jsonl"))) {
      const file = join(paths.projects, dir, name);
      const info = await stat(file).catch(() => null);
      if (!info?.isFile()) continue;
      const known = before[file];
      let slugs: string[];
      if (known && known.size === info.size && known.mtime === info.mtimeMs) slugs = known.slugs;
      else {
        const bytes = await readFile(file).catch(() => null);
        slugs = bytes && bytes.includes(PUBLISH_MARK) ? publishedSlugs(bytes.toString("utf8")) : [];
      }
      after[file] = { size: info.size, mtime: info.mtimeMs, slugs };
      for (const slug of slugs) (origins[slug] ??= []).push({ dir, session: basename(name, ".jsonl") });
    }
  }
  try {
    mkdirSync(dirname(paths.hangarArtifactOrigins), { recursive: true });
    writeFileSync(paths.hangarArtifactOrigins, JSON.stringify(after), "utf8");
  } catch (error) {
    console.error("[hangar] artifacts: could not save the origins", (error as Error).message);
  }
  return origins;
}

export function register(wire: Wire): void {
  wire.bind(artifactsContract, {
    artifactsState: () => cached(),
    refreshArtifacts: () => refresh(),
    artifactOrigins: () => {
      scanning ??= scanOrigins().finally(() => { scanning = null; });
      return scanning;
    },
    openArtifact: async (url): Promise<ActionResult> => {
      if (!isArtifactUrl(url)) return { ok: false, message: "Not an Artifact link." };
      await shell.openExternal(url);
      return { ok: true };
    },
  });
}
