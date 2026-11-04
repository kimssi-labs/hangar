/**
 * CPU and memory — the page side.
 *
 * Owns the series the graphs are drawn from: the machine's, and one per running session (store.ts).
 * Filled from the history at first paint and on coming back into view, then extended on every
 * sample the main process pushes — and
 * the machine gauges themselves (`MachineGauges`): CPU with its clock, memory with its total. A
 * screen places one component; adding a reading (a disk, a GPU) is a change here and nowhere else.
 */
import { useCallback, useEffect, useSyncExternalStore } from "react";

import type { MetricSample, MetricsSnapshot } from "@core/types";

import { api } from "../../renderer/api";
import { AreaChart } from "../../renderer/components/Chart";
import { Choice } from "../../renderer/components/SettingsCard";
import { formatBytes } from "../../renderer/format";
import { useText } from "../../renderer/useText";
import { createMetricsStore, type MetricsState } from "./store";

/** The one store of the window: samples out of sight are dropped, main still has them (store.ts). */
const store = createMetricsStore(() => document.hidden);

/**
 * The feed: the sampler's pushes go into the store, and `load` reads main's history into it — at
 * first paint, and again whenever the window comes back into view. Holds no state of its own, so
 * the component that calls it is not re-rendered by a sample. `on` is the monitoring setting: off,
 * every reading below reads as nothing. `load` is stable.
 */
export function useMetrics(on: boolean): { load(): Promise<void> } {
  useEffect(() => api.onMetrics((snapshot: MetricsSnapshot) => { store.push(snapshot); }), []);
  useEffect(() => store.setOn(on), [on]);
  const load = useCallback(async () => { store.load(await api.metrics()); }, []);
  return { load };
}

/** Everything in the store — for the machine gauges, which change with every sample. */
function useMetricsState(): MetricsState {
  return useSyncExternalStore(store.subscribe, store.get);
}

/** One session's series: re-renders its caller only when that session's series changes. */
export function useSessionSamples(id: string | null): readonly MetricSample[] {
  return useSyncExternalStore(store.subscribe, () => store.sessionSamples(id));
}

/** The settings card body: whether anything is measured at all. */
export function MonitorSettings({ on, onChange }: { on: boolean; onChange(on: boolean): void }) {
  return (
    <>
      <Choice
        label="On"
        note="CPU and memory sampled once a second, in-process"
        selected={on}
        onSelect={() => onChange(true)}
      />
      <Choice
        label="Off"
        note="no sampling at all — the graphs disappear and nothing is measured"
        selected={!on}
        onSelect={() => onChange(false)}
      />
    </>
  );
}

/**
 * The machine's gauges: CPU and memory, each the share first and the quantity behind it — a load
 * without its clock, or a percentage of memory without the gigabytes, is half a reading.
 * `wide` uses the longer labels a side panel has room for.
 */
export function MachineGauges({ compact = false, wide = false }: { compact?: boolean; wide?: boolean }) {
  const t = useText();
  const { system: systemHistory, cpuGhz, memoryTotal } = useMetricsState();
  // The machine's memory when the sampler has said so; until then, the largest reading seen.
  const totalMemory = memoryTotal || (systemHistory.length ? Math.max(...systemHistory.map((s) => s.memoryBytes)) : 1);
  const latestSystem = systemHistory[systemHistory.length - 1] ?? null;
  const cpuValue = latestSystem
    ? `${latestSystem.cpu.toFixed(0)}%${cpuGhz ? ` · ${cpuGhz.toFixed(1)} GHz` : ""}`
    : "\u2014";
  const memoryPercent = latestSystem && totalMemory ? Math.round((latestSystem.memoryBytes / totalMemory) * 100) : null;
  const memoryValue = latestSystem
    ? `${memoryPercent === null ? "" : `${memoryPercent}% · `}${formatBytes(latestSystem.memoryBytes)}`
    : "\u2014";
  return (
    <>
      <AreaChart compact={compact} samples={systemHistory} field="cpu" max={100} label={t(wide ? "gauge.cpuMachine" : "gauge.cpu")} value={cpuValue} />
      <AreaChart
        compact={compact}
        samples={systemHistory}
        field="memoryBytes"
        max={totalMemory}
        label={t(wide ? "gauge.memoryMachine" : "gauge.memory")}
        short={t("gauge.memoryShort")}
        value={memoryValue}
        total={memoryTotal ? formatBytes(memoryTotal) : undefined}
      />
    </>
  );
}
