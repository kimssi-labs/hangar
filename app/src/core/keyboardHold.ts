/**
 * Whether the window may take the keyboard when it is clicked.
 *
 * A docked band sits beside the terminal the user is typing in. Clicking it used to move the
 * keyboard as any window does, which on Windows shows as the taskbar's input indicator turning into
 * an X — the focused window accepts no text — and the next Korean keystrokes went nowhere. Measured
 * on this machine: with the band focused the indicator is X; the terminal takes it back on the next
 * click, sometimes after a detour through the desktop.
 *
 * So a band answers the mouse and leaves the keyboard where it was. It asks for the keyboard only
 * while the page has something to type into — a rename editor, the settings screen, a dialog with a
 * field — and gives it up again when that closes. An undocked window behaves like any other window.
 */
export function windowTakesKeyboard(docked: boolean, needsTyping: boolean): boolean {
  return !docked || needsTyping;
}
