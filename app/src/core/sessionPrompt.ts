/**
 * What a session opened from Hangar is asked on top of Claude Code's own system prompt.
 *
 * One ask: name local files as links. Claude Code prints a Markdown link as a terminal hyperlink,
 * and Windows Terminal opens a `file:///` one with Ctrl+click in the file's default app, so an
 * output the session wrote is one click away instead of a path to copy. Passed inline with
 * `--append-system-prompt` (core/launcher.ts): that flag is older than its `-file` form, so a
 * machine with an older Claude Code still starts the session. One line, because cmd.exe ends a
 * command at a line break.
 *
 * Measured on Windows: ShellExecute cannot find a percent-encoded non-ASCII path, and a raw one
 * breaks the terminal's link detection, so such a path is linked by its 8.3 short name.
 */
export const APPEND_PROMPT_FLAG = "--append-system-prompt";

const LINK_RULE = [
  "Hangar opened this session, and its user reads your replies in a terminal that opens links with Ctrl+click.",
  "Whenever you name a local file or folder to the user (a file you created or changed, an output, a report, a log,",
  "an installer, a source file), write it as a Markdown link to its absolute path, [name](file:///C:/full/path) with",
  "forward slashes, so it opens in its default app. Keep plain paths only inside code blocks and commands.",
  "Write web addresses as [text](https://...).",
].join(" ");

const WINDOWS_PATHS = [
  "On Windows the URL must be pure ASCII with no spaces, or the link does not open: when the full path has spaces",
  "or non-ASCII characters anywhere, link the 8.3 short path of the file itself, from PowerShell",
  "`(New-Object -ComObject Scripting.FileSystemObject).GetFile('<full path>').ShortPath` (`GetFolder` for a folder),",
  "never a short folder path with the original name appended. Keep the readable name as the link text.",
].join(" ");

const OTHER_PATHS = "Percent-encode spaces and other special characters in the URL; keep the readable name as the link text.";

export function sessionPrompt(platform: NodeJS.Platform): string {
  return `${LINK_RULE} ${platform === "win32" ? WINDOWS_PATHS : OTHER_PATHS}`;
}
