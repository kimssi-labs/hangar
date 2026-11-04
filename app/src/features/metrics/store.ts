/**
 * The series the graphs are drawn from, held outside React.
 *
 * A sample lands every second. Held as state at the top of the window, each one re-rendered every
 * row, label and pane on screen to move two lines on a canvas; held here, a sample reaches only the
 * components that subscribed to a reading (`useSyncExternalStore`), and a series that did not
 * change keeps its array, so nothing that drew it draws again.
 *
 * Pure on purpose — no DOM, no bridge — so the rules are tested without a window.
 */
import type { MetricSample, MetricsSnapshot } from "@core/types";

/** Samples a series keeps; older ones fall off the left of the graph. */
export const HISTORY_LIMIT = 300;

/** One shared empty series, so "nothing to draw" is the same value every time it is asked for. */
export const NO_SAMPLES: readonly MetricSample[] = Object.freeze([]) as readonly MetricSample[];

export interface MetricsState {
  system: MetricSample[];
  sessions: Record<string, MetricSample[]>;
  /** Not part of the history: a clock speed is a reading of right now, not a series. */
  cpuGhz: number | null;
  /** What the machine has, as the sampler reports it — the ceiling the memory graph is drawn to. */
  memoryTotal: number;
  /** Monitoring switched on in Settings; off, every reading reads as nothing. */
  on: boolean;
}

/** `series` with `sample` on the end, capped — one copy, where spread-then-slice made two. */
export function appendCapped(series: readonly MetricSample[], sample: MetricSample, limit = HISTORY_LIMIT): MetricSample[] {
  const next = series.length >= limit ? series.slice(series.length - limit + 1) : series.slice();
  next.push(sample);
  return next;
}

export interface MetricsStore {
  get(): MetricsState;
  subscribe(listener: () => void): () => void;
  /** The history main kept, replacing what is here: at first paint, and on coming back into view. */
  load(history: { system: MetricSample[]; sessions: Record<string, MetricSample[]> }): void;
  /** One sample from the sampler. Ignored, and false, while the window is not on screen. */
  push(snapshot: MetricsSnapshot): boolean;
  setOn(on: boolean): void;
  /** One session's series, or `NO_SAMPLES` — stable between samples, as a store snapshot must be. */
  sessionSamples(id: string | null): readonly MetricSample[];
}

/**
 * `hidden` says whether the window is out of sight. Main keeps the history regardless, so a sample
 * dropped while hidden is not lost: it comes back with the history reload on becoming visible.
 */
export function createMetricsStore(hidden: () => boolean = () => false): MetricsStore {
  let state: MetricsState = { system: [], sessions: {}, cpuGhz: null, memoryTotal: 0, on: true };
  const listeners = new Set<() => void>();
  const set = (next: MetricsState): void => {
    state = next;
    for (const listener of listeners) listener();
  };
  return {
    get: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    load(history) {
      const sessions: Record<string, MetricSample[]> = {};
      for (const [id, samples] of Object.entries(history.sessions)) sessions[id] = samples.slice(-HISTORY_LIMIT);
      set({ ...state, system: history.system.slice(-HISTORY_LIMIT), sessions });
    },
    push(snapshot) {
      if (hidden()) return false;
      const sessions: Record<string, MetricSample[]> = {};
      for (const [id, usage] of Object.entries(snapshot.sessions)) {
        sessions[id] = appendCapped(state.sessions[id] ?? NO_SAMPLES, { at: snapshot.at, cpu: usage.cpu, memoryBytes: usage.memoryBytes });
      }
      set({
        ...state,
        cpuGhz: snapshot.system.cpuGhz,
        memoryTotal: snapshot.system.memoryTotalBytes,
        system: appendCapped(state.system, { at: snapshot.at, cpu: snapshot.system.cpu, memoryBytes: snapshot.system.memoryBytes }),
        sessions,
      });
      return true;
    },
    setOn(on) {
      if (on !== state.on) set({ ...state, on });
    },
    sessionSamples: (id) => (state.on && id ? state.sessions[id] ?? NO_SAMPLES : NO_SAMPLES),
  };
}
