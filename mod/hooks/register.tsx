// Die Statusleiste als Band unter dem Prompt, im Layout der frueheren
// command-Statusleiste (statusline.mjs, in der Git-Historie bis de2dd7c).
// Quelle der Zahlen ist $.session.usage().
//
// Unter dem Prompt laesst die Engine nur die Hinweiszeile (PromptHint) zeichnen:
// das Band tritt an ihre Stelle, ihr Text ("? for shortcuts", "esc to interrupt")
// folgt gedimmt als letzte Zeile.
//
// $.ui.status taugt dafuer nicht: die Engine zeichnet diese Zeile als gelben
// Hinweis mit Plugin-Praefix, einzeilig und ohne eigene Farben.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CacheInfo, Snapshot } from '../types'

const WINDOW_MS = 5 * 60 * 60 * 1000 // Rate-Limit-Fenster: 5 Stunden
const TICK_MS = 5_000 // Laufzeit, Fensterzeit und Cache-Countdown laufen auch ohne Turn weiter
const BAR_WIDTH = 14
const TTL_MS = { '5m': 5 * 60_000, '1h': 60 * 60_000 } as const
const MAX_READ = 4 * 1024 * 1024 // $.fs.read lehnt groessere Dateien ab

const GLYPHS = {
  barFull: '▰',
  barEmpty: '▱',
  pipe: '│',
  dot: '·',
  branch: '⎇',
  times: '×',
  dash: '–',
}

const snapshot = atom({ plugin: 'statusline-mod', key: 'snapshot' } as const, null)
const cache = atom({ plugin: 'statusline-mod', key: 'cache' } as const, {
  lastRequestAt: null,
  ttl: null,
} as CacheInfo)

// ------------------------------------------------------------------- Helfer

/** 1.5 -> "1,5" (de-DE ohne Intl, das die Umgebung nicht zusichert) */
const dec = (v: number, digits: number) => v.toFixed(digits).replace('.', ',')

/** 8500 -> 8,5k | 1000000 -> 1,0M */
function fmtTok(n: number): string {
  if (n >= 1_000_000) return `${dec(n / 1_000_000, 1)}M`
  if (n >= 1000) return `${dec(n / 1000, 1)}k`
  return String(Math.round(n))
}

function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`
  if (m > 0) return `${m}m${String(s).padStart(2, '0')}s`
  return `${s}s`
}

/** Farbe nach Auslastung: gruen < 60 < gelb < 85 < rot */
const loadColor = (pct: number) => (pct < 60 ? 'success' : pct < 85 ? 'warning' : 'error')
const ratioColor = (r: number) => (r < 0.9 ? 'success' : r <= 1.1 ? 'warning' : 'error')

/** 3 Stellen + %, damit der Balken nicht springt */
const pctCol = (v: number) => `${Math.round(v)}%`.padStart(4)

function barCells(pct: number): [string, string] {
  const filled = Math.round((Math.max(0, Math.min(100, pct)) / 100) * BAR_WIDTH)
  return [GLYPHS.barFull.repeat(filled), GLYPHS.barEmpty.repeat(BAR_WIDTH - filled)]
}

/** "claude-opus-5-5[1m]" -> "Opus 5.5 · 1M"; ein Anzeigename bleibt, wie er ist */
function shortModel(name: string): string {
  const id = /^claude-([a-z]+)-(\d+)(?:-(\d+))?(?:-\d{8})?(?:\[(\d+[mk])\])?$/i.exec(name)
  if (!id) return name.replace(/\s*\((\d+[MK])\s*context\)/i, (_, size) => ` ${GLYPHS.dot} ${size}`)
  const [, family = '', major, minor, size] = id
  const label = `${family.charAt(0).toUpperCase()}${family.slice(1)} ${major}${minor ? `.${minor}` : ''}`
  return size ? `${label} ${GLYPHS.dot} ${size.toUpperCase()}` : label
}

const parentOf = (dir: string) => dir.replace(/[\\/][^\\/]*[\\/]?$/, '')

/**
 * Branch wie im Skript: .git/HEAD direkt lesen, kein git-Prozess.
 * Bei detached HEAD die Kurz-SHA, ausserhalb eines Repos null.
 */
async function gitBranch($: EngineInterface, startDir: string): Promise<string | null> {
  try {
    let dir = startDir
    for (let i = 0; i < 25 && dir; i++) {
      const dotGit = `${dir}/.git`
      if (await $.fs.exists(dotGit)) {
        let head = `${dotGit}/HEAD`
        const st = await $.fs.stat(dotGit)
        if (st.kind !== 'dir') {
          // Worktree: .git ist eine Datei mit "gitdir: <pfad>"
          const gitdir = /^gitdir:\s*(.+)$/m.exec(await $.fs.read(dotGit))?.[1]?.trim()
          if (!gitdir) return null
          head = `${/^([a-z]:)?[\\/]/i.test(gitdir) ? gitdir : `${dir}/${gitdir}`}/HEAD`
        }
        const txt = (await $.fs.read(head)).trim()
        const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(txt)
        return ref?.[1] ?? txt.slice(0, 7)
      }
      const up = parentOf(dir)
      if (up === dir) break
      dir = up
    }
  } catch {
    /* kein Repo oder kein Zugriff */
  }
  return null
}

// ------------------------------------------------------------ Prompt-Cache

/**
 * Das Transcript der Session: ~/.claude/projects/<root, Sonderzeichen als ->/<id>.jsonl.
 * Liegt es nicht dort, wird in den Projektordnern nach <id>.jsonl gesucht.
 */
async function transcriptPath($: EngineInterface): Promise<string | null> {
  const [configDir, profile, home, root, id] = await Promise.all([
    $.env.get('CLAUDE_CONFIG_DIR'),
    $.env.get('USERPROFILE'),
    $.env.get('HOME'),
    $.session.root(),
    $.session.id(),
  ])
  const base = configDir ?? `${profile ?? home ?? ''}/.claude`
  const projects = `${base}/projects`
  const direct = `${projects}/${root.replace(/[^a-zA-Z0-9]/g, '-')}/${id}.jsonl`
  if (await $.fs.exists(direct)) return direct
  try {
    for (const dir of await $.fs.list(projects)) {
      const candidate = `${projects}/${dir.name}/${id}.jsonl`
      if (dir.kind === 'dir' && (await $.fs.exists(candidate))) return candidate
    }
  } catch {
    /* kein Projektordner */
  }
  return null
}

/**
 * TTL der letzten Cache-Schreibung im Transcript: Claude Code schreibt den
 * Cache je nach Konto und Lage mit 5 Minuten oder 1 Stunde. null, wenn keine
 * Schreibung zu finden ist oder das Transcript zu gross zum Lesen ist.
 */
async function readCacheTtl($: EngineInterface): Promise<CacheInfo['ttl']> {
  try {
    const file = await transcriptPath($)
    if (!file || (await $.fs.stat(file)).size > MAX_READ) return null
    const lines = (await $.fs.read(file)).split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i] ?? ''
      if (!line.includes('"ephemeral_')) continue
      if (Number(/"ephemeral_1h_input_tokens":(\d+)/.exec(line)?.[1] ?? 0) > 0) return '1h'
      if (Number(/"ephemeral_5m_input_tokens":(\d+)/.exec(line)?.[1] ?? 0) > 0) return '5m'
    }
  } catch {
    /* nicht lesbar -> bisherigen Wert behalten */
  }
  return null
}

const refreshTtl = async ($: EngineInterface) => {
  const ttl = await readCacheTtl($)
  if (ttl) await update($, cache, c => ({ ...c, ttl }))
}

// ---------------------------------------------------------------- Messung

async function measure($: EngineInterface): Promise<Snapshot> {
  const [u, model, cwd, now, herdrEnv, herdrPane] = await Promise.all([
    $.session.usage(),
    $.session.model(),
    $.session.cwd(),
    $.clock.now(),
    $.env.get('HERDR_ENV'),
    $.env.get('HERDR_PANE_ID'),
  ])

  const five = u.rateLimits.find(r => r.kind === 'five_hour')
  const week = u.rateLimits.find(r => r.kind === 'seven_day')
  let elapsedPct: number | null = null
  let remainMs: number | null = null
  if (five?.resetsAt) {
    remainMs = Math.max(0, Date.parse(five.resetsAt) - now)
    elapsedPct = Math.max(0, Math.min(100, ((WINDOW_MS - remainMs) / WINDOW_MS) * 100))
  }

  return {
    now,
    model: shortModel(model),
    repo: cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd,
    branch: await gitBranch($, cwd),
    runtimeMs: now - u.startedAt,
    elapsedPct,
    remainMs,
    sessPct: five?.percentUsed ?? null,
    // Verbrauchstempo; am Fensteranfang instabil, darum erst ab 2 % Zeit
    ratio: five && elapsedPct != null && elapsedPct >= 2 ? five.percentUsed / elapsedPct : null,
    weekPct: week?.percentUsed ?? null,
    ctxPct: u.context.percent ?? null,
    ctxTokens: u.context.tokens ?? 0,
    ctxWindow: u.context.window,
    costUsd: u.cost?.usd ?? null,
    herdrPane: herdrEnv === '1' && herdrPane ? herdrPane : null,
  }
}

// Eine fehlgeschlagene Messung behaelt den letzten Stand; der naechste Tick versucht es wieder.
const refresh = async ($: EngineInterface) => {
  try {
    const next = await measure($)
    await update($, snapshot, () => next)
  } catch {
    /* Messung fehlgeschlagen */
  }
}

// ------------------------------------------------------------------ Hooks

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    $.ui.status(undefined) // Zeile aus Version 0.1.0 wegraeumen
    $.clock.every(TICK_MS, () => void refresh($))
    await Promise.all([refresh($), refreshTtl($)])
    return started
  })

  // Nach /clear oder einem Wechsel der Unterhaltung gilt der Cache der alten nicht mehr.
  on('session.end', async ($, e, next) => {
    const ended = await next(e)
    if (e.reason === 'clear' || e.reason === 'resume') {
      await update($, cache, () => ({ lastRequestAt: null, ttl: null }))
    }
    return ended
  })

  // Jede Anfrage des Hauptthreads, die eine Antwort bekam, frischt den Cache auf.
  // Gezaehlt wird ab dem Absenden: so laeuft der Countdown eher zu frueh ab als zu spaet.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)
    const sentAt = await $.clock.now()
    const response = yield* next(e)
    if (response.usage) await update($, cache, c => ({ ...c, lastRequestAt: sentAt }))
    return response
  })

  // Nach jedem Turn steht die Antwort im Transcript: dann die TTL nachlesen.
  on('session.measure', async ($, e, next) => {
    const measured = await next(e)
    await Promise.all([refresh($), refreshTtl($)])
    return measured
  })

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const s = await read($, snapshot)
    if (s === null) return next(e)
    const c = await read($, cache)
    // Ohne gelesene TTL wird mit 5 Minuten gerechnet, markiert mit "?"
    const ttlMs = TTL_MS[c.ttl ?? '5m']
    // s.now kann bis zu einem Tick aelter sein als die letzte Anfrage: nie mehr als die TTL zeigen
    const cacheLeft = c.lastRequestAt != null ? Math.min(ttlMs, c.lastRequestAt + ttlMs - s.now) : null
    const cacheColor =
      cacheLeft == null ? undefined : cacheLeft <= 0 ? 'error' : cacheLeft < 60_000 ? 'warning' : 'success'

    const { Box, Text } = $.ui.resolve(e)
    const label = (name: string) => <Text dimColor>{name.padEnd(8)}</Text>
    const sep = <Text dimColor>{`  ${GLYPHS.pipe}  `}</Text>
    const dot = <Text dimColor>{`  ${GLYPHS.dot}  `}</Text>
    const na = <Text dimColor>n/a</Text>

    const [winFull, winEmpty] = barCells(s.elapsedPct ?? 0)
    const [ctxFull, ctxEmpty] = barCells(s.ctxPct ?? 0)

    return (
      <Box flexDirection="column">
        <Text wrap="truncate-end">
          {label('Model')}
          <Text weight="bold">{s.model}</Text>
          {sep}
          <Text>{s.repo}</Text>
          {s.branch && <Text dimColor>{` ${GLYPHS.branch} `}</Text>}
          {s.branch && <Text>{s.branch}</Text>}
          {s.herdrPane && sep}
          {s.herdrPane && <Text dimColor>herdr </Text>}
          {s.herdrPane && <Text>{s.herdrPane}</Text>}
          {sep}
          <Text dimColor>Laufzeit </Text>
          <Text>{fmtDuration(s.runtimeMs)}</Text>
          {s.costUsd != null && sep}
          {s.costUsd != null && <Text dimColor>Kosten </Text>}
          {s.costUsd != null && <Text>{`$${dec(s.costUsd, 2)}`}</Text>}
        </Text>
        <Text wrap="truncate-end">
          {label('Fenster')}
          {s.elapsedPct != null && s.remainMs != null ? (
            <Text>
              <Text>[{winFull}</Text>
              <Text dimColor>{winEmpty}</Text>
              <Text>] {pctCol(s.elapsedPct)}</Text>
              <Text dimColor>{`  noch ${fmtDuration(s.remainMs)}`}</Text>
            </Text>
          ) : (
            na
          )}
          {dot}
          <Text dimColor>Session </Text>
          {s.sessPct != null ? (
            <Text>
              <Text color={loadColor(s.sessPct)}>{`${Math.round(s.sessPct)}%`}</Text>
              <Text dimColor> (</Text>
              {s.ratio != null ? (
                <Text color={ratioColor(s.ratio)}>{dec(s.ratio, 2) + GLYPHS.times}</Text>
              ) : (
                <Text dimColor>{GLYPHS.dash}</Text>
              )}
              <Text dimColor>)</Text>
            </Text>
          ) : (
            na
          )}
          {dot}
          <Text dimColor>Woche </Text>
          {s.weekPct != null ? (
            <Text color={loadColor(s.weekPct)}>{`${Math.round(s.weekPct)}%`}</Text>
          ) : (
            na
          )}
        </Text>
        <Text wrap="truncate-end">
          {label('Context')}
          <Text>[</Text>
          <Text color={loadColor(s.ctxPct ?? 0)}>{ctxFull}</Text>
          <Text dimColor>{ctxEmpty}</Text>
          <Text>] </Text>
          <Text color={loadColor(s.ctxPct ?? 0)}>
            {s.ctxPct != null ? pctCol(s.ctxPct) : GLYPHS.dash.padStart(4)}
          </Text>
          <Text dimColor>{`  ${fmtTok(s.ctxTokens)}/${fmtTok(s.ctxWindow)}`}</Text>
          {dot}
          <Text dimColor>{`Cache ${c.ttl ?? '5m?'} `}</Text>
          {cacheLeft == null ? (
            <Text dimColor>{GLYPHS.dash}</Text>
          ) : cacheLeft <= 0 ? (
            <Text color={cacheColor}>{`kalt seit ${fmtDuration(-cacheLeft)}`}</Text>
          ) : (
            <Text color={cacheColor}>{`warm noch ${fmtDuration(cacheLeft)}`}</Text>
          )}
        </Text>
        {(e.props.hint || e.props.tail) && (
          <Text wrap="truncate-end" dimColor>
            {[e.props.hint, e.props.tail].filter(Boolean).join(' ')}
          </Text>
        )}
      </Box>
    )
  })
}
