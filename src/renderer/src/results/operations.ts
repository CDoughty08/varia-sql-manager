import { SnapshotStore } from '../core/store'
import { browserTimers, type Timers } from '../core/timers'
import { gridLimits as g } from '../grid/constants'
import type { OperationPhase } from '../../../shared/ipc/port-messages'
import type { EntryKey } from './ResultsService'

/** What an operation over a whole result is doing. A sort or filter builds a grid's view, which holds that grid's
 *  controls off; the others only read and show their progress. */
export type OperationKind = 'sort' | 'filter' | 'profile' | 'pivot' | 'compare'

/** An operation over a whole result in flight for a query tab, as the toolbar's strip, the grid's bar and its header show it. */
export interface ResultOperation {
  readonly id: number
  readonly tabId: string
  readonly kind: OperationKind
  /** The grid it builds for or reads (a sort, filter or profile), or the group's Table a pivot reads. */
  readonly entry?: EntryKey
  /** The column whose header shows it: a sort's first key, a filter's column. */
  readonly column?: number
  /** What it works on, as the toolbar names it ("Result 1", "Result 1 → Result 2"). */
  readonly target: string
  readonly phase?: OperationPhase
  /** 0 – 100, never going back; absent while the phase has no total (or before the first report). */
  readonly percent?: number
  /** Shown: it has run `operationShowDelayMs`, or a click on a held-off control brought it up early. */
  readonly shown: boolean
  /** It has ended and stays only until it has been shown `operationMinShownMs`; it holds nothing off. */
  readonly ending: boolean
  readonly startedAt: number
  /** When it last reported: the strip's elapsed time is read from it, so no timer ticks in the renderer. */
  readonly updatedAt: number
  /** Bumped by each click on a control it holds off, so the strip pulses once more. */
  readonly pulse: number
}

/** What a tab's operations look like now: its operations, and the polite live region's sentence (start and end, never
 *  percentages) with the counter it was set at. */
export interface TabOperations {
  readonly items: readonly ResultOperation[]
  readonly announcement: string
  readonly announced: number
  /** How the last one ended, when it did not simply finish ("Sort cancelled. …"); '' otherwise. */
  readonly notice: string
}

/** The caller's handle on an operation it began. */
export interface OperationTicket {
  readonly id: number
  /** The backend's latest report: a percentage lower than the last is ignored. */
  progress(phase: OperationPhase, percent: number | undefined): void
  /** It ended: `done` (it shows done until it has been up long enough), `cancelled` (a notice in the toolbar says the
   *  previous view was kept), or `dropped`: it failed, which its owner reports, or newer work took its place; it goes at once. */
  end(outcome?: OperationOutcome): void
}

/** How it ended; a cancel that kept something other than the previous view says what, in place of its kind's sentence. */
export type OperationOutcome = 'done' | 'cancelled' | 'dropped' | { readonly cancelled: string }

interface Entry { operation: ResultOperation; readonly cancel: () => void; show?: unknown; hide?: unknown; shownAt?: number }

const nouns: Readonly<Record<OperationKind, { readonly doing: string; readonly done: string; readonly cancelled: string }>> = {
  sort: { doing: 'Sorting', done: 'Sorted', cancelled: 'Sort cancelled. The grid kept its previous order.' },
  filter: { doing: 'Filtering', done: 'Filtered', cancelled: 'Filter cancelled. The grid kept its previous rows.' },
  profile: { doing: 'Profiling', done: 'Profiled', cancelled: 'Profile cancelled.' },
  pivot: { doing: 'Building Pivot of', done: 'Pivot built', cancelled: 'Pivot cancelled.' },
  compare: { doing: 'Comparing', done: 'Compared', cancelled: 'Comparison cancelled.' }
}

/** The words the toolbar uses for an operation kind. */
export const operationNoun = (kind: OperationKind): string => nouns[kind].doing

const phases: Readonly<Record<OperationPhase, string>> = {
  filter: 'Keeping rows', keys: 'Reading keys', sort: 'Sorting', unpack: 'Unpacking', group: 'Grouping', aggregate: 'Aggregating', write: 'Writing',
  identify: 'Finding row keys', match: 'Matching rows', align: 'Aligning rows', profile: 'Reading values', histogram: 'Counting histograms'
}

/** A phase as the toolbar names it. */
export const phaseText = (phase: OperationPhase | undefined): string => phase ? phases[phase] : 'Starting'

/**
 * Operations over whole results, by query tab: the one place every result control reads whether it is held off, and
 * where the toolbar's strip, the grid's bar and its header read their progress. Progress comes only from the backend's
 * op.progress events (`OperationTicket.progress`); the only timers are one-shot: the delay before an operation shows, so
 * a quick one never flashes, and the least time it stays once shown, so it never blinks.
 */
export class ResultOperations extends SnapshotStore<Readonly<Record<string, TabOperations>>> {
  private readonly entries = new Map<number, Entry>()
  private readonly notices = new Map<string, { text: string; timer: unknown }>()
  private readonly announcements = new Map<string, { text: string; at: number }>()
  private next = 0
  private counter = 0
  private readonly timers: Timers
  private readonly now: () => number

  constructor(o: { timers?: Timers; now?: () => number } = {}) {
    super({})
    this.timers = o.timers ?? browserTimers
    this.now = o.now ?? (() => Date.now())
  }

  /** Starts tracking an operation; `cancel` stops it (the strip's Cancel, Escape in the grid). */
  begin(tabId: string, o: { kind: OperationKind; target: string; entry?: EntryKey; column?: number; cancel: () => void }): OperationTicket {
    const id = ++this.next, at = this.now()
    const entry: Entry = {
      operation: { id, tabId, kind: o.kind, target: o.target, ...o.entry === undefined ? {} : { entry: o.entry }, ...o.column === undefined || o.column < 0 ? {} : { column: o.column }, shown: false, ending: false, startedAt: at, updatedAt: at, pulse: 0 },
      cancel: o.cancel
    }
    entry.show = this.timers.setTimeout(() => this.show(entry), g.operationShowDelayMs)
    this.entries.set(id, entry)
    this.clearNotice(tabId)
    this.publishTab(tabId)
    let ended = false
    return {
      id,
      progress: (phase, percent) => {
        if (ended || this.entries.get(id) !== entry) return
        const last = entry.operation.percent
        const next = percent === undefined ? (entry.operation.phase === phase ? last : undefined) : Math.max(percent, last ?? 0)
        entry.operation = { ...entry.operation, phase, ...next === undefined ? { percent: undefined } : { percent: next }, updatedAt: this.now() }
        if (entry.operation.shown) this.publishTab(tabId)
      },
      end: (outcome = 'done') => {
        if (ended) return
        ended = true
        this.end(entry, outcome)
      }
    }
  }

  /** The sort or filter building `entry`'s view, which holds that grid's sorting and filtering off. */
  building(tabId: string, entry: EntryKey): ResultOperation | undefined {
    for (const item of this.entries.values()) {
      const operation = item.operation
      if (operation.tabId === tabId && operation.entry === entry && !operation.ending && (operation.kind === 'sort' || operation.kind === 'filter')) return operation
    }
    return undefined
  }

  /** Any sort or filter in flight, in any tab: Sort Text By, which sorts every text-sorted grid again, waits for them.
   *  `shown`: only one on screen, which is when the toolbar marks Sort Text By held off (a quick one never flashes it). */
  anyBuilding(shown = false): boolean {
    for (const item of this.entries.values()) if (!item.operation.ending && (!shown || item.operation.shown) && (item.operation.kind === 'sort' || item.operation.kind === 'filter')) return true
    return false
  }

  /** A click on a control a sort or filter holds off: nothing is queued; the operation shows at once if it had not yet,
   *  pulses, and the live region says why. With no tab, every building operation (Sort Text By's), and the live region of
   *  `here`, the tab the click came from, says why too. */
  refused(tabId: string | undefined, entry?: EntryKey, here?: string): void {
    const held = [...this.entries.values()].filter(item => !item.operation.ending && (item.operation.kind === 'sort' || item.operation.kind === 'filter')
      && (tabId === undefined || item.operation.tabId === tabId) && (entry === undefined || item.operation.entry === entry))
    for (const item of held) {
      if (!item.operation.shown) this.show(item, false)
      item.operation = { ...item.operation, pulse: item.operation.pulse + 1 }
      this.announce(item.operation.tabId, `${nouns[item.operation.kind].doing} ${item.operation.target}. Sorting and filtering wait until it finishes; Cancel stops it.`)
    }
    const tabs = new Set(held.map(item => item.operation.tabId))
    const first = held[0]?.operation
    if (here !== undefined && first && !tabs.has(here)) { this.announce(here, `${nouns[first.kind].doing} ${first.target}. Sort Text By waits until it finishes.`); tabs.add(here) }
    for (const tab of tabs) this.publishTab(tab)
  }

  /** Cancels one operation (its strip's Cancel), or every one of the tab the toolbar shows (Escape in a grid): one still
   *  within its delay is not on screen, so Escape leaves it alone. */
  cancel(tabId: string, id?: number): void {
    for (const item of [...this.entries.values()]) {
      const operation = item.operation
      if (operation.tabId === tabId && !operation.ending && (id === undefined ? operation.shown : operation.id === id)) item.cancel()
    }
  }

  /** Whether the tab shows an operation Escape in a grid would cancel. */
  cancellable(tabId: string): boolean {
    for (const item of this.entries.values()) if (item.operation.tabId === tabId && item.operation.shown && !item.operation.ending) return true
    return false
  }

  /** A tab closed: what it said goes with it (its operations end through their owners). */
  forget(tabId: string): void {
    this.clearNotice(tabId)
    this.announcements.delete(tabId)
    if (![...this.entries.values()].some(item => item.operation.tabId === tabId) && tabId in this.getSnapshot()) {
      const next = { ...this.getSnapshot() }
      delete next[tabId]
      this.publish(next)
    }
  }

  dispose(): void {
    for (const item of this.entries.values()) { this.timers.clearTimeout(item.show); this.timers.clearTimeout(item.hide) }
    for (const notice of this.notices.values()) this.timers.clearTimeout(notice.timer)
    this.entries.clear()
    this.notices.clear()
    this.clearListeners()
  }

  private show(entry: Entry, publish = true): void {
    if (this.entries.get(entry.operation.id) !== entry || entry.operation.shown) return
    this.timers.clearTimeout(entry.show)
    entry.shownAt = this.now()
    entry.operation = { ...entry.operation, shown: true }
    this.announce(entry.operation.tabId, `${nouns[entry.operation.kind].doing} ${entry.operation.target}`)
    if (publish) this.publishTab(entry.operation.tabId)
  }

  private end(entry: Entry, outcome: OperationOutcome): void {
    const { tabId, kind } = entry.operation
    const cancelled = outcome === 'cancelled' ? '' : typeof outcome === 'object' ? outcome.cancelled : undefined
    this.timers.clearTimeout(entry.show)
    // A cancel is said even before the operation showed: the user asked for it.
    if (cancelled !== undefined) { const said = cancelled || nouns[kind].cancelled; this.announce(tabId, said); this.notice(tabId, said) }
    else if (outcome === 'done' && entry.operation.shown) this.announce(tabId, nouns[kind].done)
    const left = entry.shownAt === undefined ? 0 : g.operationMinShownMs - (this.now() - entry.shownAt)
    if (left <= 0 || outcome !== 'done') {
      this.entries.delete(entry.operation.id)
      this.publishTab(tabId)
      return
    }
    // Shown too briefly to read: it stays, done and holding nothing off, until it has been up long enough.
    entry.operation = { ...entry.operation, ending: true, ...entry.operation.percent === undefined && entry.operation.phase !== 'identify' ? {} : { percent: 100 } }
    entry.hide = this.timers.setTimeout(() => {
      if (this.entries.get(entry.operation.id) !== entry) return
      this.entries.delete(entry.operation.id)
      this.publishTab(tabId)
    }, left)
    this.publishTab(tabId)
  }

  private announce(tabId: string, text: string): void {
    // The same sentence again (a second refused click) must still be read out: a zero-width space makes it a change.
    const last = this.announcements.get(tabId)?.text
    this.announcements.set(tabId, { text: last === text ? text + '​' : text, at: ++this.counter })
  }

  private notice(tabId: string, text: string): void {
    this.clearNotice(tabId)
    const timer = this.timers.setTimeout(() => {
      if (this.notices.get(tabId)?.timer !== timer) return
      this.notices.delete(tabId)
      this.publishTab(tabId)
    }, g.operationNoticeMs)
    this.notices.set(tabId, { text, timer })
  }

  private clearNotice(tabId: string): void {
    const notice = this.notices.get(tabId)
    if (!notice) return
    this.timers.clearTimeout(notice.timer)
    this.notices.delete(tabId)
  }

  private publishTab(tabId: string): void {
    const items = [...this.entries.values()].map(item => item.operation).filter(operation => operation.tabId === tabId)
    const announcement = this.announcements.get(tabId), notice = this.notices.get(tabId)?.text ?? ''
    const next = { ...this.getSnapshot() }
    if (items.length === 0 && !announcement && !notice) delete next[tabId]
    else next[tabId] = { items, announcement: announcement?.text ?? '', announced: announcement?.at ?? 0, notice }
    this.publish(next)
  }
}

/** The operation a grid shows: the sort or filter building its view, else another reading its result (a profile). The
 *  item itself, so a grid renders again only when it changes. */
export function gridOperation(items: readonly ResultOperation[] | undefined, entry: EntryKey): ResultOperation | undefined {
  let other: ResultOperation | undefined
  for (const item of items ?? []) {
    if (item.entry !== entry) continue
    if (item.kind === 'sort' || item.kind === 'filter') return item
    other ??= item
  }
  return other
}
