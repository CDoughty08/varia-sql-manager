import type { IconId } from '../../../shared/icons'
import type { KeybindingLabel } from '../../../shared/commands/keybindings'
import { onUnexpectedError } from '../core/errors'
import { SnapshotStore } from '../core/store'
import { browserTimers, type Timers } from '../core/timers'
import type { FocusAdapter } from '../core/focus'
import type { Disposable } from '../core/types'
import { compareRanked, prepareQuery, scoreQuery, type MatchRange } from './fuzzy'

export interface QuickPickItem {
  readonly id: string
  readonly label: string
  /** Where the item's own name starts in `label`, after a category such as "Query: ": a match there ranks as one at the start. */
  readonly titleStart?: number
  readonly description?: string
  /** The row's tooltip, such as a file path. */
  readonly tooltip?: string
  readonly icon?: IconId
  readonly keybinding?: KeybindingLabel
  readonly group?: string
  readonly keywords?: readonly string[]
  readonly disabled?: boolean
  /** Shown when the disabled row is accepted. */
  readonly disabledHint?: string
  readonly ariaLabel?: string
}
export type HideReason = 'accept' | 'cancel' | 'blur' | 'replace'
export type QuickInputMove = 'next' | 'previous' | 'pageNext' | 'pagePrevious' | 'first' | 'last'
export type ValueSelection = 'end' | 'afterPrefix' | 'all'
export interface QuickInputMessage { readonly text: string; readonly severity: 'info' | 'error' }
export interface QuickPickOptions<T extends QuickPickItem> {
  readonly ariaLabel: string
  readonly placeholder: string
  readonly title?: string
  readonly value?: string
  /** A quick access prefix such as '>': it is not part of the filter, and 'afterPrefix' selects the text after it. */
  readonly prefix?: string
  /** The row that is active on open; otherwise the first. */
  readonly activeId?: string
  /** What the rows are, in the plural, for messages: 'commands', 'databases'. */
  readonly noun: string
  readonly items: readonly T[] | ((signal: AbortSignal) => Promise<readonly T[]>)
  /**
   * 'score' (the default) orders matches best first; 'none' keeps the provided order; 'grouped' keeps the groups in the
   * order they are provided, each under its label, and orders the matches within each group best first.
   */
  readonly sort?: 'score' | 'none' | 'grouped'
  readonly matchOnDescription?: boolean
  /** Most recent first. With an empty filter these rows come first, under "recently used". */
  readonly recentIds?: readonly string[]
  /** False keeps the widget open after an accept, for rows that switch mode. */
  readonly hideOnAccept?: boolean
  onDidChangeValue?(value: string): void
  onDidChangeActive?(item: T | undefined): void
  onDidAccept(item: T): void | Promise<void>
  onDidHide?(reason: HideReason): void
}
export type { FocusAdapter } from '../core/focus'
/** A visible row. `group` is set on the first row of each run of a group, where the view draws the label and a border. */
export interface QuickInputRow { readonly item: QuickPickItem; readonly ranges: readonly MatchRange[]; readonly descriptionRanges: readonly MatchRange[]; readonly group?: string }
/** A value for the view to write into its (uncontrolled) input; `version` changes with every request. */
export interface QuickInputValue { readonly value: string; readonly selection: ValueSelection; readonly version: number }
export interface QuickInputView {
  readonly visible: boolean
  /** Changes with every `show`. */
  readonly session: number
  readonly ariaLabel: string
  readonly placeholder: string
  readonly title?: string
  readonly noun: string
  readonly prefix: string
  readonly rows: readonly QuickInputRow[]
  /** -1 when there are no rows. */
  readonly activeIndex: number
  /** A load has taken longer than 150 ms. */
  readonly busy: boolean
  readonly loading: boolean
  readonly message?: QuickInputMessage
  readonly input: QuickInputValue
}

/**
 * `items` bounds what a picker keeps and filters, above SQL Server's 32,767 databases per instance, so typing can reach
 * every row; `rows` bounds what it shows at once.
 */
export const quickInputLimits = { items: 50_000, rows: 5000, label: 512, description: 256, value: 256, busyDelay: 150, loadTimeout: 30_000 } as const
const descriptionWeight = 0.8

interface Entry { readonly source: QuickPickItem; readonly view: QuickPickItem; readonly recentRank?: number }
interface Session {
  readonly id: number
  readonly options: QuickPickOptions<QuickPickItem>
  readonly abort: AbortController
  readonly timers: unknown[]
  entries: readonly Entry[]
  value: string
  /** The last non-empty filter and what it matched, so a longer filter only re-scores those. */
  matched?: { readonly text: string; readonly entries: readonly Entry[] }
  rows: readonly QuickInputRow[]
  rowEntries: readonly Entry[]
  activeIndex: number
  lastActive?: Entry
  loading: boolean
  busy: boolean
  loadMessage?: QuickInputMessage
  /** Set while the filter matches more rows than are shown. */
  truncation?: QuickInputMessage
  hint?: QuickInputMessage
}

class VisibilityStore extends SnapshotStore<{ readonly visible: boolean }> {
  constructor() { super({ visible: false }) }
  set(visible: boolean): void { if (visible !== this.getSnapshot().visible) this.publish({ visible }) }
  dispose(): void { this.clearListeners() }
}

const errorText = (error: unknown) => error instanceof Error && error.message ? error.message : 'The list could not be loaded.'
const unavailable = (item: QuickPickItem) => item.disabledHint || `“${item.label}” is not available right now.`
const formatCount = (count: number) => count.toLocaleString('en-US')
function invoke(callback: () => unknown): void {
  try {
    const result = callback()
    if (result instanceof Promise) result.catch(onUnexpectedError)
  } catch (error) { onUnexpectedError(error) }
}
/** The row as shown, or undefined for an item without a string id and label: a malformed provider result must not break the picker. */
function displayed(item: QuickPickItem): QuickPickItem | undefined {
  if (typeof item?.id !== 'string' || typeof item.label !== 'string') return undefined
  const { label, description, ...rest } = item
  const text = typeof description === 'string' ? description.slice(0, quickInputLimits.description) : undefined
  if (label.length <= quickInputLimits.label && text === description) return item
  return { ...rest, label: label.slice(0, quickInputLimits.label), ...text === undefined ? {} : { description: text } }
}

/**
 * The quick input controller: one picker session at a time, with filtering, keyboard navigation, async loading, and
 * focus return. It has no DOM; `QuickInput.tsx` renders its snapshot and forwards input events here.
 */
export class QuickInputService extends SnapshotStore<QuickInputView> implements Disposable {
  /** Changes only when the widget opens or closes (the `quickInputVisible` context key). */
  readonly visibility = new VisibilityStore()
  private current?: Session
  private sessions = 0
  private restoreTarget: unknown
  private input: QuickInputValue = { value: '', selection: 'end', version: 0 }
  private disposed = false
  constructor(private readonly focus: FocusAdapter, private readonly timers: Timers = browserTimers) {
    super({ visible: false, session: 0, ariaLabel: '', placeholder: '', noun: '', prefix: '', rows: [], activeIndex: -1, busy: false, loading: false, input: { value: '', selection: 'end', version: 0 } })
  }
  get visible(): boolean { return !!this.current }
  /** The text in the input, prefix included. */
  get value(): string { return this.current?.value ?? '' }

  /** Opens a picker. While one is open it is replaced (`onDidHide('replace')`), and focus still returns to where it was before the first. */
  show<T extends QuickPickItem>(options: QuickPickOptions<T>): void {
    if (this.disposed) return
    const previous = this.current
    if (previous) this.stop(previous)
    else this.restoreTarget = this.capture()
    const value = (options.value ?? '').slice(0, quickInputLimits.value)
    const session: Session = {
      id: ++this.sessions, options: options as unknown as QuickPickOptions<QuickPickItem>, abort: new AbortController(), timers: [],
      entries: [], value, rows: [], rowEntries: [], activeIndex: -1, loading: false, busy: false
    }
    this.current = session
    // A mode switch by typing keeps the input as it is; anything else writes the new value.
    if (previous?.value !== value) this.requestInput(value, 'end')
    const { items } = options
    if (typeof items === 'function') this.load(session, items)
    else this.receive(session, items)
    this.publishSession(session)
    this.visibility.set(true)
    if (previous) this.notifyHide(previous, 'replace')
    this.notifyActive(session)
  }
  /** Shows a picker and resolves with the accepted item, or undefined when it closes otherwise. */
  pick<T extends QuickPickItem>(options: Omit<QuickPickOptions<T>, 'onDidAccept'>): Promise<T | undefined> {
    if (this.disposed) return Promise.resolve(undefined)
    return new Promise(resolve => {
      this.show<T>({ ...options, onDidAccept: item => resolve(item), onDidHide: reason => {
        try { options.onDidHide?.(reason) } finally { if (reason !== 'accept') resolve(undefined) }
      } })
    })
  }
  /** The input's text changed; the first row becomes active. */
  filter(value: string): void {
    const session = this.current
    if (!session) return
    value = value.slice(0, quickInputLimits.value)
    if (value === session.value) return
    session.value = value
    session.hint = undefined
    try { session.options.onDidChangeValue?.(value) } catch (error) { onUnexpectedError(error) }
    // The provider may have replaced the session (a quick access mode switch).
    if (this.current !== session) return
    this.applyFilter(session)
    this.publishSession(session)
    this.notifyActive(session)
  }
  /** Writes a value into the input (mode switches, F1 while open) and filters with it. */
  setValue(value: string, selection: ValueSelection): void {
    const session = this.current
    if (!session) return
    value = value.slice(0, quickInputLimits.value)
    this.requestInput(value, selection)
    if (value !== session.value) this.filter(value)
    else this.publishSession(session)
  }
  move(to: QuickInputMove, page = 1): void {
    const session = this.current
    if (!session || !session.rows.length) return
    const count = session.rows.length, active = session.activeIndex, step = Math.max(1, page - 1)
    const index = to === 'next' ? (active + 1) % count
      : to === 'previous' ? (active <= 0 ? count - 1 : active - 1)
      : to === 'pageNext' ? Math.min(count - 1, Math.max(0, active) + step)
      : to === 'pagePrevious' ? Math.max(0, active - step)
      : to === 'first' ? 0 : count - 1
    this.activate(session, index)
  }
  setActive(index: number): void {
    const session = this.current
    if (!session || !session.rows.length) return
    this.activate(session, Math.max(0, Math.min(session.rows.length - 1, Math.trunc(index))))
  }
  /**
   * Accepts a row (the active one by default). A disabled row shows its hint and the widget stays open. With `session`
   * (the view's session when the click began), an accept from an earlier picker is ignored, so the second click of a
   * double-click on a row that opens a picker does not pick in that picker.
   */
  accept(index?: number, session = this.current?.id): void {
    if (!this.current || session !== this.current.id) return
    const current = this.current
    const entry = current.rowEntries[index ?? current.activeIndex]
    if (!entry) return
    if (entry.view.disabled) {
      current.hint = { text: unavailable(entry.view), severity: 'info' }
      this.publishSession(current)
      return
    }
    // Focus returns first, so the command acts on what the user was working in.
    if (current.options.hideOnAccept !== false) this.hide('accept')
    invoke(() => current.options.onDidAccept(entry.source))
  }
  /** Closes the widget. Accept and cancel return focus to where it was; blur and replace leave it alone. */
  hide(reason: HideReason): void { this.close(reason, reason === 'accept' || reason === 'cancel') }
  setMessage(message?: QuickInputMessage): void {
    const session = this.current
    if (!session) return
    session.hint = message
    this.publishSession(session)
  }
  dispose(): void {
    if (this.disposed) return
    this.close('cancel', false)
    this.disposed = true
    this.visibility.dispose()
    this.clearListeners()
  }

  private capture(): unknown {
    try { return this.focus.capture() } catch (error) { onUnexpectedError(error); return undefined }
  }
  private close(reason: HideReason, restore: boolean): void {
    const session = this.current
    if (!session) return
    this.current = undefined
    this.stop(session)
    const target = this.restoreTarget
    this.restoreTarget = undefined
    this.publish({ ...this.getSnapshot(), visible: false, rows: [], activeIndex: -1, busy: false, loading: false, message: undefined, input: this.input })
    this.visibility.set(false)
    if (restore) { try { this.focus.restore(target) } catch (error) { onUnexpectedError(error) } }
    this.notifyHide(session, reason)
  }
  private stop(session: Session): void {
    session.abort.abort()
    session.loading = false
    this.clearTimers(session)
  }
  private clearTimers(session: Session): void {
    for (const timer of session.timers.splice(0)) this.timers.clearTimeout(timer)
  }
  private notifyHide(session: Session, reason: HideReason): void {
    try { session.options.onDidHide?.(reason) } catch (error) { onUnexpectedError(error) }
  }
  private requestInput(value: string, selection: ValueSelection): void {
    this.input = { value, selection, version: this.input.version + 1 }
  }
  private load(session: Session, provider: (signal: AbortSignal) => Promise<readonly QuickPickItem[]>): void {
    const { signal } = session.abort
    session.loading = true
    const pending = () => this.current === session && session.loading
    session.timers.push(this.timers.setTimeout(() => { if (pending()) { session.busy = true; this.publishSession(session) } }, quickInputLimits.busyDelay))
    session.timers.push(this.timers.setTimeout(() => {
      if (!pending()) return
      this.failLoad(session, new Error('It took longer than 30 seconds.'))
      session.abort.abort()
    }, quickInputLimits.loadTimeout))
    let request: Promise<readonly QuickPickItem[]>
    try { request = Promise.resolve(provider(signal)) } catch (error) { request = Promise.reject(error) }
    request.then(items => {
      // Results after a hide, a replace, or the timeout are dropped.
      if (!pending() || signal.aborted) return
      session.loading = false
      session.busy = false
      this.clearTimers(session)
      this.receive(session, items)
      this.publishSession(session)
      this.notifyActive(session)
    }, (error: unknown) => {
      if (!pending() || signal.aborted) return
      this.failLoad(session, error)
    })
  }
  private failLoad(session: Session, error: unknown): void {
    session.loading = false
    session.busy = false
    this.clearTimers(session)
    session.entries = []
    session.matched = undefined
    session.loadMessage = { text: `Could not load ${session.options.noun}: ${errorText(error)}`, severity: 'error' }
    this.applyFilter(session)
    this.publishSession(session)
    this.notifyActive(session)
  }
  /** Takes a provider's items; one that cannot be read is reported and shown as a failed load. */
  private receive(session: Session, items: unknown): void {
    try { this.setEntries(session, Array.isArray(items) ? items : []) }
    catch (error) { onUnexpectedError(error); this.failLoad(session, error) }
  }
  private setEntries(session: Session, items: readonly QuickPickItem[]): void {
    const { noun, recentIds = [] } = session.options
    const recent = new Map<string, number>()
    recentIds.forEach((id, rank) => { if (!recent.has(id)) recent.set(id, rank) })
    session.entries = items.slice(0, quickInputLimits.items).flatMap(source => {
      const view = displayed(source)
      return view ? [{ source, view, recentRank: recent.get(view.id) }] : []
    })
    session.matched = undefined
    if (items.length > quickInputLimits.items) session.loadMessage = { text: `Only the first ${formatCount(quickInputLimits.items)} ${noun} can be searched`, severity: 'info' }
    this.applyFilter(session, session.options.activeId)
  }
  private applyFilter(session: Session, activeId?: string): void {
    const { prefix = '', sort = 'score', matchOnDescription, noun } = session.options
    const text = session.value.startsWith(prefix) ? session.value.slice(prefix.length) : session.value
    const query = prepareQuery(text)
    let ordered: { entry: Entry; ranges: readonly MatchRange[]; descriptionRanges: readonly MatchRange[]; group?: string }[]
    // 'grouped': each group where its first item is, so a group's rows stay together under one label.
    const groupOrder = new Map<string | undefined, number>()
    if (sort === 'grouped') for (const entry of session.entries) if (!groupOrder.has(entry.view.group)) groupOrder.set(entry.view.group, groupOrder.size)
    const byGroup = (a: { group?: string }, b: { group?: string }) => groupOrder.get(a.group)! - groupOrder.get(b.group)!
    if (!query.words.length) {
      session.matched = undefined
      const recent = session.entries.filter(entry => entry.recentRank !== undefined).sort((a, b) => a.recentRank! - b.recentRank!)
      ordered = recent.length
        ? [...recent.map(entry => ({ entry, group: 'recently used' })), ...session.entries.filter(entry => entry.recentRank === undefined).map(entry => ({ entry, group: `other ${noun}` }))]
          .map(row => ({ ...row, ranges: [], descriptionRanges: [] }))
        : session.entries.map(entry => ({ entry, ranges: [], descriptionRanges: [], group: entry.view.group }))
      if (sort === 'grouped' && !recent.length) ordered.sort(byGroup)
    } else {
      const narrowing = session.matched && text.startsWith(session.matched.text)
      const candidates = narrowing ? session.matched!.entries : session.entries
      const scored: { entry: Entry; score: number; ranges: readonly MatchRange[]; descriptionRanges: readonly MatchRange[]; group?: string }[] = []
      for (const entry of candidates) {
        const label = scoreQuery(query, entry.view.label, entry.view.keywords, entry.view.titleStart)
        if (label) { scored.push({ entry, score: label.score, ranges: label.ranges, descriptionRanges: [], group: entry.view.group }); continue }
        const description = matchOnDescription && entry.view.description ? scoreQuery(query, entry.view.description) : undefined
        if (description) scored.push({ entry, score: description.score * descriptionWeight, ranges: [], descriptionRanges: description.ranges, group: entry.view.group })
      }
      session.matched = { text, entries: scored.map(match => match.entry) }
      const ranked = (a: typeof scored[number], b: typeof scored[number]) => compareRanked({ score: a.score, label: a.entry.view.label, disabled: a.entry.view.disabled, recentRank: a.entry.recentRank },
        { score: b.score, label: b.entry.view.label, disabled: b.entry.view.disabled, recentRank: b.entry.recentRank })
      if (sort === 'score') {
        // Ranked rows interleave groups, so their labels would repeat; they are shown only in provided order.
        scored.sort(ranked)
        for (const match of scored) match.group = undefined
      } else if (sort === 'grouped') scored.sort((a, b) => byGroup(a, b) || ranked(a, b))
      ordered = scored
    }
    const shown = ordered.length > quickInputLimits.rows ? ordered.slice(0, quickInputLimits.rows) : ordered
    session.truncation = shown.length < ordered.length
      ? { text: `Showing ${formatCount(shown.length)} of ${formatCount(ordered.length)} ${noun}; type to narrow the list`, severity: 'info' } : undefined
    session.rowEntries = shown.map(row => row.entry)
    session.rows = shown.map((row, index) => ({
      item: row.entry.view, ranges: row.ranges, descriptionRanges: row.descriptionRanges,
      ...row.group !== undefined && (index === 0 || shown[index - 1].group !== row.group) ? { group: row.group } : {}
    }))
    const wanted = activeId === undefined ? -1 : session.rowEntries.findIndex(entry => entry.source.id === activeId)
    session.activeIndex = session.rows.length ? Math.max(0, wanted) : -1
  }
  private activate(session: Session, index: number): void {
    if (index === session.activeIndex) return
    session.activeIndex = index
    session.hint = undefined
    this.publishSession(session)
    this.notifyActive(session)
  }
  private notifyActive(session: Session): void {
    if (this.current !== session) return
    const entry = session.rowEntries[session.activeIndex]
    if (entry === session.lastActive) return
    session.lastActive = entry
    try { session.options.onDidChangeActive?.(entry?.source) } catch (error) { onUnexpectedError(error) }
  }
  private publishSession(session: Session): void {
    if (this.current !== session) return
    const { options } = session
    this.publish({
      visible: true, session: session.id, ariaLabel: options.ariaLabel, placeholder: options.placeholder, title: options.title, noun: options.noun, prefix: options.prefix ?? '',
      rows: session.rows, activeIndex: session.activeIndex, busy: session.busy, loading: session.loading, message: session.hint ?? session.loadMessage ?? session.truncation, input: this.input
    })
  }
}
