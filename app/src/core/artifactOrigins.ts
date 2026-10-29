/**
 * Which project and session each Artifact came from, read from Claude Code's own transcripts.
 *
 * Publishing an Artifact is an `Artifact` tool call, and its result names the page it went to:
 * "Published … at https://claude.ai/code/artifact/<id>". Only those results count — a session that
 * merely mentions or reads an Artifact's link did not make it. Artifacts made on the claude.ai
 * website have no transcript here, and so no origin: they show under "all" and nowhere else.
 */
import type { ArtifactInfo } from "./artifacts.js";

export interface ArtifactOrigin {
  /** The project's encoded directory under projects/ — ProjectInfo.dir. */
  dir: string;
  /** The transcript's session id. A /clear-folded row lists it among its `folded` ids. */
  session: string;
}

/** Artifact slug → where it was published from, in the order the transcripts were read. */
export type ArtifactOrigins = Record<string, ArtifactOrigin[]>;

export type ArtifactScope = "all" | "project" | "session";
export const ARTIFACT_SCOPES: ArtifactScope[] = ["all", "project", "session"];

/** Cheap enough to test a whole transcript for before parsing a single line of it. */
export const PUBLISH_MARK = "\"name\":\"Artifact\"";
const PAGE = /claude\.ai\/code\/artifact\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

const resultText = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => (typeof (block as { text?: unknown })?.text === "string" ? (block as { text: string }).text : "")).join("\n");
};

/**
 * The slugs a transcript published, oldest first. A line is parsed only when it can matter: it calls
 * the tool, or it carries the id of a call already seen — a transcript runs to tens of megabytes.
 */
export function publishedSlugs(transcript: string): string[] {
  const calls = new Set<string>();
  const slugs: string[] = [];
  for (const line of transcript.split("\n")) {
    const relevant = line.includes(PUBLISH_MARK) || (calls.size > 0 && [...calls].some((id) => line.includes(id)));
    if (!relevant) continue;
    let content: unknown;
    try {
      content = (JSON.parse(line) as { message?: { content?: unknown } }).message?.content;
    } catch {
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const block of content as Record<string, unknown>[]) {
      if (block?.["type"] === "tool_use" && block["name"] === "Artifact") {
        const action = (block["input"] as { action?: unknown } | undefined)?.action;
        if ((action === undefined || action === "publish") && typeof block["id"] === "string") calls.add(block["id"]);
      } else if (block?.["type"] === "tool_result" && calls.has(block["tool_use_id"] as string)) {
        calls.delete(block["tool_use_id"] as string);
        const slug = PAGE.exec(resultText(block["content"]))?.[1]?.toLowerCase();
        if (slug && !slugs.includes(slug)) slugs.push(slug);
      }
    }
  }
  return slugs;
}

export interface ArtifactGroup {
  /** A project dir ("all"), a session id ("project"), or "" — no project, or the one flat list. */
  key: string;
  items: ArtifactInfo[];
}

/**
 * The list for one scope, in groups. "all": by the project each came from, the ones with no
 * project last; "project": that project's, by session; "session": that session's, one flat list.
 * `items` is newest first, and so are the groups — a group sits where its newest Artifact would.
 */
export function groupArtifacts(
  items: ArtifactInfo[],
  origins: ArtifactOrigins,
  scope: ArtifactScope,
  at: { dir: string | null; sessions: string[] },
): ArtifactGroup[] {
  const groups = new Map<string, ArtifactInfo[]>();
  const put = (key: string, item: ArtifactInfo): void => {
    const list = groups.get(key);
    if (list) list.push(item); else groups.set(key, [item]);
  };
  for (const item of items) {
    const from = origins[item.slug] ?? [];
    if (scope === "all") put(from[0]?.dir ?? "", item);
    else if (scope === "project") {
      const here = from.find((origin) => origin.dir === at.dir);
      if (at.dir && here) put(here.session, item);
    } else if (from.some((origin) => at.sessions.includes(origin.session))) put("", item);
  }
  const ordered = [...groups].map(([key, list]) => ({ key, items: list }));
  return scope === "all" ? [...ordered.filter((g) => g.key !== ""), ...ordered.filter((g) => g.key === "")] : ordered;
}
