/**
 * Claude Code's usage figures — the page side.
 *
 * Owns the snapshot the gauges draw from and the way it changes: a re-read, on a poll or when the
 * main side says fresh figures landed. The settings card's body is here too — one switch — and the
 * gauges themselves (`UsageGauges`): what a screen
 * places is one component, and what it shows is this feature's business alone.
 */
import { useCallback, useEffect, useLayoutEffect, useState } from "react";

import { RATE_WINDOWS } from "@core/constants";
import type { RateWindow, StatusConfig, StatusSnapshot } from "@core/types";

import { api } from "../../renderer/api";
import { fitsUpright, isNarrow, UprightBar, useElementWidth } from "../../renderer/components/Chart";
import { Choice } from "../../renderer/components/SettingsCard";
import { Truncated } from "../../renderer/components/Truncated";
import { formatClock, formatPercent, formatTime, resetLabel, resetRemaining, sinceParts, usageTone } from "../../renderer/format";
import { useText } from "../../renderer/useText";
import type { UsageState } from "./contract";

export interface Usage {
  /** The windows as last read; null until the first read has answered. */
  status: StatusSnapshot | null;
  /** Read the figures again. Stable, so a caller may list it as a dependency. */
  refresh(): Promise<void>;
}

export function useUsage(): Usage {
  const [status, setStatus] = useState<StatusSnapshot | null>(null);
  const refresh = useCallback(async () => { setStatus(await api.status()); }, []);
  // Figures the endpoint fetched after a poll answered arrive here rather than a poll later.
  useEffect(() => api.onStatus(setStatus), []);
  return { status, refresh };
}

/**
 * The usage card's body: on or off.
 *
 * On shows every window Claude Code reports, off shows none and stops the app asking for them at
 * all. The config still holds a list of windows, so a machine that ticked some of them under an
 * older version keeps exactly those: "on" is any non-empty choice, and choosing it again leaves
 * that choice alone rather than widening it. Under the two, only what explains a blank gauge:
 * still reading, no login, a login that ran out, or the endpoint refusing for the moment.
 */
export function UsageSettings({ status, onChange, usage }: { status: StatusConfig; onChange(status: StatusConfig): void; usage: UsageState }) {
  const t = useText();
  const on = status.windows === null || status.windows.length > 0;
  return (
    <>
      <Choice
        label={t("settings.usage.on")}
        note={t("settings.usage.on.note")}
        selected={on}
        onSelect={() => { if (!on) onChange({ ...status, windows: null }); }}
      />
      <Choice
        label={t("settings.usage.off")}
        note={t("settings.usage.off.note")}
        selected={!on}
        onSelect={() => { if (on) onChange({ ...status, windows: [] }); }}
      />
      {on && !usage.updatedAt && usage.login === "fresh" && !usage.endpointFailure ? (
        <div className="text-[11px] text-bone-500">{t("settings.usage.loading")}</div>
      ) : null}
      {on && usage.login === "absent" && !usage.updatedAt ? (
        <div className="text-[11px] text-warn">{t("settings.usage.login.absent")}</div>
      ) : null}
      {on && (usage.login === "expired" || usage.endpointFailure === "stale-token") ? (
        <div className="text-[11px] text-warn">{t("settings.usage.login.expired")}</div>
      ) : null}
      {on && usage.endpointFailure === "rate-limited" ? (
        <div className="text-[11px] text-warn">{t("settings.usage.rateLimited")}</div>
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
  // Every gauge is a handle on the whole reading: the endpoint answers for all windows at once, and
  // the main side tells every card when it has.
  const refreshNow = (): void => void api.refreshUsage();

  if (narrow) {
    // "1w Fable" where it fits, "Fable" where only one word does; "↻ 2h 15m" where it fits, and
    // nothing where "↻ 1d 12h 30m" would run into the next card — each measured against this card.
    const remaining = usage.resetsAt ? `↻ ${resetRemaining(usage.resetsAt)}` : "";
    return (
      <div ref={box} className={`card p-1 flex flex-col ${className}`} title={title} onDoubleClick={refreshNow}>
        <div className="text-[10px] text-bone-400 text-center whitespace-nowrap">{fitsUpright(usage.short, boxWidth) ? usage.short : usage.brief}</div>
        <UprightBar percent={usage.usedPercent} tone={tone} />
        <div className={`mt-1 text-[10px] font-medium tabular-nums text-center ${usageTone(usage.usedPercent)}`}>
          {formatPercent(usage.usedPercent)}
        </div>
        {/* Standing the card up must not cost the only thing the gauge is asked: how long until it
            frees up — until the card is too narrow even for that, when a time written over the next
            card's number answers nothing. The percentage stays, and the tooltip keeps the time. */}
        {remaining && fitsUpright(remaining, boxWidth) ? (
          <div data-testid="usage-reset" className="text-[10px] text-bone-400 tabular-nums text-center whitespace-nowrap">
            {remaining}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div ref={box} className={`card ${compact ? "p-1.5" : "p-3"} ${className}`} title={title} onDoubleClick={refreshNow}>
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
