/**
 * The pieces every settings card is made of.
 *
 * Shared by the shell's cards and the features' own, so the screen reads as one whoever drew each
 * card.
 */
import type { ReactNode } from "react";

/** A card: its ring says the keyboard is inside it, wherever Tab has taken it. */
export function Card({
  title, hint, body = "space-y-1", children,
}: {
  title: string;
  hint?: string;
  /** The body's spacing class; the cards differ in how much air their rows want. */
  body?: string;
  children: ReactNode;
}) {
  return (
    <section className="card p-4 transition-colors focus-within:ring-1 focus-within:ring-accent/50">
      <div className="flex items-baseline justify-between gap-3 mb-3">
        {/* The title never wraps: a long hint beside it wraps instead. */}
        <h3 className="shrink-0 whitespace-nowrap text-sm font-medium text-bone-100">{title}</h3>
        {hint ? <span className="min-w-0 text-right text-[11px] text-bone-500">{hint}</span> : null}
      </div>
      <div className={body}>{children}</div>
    </section>
  );
}

export function Choice({
  label, note, selected, onSelect, disabled = false,
}: {
  label: string;
  note?: string;
  selected: boolean;
  onSelect: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      className={`w-full text-left px-3 py-2 rounded-lg border transition-colors ${
        selected ? "border-accent/60 bg-accent/10" : "border-transparent hover:bg-ink-700/60"
      } ${disabled ? "opacity-40 cursor-not-allowed" : ""}`}
    >
      <div className="flex items-center gap-2">
        <span className={`w-3.5 h-3.5 rounded-full border ${selected ? "border-accent bg-accent" : "border-ink-500"}`} />
        <span className="text-sm text-bone-100">{label}</span>
      </div>
      {note ? <div className="pl-5 text-[11px] text-bone-500">{note}</div> : null}
    </button>
  );
}
