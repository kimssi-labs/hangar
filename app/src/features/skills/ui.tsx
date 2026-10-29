/**
 * Skills — the page side: the side pane's skills tab.
 *
 * Read again whenever the tab is shown or the project changes; there is nothing to refresh by hand,
 * because the list is the disk. A double-click copies `/name`, ready to paste into a session.
 */
import { useEffect, useMemo, useState } from "react";

import { type SkillGroup, skillMatches } from "@core/skills";

import { api } from "../../renderer/api";
import { ExpandAll, type PaneOpen } from "../../renderer/components/SidePane";
import { useText } from "../../renderer/useText";

/** The skills for `cwd`, read while `active`; null until the first answer. */
export function useSkills(cwd: string | null, active: boolean): SkillGroup[] | null {
  const [groups, setGroups] = useState<SkillGroup[] | null>(null);
  useEffect(() => {
    if (!active) return;
    let current = true;
    void api.listSkills(cwd).then((answer) => { if (current) setGroups(answer); });
    return () => { current = false; };
  }, [cwd, active]);
  return groups;
}

export function SkillsPane({ groups, open, notify }: {
  groups: SkillGroup[] | null;
  /** Which groups are open — remembered across runs; everything starts closed. */
  open: PaneOpen;
  notify(result: { ok: boolean; message?: string }): void;
}) {
  const t = useText();
  const [query, setQuery] = useState("");
  const matching = (group: SkillGroup): SkillGroup => ({ ...group, skills: group.skills.filter((skill) => skillMatches(skill, query)) });
  // Two sections, the way Claude Code scopes them: the project's own, then the global ones — the
  // user's folder and the switched-on plugins — which every project gets.
  const project = useMemo(() => (groups ?? []).find((group) => group.source === "project"), [groups]);
  const global = useMemo(() => (groups ?? []).filter((group) => group.source !== "project").map(matching)
    .filter((group) => group.skills.length > 0), [groups, query]);
  const projectShown = project ? matching(project) : null;

  const copy = (command: string): void => {
    void navigator.clipboard.writeText(`/${command}`).then(() => notify({ ok: true, message: t("skills.copied", { name: `/${command}` }) }));
  };
  const heading = (group: SkillGroup): string =>
    group.source === "plugin" ? t("skills.group.plugin", { name: group.plugin }) : t(`skills.group.${group.source}` as "skills.group.user");
  const toggle = (key: string): void => open.toggle(`skills:${key}`);
  // A search opens everything it found: a match inside a closed group would be a match unseen.
  const isOpen = (key: string): boolean => query !== "" || open.isOpen(`skills:${key}`);
  const allKeys = [...(project ? ["project"] : []), "global", ...global.map((group) => `${group.source}:${group.plugin}`)]
    .map((key) => `skills:${key}`);

  const rows = (group: SkillGroup) => group.skills.map((skill) => (
    <div
      key={skill.file}
      className="group flex items-start gap-1 pl-6 pr-2 py-0.5 hover:bg-ink-700/60 cursor-default"
      title={skill.description}
      onDoubleClick={() => copy(skill.command)}
    >
      <div className="flex-1 min-w-0">
        <div className="text-[12px] text-bone-100 truncate">{skill.command}</div>
        <div className="text-[11px] text-bone-500 truncate">{skill.description}</div>
      </div>
      <button type="button" className="hidden group-hover:block text-[11px] text-bone-400 hover:text-bone-100 px-1"
        title={t("skills.copy")} aria-label={t("skills.copy")} onClick={() => copy(skill.command)}>⧉</button>
      <button type="button" className="hidden group-hover:block text-[11px] text-bone-400 hover:text-bone-100 px-1"
        title={t("skills.open")} aria-label={t("skills.open")}
        onClick={() => void api.openSkill(skill.file).then((result) => { if (!result.ok) notify(result); })}>↗</button>
    </div>
  ));
  const section = (key: string, label: string, count: number) => (
    <button type="button" data-testid={`skills-section-${key}`} onClick={() => toggle(key)}
      className="w-full text-left px-2 pt-1.5 pb-0.5 text-[11px] font-semibold uppercase tracking-wide text-bone-300 hover:text-bone-100">
      {isOpen(key) ? "▾" : "▸"} {label} <span className="font-normal text-bone-500">{count}</span>
    </button>
  );
  const globalCount = global.reduce((sum, group) => sum + group.skills.length, 0);

  return (
    <>
      <div className="flex items-center gap-1 px-2 py-1 border-b border-ink-600">
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("skills.search")}
          aria-label={t("skills.search")}
          className="flex-1 min-w-0 bg-transparent text-[12px] text-bone-100 placeholder:text-bone-500 outline-none"
        />
        <ExpandAll keys={allKeys} open={open} />
      </div>
      <div data-testid="skills-list" className="flex-1 min-h-0 overflow-auto py-1">
        {groups === null ? <div className="px-2 text-[11px] text-bone-500">{t("skills.reading")}</div> : null}
        {projectShown ? (
          <div>
            {section("project", t("skills.section.project"), projectShown.skills.length)}
            {isOpen("project") ? (projectShown.skills.length
              ? rows(projectShown)
              : <div className="pl-6 pr-2 py-0.5 text-[11px] text-bone-500">{query ? t("skills.noMatch") : t("skills.projectNone")}</div>) : null}
          </div>
        ) : null}
        {groups !== null ? (
          <div>
            {section("global", t("skills.section.global"), globalCount)}
            {isOpen("global") ? (global.length ? global.map((group) => {
              const key = `${group.source}:${group.plugin}`;
              return (
                <div key={key}>
                  <button type="button" onClick={() => toggle(key)}
                    className="w-full text-left pl-4 pr-2 py-0.5 text-[11px] text-bone-400 hover:text-bone-100">
                    {isOpen(key) ? "▾" : "▸"} {heading(group)} ({group.skills.length})
                  </button>
                  {isOpen(key) ? rows(group) : null}
                </div>
              );
            }) : <div className="pl-6 pr-2 py-0.5 text-[11px] text-bone-500">{query ? t("skills.noMatch") : t("skills.none")}</div>) : null}
          </div>
        ) : null}
      </div>
    </>
  );
}
