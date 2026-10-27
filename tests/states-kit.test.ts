import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { explorerFault } from '../src/renderer/src/explorer/ExplorerErrorBoundary'
import { Chip, ChipGroup } from '../src/renderer/src/kit/Chip'
import EmptyState from '../src/renderer/src/kit/EmptyState'
import { copyStatus, copyText, errorDetailsText, formatAge, formatClock, formatInterval, liveIcon, liveLabel, maxErrorDetails, staleLabel, updatedLabel, type LiveStatus } from '../src/renderer/src/kit/format'
import InlineError from '../src/renderer/src/kit/InlineError'
import { LivePill, StaleBadge } from '../src/renderer/src/kit/LivePill'
import Skeleton, { maxSkeletonRows } from '../src/renderer/src/kit/Skeleton'
import StatusPill, { toneIcons } from '../src/renderer/src/kit/StatusPill'
import Tile, { tileName } from '../src/renderer/src/kit/Tile'
import { contrastPairs } from '../src/shared/theme/contrast-pairs'
import { motion } from '../src/shared/theme/metrics'
import { colorRegistry, cssVariable, type ColorKey } from '../src/shared/theme/registry'
import { isStatusTone, statusTones, tileTones, toneKeys } from '../src/shared/theme/tones'
import { stylesheetRules } from './fixtures/css-rules'

const html = (element: ReactElement) => renderToStaticMarkup(element)
const rules = stylesheetRules()
const declarationsOf = (selector: string, at: readonly string[] = []) => rules.filter(rule => rule.selector === selector && rule.at.join(' ') === at.join(' ')).flatMap(rule => rule.declarations)
const valueOf = (selector: string, property: string, at: readonly string[] = []) => declarationsOf(selector, at).find(declaration => declaration.property === property)?.value
const forced = ['@media (forced-colors: active)']
const at = (hours: number, minutes: number, seconds: number) => new Date(2026, 9, 22, hours, minutes, seconds).getTime()

/** A selector list split at its top-level commas (`:not(a, b)` stays whole). */
function selectorParts(list: string): string[] {
  const parts: string[] = []
  let depth = 0, part = ''
  for (const char of list) {
    if (char === ',' && depth === 0) { parts.push(part.trim()); part = ''; continue }
    if (char === '(') depth++
    if (char === ')') depth--
    part += char
  }
  return [...parts, part.trim()]
}
/** Specificity of a compound selector, enough for styles.css: ids; classes, attributes and pseudo-classes (`:not()` counts its argument); types and pseudo-elements. */
function specificity(selector: string): [number, number, number] {
  let a = 0, b = 0, c = 0
  const rest = selector.replace(/:not\(([^)]*)\)/g, (_, inner: string) => {
    const most = selectorParts(inner).map(specificity).sort(compare).at(-1) ?? [0, 0, 0]
    a += most[0]; b += most[1]; c += most[2]; return ''
  }).replace(/\[[^\]]*\]/g, () => { b++; return '' }).replace(/::[\w-]+/g, () => { c++; return '' }).replace(/#[\w-]+/g, () => { a++; return '' })
    .replace(/[.:][\w-]+/g, () => { b++; return '' })
  c += rest.match(/[a-z][\w-]*/gi)?.length ?? 0
  return [a, b, c]
}
const compare = (x: readonly number[], y: readonly number[]) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
/** Shorthands set the colour longhand the cascade below compares. */
const colorProperty: Record<string, string> = { background: 'background-color', outline: 'outline-color', border: 'border-color' }
/**
 * The cascade for one element: the declarations of every rule in styles.css whose selector is one compound made only of
 * the given simple selectors (so `button:hover:not(:disabled)` applies to a hovered chip, `.dock-empty button` does not),
 * at the top level or, with `forcedColors`, also inside the forced-colors block; the winner by specificity, then order.
 */
function computed(simple: readonly string[], forcedColors = false): Map<string, string> {
  const winners = new Map<string, { value: string; rank: [number, number, number]; order: number }>()
  rules.forEach((rule, order) => {
    if (rule.at.length && !(forcedColors && rule.at.join(' ') === forced[0])) return
    for (const part of selectorParts(rule.selector)) {
      const tokens = part.match(/:not\([^)]*\)|\[[^\]]*\]|::?[\w-]+|[.#][\w-]+|^[a-z][\w-]*/gi) ?? []
      if (tokens.join('') !== part || !tokens.every(token => simple.includes(token))) continue
      const rank = specificity(part)
      for (const { property, value } of rule.declarations) {
        const name = colorProperty[property] ?? property, current = winners.get(name)
        if (!current || compare(rank, current.rank) > 0 || (compare(rank, current.rank) === 0 && order >= current.order)) winners.set(name, { value, rank, order })
      }
    }
  })
  return new Map([...winners].map(([name, { value }]) => [name, value]))
}
const onChip = ['button', '.chip', '[aria-pressed="true"]', ':not(:disabled)']

describe('states kit words', () => {
  it('says intervals and ages as people do', () => {
    expect([500, 1000, 1500, 2000, 30_000, 60_000, 90_000, 3_600_000, 5_400_000].map(formatInterval)).toEqual(['500 ms', '1 s', '1.5 s', '2 s', '30 s', '1 min', '1 min 30 s', '1 h', '1 h 30 min'])
    expect([0, 999, 1000, 12_400, 59_999, 60_000, 3_599_999, 3_600_000, 47 * 3_600_000, 48 * 3_600_000, -5].map(formatAge))
      .toEqual(['just now', 'just now', '1 s ago', '12 s ago', '59 s ago', '1 min ago', '59 min ago', '1 h ago', '47 h ago', '2 d ago', 'just now'])
    expect(formatClock(at(22, 44, 3))).toBe('22:44:03')
    expect(formatClock(new Date(2026, 0, 2, 7, 5, 9))).toBe('07:05:09')
  })
  it('labels a live view by what it is doing', () => {
    expect(liveLabel({ state: 'live', intervalMs: 2000 })).toBe('Live · every 2 s')
    expect(liveLabel({ state: 'slowed', intervalMs: 2000, effectiveMs: 4000 })).toBe('Live · slowed to 4 s')
    // Slowed to no more than the chosen interval is just live.
    expect(liveLabel({ state: 'slowed', intervalMs: 2000, effectiveMs: 2000 })).toBe('Live · every 2 s')
    expect(liveLabel({ state: 'paused', intervalMs: 2000 })).toBe('Paused')
    // Every status the live layer reports has its own words, and only a collecting view shows the dot.
    const statuses: LiveStatus[] = [{ state: 'connecting', intervalMs: 2000 }, { state: 'paused', intervalMs: 2000, pausedBy: 'user' }, { state: 'paused', intervalMs: 2000, pausedBy: 'hidden' },
      { state: 'dormant', intervalMs: 2000, pausedBy: 'hidden' }, { state: 'lost', intervalMs: 2000 }, { state: 'ended', intervalMs: 2000, ended: 'sourceEnded' },
      { state: 'ended', intervalMs: 2000, ended: 'disconnected' }, { state: 'ended', intervalMs: 2000, ended: 'failed' }, { state: 'ended', intervalMs: 2000, ended: 'cancelled' }, { state: 'ended', intervalMs: 2000 }]
    expect(statuses.map(liveLabel)).toEqual(['Starting…', 'Paused', 'Paused while hidden', 'Stopped while hidden', 'Stopped · backend unavailable', 'Finished', 'Disconnected', 'Stopped · failed', 'Stopped', 'Stopped'])
    expect(statuses.map(liveIcon)).toEqual(['circle-outline', 'debug-pause', 'debug-pause', 'debug-pause', 'debug-disconnect', 'pass', 'debug-disconnect', 'debug-stop', 'debug-stop', 'debug-stop'])
    expect([liveIcon({ state: 'live', intervalMs: 2000 }), liveIcon({ state: 'slowed', intervalMs: 2000, effectiveMs: 4000 })]).toEqual([undefined, undefined])
    expect(updatedLabel(undefined, 10_000)).toBe('Waiting for data')
    expect(updatedLabel(at(22, 44, 0), at(22, 44, 12))).toBe('Updated 12 s ago')
    expect(staleLabel(at(22, 44, 3), at(22, 44, 10), at(22, 44, 13) + 200)).toBe('Stale since 22:44:03 · retrying in 4 s')
    expect(staleLabel(at(22, 44, 3), at(22, 44, 10), at(22, 44, 10))).toBe('Stale since 22:44:03 · retrying now')
    expect(staleLabel(at(22, 44, 3), at(22, 44, 10))).toBe('Stale since 22:44:03')
  })
  it('copies details with the context, code, message and SQL Server numbers, bounded', () => {
    expect(errorDetailsText({ message: 'Invalid object name \'dbo.Nope\'.', code: 'SQL_ERROR', details: { number: 208, class: 16, state: 1, server: 'localhost' }, context: 'Loading Tables on localhost' }))
      .toBe('Loading Tables on localhost\nCode: SQL_ERROR\nMessage: Invalid object name \'dbo.Nope\'.\nSQL Server: Msg 208, Level 16, State 1, Server localhost')
    expect(errorDetailsText({ message: 'The backend stopped.' })).toBe('Message: The backend stopped.')
    expect(errorDetailsText({ message: 'Failed.', code: 'BACKEND_ERROR', extra: '  System.IO.FileNotFoundException\n' })).toBe('Code: BACKEND_ERROR\nMessage: Failed.\n\nSystem.IO.FileNotFoundException')
    // The backend's exception types for BACKEND_ERROR (the generic sentence hides them), and a connect failure's reason.
    expect(errorDetailsText({ message: 'The backend operation failed.', code: 'BACKEND_ERROR', details: { exception: 'System.DllNotFoundException (0x80131524)' }, context: 'Connecting to localhost' }))
      .toBe('Connecting to localhost\nCode: BACKEND_ERROR\nMessage: The backend operation failed.\nException: System.DllNotFoundException (0x80131524)')
    expect(errorDetailsText({ message: 'Not trusted.', code: 'SQL_ERROR', details: { number: -2146893019, class: 20, state: 0, server: 'sql01', reason: 'certificate' } }))
      .toBe('Code: SQL_ERROR\nMessage: Not trusted.\nSQL Server: Msg -2146893019, Level 20, State 0, Server sql01\nReason: certificate')
    const long = errorDetailsText({ message: 'x'.repeat(40_000) })
    expect(long).toHaveLength(maxErrorDetails)
    expect(long.endsWith('…')).toBe(true)
    // Object Explorer's fault copies the fault and its component stack after the sentence.
    expect(errorDetailsText(explorerFault('Error: Object Explorer test fault.\n\nComponent stack:\n    at ExplorerTree')))
      .toBe('Message: Object Explorer stopped because of a rendering error.\n\nError: Object Explorer test fault.\n\nComponent stack:\n    at ExplorerTree')
  })
  it('say what Copy details did, for the details shown now only', async () => {
    const text = 'Message: Could not load Tables.'
    const copied = await copyText(async () => ({ ok: true }), text)
    expect(copied).toEqual({ text, ok: true })
    expect(copyStatus(copied, text)).toBe('Details copied.')
    // Main refused it (over its limit, or no clipboard), or the call failed: never "copied".
    const refused = await copyText(async () => ({ ok: false }), text)
    expect(copyStatus(refused, text)).toBe('The details could not be copied.')
    const rejected = await copyText(() => Promise.reject(new Error('IPC closed')), text)
    expect(rejected).toEqual({ text, ok: false })
    expect(copyStatus(rejected, text)).toBe('The details could not be copied.')
    // A different error replaced the copied one, or nothing was copied yet.
    expect(copyStatus(copied, 'Message: Could not load Views.')).toBe('')
    expect(copyStatus(undefined, text)).toBe('')
  })
})

describe('states kit components', () => {
  it('draw one empty state with at most one filled action', () => {
    const markup = html(createElement(EmptyState, { className: 'workspace-empty', icon: 'file-code', title: 'No open queries', detail: 'Open or create a query.',
      actions: [{ label: 'New query', run: () => {}, primary: true }, { label: 'Open SQL file', run: () => {}, primary: true }] }))
    expect(markup).toBe('<div class="empty-state workspace-empty"><span class="codicon codicon-file-code empty-state-icon" data-icon="file-code" aria-hidden="true"></span><p class="empty-state-title">No open queries</p>'
      + '<p class="empty-state-detail">Open or create a query.</p><div class="empty-state-actions"><button type="button" class="primary">New query</button><button type="button">Open SQL file</button></div></div>')
    expect(html(createElement(EmptyState, { detail: 'Results were closed.' }))).toBe('<div class="empty-state"><p class="empty-state-detail">Results were closed.</p></div>')
  })
  it('show an inline error as a live sentence with its actions and Copy details', () => {
    const markup = html(createElement(InlineError, { message: 'Could not load Tables.', code: 'TIMEOUT', actions: [{ label: 'Retry', run: () => {} }] }))
    expect(markup).toContain('<span class="codicon codicon-error" data-icon="error" aria-hidden="true"></span>')
    expect(markup).toContain('<p class="inline-error-message" role="alert">Could not load Tables.</p>')
    expect(markup).toContain('<button type="button">Retry</button><button type="button">Copy details</button><span class="inline-error-status" role="status"></span>')
    // The outer box is not a live region, so the copy outcome is announced once, by its own status.
    expect(markup.startsWith('<div class="inline-error">')).toBe(true)
    const quiet = html(createElement(InlineError, { message: 'Shown again.', role: 'status', copy: false }))
    expect(quiet).toBe('<div class="inline-error"><span class="codicon codicon-error" data-icon="error" aria-hidden="true"></span><div class="inline-error-body"><p class="inline-error-message" role="status">Shown again.</p></div></div>')
    // A note (why nothing here fixes it) is part of the live sentence, so it is read with it and lines up with it.
    expect(html(createElement(InlineError, { message: 'Not trusted.', note: 'Install a trusted certificate.', copy: false })))
      .toContain('<p class="inline-error-message" role="alert">Not trusted.<span class="inline-error-note">Install a trusted certificate.</span></p>')
  })
  it('draw bounded placeholder rows that say what is loading', () => {
    expect(html(createElement(Skeleton, { label: 'Loading databases' }))).toBe('<div class="skeleton" role="status"><span class="visually-hidden">Loading databases…</span>'
      + '<div class="skeleton-row" aria-hidden="true"></div><div class="skeleton-row" aria-hidden="true"></div><div class="skeleton-row" aria-hidden="true"></div></div>')
    const count = (rows: number) => html(createElement(Skeleton, { rows })).split('skeleton-row').length - 1
    expect([count(0), count(2.7), count(500)]).toEqual([1, 2, maxSkeletonRows])
  })
  it('draw status pills and tags with a word, a tone and the tone\'s glyph', () => {
    expect(html(createElement(StatusPill, { tone: 'running', label: 'RESTORING 42 %' })))
      .toBe('<span class="status-pill" data-tone="running"><span class="codicon codicon-loading" data-icon="loading" aria-hidden="true"></span><span class="status-pill-label">RESTORING 42 %</span></span>')
    // An environment tag has no glyph by default, and the small size fits tree rows and the status bar.
    expect(html(createElement(StatusPill, { tone: 'critical', label: 'PROD', variant: 'tag', size: 'small', title: 'Production environment' })))
      .toBe('<span class="status-pill tag small" data-tone="critical" title="Production environment"><span class="status-pill-label">PROD</span></span>')
    expect(html(createElement(StatusPill, { tone: 'success', label: 'Succeeded', icon: null }))).not.toContain('codicon')
    expect(html(createElement(StatusPill, { tone: 'neutral', label: 'Canceled', icon: 'circle-slash' }))).toContain('codicon-circle-slash')
    for (const tone of statusTones) expect(html(createElement(StatusPill, { tone, label: tone })), tone).toContain(`data-tone="${tone}"`)
    expect(Object.keys(toneIcons)).toEqual([...statusTones])
    expect([isStatusTone('critical'), isStatusTone('error'), isStatusTone(3)]).toEqual([true, false, false])
  })
  it('draw filter chips as toggle buttons whose on state is more than color', () => {
    const off = html(createElement(Chip, { label: 'Blocked', count: 1234, icon: 'lock', pressed: false, onToggle: () => {} }))
    expect(off).toBe('<button type="button" class="chip" aria-pressed="false"><span class="codicon codicon-lock" data-icon="lock" aria-hidden="true"></span><span>Blocked</span><span class="chip-count">1,234</span></button>')
    const on = html(createElement(Chip, { label: 'All', pressed: true, onToggle: () => {} }))
    expect(on).toBe('<button type="button" class="chip" aria-pressed="true"><span class="codicon codicon-check" data-icon="check" aria-hidden="true"></span><span>All</span></button>')
    expect(html(createElement(ChipGroup, { label: 'Filter sessions', children: 'x' }))).toBe('<div class="chip-group" role="group" aria-label="Filter sessions">x</div>')
  })
  it('draw the live state and the data\'s age', () => {
    expect(html(createElement(LivePill, { state: 'live', intervalMs: 2000 }))).toBe('<span class="live-pill" data-state="live"><span class="live-dot" aria-hidden="true"></span><span>Live · every 2 s</span></span>')
    expect(html(createElement(LivePill, { state: 'paused', intervalMs: 2000 }))).toBe('<span class="live-pill" data-state="paused"><span class="codicon codicon-debug-pause" data-icon="debug-pause" aria-hidden="true"></span><span>Paused</span></span>')
    expect(html(createElement(LivePill, { state: 'connecting', intervalMs: 2000 }))).toBe('<span class="live-pill" data-state="connecting"><span class="codicon codicon-circle-outline" data-icon="circle-outline" aria-hidden="true"></span><span>Starting…</span></span>')
    expect(html(createElement(LivePill, { state: 'ended', intervalMs: 2000, ended: 'disconnected' }))).toBe('<span class="live-pill" data-state="ended"><span class="codicon codicon-debug-disconnect" data-icon="debug-disconnect" aria-hidden="true"></span><span>Disconnected</span></span>')
    expect(html(createElement(StaleBadge, { updatedAt: at(22, 44, 0), now: at(22, 44, 12) }))).toBe('<span class="stale-badge">Updated 12 s ago</span>')
    expect(html(createElement(StaleBadge, { updatedAt: at(22, 44, 0), stale: { since: at(22, 44, 3), retryAt: at(22, 44, 14) }, now: at(22, 44, 10) })))
      .toBe('<span class="stale-badge" data-stale=""><span class="codicon codicon-warning" data-icon="warning" aria-hidden="true"></span><span>Stale since 22:44:03 · retrying in 4 s</span></span>')
  })
  it('draw a metric tile named for what it says, with its threshold as a glyph and words', () => {
    expect(tileName({ caption: 'Waiting Tasks', value: '12', context: 'avg 4', tone: 'warning' })).toBe('Waiting Tasks: 12, avg 4, above its warning threshold')
    expect(tileName({ caption: '% Processor Time', value: '20', unit: '%' })).toBe('% Processor Time: 20 %')
    expect(tileName({ caption: 'Batch Requests/sec', unit: '/s' })).toBe('Batch Requests/sec: no data yet')
    const markup = html(createElement(Tile, { caption: 'Database I/O', value: '3.2', unit: 'MB/s', tone: 'critical', children: createElement('canvas') }))
    expect(markup).toBe('<div class="tile" role="group" aria-label="Database I/O: 3.2 MB/s, above its critical threshold" data-tone="critical"><div class="tile-caption" aria-hidden="true">'
      + '<span class="codicon codicon-error" data-icon="error" aria-hidden="true"></span><span class="tile-caption-text">Database I/O</span></div><p class="tile-value" aria-hidden="true">3.2<span class="tile-unit">MB/s</span></p>'
      + '<div class="tile-chart"><canvas></canvas></div></div>')
    expect(html(createElement(Tile, { caption: 'CPU', unit: '%' }))).toContain('<p class="tile-value" aria-hidden="true">—</p>')
  })
})

describe('states kit styles and colors', () => {
  it('give every tone a pill rule on its own keys', () => {
    for (const tone of statusTones) {
      const { background, foreground } = toneKeys(tone)
      expect(colorRegistry[background].consumers, background).toContain('css')
      expect(valueOf(`.status-pill[data-tone="${tone}"]`, 'background'), tone).toBe(`var(${cssVariable(background)})`)
      expect(valueOf(`.status-pill[data-tone="${tone}"]`, 'color'), tone).toBe(`var(${cssVariable(foreground)})`)
    }
    for (const tone of tileTones) expect(valueOf(`.tile[data-tone="${tone}"]`, 'border-color')).toBe(`var(${cssVariable(`tile.${tone}Border` as ColorKey)})`)
  })
  it('hold pill text to 4.5:1 on every surface E2 and E3 draw pills on', () => {
    // Environment tags go on the server node, tabs, the query bar and every status bar state; status chips on tree rows,
    // selected or not.
    const surfaces: ColorKey[][] = [['sideBar.background'], ['sideBar.background', 'list.activeSelectionBackground'], ['sideBar.background', 'list.inactiveSelectionBackground'],
      ['sideBar.background', 'list.hoverBackground'], ['sideBar.background', 'objectExplorer.activeConnectionBackground'], ['documentTabs.background'], ['editor.background'],
      ['statusBar.background'], ['statusBar.executingBackground'], ['statusBar.disconnectedBackground'], ['statusBar.errorBackground'], ['queryStatusBar.background'],
      ['queryStatusBar.executingBackground'], ['queryStatusBar.errorBackground']]
    for (const tone of statusTones) {
      const { background, foreground } = toneKeys(tone)
      for (const surface of surfaces) expect(contrastPairs, `${tone} on ${surface.join(' > ')}`).toContainEqual({ foreground, background: [...surface, background], minimum: 4.5 })
    }
  })
  it('hold placeholders back so a quick load never flashes one, without motion of their own', () => {
    expect(motion.delay.ms).toBe(300)
    expect(valueOf('.skeleton', 'animation')).toBe('varia-appear var(--varia-motion-base) var(--varia-motion-ease) var(--varia-motion-delay) both')
    expect(declarationsOf('.skeleton-row::before').some(({ property }) => property.startsWith('animation'))).toBe(false)
  })
  it('pulse only a collecting live dot, and stop it under reduced motion', () => {
    expect(valueOf('.live-pill[data-state="live"] .live-dot', 'animation')).toContain('var(--varia-motion-pulse)')
    expect(valueOf('.live-pill[data-state="live"] .live-dot', 'animation', ['@media (prefers-reduced-motion: reduce)'])).toBe('none')
    expect(declarationsOf('.live-dot').some(({ property }) => property.startsWith('animation'))).toBe(false)
    // Only the collecting states keep the plain label color; the rest are muted beside their glyph.
    expect(valueOf('.live-pill:not([data-state="live"], [data-state="slowed"])', 'color')).toBe('var(--varia-live-pausedForeground)')
  })
  it('keep an on chip filled under the pointer, as the keyboard leaves it', () => {
    expect(specificity('button:hover:not(:disabled)')).toEqual([0, 2, 1])
    expect(specificity('.chip[aria-pressed="true"]:hover:not(:disabled)')).toEqual([0, 4, 0])
    const rest = computed(onChip), hovered = computed([...onChip, ':hover'])
    expect(rest.get('background-color')).toBe('var(--varia-chip-activeBackground)')
    for (const property of ['background-color', 'color', 'border-color']) expect(hovered.get(property), property).toBe(rest.get(property))
    // Selection-like state changes at once, so hovering does not bring back the hover fade.
    expect(hovered.get('transition')).toBe('none')
    // An off chip still takes the shared hover fill.
    expect(computed(['button', '.chip', ':not(:disabled)', ':hover']).get('background-color')).toBe('var(--varia-button-secondaryHoverBackground)')
  })
  it('keep the kit legible under forced colors', () => {
    expect(valueOf('.status-pill, .stale-badge[data-stale], .tile', 'border', forced)).toBe('1px solid CanvasText')
    expect(valueOf('[aria-selected="true"] .status-pill', 'color', forced)).toBe('inherit')
    // An on chip opts out of forcing, so no theme color may reach it at rest, hovered or focused: forced colors would not
    // replace it (Varia Dark's focus ring is 2.5:1 on a white Canvas).
    for (const state of [[], [':hover'], [':focus-visible'], [':hover', ':focus-visible']]) {
      const style = computed([...onChip, ...state], true), name = state.join('') || 'rest'
      expect(style.get('forced-color-adjust'), name).toBe('none')
      expect(style.get('background-color'), name).toBe('Highlight')
      expect(style.get('color'), name).toBe('HighlightText')
      for (const property of ['background-color', 'color', 'border-color', 'outline-color', 'box-shadow']) expect(style.get(property) ?? '', `${property} ${name}`).not.toContain('var(--varia-')
    }
    expect(computed([...onChip, ':focus-visible'], true).get('outline-color')).toBe('CanvasText')
    // The live dot opts out too, and its pulse ring is the theme's green, so the dot holds still.
    expect(valueOf('.live-dot, .skeleton-row::before', 'forced-color-adjust', forced)).toBe('none')
    expect(rules.find(rule => rule.at[0] === '@keyframes varia-pulse')?.declarations.some(({ value }) => value.includes('var(--varia-'))).toBe(true)
    expect(valueOf('.live-pill[data-state="live"] .live-dot', 'animation', forced)).toBe('none')
  })
})
