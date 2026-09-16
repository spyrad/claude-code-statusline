# claude-code-statusline

A status line for [Claude Code](https://claude.com/claude-code) on Windows. Three lines
telling you what model you are on, where you are, how much of your rate-limit window is
left, and how full the context is.

```
Model   Opus 5 · 1M  │  claude-code-statusline ⎇ main  │  Laufzeit 59m02s
Fenster [▰▰▰▰▰▰▰▰▰▰▰▱▱▱]  82%  noch 55m02s  ·  Session 11% (0,13×)  ·  Woche 5%
Context [▰▱▱▱▱▱▱▱▱▱▱▱▱▱]   8%  87,2k/1,0M
```

The number in brackets after `Session` is the part worth explaining: it is your token
usage divided by the time elapsed in the same five-hour window. Below `1` you are
consuming slower than the window refills, so there is headroom. Above `1` you will run
into the limit before the window resets. Green below 0.9, yellow up to 1.1, red above.

## Install

Double-click `install.cmd`, or run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1
```

Without cloning:

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/spyrad/claude-code-statusline/main/install.ps1)))
```

Then open `/statusline` in Claude Code once, or restart it.

Requires Node.js 18 or newer — the status line is a Node script that Claude Code runs on
every redraw. The installer checks for it and stops with a pointer if it is missing.

## Options

| Option | Effect |
|---|---|
| `-ShowCosts` | Add a fourth line estimating spend for this session and the last 30 days |
| `-NoTest` | Skip the sample render at the end of the install |
| `-Uninstall` | Remove the status line entry and the script |
| `-ClaudeDir <path>` | Install somewhere other than `~/.claude` |

Running the installer again is safe. It detects an existing entry, backs up
`settings.json` before touching it, and leaves every other setting alone.

## What the lines show

**Line 1** — the model (shortened, `Opus 5 (1M context)` becomes `Opus 5 · 1M`), the
repository name with the current branch, and how long this session has been running.
Outside a git repository the folder name is shown without a branch.

**Line 2** — how much of the five-hour rate-limit window has elapsed, how long is left,
your usage against the five-hour and seven-day limits, and the consumption ratio
described above. The window bar is deliberately neutral: it shows time, not load.

**Line 3** — context usage, as a bar, a percentage, and tokens used against the window
size.

**Line 4**, only with `-ShowCosts` — estimated spend for this session and the last 30
days, based on public API list prices. Treat it as an order of magnitude, not a bill.

## Privacy

Everything runs locally and nothing is sent anywhere.

The cost line is the one part that reads beyond its own configuration: it opens the
transcript files under `~/.claude/projects/**/*.jsonl` to sum up token counts. It reads
token usage and model names, not the content of your conversations, and it writes a cache
to `~/.claude/statusline-cost-cache.json` so each run only reads what was appended since
last time. If you would rather it did not open those files at all, leave `-ShowCosts` off
— then the scan never runs.

## How it works

Claude Code writes a JSON blob to the status line command's stdin on every redraw and
renders whatever comes back. `statusline.mjs` parses it and prints three or four lines
with ANSI colors.

Two details worth knowing:

The branch comes from reading `.git/HEAD` directly rather than shelling out to `git`. A
redraw happens constantly, and spawning a process each time would be noticeable. The
trade-off is that there is no dirty marker — that would need `git status`.

Every glyph in `statusline.mjs` is written as a `\uXXXX` escape so the file stays pure
ASCII. `build.ps1` enforces this, because the installer embeds the script and the
`irm | scriptblock` one-liner must not depend on a BOM or the active code page. To change
the bar style, edit `barFull` and `barEmpty` in the `GLYPHS` object.

## Uninstall

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -Uninstall
```

Removes the script, the cost cache, and the `statusLine` entry — but only if that entry
points at this installation. A status line someone else configured is left alone.

## Troubleshooting

**Nothing appears.** Open `/statusline` in Claude Code once, or restart it. Claude Code
reads the setting at startup.

**The bars show as boxes or question marks.** Your terminal font has no glyph for `▰`.
Change `barFull` and `barEmpty` in `~/.claude/statusline.mjs` to `#` and `-`, or install a
font with better coverage.

**`node is not recognized`.** Node is not on `PATH` for the shell Claude Code uses. Open a
new terminal after installing Node, then run the installer again so it records the full
path.

**The cost line says `(scan…)`.** The cache is still being built. It scans within a time
budget per run and picks up where it left off, so the number settles after a few redraws.

## Development

Sources live in `src/`. `install.ps1` is generated — edit `src/install-template.ps1` and
`src/statusline.mjs`, then rebuild:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File build.ps1
```

The build refuses to produce an installer that contains non-ASCII characters, does not
parse as PowerShell, or embeds JavaScript that does not parse.

## License

MIT
