# claude-code-statusline

A status line for [Claude Code](https://claude.com/claude-code), built as a mod. Three
lines below the prompt telling you what model you are on, where you are, how much of your
rate-limit window is left, how full the context is, and how long the prompt cache stays
warm.

```
Model   Opus 5.5 · 1M  │  claude-code-statusline ⎇ main  │  Laufzeit 59m02s  │  Kosten $2,30
Fenster [▰▰▰▰▰▰▰▰▰▰▰▱▱▱]  82%  noch 55m02s  ·  Session 11% (0,13×)  ·  Woche 5%
Context [▰▱▱▱▱▱▱▱▱▱▱▱▱▱]   8%  87,2k/1,0M  ·  Cache 1h warm noch 42m10s
? for shortcuts
```

The number in brackets after `Session` is the part worth explaining: it is your token
usage divided by the time elapsed in the same five-hour window. Below `1` you are
consuming slower than the window refills, so there is headroom. Above `1` you will run
into the limit before the window resets. Green below 0.9, yellow up to 1.1, red above.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install statusline-mod --marketplace spyrad/claude-code-statusline
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every
session). From a shell, the same is:

```
claude plugin install statusline-mod --marketplace spyrad/claude-code-statusline
```

If you still have the old command status line from an earlier version of this repository,
remove the `statusLine` entry from `~/.claude/settings.json`, or both will show.

Mods are early access: the API may change between Claude Code releases. The lines draw in
the terminal and the desktop app only.

## What the lines show

**Line 1** — the model (shortened, `claude-opus-5-5[1m]` becomes `Opus 5.5 · 1M`), the
folder name with the current branch, how long this session has been running, and what it
has cost so far. Outside a git repository the folder name is shown without a branch. When
Claude Code runs inside a Herdr pane, the pane ID (`herdr w3:p1`) is appended, read from
`HERDR_PANE_ID`.

**Line 2** — how much of the five-hour rate-limit window has elapsed, how long is left,
your usage against the five-hour and seven-day limits, and the consumption ratio
described above. The window bar is deliberately neutral: it shows time, not load.

**Line 3** — context usage, as a bar, a percentage, and tokens used against the window
size; then the prompt cache: its lifetime (`5m` or `1h`) and how long it stays warm after
the last request, or how long it has been cold. Until the lifetime is known it shows
`5m?`.

**Line 4** — Claude Code's own hint line (`? for shortcuts`, `esc to interrupt`), dimmed.
The mod draws in its place, because that is the only spot below the prompt a mod can
draw.

The numbers refresh every five seconds, so the clock and the cache countdown keep running
between turns.

## Privacy

Everything runs locally and nothing is sent anywhere.

To learn the cache lifetime, the mod reads the current session's transcript
(`~/.claude/projects/<project>/<session>.jsonl`, up to 4 MiB) and looks only at the
cache-write token counts. The branch comes from reading `.git/HEAD` directly.

## Uninstall

```
/plugin uninstall statusline-mod
```

## Development

The mod lives in `mod/`; `.claude-plugin/marketplace.json` makes the repository
installable. To run a working copy, name its folder in the `env` block of
`~/.claude/settings.json` (`"CLAUDE_CODE_PLUGIN_DIRS": "C:\\path\\to\\mod"`) instead of
installing it; saving a file then reloads it. Check and test it with:

```
claude plugin validate .
claude plugin test mod
```

The old command version (`statusline.mjs` and its PowerShell installer) is in the history
up to commit `de2dd7c`.

## Related

[claude-code-tts](https://github.com/spyrad/claude-code-tts) - makes Claude Code read its
answers aloud on Windows.

## License

MIT
