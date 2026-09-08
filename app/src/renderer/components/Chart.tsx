/**
 * The chart primitives this app needs, drawn on a canvas — and nothing about what they show.
 *
 * A charting library would be a dependency and a bundle for two shapes: a sparkline in a row and
 * one area chart per resource. Canvas keeps it to a few lines and, more importantly, keeps the
 * drawing pixel-exact at any DPI, which a stretched SVG does not.
 *
 * What is drawn here belongs to the features: the machine gauges are `features/metrics`, the
 * Claude usage gauges `features/usage`. This file knows neither, so a change to one cannot reach
 * the other through it (pinned by the boundaries test).
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import type { MetricSample } from "@core/types";

import { useText } from "../useText";
import { Truncated } from "./Truncated";

const ACCENT = "#d97757";
const ACCENT_SOFT = "rgba(217, 119, 87, 0.18)";

/** A palette token as a canvas colour — the grid has to invert with the theme like everything else. */
function token(name: string, alpha: number): string {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const channels = raw ? raw.split(/\s+/).join(", ") : "128, 128, 128";
  return `rgba(${channels}, ${alpha})`;
}

function useCanvas(draw: (context: CanvasRenderingContext2D, width: number, height: number) => void): React.RefObject<HTMLCanvasElement> {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ratio = window.devicePixelRatio || 1;
    const { clientWidth, clientHeight } = canvas;
    canvas.width = Math.max(1, Math.round(clientWidth * ratio));
    canvas.height = Math.max(1, Math.round(clientHeight * ratio));
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, clientWidth, clientHeight);
    draw(context, clientWidth, clientHeight);
  });
  return ref;
}

function path(
  context: CanvasRenderingContext2D,
  values: number[],
  width: number,
  height: number,
  max: number,
): void {
  const step = values.length > 1 ? width / (values.length - 1) : width;
  values.forEach((value, index) => {
    const x = index * step;
    const y = height - (Math.min(value, max) / max) * height;
    if (index === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  });
}

export function Sparkline({ samples, field = "cpu", max = 100, className = "w-24" }: {
  samples: MetricSample[];
  /** What to plot. Memory is plotted against its own peak — the shape, with the number beside it. */
  field?: "cpu" | "memoryBytes";
  max?: number;
  className?: string;
}) {
  const ref = useCanvas((context, width, height) => {
    // A shared floor, so the two sparklines of a row read as one instrument: without it, an idle
    // CPU line sat ON the bottom border while a flat memory line sat ON the top one, and the pair
    // looked broken rather than merely different.
    context.strokeStyle = token("--text", 0.18);
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(0, height - 0.5);
    context.lineTo(width, height - 0.5);
    context.stroke();

    if (samples.length < 2) return;
    const values = samples.map((s) => (field === "cpu" ? s.cpu : s.memoryBytes));
    // CPU is absolute. Memory has no ceiling a row this small can honour, so it is drawn to its
    // own peak — with headroom, or a steady footprint is a line pinned to the canvas's top edge.
    const ceiling = field === "cpu"
      ? Math.max(max, ...values) || 1
      : (Math.max(...values) || 1) * 1.25;
    const pad = 1.5;                               // keep the stroke inside the canvas at 0 and 100 %
    const usable = Math.max(1, height - pad * 2);
    const step = values.length > 1 ? width / (values.length - 1) : width;
    context.beginPath();
    values.forEach((value, index) => {
      const x = index * step;
      const y = pad + (1 - Math.min(value, ceiling) / ceiling) * usable;
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    context.strokeStyle = ACCENT;
    context.lineWidth = 1.5;
    context.stroke();
  });
  return <canvas ref={ref} className={`h-6 ${className}`} />;
}

/**
 * How wide the element actually is, so a card can decide its own shape.
 *
 * A card in the aside is a different width in every layout, and in a docked band the user drags
 * that width while looking at it — a breakpoint on the window would be measuring the wrong thing.
 */
export function useElementWidth<T extends HTMLElement>(): [React.RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    setWidth(element.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 0));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/** Under this, a label and its number cannot sit on one line without touching. */
export const NARROW_CARD = 132;
/**
 * ...and this much wider before it goes back to lying across.
 *
 * One threshold oscillated: standing a card up frees width, which put it back over the line, which
 * laid it down again — a card at the boundary flickered between the two shapes forever. The gap
 * has to be wider than the width the change itself gives back.
 */
export const WIDE_CARD = 168;

/** Which shape a card should be, given the shape it is in now — sticky at the boundary. */
export function isNarrow(width: number, wasNarrow: boolean): boolean {
  if (width <= 0) return wasNarrow;                       // not measured yet: do not flip on a guess
  return wasNarrow ? width < WIDE_CARD : width < NARROW_CARD;
}

/** What an upright card's width loses to its own padding and border before any text can use it. */
export const CARD_INSET = 10;
/** Tabular digits and the ↻ glyph run a little wider on the page than a canvas measures them. */
const FIT_MARGIN = 2;
let measurer: CanvasRenderingContext2D | null | undefined;
let smallType: string | undefined;

/**
 * The width `text` takes in the card's small type, measured rather than guessed.
 *
 * Whether the reset time fits is a different question for "2h 15m" and "1d 12h 30m", and the font
 * is the machine's own. A canvas measures without touching the layout, so nothing here can push
 * the card it is measuring for. Where there is no canvas — tests — the answer is 0: "fits".
 */
export function textWidth(text: string): number {
  if (measurer === undefined) {
    measurer = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
  }
  if (!measurer) return 0;
  smallType ??= `10px ${getComputedStyle(document.body).fontFamily || "sans-serif"}`;
  measurer.font = smallType;
  return measurer.measureText(text).width;
}

/**
 * Whether `text` fits on one line of an upright card `width` wide.
 *
 * A card that has not been measured yet is given the benefit of the doubt, as `isNarrow` gives it:
 * the first paint must not drop a reading on a guess of 0.
 */
export function fitsUpright(text: string, width: number): boolean {
  return width <= 0 || textWidth(text) + FIT_MARGIN <= width - CARD_INSET;
}

/**
 * The upright bar a card falls back to when it is too narrow to read across.
 *
 * It takes whatever height the card has left: a row of cards stands as tall as its tallest, and a
 * card that dropped its second reading for want of width would otherwise end in a blank where that
 * line was. Where nothing stretches the card, the bar is its old 56 px.
 */
export function UprightBar({ percent, tone }: { percent: number; tone: string }) {
  return (
    <div className="mt-1 flex-1 min-h-14 flex justify-center items-stretch">
      <div className="w-3 rounded-full bg-ink-600 overflow-hidden flex items-end">
        <div className={`w-full rounded-full ${tone}`} style={{ height: `${Math.max(3, Math.min(100, percent))}%` }} />
      </div>
    </div>
  );
}

export interface AreaChartProps {
  samples: MetricSample[];
  /** Which field to plot, and the ceiling it is measured against. */
  field: "cpu" | "memoryBytes";
  max: number;
  label: string;
  value: string;
  /** What the value is out of — the machine's memory, say. Dropped first when room runs short. */
  total?: string;
  /** The label a narrow card uses instead; the full one stays in the tooltip. */
  short?: string;
  className?: string;
  /** Half-height, tighter padding — for the bottom strip of a docked column. */
  compact?: boolean;
}

export function AreaChart({ samples, field, max, label, value, total, short, className = "", compact = false }: AreaChartProps) {
  const t = useText();
  const [box, boxWidth] = useElementWidth<HTMLDivElement>();
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => setNarrow((was) => isNarrow(boxWidth, was)), [boxWidth]);
  const ref = useCanvas((context, width, height) => {
    context.strokeStyle = token("--text", 0.08);
    context.lineWidth = 1;
    for (let i = 1; i < 4; i += 1) {
      const y = (height / 4) * i;
      context.beginPath();
      context.moveTo(0, y);
      context.lineTo(width, y);
      context.stroke();
    }
    if (samples.length < 2) return;
    const values = samples.map((s) => (field === "cpu" ? s.cpu : s.memoryBytes));
    const ceiling = Math.max(max, ...values) || 1;

    context.beginPath();
    path(context, values, width, height, ceiling);
    context.strokeStyle = ACCENT;
    context.lineWidth = 1.8;
    context.stroke();

    context.lineTo(width, height);
    context.lineTo(0, height);
    context.closePath();
    context.fillStyle = ACCENT_SOFT;
    context.fill();
  });

  const latest = samples.length ? samples[samples.length - 1] : null;
  const percent = latest
    ? Math.min(100, ((field === "cpu" ? latest.cpu : latest.memoryBytes) / (max || 1)) * 100)
    : 0;

  // "31% · 1.8 GHz" is two readings; upright they go on two lines rather than one that overflows.
  const [head, detail] = value.split(" · ");

  // Too narrow to read a label and a number across: stand the reading up instead of overlapping it.
  if (narrow) {
    return (
      <div ref={box} className={`card p-1 flex flex-col ${className}`} title={total ? t("tip.gaugeOf", { label, value, total }) : t("tip.gauge", { label, value })}>
        <div className="text-[10px] text-bone-400 text-center whitespace-nowrap">{short ?? label}</div>
        <UprightBar percent={percent} tone="bg-accent" />
        <div className="mt-1 text-[10px] font-medium text-bone-100 tabular-nums text-center">
          {head}
        </div>
        {/* The share alone is half the reading: a busy CPU still has a clock, and a percentage of
            memory means nothing without the quantity it is a percentage of. Unless the card has no
            room for it — then the share, alone and legible, beats two readings written over each
            other (measured in a docked band, where "2.2 GHz" ran into the next card's number); the
            tooltip still has both. */}
        {detail && fitsUpright(detail, boxWidth) ? (
          <div className="text-[10px] text-bone-400 tabular-nums text-center whitespace-nowrap">
            {detail}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div ref={box} className={`card ${compact ? "p-1.5" : "p-3"} ${className}`}>
      <div className="flex items-baseline justify-between gap-2">
        <Truncated as="span" className={`${compact ? "text-[11px]" : "text-xs"} text-bone-400`}>{label}</Truncated>
        <span className={`${compact ? "text-xs" : "text-sm"} font-medium text-bone-100 tabular-nums whitespace-nowrap`}>
          {value}
          {total ? <span className="text-bone-500"> / {total}</span> : null}
        </span>
      </div>
      <canvas ref={ref} className={`${compact ? "mt-1 h-7" : "mt-2 h-16"} w-full`} />
    </div>
  );
}
