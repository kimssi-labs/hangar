/**
 * The caption buttons, drawn by us.
 *
 * Minimise, maximise and close are the window's own. Anything else a feature wants beside them —
 * the dock button, today — arrives through `slot`: this component does not know what a band is,
 * and a feature that changes what its button means changes its own file, not this one.
 */
import type { ReactNode } from "react";

import { useText } from "../useText";

export interface WindowControlsProps {
  /** The window is maximised: the middle button offers its old size back. */
  maximized: boolean;
  onMinimize: () => void;
  /** Maximise, or restore when already maximised. */
  onMaximize: () => void;
  onClose: () => void;
  /** Kept above every other window: the pin is pressed in. */
  onTop: boolean;
  onPin: () => void;
  /** A feature's own button, drawn before the window's three. */
  slot?: ReactNode;
}

const BUTTON = "no-drag grid h-8 w-11 place-items-center text-bone-400 transition-colors";

export function WindowControls({ maximized, onMinimize, onMaximize, onClose, onTop, onPin, slot }: WindowControlsProps) {
  const t = useText();
  return (
    <div className="flex shrink-0 self-start">
      <button
        type="button"
        aria-label={onTop ? t("tip.unpin") : t("tip.pin")}
        aria-pressed={onTop}
        title={onTop ? t("tip.unpin") : t("tip.pin")}
        onClick={onPin}
        className={`${BUTTON} hover:bg-ink-700 hover:text-bone-100 ${onTop ? "text-accent" : ""}`}
      >
        {/* A push pin: upright and filled while the window is kept on top, tilted and hollow when not. */}
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" fill={onTop ? "currentColor" : "none"}
          stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" strokeLinecap="round">
          <g transform={onTop ? undefined : "rotate(45 6 6)"}>
            <path d="M4 1h4l-.6 3.4L9.5 6.5h-7l2.1-2.1z" />
            <path d="M6 6.5V11" fill="none" />
          </g>
        </svg>
      </button>
      {slot}

      <button type="button" aria-label={t("tip.minimise")} title={t("tip.minimise")} onClick={onMinimize}
        className={`${BUTTON} hover:bg-ink-700 hover:text-bone-100`}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0 5h10" stroke="currentColor" strokeWidth="1" />
        </svg>
      </button>

      <button
        type="button"
        aria-label={maximized ? t("tip.restore") : t("tip.maximise")}
        title={maximized ? t("tip.restore") : t("tip.maximise")}
        onClick={onMaximize}
        className={`${BUTTON} hover:bg-ink-700 hover:text-bone-100`}
      >
        {maximized ? (
          // Two overlapping frames: the same glyph Windows uses for "restore down".
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1">
            <path d="M2.5 2.5V0.5h7v7h-2" />
            <rect x="0.5" y="2.5" width="7" height="7" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1">
            <rect x="0.5" y="0.5" width="9" height="9" />
          </svg>
        )}
      </button>

      <button type="button" aria-label={t("tip.close")} title={t("tip.close")} onClick={onClose}
        className={`${BUTTON} hover:bg-bad hover:text-white`}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" stroke="currentColor" strokeWidth="1">
          <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" />
        </svg>
      </button>
    </div>
  );
}
