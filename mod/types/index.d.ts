/** Die Werte einer Messung, wie das Band sie zeichnet; null, wo die Engine keinen hat. */
export type Snapshot = {
  now: number
  model: string
  repo: string
  branch: string | null
  runtimeMs: number
  elapsedPct: number | null
  remainMs: number | null
  sessPct: number | null
  ratio: number | null
  weekPct: number | null
  ctxPct: number | null
  ctxTokens: number
  ctxWindow: number
  costUsd: number | null
  herdrPane: string | null
}

/** Prompt-Cache des Hauptthreads: wann er zuletzt aufgefrischt wurde, mit welcher TTL. */
export type CacheInfo = {
  /** Als die letzte Anfrage mit Antwort abging, in $.clock.now()-Millisekunden. */
  lastRequestAt: number | null
  /**
   * Aus dem Transcript gelesen, sonst aus der Einstellung, sonst die zuletzt
   * gesehene; null, solange keine Quelle etwas hergibt.
   */
  ttl: '5m' | '1h' | null
  /** true, wenn die TTL nur die zuletzt gesehene ist: das Band markiert sie mit "?". */
  guess: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'statusline-mod': { snapshot: Snapshot | null; cache: CacheInfo }
  }
}
