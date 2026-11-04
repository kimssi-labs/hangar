/**
 * Updates — the page side.
 *
 * The updater's state as main pushes it, the three commands, and the settings card that shows
 * them. The state is held at the window's level rather than the card's: a download runs while the
 * settings screen is closed, and the card should show where it got to when it is opened again.
 */
import { useCallback, useEffect, useState } from "react";

import { actionLabel, describe as describeUpdate, initialState, type UpdateState } from "@core/updates";

import { api } from "../../renderer/api";
import { Choice } from "../../renderer/components/SettingsCard";
import { Truncated } from "../../renderer/components/Truncated";
import { useText } from "../../renderer/useText";
import type { UpdateCommand } from "./contract";

export interface Updates {
  state: UpdateState;
  /** Check, download, or restart into what was downloaded. The answer replaces the state. */
  act(command: UpdateCommand): void;
}

/** `version` is the app's own, known once appInfo has answered; the state names it as "current". */
export function useUpdates(version: string | undefined): Updates {
  const [state, setState] = useState<UpdateState>(() => initialState("", true));
  // A download runs for a while; the screen learns about it as it happens rather than on reopen.
  useEffect(() => api.onUpdate(setState), []);
  useEffect(() => {
    if (version) setState((previous) => ({ ...previous, current: version }));
  }, [version]);
  const act = useCallback((command: UpdateCommand) => { void api.updateAction(command).then(setState); }, []);
  return { state, act };
}

/** The settings card body: the switch, and the one button that does whatever comes next. */
export function UpdatesSettings({ automatic, onChange, updates }: {
  automatic: boolean;
  onChange(automatic: boolean): void;
  updates: Updates;
}) {
  const t = useText();
  const { state, act } = updates;
  const next: UpdateCommand = state.phase === "ready" ? "install" : state.phase === "available" ? "download" : "check";
  return (
    <>
      <Choice
        label={t("settings.updates.auto")}
        note={t("settings.updates.auto.note")}
        selected={automatic}
        onSelect={() => onChange(true)}
      />
      <Choice
        label={t("settings.updates.manual")}
        note={t("settings.updates.manual.note")}
        selected={!automatic}
        onSelect={() => onChange(false)}
      />
      <div className="flex items-center gap-2 pt-1">
        <button
          type="button"
          className={`btn ${state.phase === "ready" ? "btn-accent" : ""}`}
          disabled={state.phase === "checking" || state.phase === "downloading" || state.phase === "unsupported"}
          onClick={() => act(next)}
        >
          {t(actionLabel(state))}
        </button>
        <Truncated className="text-[11px] text-bone-400 flex-1">{t(describeUpdate(state).key, describeUpdate(state).vars)}</Truncated>
      </div>
    </>
  );
}

/**
 * The question asked as the app opens when a newer version is out: what is happening with it in
 * words that fit — found, downloading, or downloaded — and yes restarts into it as soon as it can.
 * "Not for a week" goes with the no.
 */
export function UpdatePrompt({ state, onAnswer }: {
  state: UpdateState;
  /** Yes or no, and whether the box asking not to be asked for a week was ticked. */
  onAnswer(yes: boolean, snooze: boolean): void;
}) {
  const t = useText();
  const [snooze, setSnooze] = useState(false);
  const key = state.phase === "ready" ? "update.prompt.ready" : state.phase === "downloading" ? "update.prompt.downloading" : "update.prompt.available";
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") { event.preventDefault(); onAnswer(false, snooze); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onAnswer, snooze]);
  return (
    <div role="dialog" aria-modal="true" aria-label={t("update.prompt.title")}
      className="absolute inset-0 z-50 bg-ink-900/80 flex items-center justify-center p-6">
      <div className="card w-[28rem] max-w-full overflow-hidden">
        <div className="flex items-start gap-3 p-4">
          {/* A download arrow in a circle: the kind of message this is, at a glance. */}
          <svg width="32" height="32" viewBox="0 0 32 32" aria-hidden="true" className="shrink-0 text-accent">
            <circle cx="16" cy="16" r="15" fill="currentColor" />
            <path d="M16 8v11M11 15l5 5 5-5M10 23h12" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <div className="min-w-0">
            <h2 className="text-sm font-medium text-bone-100">{t("update.prompt.title")}</h2>
            <p className="mt-1 text-xs text-bone-300 whitespace-pre-line">{t(key, { version: state.latest ?? "", current: state.current })}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 px-4 py-3 border-t border-ink-600 bg-ink-800/60">
          <label className="flex items-center gap-1.5 text-[11px] text-bone-400 cursor-pointer select-none">
            <input type="checkbox" checked={snooze} onChange={(event) => setSnooze(event.target.checked)} />
            {t("update.prompt.snooze")}
          </label>
          <div className="flex-1" />
          <button type="button" className="btn btn-accent" ref={(node) => node?.focus()} onClick={() => onAnswer(true, false)}>
            {t("update.prompt.yes")}
          </button>
          <button type="button" className="btn" onClick={() => onAnswer(false, snooze)}>{t("update.prompt.no")}</button>
        </div>
      </div>
    </div>
  );
}
