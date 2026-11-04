/**
 * The app's own dialog: asking a question in the window rather than in a box the OS drew.
 *
 * Two reasons it exists. Electron does not implement `window.prompt` at all, so asking for a branch
 * name that way returned nothing and the feature quietly did not work. And the native message box
 * is the system's own light or dark, which beside a dark window looks like a different program.
 *
 * It is deliberately small: a question, an optional field, two buttons. Anything more elaborate is a
 * screen, not a dialog.
 */
import { useEffect, useRef, useState } from "react";

import { useText } from "../useText";

export interface Ask {
  title: string;
  /** The sentence under the title; may be several lines. */
  detail?: string;
  /** Present when the dialog asks for a value rather than a yes or no. */
  input?: { placeholder?: string; initial?: string };
  confirm: string;
  /** Red confirm button, for a question whose yes cannot be taken back. */
  danger?: boolean;
}

/**
 * Resolves with the typed value, `true` for a plain confirmation, or null when dismissed.
 *
 * One resolution type for both shapes keeps the caller to a single `if`.
 */
export type AskResult = string | true | null;

/**
 * Puts the keyboard back where it was before a question took it, once the question is gone.
 *
 * Read while rendering, before the window behind is made inert and loses the focus; given back
 * after the question has left, once the window behind takes the focus again.
 */
export function useReturnFocus(): void {
  const [returnTo] = useState(() => document.activeElement);
  useEffect(() => () => {
    if (returnTo instanceof HTMLElement && returnTo.isConnected) returnTo.focus();
  }, [returnTo]);
}

export function Modal({ ask, onDone }: { ask: Ask; onDone: (result: AskResult) => void }) {
  const t = useText();
  const [value, setValue] = useState(ask.input?.initial ?? "");
  const field = useRef<HTMLInputElement>(null);
  useReturnFocus();

  // The field, or the confirm button, has focus the moment the dialog appears: a dialog that has to
  // be clicked before it can be typed into is a dialog that interrupts twice.
  useEffect(() => { field.current?.focus(); field.current?.select(); }, []);

  const confirm = (): void => {
    if (!ask.input) onDone(true);
    else if (value.trim()) onDone(value.trim());
  };

  return (
    <div
      className="absolute inset-0 z-50 bg-ink-900/80 flex items-center justify-center p-6"
      onClick={() => onDone(null)}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={ask.title}
        // Focusable, so a click on the dialog's own text keeps the keyboard in it.
        tabIndex={-1}
        className="card p-4 w-[26rem] max-w-full outline-none"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          // The dialog's keys are the dialog's: nothing behind it hears them.
          event.stopPropagation();
          if (event.key === "Escape") {
            event.preventDefault();
            onDone(null);
          } else if (event.key === "Enter" && !event.shiftKey && !(event.target instanceof HTMLButtonElement)) {
            // Enter confirms from the field; on a button it presses that button, as Enter does.
            event.preventDefault();
            confirm();
          } else if (event.key === "Tab") {
            // Round the dialog's own controls, never out of it.
            const stops = [...event.currentTarget.querySelectorAll<HTMLElement>("input, button:not(:disabled)")];
            const edge = event.shiftKey ? stops[0] : stops[stops.length - 1];
            if (document.activeElement === edge || document.activeElement === event.currentTarget) {
              event.preventDefault();
              (event.shiftKey ? stops[stops.length - 1] : stops[0])?.focus();
            }
          }
        }}
      >
        <h2 className="text-sm font-medium text-bone-100">{ask.title}</h2>
        {ask.detail ? (
          <p className="mt-2 text-xs text-bone-400 whitespace-pre-line break-words">{ask.detail}</p>
        ) : null}
        {ask.input ? (
          <input
            ref={field}
            value={value}
            spellCheck={false}
            placeholder={ask.input.placeholder}
            onChange={(event) => setValue(event.target.value)}
            className="mt-3 w-full bg-ink-800 border border-ink-600 rounded-lg px-3 py-1.5 text-sm placeholder:text-bone-500 focus:border-accent/60"
          />
        ) : null}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="btn" onClick={() => onDone(null)}>{t("dialog.cancel")}</button>
          <button
            type="button"
            // On mount only: focused again on every render, a Tab to Cancel was undone by the next
            // repaint of the window behind, and Enter then confirmed.
            autoFocus={!ask.input}
            className={`btn ${ask.danger ? "bg-bad/90 text-ink-900 border-transparent font-medium hover:bg-bad" : "btn-accent"}`}
            disabled={Boolean(ask.input) && !value.trim()}
            onClick={confirm}
          >
            {ask.confirm}
          </button>
        </div>
      </div>
    </div>
  );
}
