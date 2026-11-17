/**
 * Artifacts — the main side: asking claude.ai for the list (core/artifacts.ts says how, and why it
 * is defensive about it) and keeping the last answer in the Claude home's cache folder.
 *
 * Only when asked: the page asks once when the tab is first shown and again on its refresh button.
 * Chromium's network stack, as for the usage figures — the machine's proxy, and a request
 * claude.ai's bot wall lets through, which Node's fetch is not (measured: 403 "Just a moment").
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { net, shell } from "electron";

import type { Wire } from "../../bridge/build.js";
import {
  ARTIFACTS_ENDPOINT, ARTIFACTS_HEADERS, type ArtifactInfo, type ArtifactsState, EMPTY_ARTIFACTS, failureFor, frameUrl, isArtifactUrl,
  parseArtifacts, retitleUrl, TITLE_MAX,
} from "../../core/artifacts.js";
import { type ArtifactOrigins, PUBLISH_MARK, publishedSlugs } from "../../core/artifactOrigins.js";
import { readJson, writeJson } from "../../core/json.js";
import { homePaths } from "../../core/paths.js";
import { accessTokenFrom } from "../../core/usageEndpoint.js";
import type { ActionResult } from "../../main/ipc.js";
import { artifactsContract } from "./contract.js";

const REQUEST_TIMEOUT_MS = 15_000;

function cached(): ArtifactsState {
  const saved = readJson<Partial<ArtifactsState>>(homePaths().hangarArtifacts, {});
  return Array.isArray(saved.items) ? { items: saved.items, fetchedAt: saved.fetchedAt ?? null, failure: null } : EMPTY_ARTIFACTS;
}

function keep(state: ArtifactsState): void {
  try {
    writeJson(homePaths().hangarArtifacts, state);
  } catch (error) {
    console.error("[hangar] artifacts: could not save the list", (error as Error).message);
  }
}

async function refresh(): Promise<ArtifactsState> {
  const last = cached();
  const token = accessTokenFrom(readJson<unknown>(homePaths().credentials, null));
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

/**
 * One change to an Artifact of this account, signed in as the list is; null when claude.ai took it.
 * Only one the last list showed as this account's own: someone else's, shared here, is theirs.
 */
async function change(slug: string, url: string, init: RequestInit): Promise<string | null> {
  if (!cached().items.some((item) => item.slug === slug && !item.shared)) return "That is not one of your Artifacts in the list.";
  const token = accessTokenFrom(readJson<unknown>(homePaths().credentials, null));
  if (!token) return "Sign in to Claude Code first.";
  try {
    const response = await net.fetch(url, {
      ...init,
      headers: { ...ARTIFACTS_HEADERS, ...init.headers, Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.ok) return null;
    console.error(`[hangar] artifacts: ${init.method} HTTP ${response.status}`);
    if (response.status === 404) return "claude.ai has no such Artifact of yours; it may be gone already.";
    return `claude.ai answered HTTP ${response.status}.`;
  } catch (error) {
    return `claude.ai could not be reached: ${(error as Error).message}`;
  }
}

/** The cached list with one Artifact changed or taken out, so the tab shows it without a refetch. */
function keepEdited(slug: string, edit: (item: ArtifactInfo) => ArtifactInfo | null): void {
  const last = cached();
  const items = last.items.map((item) => (item.slug === slug ? edit(item) : item)).filter((item): item is ArtifactInfo => item !== null);
  keep({ ...last, items });
}

async function renameArtifact(slug: string, title: string): Promise<ActionResult> {
  if (!title || title.length > TITLE_MAX) return { ok: false, message: `A title is 1 to ${TITLE_MAX} characters.` };
  const failed = await change(slug, retitleUrl(slug), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  if (failed) return { ok: false, message: `Could not rename it: ${failed}` };
  keepEdited(slug, (item) => ({ ...item, title }));
  return { ok: true };
}

async function deleteArtifact(slug: string): Promise<ActionResult> {
  const failed = await change(slug, frameUrl(slug), { method: "DELETE" });
  if (failed) return { ok: false, message: `Could not delete it: ${failed}` };
  keepEdited(slug, () => null);
  return { ok: true };
}

/** What one transcript published, as of its size and time — so an unchanged file is never read again. */
interface Scanned { size: number; mtime: number; slugs: string[] }

let scanning: Promise<ArtifactOrigins> | null = null;

/**
 * Every top-level transcript's publishes, from the cache where the file has not changed. The first
 * pass reads them all — a gigabyte on this machine, as seconds of async reads off the main thread —
 * and a transcript that never called the tool is dismissed by one search of its bytes, not parsed.
 */
async function scanOrigins(): Promise<ArtifactOrigins> {
  const paths = homePaths();
  const before = readJson<Record<string, Scanned>>(paths.hangarArtifactOrigins, {});
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
    writeJson(paths.hangarArtifactOrigins, after);
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
    renameArtifact: ({ slug, title }) => renameArtifact(slug, title.trim()),
    deleteArtifact: (slug) => deleteArtifact(slug),
  });
}
