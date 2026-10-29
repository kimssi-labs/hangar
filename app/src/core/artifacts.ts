/**
 * The user's Artifacts on claude.ai — the list, and what a failure to get it means.
 *
 * There is no public API for this. Claude Code lists Artifacts with `GET /api/frame/frames` on
 * claude.ai, signed in with the same OAuth login the usage figures use, and the server answers only
 * a request that carries `X-Frame-CP: go` (measured: without it, 404). Being undocumented it can
 * change without notice, so everything here is defensive: rows that do not read are dropped, and a
 * failure keeps the last list and says which kind of failure it was.
 */

export const ARTIFACTS_ENDPOINT = "https://claude.ai/api/frame/frames?limit=200";
/** The one header the endpoint insists on — Claude Code's own `du()` sends it with every frame call. */
export const ARTIFACTS_HEADERS = { "X-Frame-CP": "go", Accept: "application/json" } as const;
const ARTIFACT_PAGE = "https://claude.ai/code/artifact/";
const SLUG = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ArtifactInfo {
  slug: string;
  title: string;
  description: string;
  /** A short word for its kind — chart, chat, map… — as claude.ai shows it. */
  icon: string;
  /** Somebody else's, shared with this account. */
  shared: boolean;
  /** ISO time it last changed; empty when the server did not say. */
  updatedAt: string;
  url: string;
}

/** Why the list could not be had. `null` is "it could". */
export type ArtifactsFailure = "login" | "offline" | "changed" | null;

export interface ArtifactsState {
  items: ArtifactInfo[];
  /** When the list was last fetched, ms since the epoch; null before the first time. */
  fetchedAt: number | null;
  failure: ArtifactsFailure;
}

export const EMPTY_ARTIFACTS: ArtifactsState = { items: [], fetchedAt: null, failure: null };

/** The page an Artifact lives at. */
export function artifactUrl(slug: string): string {
  return `${ARTIFACT_PAGE}${slug}`;
}

/** Only links this app made itself are opened: an Artifact page on claude.ai. */
export function isArtifactUrl(url: string): boolean {
  return url.startsWith(ARTIFACT_PAGE) && SLUG.test(url.slice(ARTIFACT_PAGE.length));
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** The endpoint's answer as a list, newest first; null when it is not the shape it used to be. */
export function parseArtifacts(body: unknown): ArtifactInfo[] | null {
  const frames = (body as { frames?: unknown } | null)?.frames;
  if (!Array.isArray(frames)) return null;
  const items = frames.flatMap((frame): ArtifactInfo[] => {
    if (!frame || typeof frame !== "object") return [];
    const row = frame as Record<string, unknown>;
    const slug = text(row["slug"]);
    if (!SLUG.test(slug)) return [];
    return [{
      slug,
      title: text(row["title"]).trim() || "Untitled",
      description: text(row["description"]).trim(),
      icon: text(row["icon_key"]) || text(row["icon"]).toLowerCase(),
      shared: text(row["rel"]) !== "" && text(row["rel"]) !== "mine",
      updatedAt: text(row["updatedAt"]) || text(row["created_at"]),
      url: artifactUrl(slug),
    }];
  });
  return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * What an HTTP answer that was not a list means. 401/403 with JSON is the login; an HTML page is
 * claude.ai's bot wall or a moved route — either way the route as known no longer works.
 */
export function failureFor(status: number, contentType: string | null): ArtifactsFailure {
  if ((status === 401 || status === 403) && (contentType ?? "").includes("json")) return "login";
  return "changed";
}

/** Whether an Artifact matches what was typed in the search box. */
export function artifactMatches(item: ArtifactInfo, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || item.title.toLowerCase().includes(q) || item.description.toLowerCase().includes(q);
}
