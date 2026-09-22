<img src="app/build/icon.png" width="96" align="right" alt="">

# Hangar

**Session manager for [Claude Code](https://claude.com/claude-code).** Where your sessions are kept
between flights: Hangar lists every project you have ever opened, drills into that project's
sessions, and resumes, renames or deletes them — in one window, by mouse or keyboard, with no LLM
tokens spent.

It can also **dock to a screen edge**: not merely a window parked at the side, but a reserved band
the desktop works around, so a maximised window stops at it instead of covering it.

![Every project you have opened, with what is running right now](docs/screens/projects.png)

## Why

`/resume` shows one flat list of sessions for the current folder. This shows **every project**, what
is running right now, what each session is costing in CPU and memory, and lets you jump straight into
any of them in a new terminal — while the manager stays open for the next one.

Open a project and its sessions are listed with their first prompt, their size and when they were
last written; a running one carries its own CPU and memory line.

![A project's sessions, one of them running](docs/screens/sessions.png)

## Install

Download from [Releases](../../releases):

| Platform | File |
|---|---|
| Windows | `Hangar-Setup-<version>.exe` (installer) or `Hangar-<version>.exe` (portable) |
| Linux | `.AppImage` (any distribution) or `.deb` |

Nothing else is needed — the app only reads files Claude Code already writes, and launches `claude`
from your `PATH`.

From source (Node 20+):

```bash
git clone https://github.com/kimssi-labs/hangar.git
cd hangar/app
npm ci
npm run build && npx electron .      # or: npm run dev
```

Optional — make it a flag on `claude` itself, by adding this to your PowerShell `$PROFILE`:

```powershell
function claude {
    $i = [array]::IndexOf($args, '--p')
    if ($i -lt 0) { & (Get-Command claude -CommandType Application) @args; return }
    $exe = "$env:LOCALAPPDATA\Programs\Hangar\Hangar.exe"          # installed for you
    if (-not (Test-Path $exe)) { $exe = "$env:ProgramFiles\Hangar\Hangar.exe" }   # installed for everyone
    Start-Process $exe
}
```

Then `claude --p` opens the manager. The permission mode sessions start in is a setting
(**Settings · Permissions**), not something the wrapper decides.

## Keys

In a window, everything is reachable from the keyboard; `?` shows this list in the app.

**Docked, the band does not take the keyboard.** Clicking it would otherwise move the keyboard away
from the terminal you are typing in — on Windows the taskbar's input indicator turns into an X and
the next keystrokes go nowhere — so the band answers the mouse and leaves the keyboard where it was.
It takes the keyboard only while it has a field open: renaming, the settings screen, a dialog. The
keys below are therefore for the undocked window; docked, the same verbs are in every row's
right-click menu.

| Key | Projects | Sessions |
|---|---|---|
| `↑` `↓` `PgUp` `PgDn` `Home` `End` | move | move |
| `Enter` | open the project's sessions | resume in a new terminal |
| `O` | new session in a new window | resume in a new window |
| `N` | new session in the project | new session in the project |
| `F2` | set a display alias | rename the session |
| `Del` | delete the project folder | delete the session |
| `V` | save the clipboard image, copy its path | same |
| `/` | search projects | search projects |
| `S` | settings | settings |
| `←` `Esc` | — | back to projects |
| `Tab` | — (settings: next section) | — |
| `F5` / `Ctrl+Q` | refresh / quit | refresh / quit |

A folder that has never had a session is not in the list yet: the **+** beside the search box opens
a folder picker and adds it, ready for **New**. Every row also has a right-click menu with the same
verbs, plus **Pin to top** — a pinned project or session stays at the head of its list, marked with a
pin, until it is unpinned. Deletions ask first and refuse anything still running. Renaming a session writes the same
`custom-title.json` Claude Code's own `/rename` writes, so the new name also shows up in `/resume`.

**`/clear` replaces a row rather than adding one.** Clearing does not empty a session: Claude Code
starts a new session id in the same terminal and leaves the finished transcript on disk. Hangar shows
the conversation as one row — the newest transcript, saying how many came before it — and deleting
that row deletes the earlier transcripts with it, telling you how many first. The pairing is read from what
Claude Code records (the live session registry while Hangar is running, and the previous session's id
inside the new transcript afterwards), so a clear that happened while Hangar was closed folds as well.
A session nobody has named yet, the moment after a clear, reads **Claude Code** until it earns a name.

## The project's files

Beside the lists, Hangar draws the selected project's folder. Where the window has room that is a
tree in a column of its own — in a stacked window it makes three panes, projects, sessions and files,
each resizable — and where it does not, it is the list of files git says changed, which is the
question a session manager is usually asked anyway. The button beside the heading switches between
the two, so a narrow band can still be asked for the whole folder.

Only what is opened is read: a directory when its folder is expanded, never recursively, and a folder
with thousands of entries stops at five hundred and says how many it left out. Changed files are
marked — edited, new, staged, conflicted — from the `git status` the project rows already run.

Double-click opens a file with whatever the machine opens it with; right-click offers open, show in
the file manager, rename, copy path and delete; dragging onto a folder moves it, and dragging onto
the empty space below moves it to the project's root. Deleting goes to the recycle bin and asks
first. Renaming and moving refuse before they write: a name must be a name, nothing may leave the
project, and neither ever replaces a file that is already there.

**Settings · Project files** turns the whole panel off, and then no directory is read at all — worth
having for a project on a network share, where one directory can take seconds to answer.

## Pasting a screenshot

A terminal cannot paste a picture, and Claude Code opens an image by path — so copying a screenshot
normally means saving it somewhere first. Copy one while Hangar is running and **your ordinary paste
key does the rest**: the image is written out and the clipboard is left holding both the picture and
that file's path, so `Ctrl+V` in a terminal pastes the path while `Ctrl+V` in an image editor still
pastes the image. Each window takes the format it understands; nothing is intercepted, so no other
application's paste is touched.

**Settings · Launch** turns it off. **Ctrl+Alt+V** remains for a clipboard that already carries text,
and `V` in Hangar's own window does the same without sending the keystroke.

Images are written to `~/.claude/cache/hangar-clips/`, most recent 50 kept. The automatic path is
Windows-only — elsewhere the shortcut is the way.

## Monitoring

Every running session is sampled once a second — its whole process tree, not just the `claude`
process — and drawn as a sparkline in its row; the machine's own CPU, clock speed and memory are
drawn beside the list. Five minutes of history is kept, which is enough to see whether a session is
working or stuck.

A monitor may not be the reason a machine is busy, so every reading is taken in-process — a toolhelp
snapshot plus `GetProcessTimes` on Windows, `/proc` on Linux, `os.cpus()` for the machine itself —
and on a worker thread, so none of it lands on the thread that draws the window. Sampling costs
about 3 % of one core, and **Settings · Monitoring** turns it off entirely, stopping the timer
rather than just the drawing.

## Layout

The window has four shapes and picks one from its own size, so it works docked as a thin band on any
edge without a scrollbar:

| Shape | When | What it shows |
|---|---|---|
| Full | wide and tall | project list, session list, detail panel, machine graphs; the project's files in a column of their own when there is room for one |
| Compact | narrow | list and graphs, no detail panel; changed files under the sessions |
| Band | short (top/bottom dock) | one strip: list plus graphs |
| Stacked | narrow | project list, its sessions and the graphs, one under the other — three resizable panes when the files have a column |

**Settings · Layout** decides: side by side, stacked, or automatic — which stacks when the window
is narrow. The panes can be dragged to any size; double-click a divider for the default back.

Docked along the top of a screen, the whole thing is one strip — the gauges lie across the end of it
rather than scrolling out of sight:

![The band: list, sessions and gauges in one strip](docs/screens/band.png)

Narrow it instead and the lists stack, the gauges stand upright, and each keeps both of its readings
— the share on one line, the clock speed, the quantity or the time until reset on the next:

<img src="docs/screens/stacked.png" width="430" alt="Stacked: lists one above the other, gauges upright">

## What it reads

Everything comes from files Claude Code maintains under `~/.claude` — Claude Code's own
`CLAUDE_CONFIG_DIR` is followed when it is set, and `CLAUDE_HOME` overrides both:

| Path | Used for |
|---|---|
| `projects/<encoded-path>/*.jsonl` | one transcript per session; the real folder comes from its `cwd` |
| `projects/<encoded-path>/<id>/custom-title.json` | session title set by `/rename` |
| `sessions/*.json` | which sessions are running right now (the ● mark) |
| `history.jsonl` | first prompt of a session, used as its title when it has no custom one |
| `~/.claude.json` | folder path for projects whose transcripts are gone |
| `config/manager.json` | this app's own settings: dock (per monitor), status line, launch, appearance |
| `config/project-aliases.json` | display aliases for projects |
| `cache/hangar-usage.json` | the usage figures, written only from the usage endpoint |
| `cache/hangar-chains.json` | which session replaced which, so a cleared conversation stays one row |
| `cache/hangar-update.log` | what the updater did, kept across restarts |
| `cache/hangar-clips/` | screenshots written out for pasting, most recent 50 kept |

The usage gauges are read the way Claude Code's own `/usage` reads them: from the usage endpoint at
api.anthropic.com, with the login Claude Code keeps in `.credentials.json`. Nothing to set up and no
separate key — and it is a reading, not a model call, so it spends no tokens. The app asks every
minute while a Claude Code session is running and every ten minutes otherwise, never twice within a
minute, and writes the answer to `cache/hangar-usage.json`, a file of its own. The token goes to
api.anthropic.com and nowhere else and is never refreshed or stored by the app; once it has run out
the gauges wait for Claude Code's next run to renew it, and the settings screen says so. On a machine
signed in with an API key rather than a Claude subscription there are no five-hour or weekly windows
to report, and the screen says that too.

Nothing else in Claude Code hands these figures out: no hook event carries them (checked against
2.1.263), and the one place they do go — the status line's stdin — is the user's own. Versions up to
2.15.1 installed a Stop hook meant to read them there; it could not, and a hook an older version
left in `settings.json` is removed at start-up.

Each window shows how much is used and how long until it resets — in every shape, the docked band
included. Wide enough and the clock time it resets at is printed beside it; upright it moves to the
tooltip, which is also where a card's full label goes when it has been shortened.

## Git

A project that is a repository says so on its row: the branch, and how far it is from its upstream —
`main ↑2 ●3`. That much is read straight out of `.git` and costs nothing, so it is on by default.
Counting uncommitted files runs `git status` and is done for the selected project only.

**Update from the base branch** is in a project's right-click menu. The base is fetched into a ref of
its own first, so another fetch cannot move it mid-rebase, and the strategy is yours: rebase, merge,
or fast-forward only. Nothing is pushed, and a conflict stops and leaves the repository to you. It
can also run on a timer — never, only where it fast-forwards cleanly, or with your chosen strategy —
and it always skips a project with a session running in it or with uncommitted changes.

**Worktrees** turn one repository into several places to work. A project's menu can cut a worktree on
a new branch beside the repository, and that folder joins the list as a project of its own, ready for
its own sessions. The branch is created with `--no-track`, so it does not report itself behind a base
it has never been pushed to. Removing a worktree refuses while it holds uncommitted work, and asks
before forcing.

Only the branch line works without git on `PATH`; the rest says so, with a button to install it.

## Updates

Hangar updates itself from its own releases. **Settings · Updates** chooses between checking on a
timer and only when you ask, has a **Check now** button that tells you what it found, and shows a
percentage while downloading. Builds before v2.8.0 carry no update metadata, so this works from that
version onwards; a portable copy and a Linux package say plainly that they cannot replace themselves.

**When it installs depends on where the app lives.** A copy installed for one user
(`%LOCALAPPDATA%\Programs\Hangar`) installs the update itself on the next restart. A copy installed
for everyone (`C:\Program Files\Hangar`) needs administrator rights to be replaced, and the restart
install is silent — with no way to ask for them — so it waits for the button instead, where Windows
can put its prompt on screen. The installer removes the old version before writing the new one, which
is why an update that cannot finish must never be started unattended.

Every step is written to `cache/hangar-update.log` (rolled over at 256 KB), so an update that fails on
a machine you are not sitting at can be read afterwards rather than guessed at. The installers are not
code-signed, so SmartScreen warns on a hand-downloaded one and an antivirus may quarantine it; the log
tells that apart from an install that failed on its own.

## Language

English by default, Korean available, and a new install follows the machine's own language —
**Settings · Language** overrides it. It covers the manager's own text: menus, tooltips, settings and
relative times. What Claude Code itself prints is untouched.

## Settings (`S`)

One screen of cards — **Appearance**, **Language**, **Layout**, **Monitoring**, **Dock**,
**Claude usage**, **Project files**, **Git**, **Updates**, **Launch**, **Permissions**. `Tab` moves
between them, `Esc` closes. Every choice, and the project and row you were last on, is kept in
`config/manager.json`.

![Appearance, layout and monitoring](docs/screens/settings.png)

**Appearance** — light, dark, or system. System follows the OS setting and changes with it, without
a restart.

**Dock** places the manager as a reserved band on a monitor edge — pick the monitor, then the edge,
size and on/off. Dragging the band's inner edge sets its size; dragging the window anywhere else
undocks it. Monitors are remembered by where they are and how big they are, because Electron's
display ids are not the same from one run to the next.

The space is genuinely reserved: on Windows through an application desktop toolbar
(`SHAppBarMessage`), on Linux/X11 through `_NET_WM_STRUT_PARTIAL`, both of which shrink the work area
so maximised windows stop at the band. Wayland has no equivalent an ordinary application may use, so
there the window is positioned but nothing is reserved, and the screen says so.

Every monitor keeps its own edge, size and on/off — a band that suits a portrait display is wrong on
a wide one — and displays with saved settings are marked `(saved)`. Each **arrangement** of monitors
also remembers which of them was docked, so plugging a screen in or out brings back that setup. A window manager may refuse to
shrink below some minimum; the first refusal is measured and becomes the lower bound of the size
setting, so what the screen shows is what docking will give you.

**Claude usage** is one On/Off choice: whether the usage gauges are drawn beside the machine graphs.
A window the endpoint does not report — a machine signed in with an API key has no five-hour or
weekly window — is not drawn either way.

**Launch** picks the terminal and shell that host an opened session: PowerShell 7, Windows
PowerShell, Command Prompt or none on Windows; on Linux the first terminal emulator found, or a named
one. The choice is a preference rather than a demand — on a machine without PowerShell 7 a session
opens in Windows PowerShell, then cmd, and says which it used, so settings carried between machines
still work. **Custom program** is different in kind: name an editor like VS Code and opening a session opens
that program on the project folder instead of a terminal — what runs inside it is its own business.
A missing executable is marked rather than failing when a session is opened.

**Permissions** picks the mode a session starts in — ask (default), bypass, accept edits, plan, or
auto.

## Development

```bash
cd app
npm run dev          # vite + electron, hot reload
npm run typecheck
npm test             # unit tests (vitest)
npm run e2e          # end-to-end against the built app (playwright)
npm run dist         # installers into app/release
```

CI runs typecheck, unit tests and the end-to-end suite on Windows and Linux for every push; a tag
builds the installers on both and publishes them.

Tests are filed by what they cover, and a fix lands with the case that would have caught it:

| Where | What it covers |
|---|---|
| `src/core/__tests__` | the feature's own logic — scanning, config, launch commands, key map, layout rules |
| `src/main/__tests__` | the main process: docking arithmetic and what the OS is asked for |
| `src/renderer/__tests__` | what the window decides to draw |
| `e2e` | the built app, driven like a person: keyboard, settings, and the real docked window |

The end-to-end suite drives the real window: it docks to every attached monitor on every edge and
checks the desktop's work area really changed and came back. A machine with one screen exercises
one, and the run says which it checked.

## Requirements

Windows 10/11 or Linux (X11 for docking), and `claude` on `PATH`.

## Releases

Every version's changes are listed in [CHANGELOG.md](CHANGELOG.md); CI publishes that section as the
release notes and refuses to release a tag that has no section.

Versions up to **v1.15.0** were *Claude Projects*, a Windows terminal application written in
Python; it is still downloadable from its release, and its source is in this repository's history.
