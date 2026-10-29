/**
 * Artifacts — the page side: the side pane's Artifacts tab.
 *
 * The cached list is shown at once; claude.ai is asked once, the first time the tab is shown in a
 * run, and again only from the refresh button. A failed ask keeps the list and says why above it.
 * Where each one came from is read from the transcripts (core/artifactOrigins.ts), which is what the
 * scope switch filters by: all of them grouped by project, this project's by session, or this
 * session's alone.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { type ArtifactGroup, type ArtifactOrigins, type ArtifactScope, ARTIFACT_SCOPES, groupArtifacts } from "@core/artifactOrigins";
import { type ArtifactInfo, artifactMatches, type ArtifactsState, EMPTY_ARTIFACTS } from "@core/artifacts";

import { api } from "../../renderer/api";
import { ExpandAll, type PaneOpen } from "../../renderer/components/SidePane";
import { agoParts } from "../../renderer/format";
import { useText } from "../../renderer/useText";

export interface Artifacts extends ArtifactsState {
  loading: boolean;
  origins: ArtifactOrigins;
  refresh(): void;
}

/**
 * The list, fetched once when the tab is first `active` and then only by `refresh`; the origins are
 * read whenever the tab is shown — the transcripts grow while the app runs, and a re-read of files
 * that did not change costs a stat each.
 */
export function useArtifacts(active: boolean): Artifacts {
  const [state, setState] = useState<ArtifactsState>(EMPTY_ARTIFACTS);
  const [origins, setOrigins] = useState<ArtifactOrigins>({});
  const [loading, setLoading] = useState(false);
  const asked = useRef(false);
  const readOrigins = useCallback(() => { void api.artifactOrigins().then(setOrigins); }, []);
  const refresh = useCallback(() => {
    setLoading(true);
    void api.refreshArtifacts().then(setState).finally(() => setLoading(false));
    readOrigins();
  }, [readOrigins]);
  useEffect(() => { void api.artifactsState().then((cached) => { if (!asked.current) setState(cached); }); }, []);
  useEffect(() => {
    if (!active) return;
    if (asked.current) { readOrigins(); return; }
    asked.current = true;
    refresh();
  }, [active, refresh, readOrigins]);
  return { ...state, origins, loading, refresh };
}

/** What the tab needs to know about the window: which project and session are picked, and their names. */
export interface ArtifactPlace {
  /** The picked project's encoded dir, or null. */
  dir: string | null;
  /** The picked session's id and the ids /clear folded under it; empty when no session is picked. */
  sessions: string[];
  projectName(dir: string): string | null;
  sessionTitle(id: string): string | null;
}

/** A small glyph for the kind of Artifact claude.ai says it is. */
const ICONS: Record<string, string> = { chart: "▤", chat: "✉", map: "⌖", calendar: "▦", code: "‹›", doc: "▭", recipe: "✎" };

export function ArtifactsPane({ artifacts, place, scope, onScope, open, notify }: {
  artifacts: Artifacts;
  place: ArtifactPlace;
  scope: ArtifactScope;
  onScope(scope: ArtifactScope): void;
  /** Which groups are open — remembered across runs; everything starts closed. */
  open: PaneOpen;
  notify(result: { ok: boolean; message?: string }): void;
}) {
  const t = useText();
  const [query, setQuery] = useState("");
  const ago = (ms: number): string => {
    const { key, vars } = agoParts(ms);
    return t(key, vars);
  };
  const matching = useMemo(() => artifacts.items.filter((item) => artifactMatches(item, query)), [artifacts.items, query]);
  const groups = useMemo(
    () => groupArtifacts(matching, artifacts.origins, scope, { dir: place.dir, sessions: place.sessions }),
    [matching, artifacts.origins, scope, place.dir, place.sessions],
  );
  const groupKey = (group: ArtifactGroup): string => `artifacts:${scope}:${group.key}`;
  const flat = scope === "session";
  const label = (group: ArtifactGroup): string => {
    if (scope === "all") return group.key ? place.projectName(group.key) ?? group.key : t("artifacts.noProjectOrigin");
    return place.sessionTitle(group.key) ?? t("artifacts.unknownSession");
  };

  const row = (item: ArtifactInfo) => (
    <div
      key={item.slug}
      className={`group flex items-center gap-1.5 ${flat ? "pl-2" : "pl-5"} pr-2 py-0.5 hover:bg-ink-700/60 cursor-pointer`}
      title={item.description || item.title}
      onClick={() => void api.openArtifact(item.url).then((result) => { if (!result.ok) notify(result); })}
    >
      <span className="shrink-0 w-4 text-center text-[11px] text-bone-400" aria-hidden="true">{ICONS[item.icon] ?? "◧"}</span>
      <span className="flex-1 min-w-0 text-[12px] text-bone-100 truncate">{item.title}</span>
      {item.shared ? <span className="shrink-0 text-[10px] text-bone-500">{t("artifacts.shared")}</span> : null}
      <span className="shrink-0 text-[11px] text-bone-500 group-hover:hidden">
        {Number.isFinite(Date.parse(item.updatedAt)) ? ago(Date.parse(item.updatedAt)) : ""}
      </span>
      <button
        type="button"
        className="hidden group-hover:block shrink-0 text-[11px] text-bone-400 hover:text-bone-100 px-1"
        title={t("artifacts.copy")}
        aria-label={t("artifacts.copy")}
        onClick={(event) => {
          event.stopPropagation();
          void navigator.clipboard.writeText(item.url).then(() => notify({ ok: true, message: t("artifacts.copied") }));
        }}
      >
        ⧉
      </button>
    </div>
  );

  const emptyNote = (): string | null => {
    if (artifacts.items.length === 0) return artifacts.loading ? t("artifacts.loading") : artifacts.fetchedAt ? t("artifacts.none") : t("artifacts.notYet");
    if (scope === "project" && !place.dir) return t("artifacts.pickProject");
    if (scope === "session" && place.sessions.length === 0) return t("artifacts.pickSession");
    if (groups.length === 0) return query ? t("artifacts.noMatch") : t("artifacts.scopeNone");
    return null;
  };
  const note = emptyNote();

  return (
    <>
      <div className="flex items-center gap-1 px-2 py-1 border-b border-ink-600">
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("artifacts.search")}
          aria-label={t("artifacts.search")}
          className="flex-1 min-w-0 bg-transparent text-[12px] text-bone-100 placeholder:text-bone-500 outline-none"
        />
        {artifacts.fetchedAt ? (
          <span className="shrink-0 text-[11px] text-bone-500" title={t("artifacts.fetched")}>{ago(artifacts.fetchedAt)}</span>
        ) : null}
        {flat ? null : <ExpandAll keys={groups.map(groupKey)} open={open} />}
        <button
          type="button"
          disabled={artifacts.loading}
          className={`shrink-0 text-[12px] px-1 rounded text-bone-400 hover:text-bone-100 hover:bg-ink-700/60 ${artifacts.loading ? "animate-spin" : ""}`}
          title={t("artifacts.refresh")}
          aria-label={t("artifacts.refresh")}
          onClick={artifacts.refresh}
        >
          ↻
        </button>
      </div>
      <div role="radiogroup" className="flex gap-0.5 px-2 py-1 border-b border-ink-600">
        {ARTIFACT_SCOPES.map((choice) => (
          <button
            key={choice}
            type="button"
            role="radio"
            aria-checked={choice === scope}
            data-testid={`artifacts-scope-${choice}`}
            onClick={() => onScope(choice)}
            className={`px-2 py-0.5 rounded text-[11px] ${choice === scope ? "bg-ink-700 text-bone-100" : "text-bone-400 hover:text-bone-100"}`}
          >
            {t(`artifacts.scope.${choice}` as "artifacts.scope.all")}
          </button>
        ))}
      </div>
      {artifacts.failure ? (
        <div role="status" className="px-2 py-1 text-[11px] text-warn border-b border-ink-600">
          {t(`artifacts.failure.${artifacts.failure}` as "artifacts.failure.login")}
        </div>
      ) : null}
      <div data-testid="artifacts-list" className="flex-1 min-h-0 overflow-auto py-1">
        {note ? <div className="px-2 text-[11px] text-bone-500">{note}</div> : null}
        {note ? null : flat ? groups.flatMap((group) => group.items.map(row)) : groups.map((group) => {
          const key = groupKey(group);
          const shown = query !== "" || open.isOpen(key);
          return (
            <div key={key}>
              <button type="button" onClick={() => open.toggle(key)} data-testid="artifacts-group"
                className="w-full text-left px-2 py-0.5 text-[11px] text-bone-400 hover:text-bone-100 truncate">
                {shown ? "▾" : "▸"} {label(group)} ({group.items.length})
              </button>
              {shown ? group.items.map(row) : null}
            </div>
          );
        })}
      </div>
    </>
  );
}
