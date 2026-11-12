/**
 * Settings, as cards.
 *
 * Everything at once, walked with Tab like any page: the card with the keyboard in it wears the ring,
 * and every choice is one Space or Enter away. Each card's body is its feature's, from that
 * feature's `ui.tsx`; this file owns the order of the cards, the draft they all edit, and the three
 * cards that are the window's own.
 */
import { useEffect, useRef, useState } from "react";

import { LAYOUT_MODES, THEME_MODES } from "@core/constants";
import { LANGUAGES, resolveLanguage } from "@core/i18n";
import { ZOOM_LEVELS } from "@core/zoom";

import { PasteSettings } from "../../features/clipboard/ui";
import { DockSettings, KeepIconsSetting } from "../../features/dock/ui";
import { FilesSettings } from "../../features/files/ui";
import { GitSettings } from "../../features/git/ui";
import { MonitorSettings } from "../../features/metrics/ui";
import { LaunchSettings, PermissionSettings } from "../../features/projects/ui";
import { UpdatesSettings, type Updates } from "../../features/updates/ui";
import { UsageSettings } from "../../features/usage/ui";
import type { DisplayInfo, PageName, SettingsPayload } from "../api";
import { useText } from "../useText";
import { Card, Choice } from "./SettingsCard";
import { Truncated } from "./Truncated";

export interface SettingsViewProps {
  settings: SettingsPayload;
  displays: DisplayInfo[];
  onChange: (next: SettingsPayload) => void;
  onApplyDock: (enabled: boolean) => void;
  /** What the machine's language is, so "System" can say which one that is. */
  locale: string;
  /** Open one of the app's known pages in a browser. */
  onOpenPage: (page: PageName) => void;
  /** The updater, as the updates feature keeps it. */
  updates: Updates;
  onClose: () => void;
}

export function SettingsView({ settings, displays, onChange, onApplyDock, onOpenPage, locale, updates, onClose }: SettingsViewProps) {
  const t = useText();
  const [draft, setDraft] = useState(settings);
  // What we last sent, so a push that is only the echo of our own save does not reset the draft
  // out from under someone mid-drag. Anything genuinely new — main undocking us, say — still does.
  const sent = useRef(JSON.stringify(settings));
  useEffect(() => {
    const incoming = JSON.stringify(settings);
    if (incoming === sent.current) return;
    sent.current = incoming;
    setDraft(settings);
  }, [settings]);

  const update = (next: SettingsPayload): void => {
    setDraft(next);
    sent.current = JSON.stringify(next);
    onChange(next);
  };
  /** One section of the draft, replaced; every card writes through this. */
  const section = <K extends keyof SettingsPayload>(key: K) => (value: SettingsPayload[K]): void =>
    update({ ...draft, [key]: value });

  return (
    // Focusable itself, so a click on a card's empty space keeps the keyboard here, where Esc closes.
    <div tabIndex={-1} className="flex-1 overflow-auto p-4 space-y-3 outline-none" onKeyDown={(event) => event.key === "Escape" && onClose()}>
      {/* Esc still closes the screen; a button is for the times the keyboard is not where the hand
          is, and for anyone who never learns that Esc goes back. The keyboard starts on it. */}
      <div className="flex items-center gap-2 min-w-0">
        <button type="button" autoFocus className="btn shrink-0" title={t("settings.back.title")} onClick={onClose} aria-label={t("settings.back")}>
          ← {t("settings.back")}
        </button>
        <Truncated as="span" className="text-[11px] text-bone-500">
          {t("settings.saved")}
        </Truncated>
      </div>

      <Card title={t("settings.appearance")}>
        {THEME_MODES.map((theme) => (
          <Choice
            key={theme}
            label={t(`settings.appearance.${theme}` as const)}
            note={theme === "system" ? t("settings.appearance.system.note") : undefined}
            selected={draft.ui.theme === theme}
            onSelect={() => section("ui")({ ...draft.ui, theme })}
          />
        ))}
      </Card>

      <Card title={t("settings.zoom")} hint={t("settings.zoom.hint")}>
        <div className="flex flex-wrap gap-1" role="radiogroup" aria-label={t("settings.zoom")}>
          {ZOOM_LEVELS.map((zoom) => (
            <button
              key={zoom}
              type="button"
              role="radio"
              aria-checked={draft.ui.zoom === zoom}
              data-testid={`zoom-${Math.round(zoom * 100)}`}
              onClick={() => section("ui")({ ...draft.ui, zoom })}
              className={`px-2 py-0.5 rounded-lg text-xs border ${draft.ui.zoom === zoom
                ? "border-accent/60 bg-accent/15 text-bone-100" : "border-ink-600 text-bone-400 hover:text-bone-100 hover:bg-ink-700/60"}`}
            >
              {Math.round(zoom * 100)}%
            </button>
          ))}
        </div>
      </Card>

      <Card title={t("settings.language")} hint={t("settings.language.hint")}>
        {LANGUAGES.map((language) => (
          <Choice
            key={language.key}
            label={language.label}
            note={language.key === "system"
              ? t("settings.language.system.note", {
                resolved: resolveLanguage("system", locale) === "ko" ? "한국어" : "English",
              })
              : undefined}
            selected={draft.ui.language === language.key}
            onSelect={() => section("ui")({ ...draft.ui, language: language.key })}
          />
        ))}
        <div className="text-[11px] text-bone-500">{t("settings.language.note")}</div>
      </Card>

      <Card title={t("settings.layout")} hint={t("settings.layout.hint")} body="space-y-3">
        <div className="space-y-1">
          {LAYOUT_MODES.map((layout) => (
            <Choice
              key={layout}
              label={t(`settings.layout.${layout}` as const)}
              note={t(`settings.layout.${layout}.note` as const)}
              selected={draft.ui.layout === layout}
              onSelect={() => section("ui")({ ...draft.ui, layout })}
            />
          ))}
        </div>
      </Card>

      <Card title={t("settings.monitor")} hint={t("settings.monitor.hint")}>
        <MonitorSettings on={draft.ui.monitor} onChange={(monitor) => section("ui")({ ...draft.ui, monitor })} />
      </Card>

      <Card title={t("settings.dock")} body="space-y-3">
        <DockSettings
          dock={draft.dock}
          floor={draft.dockFloor}
          minPercent={draft.minPercent}
          displays={displays}
          onChange={section("dock")}
          onApply={onApplyDock}
        />
        <KeepIconsSetting on={draft.ui.keepIcons} onChange={(keepIcons) => section("ui")({ ...draft.ui, keepIcons })} />
      </Card>

      <Card title={t("settings.usage")} hint={t("settings.usage.hint")} body="space-y-2">
        <UsageSettings status={draft.status} onChange={section("status")} usage={settings.usage} />
      </Card>

      <Card title={t("settings.files")} hint={t("settings.files.hint")}>
        <FilesSettings on={draft.ui.files} onChange={(files) => section("ui")({ ...draft.ui, files })} />
        <PaneToggle label={t("settings.pane.skills")} note={t("settings.pane.skills.note")} on={draft.ui.skills}
          onChange={(skills) => section("ui")({ ...draft.ui, skills })} />
        <PaneToggle label={t("settings.pane.artifacts")} note={t("settings.pane.artifacts.note")} on={draft.ui.artifacts}
          onChange={(artifacts) => section("ui")({ ...draft.ui, artifacts })} />
      </Card>

      <Card title={t("settings.git")} hint={t("settings.git.hint")}>
        <GitSettings git={draft.git} available={settings.gitAvailable} onChange={section("git")} onInstall={() => onOpenPage("git")} />
      </Card>

      <Card title={t("settings.updates")} hint={t("settings.updates.hint")} body="space-y-2">
        <UpdatesSettings
          automatic={draft.updates.automatic}
          onChange={(automatic) => section("updates")({ ...draft.updates, automatic })}
          updates={updates}
        />
      </Card>

      <Card title={t("settings.launch")}>
        <LaunchSettings launch={draft.launch} onChange={section("launch")} />
        <PasteSettings launch={draft.launch} hotkeyActive={draft.pasteHotkeyActive} onChange={section("launch")} />
      </Card>

      <Card title={t("settings.permissions")}>
        <PermissionSettings launch={draft.launch} onChange={section("launch")} />
      </Card>
    </div>
  );
}

/** One of the side pane's tabs, on or off — a line with a switch rather than two whole choices. */
function PaneToggle({ label, note, on, onChange }: { label: string; note: string; on: boolean; onChange(on: boolean): void }) {
  return (
    <label className="flex items-start gap-2 pt-2 cursor-pointer">
      <input type="checkbox" checked={on} onChange={(event) => onChange(event.target.checked)} className="mt-0.5 accent-current" aria-label={label} />
      <span className="min-w-0">
        <span className="block text-[12px] text-bone-100">{label}</span>
        <span className="block text-[11px] text-bone-500">{note}</span>
      </span>
    </label>
  );
}
