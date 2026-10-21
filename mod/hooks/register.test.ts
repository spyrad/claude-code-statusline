import { expect, mock, test } from 'claude-code/testing'

const NOW = Date.parse('2026-10-20T12:00:00Z')

const BAND = {
  plugin: 'statusline-mod',
  component: 'PromptHint',
  props: {
    isDraft: false,
    isWorking: false,
    hint: '? for shortcuts',
  },
} as const

test('das Band zeigt Modell, Branch, Fenster, Last, Context, Kosten und Herdr-Pane', async ($, on) => {
  // Jeder Hook hier steht fuer die Engine; ein Aufruf auf `$` wird `{ value }` beantwortet.
  const shown: (string | undefined)[] = []
  on('ui.status', (_, e) => (shown.push(e.text), { value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.now', () => ({ value: NOW }))
  on('session.cwd', () => ({ value: 'C:/proj/claude-code-statusline' }))
  on('session.model', () => ({ value: 'claude-opus-5-5[1m]' }))
  on('env.get', (_, e) => ({
    value: ({ HERDR_ENV: '1', HERDR_PANE_ID: 'w3:p2' } as Record<string, string>)[e.name],
  }))
  // Die Engine reicht Pfade normalisiert weiter (unter Windows mit Backslashes).
  on('fs.exists', (_, e) => ({
    value: e.path.replace(/\\/g, '/') === 'C:/proj/claude-code-statusline/.git',
  }))
  on('fs.stat', () => ({
    value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false } as const,
  }))
  on('fs.read', () => ({ value: 'ref: refs/heads/main\n' }))
  on('session.usage', () => ({
    value: {
      startedAt: NOW - 12 * 60_000,
      context: { tokens: 90_000, window: 1_000_000, percent: 9 },
      rateLimits: [
        // 2h noch -> 3h von 5h verstrichen = 60 %
        { kind: 'five_hour', percentUsed: 30, resetsAt: new Date(NOW + 2 * 3600_000).toISOString() },
        { kind: 'seven_day', percentUsed: 12 },
      ],
      cost: { usd: 1.234 },
    },
  }))

  await $.session.start({ cwd: 'C:/proj/claude-code-statusline', surface: 'terminal', isInteractive: true })

  // Die alte Statuszeile aus Version 0.1.0 wird weggeraeumt.
  expect(shown.at(-1)).toBeUndefined()

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  const line = texts.join('')

  for (const part of [
    'Opus 5.5 · 1M',
    'claude-code-statusline ⎇ main',
    'Laufzeit 12m00s',
    'Kosten $1,23',
    'herdr w3:p2',
    '  60%  noch 2h00m',
    'Session 30% (0,50×)',
    'Woche 12%',
    '   9%  90,0k/1,0M',
    '? for shortcuts',
  ]) {
    expect(line).toContain(part)
  }
  const session = await ui.find({ type: 'Text', text: /^30%$/ })
  expect(session?.props.color).toBe('success')
  await ui.unmount()
})

test('der Cache-Countdown laeuft ab der letzten Anfrage, mit der TTL aus dem Transcript', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, { USERPROFILE: 'C:/Users/x' })
  const transcript = 'C:/Users/x/.claude/projects/C--proj-repo/sid.jsonl'
  const same = (a: string, b: string) => a.replace(/\\/g, '/') === b
  on('ui.status', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('session.cwd', () => ({ value: 'C:/proj/repo' }))
  on('session.root', () => ({ value: 'C:/proj/repo' }))
  on('session.id', () => ({ value: 'sid' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({
    value: { startedAt: NOW, context: { window: 1_000_000 }, rateLimits: [] },
  }))
  on('fs.exists', (_, e) => ({ value: same(e.path, transcript) }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 100, mtimeMs: 0, isLink: false } as const }))
  on('fs.read', () => ({
    value: [
      '{"message":{"usage":{"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":800}}}}',
      '{"message":{"usage":{"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":0}}}}',
      '',
    ].join('\n'),
  }))
  on('turn.step', async function* (_, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'ok',
      toolUses: [],
      stopReason: 'end_turn',
      usage: {
        model: e.model,
        input_tokens: 1,
        output_tokens: 1,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 800,
      },
    } as const
  })

  await $.session.start({ cwd: 'C:/proj/repo', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const line = async () => (await ui.findAll({ type: 'Text' })).map(t => t.text).join('')

  // Vor der ersten Anfrage gibt es nichts zu zaehlen; die TTL kommt aus dem Transcript.
  expect(await line()).toContain('Cache 1h \u2013')

  // Ein Stream laeuft erst, wenn er gelesen wird.
  const step = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })
  for await (const _ of step);
  await step.result
  await clock.advance(10 * 60_000)
  expect(await line()).toContain('Cache 1h warm noch 50m00s')
  expect((await ui.find({ type: 'Text', text: /^warm noch/ }))?.props.color).toBe('success')

  await clock.advance(55 * 60_000)
  expect(await line()).toContain('Cache 1h kalt seit 5m00s')

  // Nach /clear gilt der Cache der alten Unterhaltung nicht mehr.
  await $.session.end({ reason: 'clear', sessionId: 'sid', resume: { id: 'sid' } })
  await clock.advance(5_000)
  expect(await line()).toContain('Cache 5m? –')
  await ui.unmount()
})
