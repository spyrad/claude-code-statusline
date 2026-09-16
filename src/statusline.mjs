#!/usr/bin/env node
// Claude Code Statusline
// Zeile 1: Model | Session-% | Weekly-%
// Zeile 2: 5h-Fenster (verstrichene Zeit in %) | Session-Laufzeit
// Zeile 3: Context-Bar
// Zeile 4: Kosten Session / Woche / Monat (Schaetzung nach API-Listenpreisen)
//
// Kosten werden aus den lokalen Transcripts (~/.claude/projects/**/*.jsonl)
// berechnet und in statusline-cost-cache.json inkrementell gecacht
// (nur neu angehaengte Bytes werden gelesen).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ---------------------------------------------------------------- Konstanten

// Kosten-Zeile ein- oder ausblenden. Eingeschaltet liest das Skript die
// lokalen Transcripts unter ~/.claude/projects, um die Kosten zu schaetzen.
const SHOW_COSTS = false;

// Alle Sonderzeichen an einer Stelle, als Escapes notiert: diese Datei muss
// reines ASCII bleiben, weil der Installer sie einbettet und ohne BOM sowie
// unabhaengig von der aktiven Codepage laufen muss. Fuer einen anderen
// Balkenstil genuegt es, barFull und barEmpty zu aendern.
const GLYPHS = {
  barFull: '\u25b0',  // schwarzes Parallelogramm
  barEmpty: '\u25b1', // weisses Parallelogramm
  pipe: '\u2502',     // senkrechter Trennstrich
  dot: '\u00b7',      // Mittelpunkt
  branch: '\u2387',   // Branch-Symbol
  times: '\u00d7',    // Faktor-Marker
  dash: '\u2013',     // Platzhalter, wenn nichts berechenbar ist
  ellipsis: '\u2026', // Hinweis, waehrend der Kosten-Cache aufgebaut wird
};
const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const CACHE_FILE = path.join(CLAUDE_DIR, 'statusline-cost-cache.json');

const CACHE_VERSION = 2;
const LOOKBACK_DAYS = 31; // Monat = letzte 30 Tage, +1 Puffer
const FILE_MTIME_CUTOFF_DAYS = 40; // aeltere Dateien gar nicht erst oeffnen
const SCAN_BUDGET_MS = 2500; // Zeitbudget pro Aufruf; Rest kommt beim naechsten

const WINDOW_MS = 5 * 60 * 60 * 1000; // Rate-Limit-Fenster: 5 Stunden

// API-Listenpreise in USD pro 1 Mio Tokens (Stand 2026-08).
// cacheWrite5m = 1,25x input | cacheWrite1h = 2x input | cacheRead = 0,1x input
const PRICES = [
  [/fable|mythos/, { in: 10, out: 50 }],
  [/opus/, { in: 5, out: 25 }],
  [/sonnet/, { in: 3, out: 15 }],
  [/haiku/, { in: 1, out: 5 }],
];
const FALLBACK_PRICE = { in: 5, out: 25 };

// ------------------------------------------------------------------- Helfer

const e = '\x1b';
const R = `${e}[0m`;
const DIM = `${e}[90m`;
const BOLD = `${e}[1m`;
const c = (code, s) => `${e}[${code}m${s}${R}`;

/** Farbe nach Auslastung: gruen < 60 < gelb < 85 < rot */
const loadColor = (pct) => (pct < 60 ? '32' : pct < 85 ? '33' : '31');

const nf1 = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const pct1 = (v) => `${nf1.format(v)}%`;
const usd = (v) => `$${nf2.format(v)}`;

/** 8500 -> 8,5k | 1000000 -> 1,0M */
function fmtTok(n) {
  if (n >= 1_000_000) return `${nf1.format(n / 1_000_000)}M`;
  if (n >= 1000) return `${nf1.format(n / 1000)}k`;
  return String(Math.round(n));
}

function fmtDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

function bar(pct, width, colorCode) {
  const p = Math.max(0, Math.min(100, pct));
  const filled = Math.round((p / 100) * width);
  const full = filled > 0 ? c(colorCode, GLYPHS.barFull.repeat(filled)) : '';
  const empty = width - filled > 0 ? `${DIM}${GLYPHS.barEmpty.repeat(width - filled)}${R}` : '';
  return `${full}${empty}`;
}

/**
 * Aktueller Branch ohne git-Subprozess: .git/HEAD direkt lesen.
 * Die Statusline rendert bei jeder Aenderung neu - ein Prozess-Spawn
 * waere hier zu teuer. Kein Dirty-Marker, der braeuchte `git status`.
 * Liefert den Branchnamen, bei detached HEAD die Kurz-SHA, sonst null.
 */
function gitBranch(startDir) {
  try {
    let dir = startDir;
    for (let i = 0; i < 25 && dir; i++) {
      const dotGit = path.join(dir, '.git');
      let head = null;
      if (fs.existsSync(dotGit)) {
        const st = fs.statSync(dotGit);
        if (st.isDirectory()) {
          head = path.join(dotGit, 'HEAD');
        } else {
          // Worktree oder Submodul: ".git" ist eine Datei mit "gitdir: <pfad>"
          const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'));
          if (m) head = path.join(path.resolve(dir, m[1].trim()), 'HEAD');
        }
      }
      if (head && fs.existsSync(head)) {
        const txt = fs.readFileSync(head, 'utf8').trim();
        const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(txt);
        return ref ? ref[1] : txt.slice(0, 7);
      }
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  } catch {
    /* kein Repo oder kein Zugriff */
  }
  return null;
}
/** "Opus 5 (1M context)" -> "Opus 5 - 1M" */
/** "Opus 5 (1M context)" -> "Opus 5 - 1M" (Mittelpunkt statt Bindestrich) */
function shortModel(name) {
  return name.replace(/\s*\((\d+[MK])\s*context\)/i, (_, size) => ` ${GLYPHS.dot} ${size}`);
}

/** Lokales Datum als YYYY-MM-DD (Bucket-Key) */
function dayKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function priceFor(model) {
  if (!model) return null;
  const id = String(model).toLowerCase();
  if (id.includes('synthetic') || id === '<synthetic>') return null;
  for (const [re, p] of PRICES) if (re.test(id)) return p;
  return FALLBACK_PRICE;
}

/** Kosten einer usage-Struktur in USD */
function costOf(usage, model) {
  const price = priceFor(model);
  if (!price || !usage) return 0;
  const cc = usage.cache_creation || {};
  const w5 = cc.ephemeral_5m_input_tokens ?? 0;
  const w1h = cc.ephemeral_1h_input_tokens ?? 0;
  // Fallback, falls die Aufschluesselung fehlt: alles als 5m werten
  const writeTotal = usage.cache_creation_input_tokens ?? 0;
  const w5eff = w5 + w1h === 0 ? writeTotal : w5;

  const inTok = usage.input_tokens ?? 0;
  const readTok = usage.cache_read_input_tokens ?? 0;
  const outTok = usage.output_tokens ?? 0;

  return (
    (inTok * price.in +
      w5eff * price.in * 1.25 +
      w1h * price.in * 2 +
      readTok * price.in * 0.1 +
      outTok * price.out) /
    1_000_000
  );
}

// ------------------------------------------------------------- Kosten-Cache

function loadCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (raw && raw.v === CACHE_VERSION && raw.files) return raw;
  } catch {
    /* kein/kaputter Cache -> neu aufbauen */
  }
  return { v: CACHE_VERSION, files: {} };
}

function saveCache(cache) {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache), 'utf8');
  } catch {
    /* nicht schreibbar -> naechster Lauf rechnet halt neu */
  }
}

/** Alle Transcript-Dateien der letzten FILE_MTIME_CUTOFF_DAYS Tage */
function listTranscripts() {
  const cutoff = Date.now() - FILE_MTIME_CUTOFF_DAYS * 86_400_000;
  const out = [];
  let projects;
  try {
    projects = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const p of projects) {
    if (!p.isDirectory()) continue;
    const dir = path.join(PROJECTS_DIR, p.name);
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of entries) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
      const full = path.join(dir, f.name);
      let st;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      if (st.mtimeMs < cutoff) continue;
      out.push({ file: full, size: st.size, mtimeMs: st.mtimeMs });
    }
  }
  // Zuletzt geaenderte zuerst -> bei Zeitbudget-Abbruch ist das Aktuelle drin
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

/**
 * Liest die seit dem letzten Lauf angehaengten Bytes einer JSONL-Datei
 * und bucketet die Kosten pro Kalendertag.
 */
function scanFile(full, size, entry) {
  const from = entry.off > size ? 0 : entry.off; // Datei gekuerzt/ersetzt -> neu
  if (from === 0) entry.days = {};
  if (size <= from) {
    entry.off = size;
    return;
  }

  let buf;
  let fd;
  try {
    fd = fs.openSync(full, 'r');
    buf = Buffer.allocUnsafe(size - from);
    fs.readSync(fd, buf, 0, size - from, from);
  } catch {
    return;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignorieren */
      }
    }
  }

  const text = buf.toString('utf8');
  const lastNl = text.lastIndexOf('\n');
  if (lastNl < 0) return; // noch keine vollstaendige Zeile dazugekommen

  for (const line of text.slice(0, lastNl).split('\n')) {
    if (!line || line.charCodeAt(0) !== 123 /* { */) continue;
    if (!line.includes('"usage"')) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const msg = obj.message;
    const usage = msg?.usage;
    if (!usage) continue;
    const cost = costOf(usage, msg.model);
    if (!cost) continue;
    const ts = obj.timestamp ? new Date(obj.timestamp) : null;
    if (!ts || Number.isNaN(ts.getTime())) continue;
    const key = dayKey(ts);
    entry.days[key] = (entry.days[key] ?? 0) + cost;
  }

  entry.off = from + Buffer.byteLength(text.slice(0, lastNl + 1), 'utf8');
}

/**
 * Summiert Kosten fuer Woche (7 Tage), Monat (30 Tage) und die aktive Session.
 * @returns {{week:number, month:number, session:number, partial:boolean}}
 */
function collectCosts(transcriptPath) {
  const cache = loadCache();
  const files = listTranscripts();
  const seen = new Set();
  const started = Date.now();
  let partial = false;

  for (const { file, size } of files) {
    seen.add(file);
    let entry = cache.files[file];
    if (!entry || typeof entry.off !== 'number' || !entry.days) {
      entry = { off: 0, days: {} };
      cache.files[file] = entry;
    }
    if (entry.off === size) continue; // unveraendert
    if (Date.now() - started > SCAN_BUDGET_MS) {
      partial = true;
      break;
    }
    scanFile(file, size, entry);
  }

  // Verschwundene Dateien aus dem Cache werfen
  for (const key of Object.keys(cache.files)) {
    if (!seen.has(key)) delete cache.files[key];
  }

  // Alte Tages-Buckets entsorgen
  const keepFrom = dayKey(new Date(Date.now() - LOOKBACK_DAYS * 86_400_000));
  for (const entry of Object.values(cache.files)) {
    for (const day of Object.keys(entry.days)) {
      if (day < keepFrom) delete entry.days[day];
    }
  }

  saveCache(cache);

  const weekFrom = dayKey(new Date(Date.now() - 6 * 86_400_000)); // heute + 6 Tage zurueck
  const monthFrom = dayKey(new Date(Date.now() - 29 * 86_400_000));
  let week = 0;
  let month = 0;
  for (const entry of Object.values(cache.files)) {
    for (const [day, cost] of Object.entries(entry.days)) {
      if (day >= monthFrom) month += cost;
      if (day >= weekFrom) week += cost;
    }
  }

  let session = 0;
  const sessionEntry = transcriptPath ? cache.files[path.resolve(transcriptPath)] : null;
  if (sessionEntry) for (const cost of Object.values(sessionEntry.days)) session += cost;

  return { week, month, session, partial };
}

// --------------------------------------------------------------------- Main

let data = {};
try {
  data = JSON.parse(fs.readFileSync(0, 'utf8'));
} catch {
  /* stdin leer -> Defaults */
}

const model = data?.model?.display_name ?? 'Claude';

// --- Arbeitsverzeichnis und Branch ---
const cwd = data?.workspace?.current_dir ?? data?.cwd ?? null;
const branch = cwd ? gitBranch(cwd) : null;

// --- Kosten (nur wenn eingeschaltet - sonst waere der Transcript-Scan umsonst) ---
const costs = SHOW_COSTS ? collectCosts(data?.transcript_path) : null;

// --- Context ---
const cw = data?.context_window ?? {};
const ctxSize = Number(cw.context_window_size ?? 200_000);
const ctxUsed = Number(cw.total_input_tokens ?? 0) + Number(cw.total_output_tokens ?? 0);
const ctxPct = cw.used_percentage != null ? Number(cw.used_percentage) : ctxSize ? (ctxUsed / ctxSize) * 100 : 0;

// --- Rate Limits ---
const rl = data?.rate_limits ?? {};
const sessPct = rl.five_hour?.used_percentage;
const weekPct = rl.seven_day?.used_percentage;

// --- 5h-Fenster: verstrichene Zeit ---
const resetsAt = rl.five_hour?.resets_at ? Number(rl.five_hour.resets_at) * 1000 : null;
let elapsedPct = null;
let remainMs = null;
if (resetsAt) {
  remainMs = Math.max(0, resetsAt - Date.now());
  elapsedPct = Math.max(0, Math.min(100, ((WINDOW_MS - remainMs) / WINDOW_MS) * 100));
}

// --- Session-Laufzeit ---
const durMs = Number(data?.cost?.total_duration_ms ?? 0);

// ---------------------------------------------------------------- Ausgabe

const sep = `  ${DIM}${GLYPHS.pipe}${R}  `;
const dot = `  ${DIM}${GLYPHS.dot}${R}  `;
const L = (s) => `${DIM}${s.padEnd(8)}${R}`;          // buendige Label-Spalte
const pctCol = (v) => `${Math.round(v)}%`.padStart(4); // 3 Stellen + %, Balken springt nicht

// --- Zeile 1: Modell, Repo/Branch, Laufzeit ---
const repoName = data?.workspace?.repo?.name ?? (cwd ? path.basename(cwd) : null);
const place = repoName
  ? `${c('37', repoName)}${branch ? ` ${DIM}${GLYPHS.branch}${R} ${c('37', branch)}` : ''}`
  : null;

const line1 = [
  L('Model') + c('37', BOLD + shortModel(model)),
  place,
  `${DIM}Laufzeit ${R}${c('37', fmtDuration(durMs))}`,
].filter(Boolean).join(sep);

// --- Zeile 2: 5h-Fenster (verstrichene Zeit) + Auslastung ---
// Der Fensterbalken bleibt neutral weiss: er zeigt Zeit, keine Last -
// eine Ampelfarbe waere hier irrefuehrend.
// Verbrauchstempo: Anteil am Token-Limit geteilt durch verstrichene Fensterzeit.
// Unter 1 wird langsamer verbraucht, als das Fenster ablaeuft - es bleibt Puffer.
// Am Fensteranfang ist der Quotient instabil (0/0), darum erst ab 2 % Zeit.
const ratio =
  sessPct != null && elapsedPct != null && elapsedPct >= 2 ? sessPct / elapsedPct : null;
const ratioColor = (r) => (r < 0.9 ? '32' : r <= 1.1 ? '33' : '31');
const ratioStr =
  ratio != null ? c(ratioColor(ratio), nf2.format(ratio) + GLYPHS.times) : c('90', GLYPHS.dash);

const sessStr =
  sessPct != null
    ? c(loadColor(sessPct), `${Math.round(sessPct)}%`) + ` ${DIM}(${R}${ratioStr}${DIM})${R}`
    : c('90', 'n/a');
const weekStr = weekPct != null ? c(loadColor(weekPct), `${Math.round(weekPct)}%`) : c('90', 'n/a');

const windowPart =
  elapsedPct != null
    ? `[${bar(elapsedPct, 14, '37')}] ${c('37', pctCol(elapsedPct))}  ${DIM}noch ${fmtDuration(remainMs)}${R}`
    : c('90', 'n/a');

const line2 =
  L('Fenster') + windowPart +
  `${dot}${DIM}Session ${R}${sessStr}` +
  `${dot}${DIM}Woche ${R}${weekStr}`;

// --- Zeile 3: Context ---
const line3 =
  L('Context') + `[${bar(ctxPct, 14, loadColor(ctxPct))}] ` +
  `${c(loadColor(ctxPct), pctCol(ctxPct))}  ` +
  `${DIM}${fmtTok(ctxUsed)}/${fmtTok(ctxSize)}${R}`;

// --- Zeile 4: Kosten (nur bei SHOW_COSTS; Woche wird berechnet, aber nicht gezeigt) ---
const line4 = SHOW_COSTS
  ? L('Kosten') + `${DIM}Session ${R}${c('37', usd(costs.session))}` +
    `${dot}${DIM}Monat ${R}${c('37', usd(costs.month))}` +
    (costs.partial ? ` ${DIM}(scan${GLYPHS.ellipsis})${R}` : '')
  : null;

process.stdout.write([line1, line2, line3, line4].filter(Boolean).join('\n'));
