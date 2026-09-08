/**
 * Claude Code's usage figures — the page side.
 *
 * Owns the snapshot the gauges draw from and the two ways it changes: a re-read, and the hook
 * being switched on or off. The two settings card bodies are here too — which windows the strip
 * shows, and the collection switch — and the gauges themselves (`UsageGauges`): what a screen
 * places is one component, and what it shows is this feature's business alone.
 */
import { useCallback, useEffect, useLayoutEffect, useState } from "react";

import { RATE_WINDOWS } from "@core/constants";
import type { RateWindow, StatusConfig, StatusSnapshot } from "@core/types";

import { api, type SettingsPayload } from "../../renderer/api";
import { isNarrow, UprightBar, useElementWidth } from "../../renderer/components/Chart";
import { Truncated } from "../../renderer/components/Truncated";
import { formatClock, formatPercent, formatTime, resetLabel, resetRemaining, sinceParts, usageTone } from "../../renderer/format";
import { useText } from "../../renderer/useText";
import type { UsageState } from "./contract";

export interface Usage {
  /** The windows as last read; null until the first read has answered. */
  status: StatusSnapshot | null;
  /** Read the figures again. Stable, so a caller may list it as a dependency. */
  refresh(): Promise<void>;
  /**
   * Turn collection on or off, then read what it did or did not find. Answers with the result and
   * the settings payload the toggle came back with — the settings state belongs to the caller.
   */
  collect(on: boolean): Promise<{ ok: boolean; message?: string; settings: SettingsPayload }>;
}

export function useUsage(): Usage {
  const [status, setStatus] = useState<StatusSnapshot | null>(null);
  const refresh = useCallback(async () => { setStatus(await api.status()); }, []);
  // Figures the endpoint fetched after a poll answered arrive here rather than a poll later.
  useEffect(() => api.onStatus(setStatus), []);
  const collect = useCallback(async (on: boolean) => {
    const result = await api.setUsageHook(on);
    await refresh();
    return result;
  }, [refresh]);
  return { status, refresh, collect };
}

/** Named here so the screen can say exactly which file it writes. */
const HOOK_SCRIPT_NAME = navigator.userAgent.includes("Windows") ? "hangar-usage.cmd" : "hangar-usage.sh";

/** When the figures were last written, in the language on screen. */
function usageWhen(t: ReturnType<typeof useText>, ms: number): string {
  const { key, vars } = sinceParts(ms);
  return key === "since.absolute" ? formatTime(ms) : t(key, vars as Record<string, number>);
}

/**
 * The settings card body for the status strip: which rate-limit windows the gauges show.
 * Unticking them all is how the usage segment is turned off — there is no separate switch to
 * disagree with. Each window appears only when Claude Code reports it, so a tick here is "show it
 * when there is one", not "invent one".
 */
export function StatusSettings({ status, onChange }: { status: StatusConfig; onChange(status: StatusConfig): void }) {
  const t = useText();
  const chosen = status.windows;
  return (
    <>
      <div className="text-[11px] text-bone-500 pt-1">{t("settings.status.windows")}</div>
      {RATE_WINDOWS.map(({ key, label }) => {
        const on = chosen === null || chosen.includes(key);
        return (
          <label key={key} className="flex items-center gap-2 px-3 py-1.5 rounded-lg hover:bg-ink-700/60">
            <input
              type="checkbox"
              checked={on}
              onChange={() => {
                const current = chosen ?? RATE_WINDOWS.map((w) => w.key);
                const next = on ? current.filter((k) => k !== key) : [...current, key];
                onChange({ ...status, windows: next });
              }}
              className="accent-accent"
            />
            <Truncated as="span" className="text-sm text-bone-100">{label}</Truncated>
          </label>
        );
      })}
      <div className="text-[11px] text-bone-500">{t("settings.status.note")}</div>
      <div className="flex flex-wrap gap-2 mt-2">
        <button
          type="button"
          className={`btn ${chosen === null ? "btn-accent" : ""}`}
          onClick={() => onChange({ ...status, windows: null })}
        >
          {t("settings.status.all")}
        </button>
        <button type="button" className="btn" onClick={() => onChange({ ...status, windows: [] })}>
          {t("settings.status.none")}
        </button>
      </div>
    </>
  );
}

/** The settings card body for collection: how it stands right now, and the switch. */
export function UsageSettings({ usage, onCollect }: { usage: UsageState; onCollect(on: boolean): void }) {
  const t = useText();
  return (
    <>
      <div className="text-xs text-bone-300">{t("settings.usage.what")}</div>
      <div className="flex items-center gap-2">
        <span className={`chip ${usage.collecting ? "text-ok" : ""}`}>
          {usage.collecting ? t("settings.usage.collecting") : t("settings.usage.off")}
        </span>
        <span className="text-[11px] text-bone-500">
          {usage.updatedAt
            ? t("settings.usage.state", { count: usage.reported, when: usageWhen(t, usage.updatedAt) })
            : t("settings.usage.never")}
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={`btn ${usage.collecting ? "" : "btn-accent"}`}
          onClick={() => onCollect(!usage.collecting)}
        >
          {usage.collecting ? t("settings.usage.stop") : t("settings.usage.start")}
        </button>
      </div>
      {/* Saying exactly what is written where: this edits a file the user owns. */}
      <div className="text-[11px] text-bone-500">
        {t("settings.usage.writes", { file: HOOK_SCRIPT_NAME })}
      </div>
      {usage.source === "endpoint" ? (
        <div className="text-[11px] text-bone-500">{t("settings.usage.endpoint")}</div>
      ) : null}
      {/* Why the endpoint has nothing to show, when it has nothing: the login, or a refusal. */}
      {usage.login === "absent" && !usage.updatedAt ? (
        <div className="text-[11px] text-warn">{t("settings.usage.login.absent")}</div>
      ) : null}
      {(usage.login === "expired" || usage.endpointFailure === "stale-token") && !usage.collecting ? (
        <div className="text-[11px] text-warn">{t("settings.usage.login.expired")}</div>
      ) : null}
      {usage.endpointFailure === "rate-limited" ? (
        <div className="text-[11px] text-warn">{t("settings.usage.rateLimited")}</div>
      ) : null}
      {usage.portable && usage.collecting ? (
        <div className="text-[11px] text-warn">{t("settings.usage.portable")}</div>
      ) : null}
      {usage.collecting && !usage.updatedAt && usage.source !== "endpoint" ? (
        <div className="text-[11px] text-warn">{t("settings.usage.waiting")}</div>
      ) : null}
    </>
  );
}

/**
 * One rate-limit window as a gauge — the same card shape as the machine gauges beside it.
 *
 * It used to live in the title bar, where a narrow window cut it off — and a percentage you cannot
 * read is worse than none.
 */
export function UsageCard({ window: usage, className = "", compact = false }: {
  window: RateWindow;
  className?: string;
  compact?: boolean;
}) {
  const t = useText();
  const [box, boxWidth] = useElementWidth<HTMLDivElement>();
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => setNarrow((was) => isNarrow(boxWidth, was)), [boxWidth]);
  const tone = usage.usedPercent >= 80 ? "bg-bad" : usage.usedPercent >= 50 ? "bg-warn" : "bg-ok";
  const reset = usage.resetsAt ? resetLabel(usage.resetsAt) : "";
  const title = usage.resetsAt
    ? t("tip.usageResets", {
      label: usage.label,
      percent: formatPercent(usage.usedPercent),
      left: resetRemaining(usage.resetsAt),
      clock: formatClock(usage.resetsAt),
    })
    : t("tip.usage", { label: usage.label, percent: formatPercent(usage.usedPercent) });

  if (narrow) {
    return (
      <div ref={box} className={`card p-1 ${className}`} title={title}>
        <div className="text-[10px] text-bone-400 text-center whitespace-nowrap">{usage.short}</div>
        <UprightBar percent={usage.usedPercent} tone={tone} />
        <div className={`mt-1 text-[10px] font-medium tabular-nums text-center ${usageTone(usage.usedPercent)}`}>
          {formatPercent(usage.usedPercent)}
        </div>
        {/* Standing the card up must not cost the only thing the gauge is asked: how long until it frees up. */}
        {usage.resetsAt ? (
          <div data-testid="usage-reset" className="text-[10px] text-bone-400 tabular-nums text-center whitespace-nowrap">
            ↻ {resetRemaining(usage.resetsAt)}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div ref={box} className={`card ${compact ? "p-1.5" : "p-3"} ${className}`} title={title}>
      <div className="flex items-baseline justify-between gap-2">
        <Truncated as="span" className={`${compact ? "text-[11px]" : "text-xs"} text-bone-400`}>{usage.label}</Truncated>
        <span className={`${compact ? "text-xs" : "text-sm"} font-semibold tabular-nums ${usageTone(usage.usedPercent)}`}>
          {formatPercent(usage.usedPercent)}
        </span>
      </div>
      <div className={`${compact ? "mt-1" : "mt-2"} h-2.5 rounded-full bg-ink-600 overflow-hidden`}>
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${Math.max(2, Math.min(100, usage.usedPercent))}%` }} />
      </div>
      {reset ? (
        <Truncated testId="usage-reset" className={`${compact ? "mt-0.5" : "mt-1"} text-[11px] text-bone-400 tabular-nums`}>
          ↻ {reset}
        </Truncated>
      ) : null}
    </div>
  );
}

/**
 * Every window Claude Code reports and the settings let through, as gauges. Nothing when there is
 * none — which is also how the segment is turned off. Independent of the machine gauges: those
 * come and go with monitoring, these with the usage settings.
 */
export function UsageGauges({ windows, compact = false }: { windows: RateWindow[]; compact?: boolean }) {
  return <>{windows.map((usage) => <UsageCard key={usage.key} window={usage} compact={compact} />)}</>;
}
