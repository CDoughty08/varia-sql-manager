import type { BigQueryDryRunResult } from '../../../shared/bigquery/dry-run'
import { bigQueryPath, isBigQueryName } from '../../../shared/bigquery/names'
import { bigQueryPreviewRows, isBigQueryPropertyKind, type BigQueryPropertyKind } from '../../../shared/bigquery/objects'
import { maxClipboardText, type ApiResult, type ExplorerError, type VariaApi } from '../../../shared/contracts'
import { isPeekKind, peekHas, peekLimits, peekSpecs, peekTabsOf, type PeekDependency, type PeekKind, type PeekResult, type PeekTab } from '../../../shared/explorer/peek.ts'
import { childParentKinds, kindSpecs, scopeFields, type NodeSubtype } from '../../../shared/explorer/catalog.ts'
import type { ObjectRef } from '../../../shared/explorer/refs.ts'
import { scriptMenuState } from '../../../shared/scripting/catalog.ts'
import { defaultScriptingOptions, type ScriptingOptions } from '../../../shared/scripting/options.ts'
import { selectTopRowsScript } from '../../../shared/sql/identifiers'
import { onUnexpectedError } from '../core/errors'
import { SnapshotStore } from '../core/store'
import type { ExternalStore } from '../core/types'
import type { ExplorerMenuNode } from '../menus/targets'
import type { ResultsService } from '../results/ResultsService'
import { isLiveConnection, type ConnectionAvailability } from '../services/connection-availability'
import {
  hasDefinitionTab, isBigQueryPropertiesTabId, isBigQueryTabAvailable, supportsPreviewTab,
  type BigQueryPropertiesTabId
} from './bigquery-properties-format'
import { bigQueryObjectIdentity, type BigQueryDdlState, type BigQueryPreviewState, type BigQueryPropertiesView } from './BigQueryPropertiesService'
import { peekObjectName } from './peek-format'

/** Every Object Explorer kind the floating Peek Card describes: SQL Server peek kinds + BigQuery properties kinds. */
export type AnyPeekKind = PeekKind | BigQueryPropertyKind
export type AnyPeekTab = PeekTab | BigQueryPropertiesTabId
export const isAnyPeekKind = (kind: string): kind is AnyPeekKind => isPeekKind(kind) || isBigQueryPropertyKind(kind)

/** How a peek was asked for: a hover opens the card without moving focus; the keyboard and the menu focus it. */
export type PeekSource = 'hover' | 'keyboard' | 'menu'
/** `loading` may say how much of a long definition's text has come (0 to 1) while its pages are read. */
export type PeekPart<T> = { readonly status: 'loading'; readonly progress?: number } | { readonly status: 'ready'; readonly value: T } | { readonly status: 'error'; readonly message: string }
/** Whether Copy can put `text` on the clipboard whole: a longer one is opened by Script to New Query, or selected in the editor. */
export const copyableDefinition = (text: string | undefined): text is string => text !== undefined && text.length <= maxClipboardText
/** Copy's tooltip when the definition is longer than the clipboard takes. */
export const tooLongToCopy = `Longer than Copy takes (${maxClipboardText.toLocaleString('en-US')} characters). Select the text and copy it from the editor, or Script to New Query.`
/** A definition, always whole: a long module's pages are put together before it is ready. */
export interface PeekDefinition {
  readonly text?: string
  /** The module's whole length, when `text` is only its start: a reader that asked for at most so many characters (`read`). */
  readonly length?: number
}
export interface PeekDependencies {
  readonly uses: readonly PeekDependency[]
  readonly usesTruncated: boolean
  readonly usedBy: readonly PeekDependency[]
  readonly usedByTruncated: boolean
}
/** Top rows: the ResultsService entry the view's run owns, by its key, which the results grid shows. */
export interface PeekRows { readonly key: string }
/** A card the user moved on from by following a dependency or cross-object link, which Back returns to. */
export interface PeekStep { readonly node: ExplorerMenuNode; readonly kind: AnyPeekKind; readonly tab: AnyPeekTab }
export interface OpenPeek {
  /** Increments with every peek, so the card knows a new one from a refresh of the same. */
  readonly id: number
  readonly rowId: number
  readonly node: ExplorerMenuNode
  readonly kind: AnyPeekKind
  readonly source: PeekSource
  readonly facts: PeekPart<PeekResult['facts']>
  /** The kind's lists and the optional groups the login was refused, which come with the facts. */
  readonly lists?: PeekResult['lists']
  readonly refused?: PeekResult['refused']
  readonly definition: PeekPart<PeekDefinition>
  /**
   * The tab shown; Dependencies and Top rows (or BigQuery Preview Rows) are read the first time they are chosen,
   * and again when chosen after failing.
   */
  readonly tab: AnyPeekTab
  readonly dependencies?: PeekPart<PeekDependencies>
  readonly rows?: PeekPart<PeekRows>
  /** BigQuery metadata state when peeking a BigQuery object (`bqTable`, `bqView`, `bqMaterializedView`, `bqExternalTable`, `bqRoutine`, `bqDataset`). */
  readonly bigQuery?: BigQueryPropertiesView
  /** The cards before this one, oldest first, when a dependency or cross-object link was followed. */
  readonly back: readonly PeekStep[]
  /** Where a card not beside an Object Explorer row is anchored: a name in a query editor (`peekAt`). */
  readonly anchor?: PeekAnchor
}
/**
 * A place outside Object Explorer the card is drawn beside, in `document`'s window: `rect` is where it is now (undefined
 * while it is scrolled out of view), `watch` reports it moving or going away (the card closes then), and `focus` takes focus
 * back when the card closes from the keyboard.
 */
export interface PeekAnchor {
  readonly document: Document
  rect(): { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number } | undefined
  watch(moved: () => void, gone: () => void): () => void
  focus(): void
}
export interface PeekSnapshot { readonly open?: OpenPeek }
/** What a read peeks; `subtype` (the tree's) says whether Script As can write a scripted kind's definition. */
export interface PeekTarget { readonly connectionId: string; readonly object: ObjectRef; readonly kind: PeekKind; readonly subtype?: NodeSubtype }
/** A read's parts as they arrive. */
export type PeekChange = Partial<{ readonly facts: PeekPart<PeekResult['facts']>; readonly definition: PeekPart<PeekDefinition>; readonly lists: PeekResult['lists']; readonly refused: PeekResult['refused'] }>
/**
 * A running read: a Search Objects tab's details pane's. Releasing it cancels the properties read, and the table's script
 * unless `keep` and the facts gave its modified time, when it finishes in the background to be cached.
 */
export interface PeekReader { release(keep: boolean): void }
/** What a view's Top rows run needs of the results: it follows its run as a query tab's, under a key of its own, and releases it. */
export type PeekResults = Pick<ResultsService, 'begin' | 'finish' | 'release'>

export interface PeekServiceOptions {
  readonly api: Pick<VariaApi, 'explorerPeek' | 'explorerPeekDependencies' | 'explorerPeekDefinition' | 'explorerCancel' | 'scriptObjects' | 'cancelScripting' | 'writeClipboardText'
    | 'tableColumns' | 'execute' | 'closeQuerySession'> & Partial<Pick<VariaApi, 'bigQueryProperties' | 'cancel'>>
  readonly connections: ExternalStore<readonly (ConnectionAvailability & { readonly id: string })[]>
  /** Tools › Options › Scripting, which a table's CREATE script follows, as Script As does. */
  readonly scriptingOptions: ExternalStore<{ readonly options: ScriptingOptions }>
  /** Where Top rows' and BigQuery Preview Rows' result sets live; without it the tab says it cannot read them. */
  readonly results?: PeekResults
  /** BigQuery's cost prompts before on-demand CREATE DDL runs its billed INFORMATION_SCHEMA query (BigQueryCostService.beforeScript). */
  readonly billedGate?: (connectionId: string, estimate: BigQueryDryRunResult, signal: AbortSignal) => Promise<{ readonly run: boolean; readonly maximumBytesBilled?: number }>
  readonly timers?: { setTimeout(callback: () => void, ms: number): unknown; clearTimeout(handle: unknown): void }
  readonly newId?: () => string
  /** Ctrl+hover peeks; on macOS ⌘+hover, as ⌘ is macOS's Ctrl. */
  readonly platform?: string
  /** Peek on Hover's modifier as remapped (`explorer.peekHover`); without it, Ctrl (⌘ on macOS). */
  readonly gestures?: { isModifierKey(id: 'explorer.peekHover', key: string): boolean }
  /** Whether a key is either Peek on Hover modifier (Object Explorer's or the query editor's) (the gestures, which can be remapped); defaults to Ctrl (⌘). */
  readonly hoverModifier?: (key: string) => boolean
  /** The clock kept scripts expire by; defaults to `Date.now`. */
  readonly now?: () => number
}

export const peekMessages = {
  notConnected: 'The server is not connected.',
  noDefinition: 'The definition is encrypted, or the login does not have VIEW DEFINITION permission on it.',
  definitionChanged: 'The definition changed while Peek read it. Refresh to read it again.',
  definitionTooLong: `The definition is longer than Peek reads (${peekLimits.definitionMaxChars.toLocaleString('en-US')} characters), the most it holds in memory.`,
  noRows: 'It has no rows.',
  noDependencies: 'None found.',
  noResult: 'The query returned no result set. See Select Top 1000 Rows for its messages.',
  rowsUnavailable: 'The top rows cannot be read here.'
} as const

type ScriptReply = Awaited<ReturnType<VariaApi['scriptObjects']>>
/**
 * A table's finished CREATE script, good while the table's modified time is still `modified`, the scripting options are still
 * those it was made with, and it is younger than `peekLimits.scriptCacheMs`.
 */
interface CachedScript { readonly connectionId: string; readonly text: string; readonly modified: string; readonly optionsKey: string; readonly at: number }
/**
 * A read's requests still running: the properties read, the page of a long module's text being read, the table's script, and
 * (a view's only) its tabs' reads.
 */
type Requests = { peek?: string; definition?: string; script?: ScriptJob } & { [tab in TabPart]?: string }
/** A table's script request: a view's, or one a replaced view left running so that its script can be cached. */
interface ScriptJob {
  readonly requestId: string
  readonly connectionId: string
  readonly key: string
  /** The scripting options it was asked with. */
  readonly optionsKey: string
  /** The view it answers, while one waits for it; a background job has none until a view takes it over. */
  deliver?: (result: ScriptReply) => void
  /** The table's modified time, from the peek's facts, once they are in. */
  modified?: string
  /** The script, when it came before the facts did. */
  text?: string
  done: boolean
}
/**
 * A view's Top rows run: `key` names both its query session and its ResultsService entry, so nothing else (no query tab, no
 * other view) can own either; `session` while the session may still be open.
 */
interface RowsRun { readonly key: string; readonly queryId: string; session: boolean }

/**
 * What every view shares: the properties and definition reads, the window's cache of table scripts, and the scripts replaced
 * views left running. A closed or replaced view cancels its reads, but a table's script whose modified time is known
 * finishes in the background (at most `peekLimits.backgroundScripts`), so that peeking the table again while it is unchanged
 * takes the script from the cache instead of starting another SMO job.
 */
export class PeekReads {
  private background: ScriptJob[] = []
  /** Least recently used first. */
  private readonly scripts = new Map<string, CachedScript>()
  private scriptChars = 0
  private disposed = false
  readonly newId: () => string
  private readonly now: () => number
  private readonly unsubscribe: () => void

  constructor(readonly options: PeekServiceOptions) {
    this.newId = options.newId ?? (() => crypto.randomUUID())
    this.now = options.now ?? Date.now
    const connections = options.connections.subscribe(() => this.forget(connectionId => !this.isLive(connectionId)))
    // Scripts follow Tools > Options > Scripting: a change there (not to any other setting, which the store also announces)
    // makes every kept or background script stale.
    let optionsKey = this.optionsKey()
    const scripting = options.scriptingOptions.subscribe(() => {
      const next = this.optionsKey()
      if (next !== optionsKey) { optionsKey = next; this.forget(() => true) }
    })
    this.unsubscribe = () => { connections(); scripting() }
  }

  get api(): PeekServiceOptions['api'] { return this.options.api }
  get results(): PeekResults | undefined { return this.options.results }
  get isDisposed(): boolean { return this.disposed }

  isLive(connectionId: string): boolean {
    return this.options.connections.getSnapshot().some(connection => connection.id === connectionId && isLiveConnection(connection))
  }

  /**
   * Reads `target`'s properties and definition for a caller other than a view (a Search Objects tab's details pane), sharing
   * the kept and background scripts. `update` gets each part as it arrives, until the reader is released. With `maxChars`, a
   * long module's pages stop once that much text is in (the pane shows no more), and its definition carries the whole length.
   */
  read(target: PeekTarget, fresh: boolean, update: (change: PeekChange) => void, maxChars?: number): PeekReader {
    const requests: Requests = {}
    let released = this.disposed
    const reader: PeekReader = { release: keep => { if (released) return; released = true; this.release(requests, keep) } }
    if (!released) this.begin(target, fresh, requests, () => !this.disposed && !released, update, maxChars)
    return reader
  }

  /**
   * Starts reading `target`'s properties (explorer.peek) and its definition: a module's text comes with them, and a text longer
   * than one reply in further pages (`readPages`); a table's from
   * Script As CREATE, taken from the window's cache while the table's modified time still matches (never when `fresh`), or
   * from a replaced read's script still running for it. The reads' ids go in `requests`; `update` runs while `current()`.
   */
  begin(target: PeekTarget, fresh: boolean, requests: Requests, current: () => boolean, update: (change: PeekChange) => void, maxChars?: number): void {
    const { connectionId, object, kind } = target
    // A scripted kind Script As cannot write (an index of a table type, a dropped ledger table) has no definition to show, as a
    // module without text has none: it is not asked for one, which it would refuse.
    const key = peekSpecs[kind].definition === 'script' && scriptable(target) ? scriptKey(connectionId, object) : undefined
    const cached = key === undefined || fresh ? undefined : this.kept(key)
    const peekId = this.newId()
    requests.peek = peekId
    const tell = (change: PeekChange) => { if (current()) update(change) }
    const deliver = (result: ScriptReply) => {
      if (!current()) return
      if (!result.ok) { tell({ definition: { status: 'error', message: result.error } }); return }
      const value = result.value
      if (value.error) { tell({ definition: { status: 'error', message: value.error.message } }); return }
      tell({ definition: { status: 'ready', value: value.text === undefined ? {} : { text: value.text } } })
    }
    const startScript = (key: string, modified?: string): ScriptJob => {
      const options = this.options.scriptingOptions.getSnapshot().options
      const job: ScriptJob = { requestId: this.newId(), connectionId, key, optionsKey: JSON.stringify(options), deliver, ...(modified === undefined ? {} : { modified }), done: false }
      requests.script = job
      void settle(this.options.api.scriptObjects({ connectionId, requestId: job.requestId, targets: [object], verb: 'create', options })).then(result => {
        job.done = true
        this.background = this.background.filter(other => other !== job)
        if (requests.script === job) requests.script = undefined
        if (result.ok && !result.value.error && result.value.text !== undefined) {
          if (job.modified === undefined) job.text = result.value.text
          else this.keep(job, result.value.text)
        }
        job.deliver?.(result)
      }).catch(onUnexpectedError)
      return job
    }
    // A replaced read's script for this table, still running, answers this read instead of a second SMO job.
    const adopt = (key: string): ScriptJob | undefined => {
      const job = this.background.find(other => other.key === key && !other.done && other.optionsKey === this.optionsKey())
      if (!job) return undefined
      this.background = this.background.filter(other => other !== job)
      job.deliver = deliver
      requests.script = job
      return job
    }
    // Without a kept script the table is scripted at once (or by the script already running for it); with one, the facts'
    // modified time says whether it still holds.
    let job = key === undefined || cached ? undefined : (fresh ? undefined : adopt(key)) ?? startScript(key)
    void settle(this.options.api.explorerPeek({ connectionId, requestId: peekId, target: object })).then(result => {
      if (!current()) return
      if (requests.peek === peekId) requests.peek = undefined
      if (!result.ok || result.value.error) {
        const message = result.ok ? result.value.error?.message ?? '' : result.error
        tell({ facts: { status: 'error', message }, ...(key === undefined ? { definition: { status: 'error', message } } : {}) })
        // A kept script cannot be checked without the facts, so the table is scripted again.
        if (key !== undefined && cached) startScript(key)
        return
      }
      // A login's modified time misses its role memberships and CONNECT permission, which its script holds: it is never kept.
      const value = result.value, modified = kind !== 'login' && typeof value.facts.modified === 'string' ? value.facts.modified : undefined
      tell({ facts: { status: 'ready', value: value.facts }, ...(value.lists ? { lists: value.lists } : {}), ...(value.refused ? { refused: value.refused } : {}),
        ...(key === undefined && value.definitionLength === undefined ? { definition: { status: 'ready', value: value.definition === undefined ? {} : { text: value.definition } } } : {}) })
      if (key === undefined) {
        if (value.definitionLength !== undefined) void this.readPages(target, value, requests, current, tell, maxChars).catch(onUnexpectedError)
        return
      }
      if (job && modified !== undefined) {
        if (job.modified !== undefined && job.modified !== modified) {
          // A taken-over script began before the table last changed: it is scripted again.
          job.deliver = undefined
          this.cancelScript(job)
          job = startScript(key, modified)
        } else {
          job.modified = modified
          if (job.text !== undefined) { this.keep(job, job.text); job.text = undefined }
        }
      }
      if (!cached) return
      if (modified !== undefined && cached.modified === modified) {
        this.touch(key, cached)
        tell({ definition: { status: 'ready', value: { text: cached.text } } })
      } else startScript(key, modified)
    }).catch(onUnexpectedError)
  }

  /**
   * Reads the rest of a module's text after the peek's first page, one page at a time (each asked for once the last is in, so at
   * most one is running, its id in `requests.definition` for `release` to cancel), and tells the whole text once it has every
   * page. A length or stamp that differs from the first page's means the module changed in between: the pages would not fit, so
   * it says so instead. A text longer than Peek reads is not read at all. With `maxChars` the pages stop once that much is in, and
   * the start read so far is told with the whole length (a text longer than Peek reads included: only its start is read).
   */
  private async readPages(target: PeekTarget, first: PeekResult, requests: Requests, current: () => boolean, tell: (change: PeekChange) => void, maxChars?: number): Promise<void> {
    const length = first.definitionLength!, stamp = first.definitionStamp
    if (maxChars === undefined && length > peekLimits.definitionMaxChars) { tell({ definition: { status: 'error', message: peekMessages.definitionTooLong } }); return }
    // A page ends a code unit short rather than split a surrogate pair: one short of `maxChars` is enough, never worth a page more.
    const wanted = maxChars !== undefined && maxChars < length ? maxChars - 1 : length
    const pages = [first.definition ?? '']
    let offset = pages[0]!.length
    if (offset < wanted) tell({ definition: { status: 'loading', progress: offset / wanted } })
    while (offset < wanted) {
      if (!current()) return
      const requestId = this.newId()
      requests.definition = requestId
      const result = await settle(this.options.api.explorerPeekDefinition({ connectionId: target.connectionId, requestId, target: target.object, offset }))
      // A release took the request (and cancelled it): its answer, a cancellation most likely, is not this view's to show.
      if (requests.definition !== requestId) return
      requests.definition = undefined
      if (!current()) return
      if (!result.ok || result.value.error) { tell({ definition: { status: 'error', message: result.ok ? result.value.error!.message : result.error } }); return }
      const page = result.value
      if (page.length !== length || page.stamp !== stamp || !page.text) { tell({ definition: { status: 'error', message: peekMessages.definitionChanged } }); return }
      pages.push(page.text)
      offset += page.text.length
      if (offset < wanted) tell({ definition: { status: 'loading', progress: offset / wanted } })
    }
    if (offset < length && offset >= wanted) { tell({ definition: { status: 'ready', value: { text: pages.join(''), length } } }); return }
    if (offset !== length) { tell({ definition: { status: 'error', message: peekMessages.definitionChanged } }); return }
    tell({ definition: { status: 'ready', value: { text: pages.join('') } } })
  }

  /**
   * A read ends (a view's, or a reader's): the properties, definition page and tab reads are cancelled, and so is the table's script unless
   * `keep` and the facts gave its modified time, when it finishes in the background to be cached (the oldest background
   * script gives way past the limit).
   */
  release(requests: Requests, keep: boolean): void {
    const { peek, definition, script, dependencies } = requests
    for (const name of ['peek', 'definition', 'script', 'dependencies'] as const) requests[name] = undefined
    try {
      const reads = [peek, definition, dependencies].filter((request): request is string => request !== undefined)
      if (reads.length) report(this.options.api.explorerCancel(reads))
      if (!script || script.done) return
      if (!keep || script.modified === undefined || this.disposed) { this.cancelScript(script); return }
      script.deliver = undefined
      this.background.push(script)
      while (this.background.length > peekLimits.backgroundScripts) this.cancelScript(this.background.shift()!)
    } catch (error) { onUnexpectedError(error) }
  }

  dispose(): void {
    if (this.disposed) return
    this.forget(() => true)
    this.disposed = true
    this.unsubscribe()
  }

  private optionsKey(): string { return JSON.stringify(this.options.scriptingOptions.getSnapshot().options) }

  /** The kept script for `key`, when it is still good for these options and not too old. */
  private kept(key: string): CachedScript | undefined {
    const entry = this.scripts.get(key)
    if (!entry) return undefined
    if (entry.optionsKey === this.optionsKey() && this.now() - entry.at <= peekLimits.scriptCacheMs) return entry
    this.drop(key)
    return undefined
  }

  /** Keeps a finished script, least recently used out first, within `peekLimits`' entries and characters. */
  private keep(job: ScriptJob, text: string): void {
    // A script asked with options since changed is not kept: the next peek would show what the user turned off.
    if (this.disposed || job.modified === undefined || job.optionsKey !== this.optionsKey() || !this.isLive(job.connectionId)) return
    this.drop(job.key)
    if (text.length > peekLimits.scriptCacheChars) return
    this.scripts.set(job.key, { connectionId: job.connectionId, text, modified: job.modified, optionsKey: job.optionsKey, at: this.now() })
    this.scriptChars += text.length
    for (const [key] of [...this.scripts]) {
      if (this.scripts.size <= peekLimits.scriptCacheEntries && this.scriptChars <= peekLimits.scriptCacheChars) break
      this.drop(key)
    }
  }

  private touch(key: string, entry: CachedScript): void {
    this.scripts.delete(key)
    this.scripts.set(key, entry)
  }

  private drop(key: string): void {
    const entry = this.scripts.get(key)
    if (!entry) return
    this.scripts.delete(key)
    this.scriptChars -= entry.text.length
  }

  /** Drops kept scripts and cancels background ones for the connections `stale` names. */
  private forget(stale: (connectionId: string) => boolean): void {
    for (const [key, entry] of [...this.scripts]) if (stale(entry.connectionId)) this.drop(key)
    const ended = this.background.filter(job => stale(job.connectionId))
    this.background = this.background.filter(job => !stale(job.connectionId))
    for (const job of ended) this.cancelScript(job)
  }

  private cancelScript(job: ScriptJob): void {
    if (job.done) return
    try { report(this.options.api.cancelScripting([job.requestId])) } catch (error) { onUnexpectedError(error) }
  }
}

/** A view's BigQuery on-demand DDL flight (estimate + cost prompt + script), cancelled on close/switch/refresh. */
interface BigQueryDdlFlight { requestId?: string; prompt?: AbortController; cancelled: boolean }
/** A view's BigQuery Preview Rows run (free tabledata.list into a bare ResultsService entry). */
interface BigQueryPreviewRun { readonly key: string; readonly queryId: string; running: boolean }

const bigQueryPreviewTimeoutSeconds = 110
const bigQueryDdlUnavailableMessage = 'Loading DDL is not available on this connection.'
const bigQueryPreviewUnavailableMessage = 'Preview Rows is not available for this object.'
const bigQueryPreviewSql = (view: Pick<BigQueryPropertiesView, 'project' | 'dataset' | 'name'>): string =>
  `SELECT *\nFROM ${bigQueryPath(view.project, view.dataset, view.name)}\nLIMIT ${bigQueryPreviewRows};\n`

/**
 * One object's Peek, as the card or a promoted tab shows it: its properties and definition, its tabs' parts, the dependencies
 * followed (Back), and its Top rows run (or BigQuery's free `bigquery.properties`, on-demand DDL and free `tabledata.list`
 * Preview Rows).
 */
export class PeekView extends SnapshotStore<PeekSnapshot> {
  private detached = false
  private next = 0
  private requests: Requests = {}
  private rowsRun: RowsRun | undefined
  private bqRequestId: string | undefined
  private bqDdlFlight: BigQueryDdlFlight | undefined
  private bqPreviewRun: BigQueryPreviewRun | undefined
  protected disposed = false
  private readonly unsubscribeConnections: () => void

  /**
   * `onLost`: what the view does when its server is lost. The card closes; a tab keeps what it shows, its reads cancelled and its
   * rows released, until Refresh reads it again on a live server.
   */
  constructor(protected readonly reads: PeekReads, private readonly onLost: 'close' | 'keep') {
    super({})
    this.unsubscribeConnections = reads.options.connections.subscribe(() => {
      const open = this.getSnapshot().open
      if (open && !this.reads.isLive(open.node.connectionId)) this.lost(open)
    })
  }

  /** Whether the view's server is live, so Refresh can read it again. */
  get connected(): boolean { const open = this.getSnapshot().open; return !this.detached && !!open && this.reads.isLive(open.node.connectionId) }

  /** Shows `node` (an object Peek describes), replacing whatever the view showed, on `tab` when its kind has it. */
  show(node: ExplorerMenuNode, tab?: AnyPeekTab): void {
    if (this.disposed || node.ref.type !== 'object' || node.kind === 'folder' || !isAnyPeekKind(node.kind)) return
    this.detached = false
    this.load(node, node.kind, 'keyboard', false, tab ? { tab } : {})
  }

  /** Shows another tab, reading it the first time; choosing a tab whose read failed reads it again. */
  selectTab(tab: AnyPeekTab): void {
    const open = this.getSnapshot().open
    if (!open) return
    if (open.bigQuery) {
      if (!isBigQueryPropertiesTabId(tab)) return
      const view = open.bigQuery
      if (tab === 'definition' && !hasDefinitionTab(view.kind)) return
      if (tab === 'preview' && !supportsPreviewTab(view.kind)) return
      if (view.value && !isBigQueryTabAvailable(tab, view.kind, view.value)) return
      if (open.tab !== tab || view.activeTab !== tab) {
        this.publish({ open: { ...open, tab, bigQuery: { ...view, activeTab: tab } } })
      }
      if (tab === 'preview' && view.kind === 'bqTable') {
        const latest = this.getSnapshot().open?.bigQuery
        if (latest && (!latest.preview || latest.preview.status === 'error')) {
          void this.loadBigQueryPreview(open.id)
        }
      }
      return
    }
    if (!isPeekKind(open.kind) || !peekTabsOf(open.kind).includes(tab as PeekTab)) return
    if (open.tab !== tab) this.publish({ open: { ...open, tab } })
    this.loadTab()
  }

  /** Whether on-demand billed CREATE DDL can be loaded for the current BigQuery Peek object. */
  canLoadBigQueryDdl(): boolean {
    const open = this.getSnapshot().open
    const view = open?.bigQuery
    return !this.disposed && !this.detached && !!open && !!view && hasDefinitionTab(view.kind)
      && !view.loading && !!view.value && view.value.definition === undefined && view.ddl?.status !== 'loading'
      && !!this.reads.api.scriptObjects && !!this.reads.options.billedGate && this.reads.isLive(view.connectionId)
  }

  /** Explicitly loads a BigQuery object's CREATE DDL on demand (free dry-run estimate + cost prompts first). */
  async loadBigQueryDdl(): Promise<void> {
    const open = this.getSnapshot().open
    const view = open?.bigQuery
    const gate = this.reads.options.billedGate
    if (this.disposed || this.detached || !open || !view || !hasDefinitionTab(view.kind) || view.loading || !view.value || view.value.definition !== undefined) return
    const openId = open.id
    const updateDdl = (ddl: BigQueryDdlState | undefined) => {
      const latest = this.getSnapshot().open
      if (latest && latest.id === openId && latest.bigQuery && !this.disposed && !this.detached) {
        this.publish({ open: { ...latest, bigQuery: { ...latest.bigQuery, ddl } } })
      }
    }
    if (!gate) {
      updateDdl({ status: 'error', message: bigQueryDdlUnavailableMessage })
      return
    }
    if (!this.reads.isLive(view.connectionId)) {
      updateDdl({ status: 'error', message: peekMessages.notConnected })
      return
    }
    this.stopBigQueryDdl()
    const flight: BigQueryDdlFlight = { cancelled: false }
    this.bqDdlFlight = flight
    const active = () => !this.disposed && !this.detached && !flight.cancelled && this.bqDdlFlight === flight && this.getSnapshot().open?.id === openId
    const finish = (ddl: BigQueryDdlState | undefined) => {
      if (this.bqDdlFlight === flight) this.bqDdlFlight = undefined
      if (active()) updateDdl(ddl)
    }
    const target: ObjectRef = { kind: view.kind, project: view.project, dataset: view.dataset, name: view.name }
    const options = this.reads.options.scriptingOptions.getSnapshot().options ?? defaultScriptingOptions
    const request = { connectionId: view.connectionId, targets: [target], verb: 'create' as const, options }

    updateDdl({ status: 'loading', phase: 'estimating' })
    let requestId = this.reads.newId()
    flight.requestId = requestId
    const estimated = await settle(this.reads.api.scriptObjects({ ...request, requestId, estimateOnly: true }))
    if (!active() || flight.requestId !== requestId) return
    flight.requestId = undefined
    if (!estimated.ok) { finish({ status: 'error', message: estimated.error }); return }
    if (estimated.value.error) { finish({ status: 'error', message: estimated.value.error.message }); return }

    let answer: { readonly run: boolean; readonly maximumBytesBilled?: number } = { run: true }
    if (estimated.value.estimate) {
      const prompt = new AbortController()
      flight.prompt = prompt
      try {
        answer = await gate(view.connectionId, estimated.value.estimate, prompt.signal).catch(() => ({ run: false }))
      } finally {
        if (flight.prompt === prompt) flight.prompt = undefined
      }
      if (!active() || prompt.signal.aborted) return
    }
    if (!answer.run) { finish(undefined); return }
    if (!this.reads.isLive(view.connectionId)) { finish({ status: 'error', message: peekMessages.notConnected }); return }

    updateDdl({ status: 'loading', phase: 'reading' })
    requestId = this.reads.newId()
    flight.requestId = requestId
    const result = await settle(this.reads.api.scriptObjects({
      ...request,
      requestId,
      ...(answer.maximumBytesBilled === undefined ? {} : { maximumBytesBilled: answer.maximumBytesBilled })
    }))
    if (!active() || flight.requestId !== requestId) return
    flight.requestId = undefined
    if (!result.ok) { finish({ status: 'error', message: result.error }); return }
    if (result.value.error) { finish({ status: 'error', message: result.value.error.message }); return }
    if (result.value.text === undefined) {
      finish({ status: 'error', message: `BigQuery produced no CREATE statement for ${view.name}.` })
      return
    }
    finish({ status: 'ready', text: result.value.text, warnings: result.value.warnings })
  }

  /** Cancels any in-flight BigQuery DDL request or open cost prompt. */
  cancelBigQueryDdl(): void {
    this.stopBigQueryDdl()
    const open = this.getSnapshot().open
    if (open?.bigQuery?.ddl?.status === 'loading') {
      this.publish({ open: { ...open, bigQuery: { ...open.bigQuery, ddl: undefined } } })
    }
  }

  /** Reloads free BigQuery Preview Rows via `tabledata.list`. */
  async reloadBigQueryPreview(): Promise<void> {
    const open = this.getSnapshot().open
    if (!open?.bigQuery) return
    await this.loadBigQueryPreview(open.id)
  }

  /** Cancels an in-flight BigQuery Preview Rows read. */
  cancelBigQueryPreview(): void {
    const run = this.bqPreviewRun
    if (!run || !run.running) return
    this.releaseBigQueryPreview()
    const open = this.getSnapshot().open
    if (open?.bigQuery?.preview?.status === 'loading') {
      this.publish({ open: { ...open, bigQuery: { ...open.bigQuery, preview: { status: 'error', message: 'Preview cancelled.' } } } })
    }
  }

  /**
   * Whether a dependency can be peeked from the view: an object of a kind Peek describes, in the view's database. The backend
   * names no server or database for an object SQL Server resolved there, however the code spelled the database.
   */
  canFollow(dependency: PeekDependency): boolean {
    // Only an object named by its schema: a trigger a module uses is named below its table, which a dependency does not give.
    return dependency.kind !== undefined && isPeekKind(dependency.kind) && kindSpecs[dependency.kind].scope === 'schemaObject' && dependency.server === undefined && dependency.database === undefined && dependency.schema !== undefined
  }

  /** Peeks a dependency in the same view (the card stays beside the same row); Back returns to this one. */
  follow(dependency: PeekDependency): void {
    const open = this.getSnapshot().open
    if (!open || open.node.ref.type !== 'object' || !this.canFollow(dependency) || !dependency.kind || !isPeekKind(dependency.kind)) return
    const object = { kind: dependency.kind, ...(open.node.ref.object.database === undefined ? {} : { database: open.node.ref.object.database }), schema: dependency.schema!, name: dependency.name }
    const { subtype: _subtype, status: _status, database: _database, listedAt: _listedAt, filtered: _filtered, insertable: _insertable, ...rest } = open.node
    // The dependency's own subtype, as the tree lists it, so Script As offers its verbs.
    const node: ExplorerMenuNode = { ...rest, kind: dependency.kind, ...(dependency.subtype === undefined ? {} : { subtype: dependency.subtype }), ref: { type: 'object', object }, label: `${dependency.schema}.${dependency.name}` }
    const back = [...open.back, { node: open.node, kind: open.kind, tab: open.tab }].slice(-peekLimits.backSteps)
    this.load(node, dependency.kind, open.source === 'hover' ? 'keyboard' : open.source, false, { back })
  }

  /**
   * Navigates in-place to another peekable object on the same connection (such as a child's parent table, a foreign key's
   * referenced table, a login's default database, or a BigQuery table's dataset / snapshot base table), pushing the current
   * object onto the Back stack.
   */
  followObject(target: ObjectRef, label?: string): void {
    const open = this.getSnapshot().open
    if (!open || !this.connected) return
    const valid = isPeekKind(target.kind)
      ? validPeekObjectRef(target)
      : isBigQueryPropertyKind(target.kind) && validBigQueryPeekRef(target) && !!this.reads.api.bigQueryProperties
    if (!valid || !isAnyPeekKind(target.kind)) return
    const { subtype: _subtype, status: _status, database: _database, listedAt: _listedAt, filtered: _filtered, insertable: _insertable, ...rest } = open.node
    const node: ExplorerMenuNode = { ...rest, kind: target.kind, ref: { type: 'object', object: target }, label: label ?? peekObjectName(target) }
    const back = [...open.back, { node: open.node, kind: open.kind, tab: open.tab }].slice(-peekLimits.backSteps)
    this.load(node, target.kind, open.source === 'hover' ? 'keyboard' : open.source, false, { back })
  }

  /** Returns to the object a dependency was followed from, on the tab it showed. */
  goBack(): void {
    const open = this.getSnapshot().open
    const step = open?.back[open.back.length - 1]
    if (!open || !step) return
    this.load(step.node, step.kind, open.source, false, { back: open.back.slice(0, -1), tab: step.tab })
  }

  /**
   * After Reconnect, the tab's document moves to the new connection to its server: so does the view (its object and its Back
   * steps), which then reads again there.
   */
  rebind(connectionId: string): void {
    const open = this.getSnapshot().open
    if (this.disposed || !open || !this.detached && open.node.connectionId === connectionId) return
    this.detached = false
    const move = (node: ExplorerMenuNode): ExplorerMenuNode => ({ ...node, connectionId, lost: false })
    this.publish({
      open: {
        ...open,
        node: move(open.node),
        ...(open.bigQuery ? { bigQuery: { ...open.bigQuery, connectionId } } : {}),
        back: open.back.map(step => ({ ...step, node: move(step.node) }))
      }
    })
    this.refresh()
  }

  /** A retained tab whose target detached cancels its work and keeps completed metadata until exact reassociation. */
  detach(): void {
    if (this.detached) return
    this.detached = true
    const open = this.getSnapshot().open
    if (!open) return
    this.lost(open)
    const current = this.getSnapshot().open
    if (current) this.publish({ open: { ...current, node: { ...current.node, lost: true } } })
  }

  /** Reads the object again, its script and its rows included: Refresh never takes a kept script. */
  refresh(): void {
    const open = this.getSnapshot().open
    if (open && this.connected) this.load(open.node, open.kind, open.source, true, { back: open.back, tab: open.tab })
  }

  /** Copies the definition, once the view has all of it and the clipboard takes it (`maxClipboardText`). */
  async copyDefinition(): Promise<void> {
    const open = this.getSnapshot().open
    if (!open) return
    const definition = open.definition
    const fallback = open.kind === 'constraint' && open.facts.status === 'ready' && typeof open.facts.value.expression === 'string' && open.facts.value.expression.length > 0
      ? open.facts.value.expression
      : undefined
    const text = definition.status === 'ready'
      ? (definition.value.text ?? fallback)
      : definition.status === 'error'
        ? fallback
        : undefined
    if (!copyableDefinition(text)) return
    const result = await this.reads.api.writeClipboardText(text)
    if (!result.ok) throw new Error(result.error)
  }

  close(): void {
    this.reads.release(this.requests, true)
    this.releaseRows()
    this.stopBigQuery()
    if (this.getSnapshot().open) this.publish({})
  }

  dispose(): void {
    if (this.disposed) return
    this.reads.release(this.requests, false)
    this.releaseRows()
    this.stopBigQuery()
    if (this.getSnapshot().open) this.publish({})
    this.disposed = true
    this.unsubscribeConnections()
    this.clearListeners()
  }

  /** `carry.anchor`: the new card's anchor, `null` for a row's; left out, Back, a followed dependency and Refresh keep the card's. */
  protected load(node: ExplorerMenuNode, kind: AnyPeekKind, source: PeekSource, fresh: boolean, carry: { readonly back?: readonly PeekStep[]; readonly tab?: AnyPeekTab; readonly anchor?: PeekAnchor | null } = {}): void {
    if (node.ref.type !== 'object' || this.detached || this.disposed) return
    const bqIdentity = isBigQueryPropertyKind(kind) ? bigQueryObjectIdentity(node.ref.object) : undefined
    const bqFetch = isBigQueryPropertyKind(kind) ? this.reads.api.bigQueryProperties : undefined
    if (isBigQueryPropertyKind(kind) && (!bqIdentity || !bqFetch)) return
    // A refresh asks for the same script again, so the one running is not worth keeping.
    this.reads.release(this.requests, !fresh)
    this.releaseRows()
    this.stopBigQuery()
    const id = ++this.next
    const requests: Requests = this.requests = {}
    // Rows the row's card does not own (a followed dependency) still anchor at that row.
    const rowId = carry.back?.length ? carry.back[0]!.node.id : node.id
    const anchor = carry.anchor === undefined ? this.getSnapshot().open?.anchor : carry.anchor ?? undefined

    if (isBigQueryPropertyKind(kind)) {
      const identity = bqIdentity!, fetch = bqFetch!
      const tab: BigQueryPropertiesTabId = carry.tab && isBigQueryPropertiesTabId(carry.tab)
        && (carry.tab !== 'definition' || hasDefinitionTab(kind))
        && (carry.tab !== 'preview' || supportsPreviewTab(kind))
        ? carry.tab
        : 'overview'
      const initialView: BigQueryPropertiesView = {
        connectionId: node.connectionId,
        kind: identity.kind,
        ...(node.subtype === undefined ? {} : { subtype: node.subtype }),
        project: identity.project,
        dataset: identity.dataset,
        name: identity.name,
        activeTab: tab,
        loading: true
      }
      this.publish({
        open: {
          id, rowId, node, kind, source,
          facts: { status: 'loading' },
          definition: { status: 'loading' },
          tab,
          bigQuery: initialView,
          back: carry.back ?? [],
          ...anchor ? { anchor } : {}
        }
      })
      const requestId = this.reads.newId()
      this.bqRequestId = requestId
      // Free metadata only: zero billed queries on Peek open.
      void settle(fetch({
        connectionId: node.connectionId,
        requestId,
        kind: identity.kind,
        project: identity.project,
        dataset: identity.dataset,
        name: identity.name
      })).then(result => {
        if (this.disposed || this.detached || this.bqRequestId !== requestId) return
        this.bqRequestId = undefined
        const current = this.getSnapshot().open
        if (!current || current.id !== id || !current.bigQuery) return
        if (result.ok) {
          if (result.value.definition !== undefined) this.stopBigQueryDdl()
          const nextTab = isBigQueryTabAvailable(current.bigQuery.activeTab, current.bigQuery.kind, result.value) ? current.bigQuery.activeTab : 'overview'
          this.publish({
            open: {
              ...current,
              tab: nextTab,
              bigQuery: {
                ...current.bigQuery,
                loading: false,
                value: result.value,
                error: undefined,
                activeTab: nextTab,
                ...(result.value.definition !== undefined ? { ddl: undefined } : {})
              }
            }
          })
        } else {
          this.publish({
            open: {
              ...current,
              bigQuery: { ...current.bigQuery, loading: false, error: result.error }
            }
          })
        }
      }).catch(onUnexpectedError)
      if (tab === 'preview' && kind === 'bqTable') void this.loadBigQueryPreview(id)
      return
    }

    // A row's own card opens on Overview (canonical tab 1); Back and Refresh keep the tab they had.
    const tab = carry.tab && peekTabsOf(kind).includes(carry.tab as PeekTab) ? carry.tab as PeekTab : 'overview'
    this.publish({ open: { id, rowId, node, kind, source, facts: { status: 'loading' }, definition: { status: 'loading' }, tab, back: carry.back ?? [], ...anchor ? { anchor } : {} } })
    this.reads.begin({ connectionId: node.connectionId, object: node.ref.object, kind, ...(node.subtype === undefined ? {} : { subtype: node.subtype }) }, fresh, requests, () => !this.disposed && !this.detached && this.getSnapshot().open?.id === id, change => {
      const open = this.getSnapshot().open
      if (open && open.id === id) this.publish({ open: { ...open, ...change } })
    })
    this.loadTab()
  }

  /** The server went away: the card closes; a tab keeps what it has, says what it was still reading is gone, and frees its rows. */
  private lost(open: OpenPeek): void {
    // Nothing is kept for a lost server: its table script is cancelled, not left to finish for the cache.
    this.reads.release(this.requests, false)
    this.releaseRows()
    this.stopBigQuery()
    if (this.onLost === 'close') { this.close(); return }
    const gone = <T>(part: PeekPart<T> | undefined): PeekPart<T> | undefined => part && part.status === 'loading' ? { status: 'error', message: peekMessages.notConnected } : part
    const rows: PeekPart<PeekRows> | undefined = open.rows && { status: 'error', message: peekMessages.notConnected }
    const bigQuery: BigQueryPropertiesView | undefined = open.bigQuery
      ? {
          ...open.bigQuery,
          ...(open.bigQuery.loading ? { loading: false, error: peekMessages.notConnected } : {}),
          ...(open.bigQuery.ddl?.status === 'loading' ? { ddl: { status: 'error', message: peekMessages.notConnected } } : {}),
          ...(open.bigQuery.preview !== undefined ? { preview: { status: 'error', message: peekMessages.notConnected } } : {})
        }
      : undefined
    this.publish({ open: { ...open, facts: gone(open.facts)!, definition: gone(open.definition)!, dependencies: gone(open.dependencies), rows, ...(bigQuery ? { bigQuery } : {}) } })
  }

  /**
   * Reads the shown tab's part when this view has none or its read failed: the dependencies (apart from the properties, since
   * a login may read those and not sys.sql_expression_dependencies), or the top rows.
   */
  private loadTab(): void {
    const open = this.getSnapshot().open
    if (!open || open.bigQuery || open.node.ref.type !== 'object' || !isPeekKind(open.kind) || this.disposed || this.detached || open.tab === 'definition') return
    const connectionId = open.node.connectionId, target = open.node.ref.object
    switch (open.tab) {
      case 'dependencies': return peekHas(open.kind, 'dependencies') ? this.loadPart(open, 'dependencies', requestId => this.reads.api.explorerPeekDependencies({ connectionId, requestId, target }),
        value => ({ uses: value.uses, usesTruncated: !!value.usesTruncated, usedBy: value.usedBy, usedByTruncated: !!value.usedByTruncated })) : undefined
      case 'rows': return peekHas(open.kind, 'rows') ? this.loadRows(open) : undefined
      // The kind's lists come with the facts: when those failed, choosing the tab (or its Retry) reads the object again.
      default: return open.facts.status === 'error' ? this.load(open.node, open.kind, open.source, false, { back: open.back, tab: open.tab }) : undefined
    }
  }

  private async loadBigQueryPreview(openId: number): Promise<void> {
    const open = this.getSnapshot().open
    const view = open?.bigQuery
    if (this.disposed || this.detached || !open || open.id !== openId || !view) return
    const updatePreview = (preview: BigQueryPreviewState | undefined) => {
      const latest = this.getSnapshot().open
      if (latest && latest.id === openId && latest.bigQuery && !this.disposed && !this.detached) {
        this.publish({ open: { ...latest, bigQuery: { ...latest.bigQuery, preview } } })
      }
    }
    const results = this.reads.results
    if (view.kind !== 'bqTable' || !results) {
      updatePreview({ status: 'error', message: bigQueryPreviewUnavailableMessage })
      return
    }
    if (!this.reads.isLive(view.connectionId)) {
      updatePreview({ status: 'error', message: peekMessages.notConnected })
      return
    }
    this.releaseBigQueryPreview()
    const run: BigQueryPreviewRun = { key: this.reads.newId(), queryId: this.reads.newId(), running: true }
    this.bqPreviewRun = run
    updatePreview({ status: 'loading' })
    try {
      results.begin(run.key, run.queryId, undefined, { bare: true })
    } catch (error) {
      onUnexpectedError(error)
      if (this.bqPreviewRun === run) this.bqPreviewRun = undefined
      updatePreview({ status: 'error', message: error instanceof Error && error.message ? error.message : bigQueryPreviewUnavailableMessage })
      return
    }

    const response = await settle(this.reads.api.execute({
      connectionId: view.connectionId,
      sessionId: run.key,
      sql: bigQueryPreviewSql(view),
      queryId: run.queryId,
      maxRows: bigQueryPreviewRows,
      timeoutSeconds: bigQueryPreviewTimeoutSeconds,
      maxResultSets: 1,
      preview: { project: view.project, dataset: view.dataset, table: view.name }
    }))
    run.running = false
    const summary = response.ok ? response.value : undefined
    try {
      await results.finish(run.key, run.queryId, response.ok
        ? { summary }
        : { error: response.error, ...(response.code ? { code: response.code } : {}) })
    } catch (error) {
      onUnexpectedError(error)
      const isCurrent = this.bqPreviewRun === run
      if (isCurrent) this.bqPreviewRun = undefined
      this.safeReleaseResults(run.key)
      if (isCurrent) updatePreview({ status: 'error', message: error instanceof Error && error.message ? error.message : bigQueryPreviewUnavailableMessage })
      return
    }
    if (this.disposed || this.detached || this.bqPreviewRun !== run || this.getSnapshot().open?.id !== openId) {
      this.safeReleaseResults(run.key)
      return
    }
    if (summary?.resultSets.length) {
      updatePreview({ status: 'ready', key: run.key, rowsRead: summary.resultSets[0].rowsRead })
      return
    }
    this.releaseBigQueryPreview()
    const message = !response.ok
      ? response.error
      : summary?.error?.message ?? summary?.messages.find(entry => entry.kind === 'error')?.text ?? bigQueryPreviewUnavailableMessage
    updatePreview({ status: 'error', message })
  }

  private stopBigQuery(): void {
    this.bqRequestId = undefined
    this.stopBigQueryDdl()
    this.releaseBigQueryPreview()
  }

  private stopBigQueryDdl(): void {
    const flight = this.bqDdlFlight
    if (!flight) return
    this.bqDdlFlight = undefined
    flight.cancelled = true
    flight.prompt?.abort()
    if (flight.requestId) {
      try { report(this.reads.api.cancelScripting([flight.requestId])) } catch (error) { onUnexpectedError(error) }
    }
  }

  private releaseBigQueryPreview(): void {
    const run = this.bqPreviewRun
    if (!run) return
    this.bqPreviewRun = undefined
    if (run.running && this.reads.api.cancel) {
      run.running = false
      try { report(this.reads.api.cancel(run.queryId)) } catch (error) { onUnexpectedError(error) }
    }
    this.safeReleaseResults(run.key)
  }

  private safeReleaseResults(key: string): void {
    try { this.reads.results?.release(key) } catch (error) { onUnexpectedError(error) }
  }

  private loadPart<K extends TabPart, R extends { readonly error?: ExplorerError }>(open: OpenPeek, key: K, request: (requestId: string) => Promise<ApiResult<R>>, value: (result: R) => PartValue<K>): void {
    if (open[key] && open[key].status !== 'error') return
    const id = open.id, requestId = this.reads.newId()
    const update = (part: PeekPart<PartValue<K>>) => { const now = this.getSnapshot().open; if (!this.disposed && !this.detached && now?.id === id) this.publish({ open: { ...now, [key]: part } }) }
    const requests = this.requests
    requests[key] = requestId
    update({ status: 'loading' })
    void settle(request(requestId)).then(result => {
      if (requests[key] !== requestId) return
      requests[key] = undefined
      if (!result.ok || result.value.error) update({ status: 'error', message: result.ok ? result.value.error?.message ?? '' : result.error })
      else update({ status: 'ready', value: value(result.value) })
    }).catch(onUnexpectedError)
  }

  /**
   * Top rows: the table's or view's columns (tables.columns, as Select Top 1000 Rows lists them), then SSMS's Select Top N Rows
   * script with `peekLimits.rows` through query.execute in a session and under a ResultsService key of the run's own. A run
   * with a result set shows it in the results grid; one without says why and keeps nothing.
   */
  private loadRows(open: OpenPeek): void {
    if (open.rows && open.rows.status !== 'error') return
    const id = open.id
    const update = (part: PeekPart<PeekRows>) => { const now = this.getSnapshot().open; if (!this.disposed && !this.detached && now?.id === id) this.publish({ open: { ...now, rows: part } }) }
    const object = open.node.ref.type === 'object' ? open.node.ref.object : undefined
    const results = this.reads.results
    if (!results || object?.database === undefined || object.schema === undefined || object.name === undefined) { update({ status: 'error', message: peekMessages.rowsUnavailable }); return }
    this.releaseRows()
    const api = this.reads.api, connectionId = open.node.connectionId, { database, schema, name } = object
    const run: RowsRun = { key: this.reads.newId(), queryId: this.reads.newId(), session: false }
    this.rowsRun = run
    update({ status: 'loading' })
    // The run's events are followed before the script is sent, as a query tab's are.
    // Bare: the grid alone, with no Pivot, comparison or close.
    results.begin(run.key, run.queryId, undefined, { bare: true })
    void (async () => {
      const columns = await settle(api.tableColumns(connectionId, database, schema, name))
      // Released while the columns were read: no session was opened, and releasing dropped the entry.
      if (this.rowsRun !== run) return
      const listed = columns.ok ? columns.value : { columns: [], truncated: true }
      const sql = selectTopRowsScript({ database, schema, name, columns: listed.columns, truncated: listed.truncated }, peekLimits.rows)
      run.session = true
      const response = await settle(api.execute({ connectionId, sessionId: run.key, database, sql, queryId: run.queryId, maxRows: peekLimits.rows,
        timeoutSeconds: Math.ceil(peekLimits.budgetMs / 1000), maxResultSets: 1 }))
      this.endSession(run)
      const summary = response.ok ? response.value : undefined
      // After a release this frees the sets the summary describes, since nothing will show them.
      await results.finish(run.key, run.queryId, response.ok ? { summary } : { error: response.error, ...(response.code ? { code: response.code } : {}) })
      if (this.rowsRun !== run) return
      if (summary?.resultSets.length) { update({ status: 'ready', value: { key: run.key } }); return }
      this.releaseRows()
      update({ status: 'error', message: !response.ok ? response.error : summary?.error?.message ?? summary?.messages.find(entry => entry.kind === 'error')?.text ?? peekMessages.noResult })
    })().catch(onUnexpectedError)
  }

  /** Ends the view's rows run: its session closes (stopping a run still going) and its results are released. */
  private releaseRows(): void {
    const run = this.rowsRun
    if (!run) return
    this.rowsRun = undefined
    this.endSession(run)
    try { this.reads.results?.release(run.key) } catch (error) { onUnexpectedError(error) }
  }

  /** Closes a run's session once; the backend keeps its results until they are released. */
  private endSession(run: RowsRun): void {
    if (!run.session) return
    run.session = false
    // A close that fails means the session ended with its backend or connection, which is what it asked for.
    void this.reads.api.closeQuerySession(run.key).catch(() => {})
  }
}

/**
 * Object Explorer's Peek: at most one card, on one object (the view it is), and the reads every view shares. A Ctrl+hover (⌘
 * on macOS) opens the card after `peekLimits.hoverMs`; `createView` makes a promoted tab's view, which shares the card's
 * script cache but owns its own reads and rows.
 */
export class PeekService extends PeekView {
  private hoverTimer: unknown
  private hoverRow: number | undefined
  /** The row the pointer rests on, read when the modifier goes down with the pointer still. */
  private pointerRow: (() => ExplorerMenuNode | undefined) | undefined
  /** The editor name `hoverAt` waits on; meaningful only while `hoverTimer` runs. */
  private hoverKey: string | undefined
  /** Counts cancelled hovers, so an editor hover whose lookup is still running knows it is no longer wanted. */
  private hoverEpoch = 0
  private readonly timers: NonNullable<PeekServiceOptions['timers']>
  private readonly armedStore = new (class extends SnapshotStore<boolean> { set(value: boolean) { if (value !== this.getSnapshot()) this.publish(value) } clear() { this.clearListeners() } })(false)
  /** Whether Peek on Hover's modifier is held: the tree shows the peek cursor over rows it can peek. */
  readonly armed: ExternalStore<boolean> = this.armedStore

  constructor(private readonly options: PeekServiceOptions) {
    super(new PeekReads(options), 'close')
    this.timers = options.timers ?? { setTimeout: (callback, ms) => setTimeout(callback, ms), clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) }
  }

  /** Whether a node can be peeked: a SQL Server peek kind or BigQuery properties kind on a live connection. */
  canPeek(node: ExplorerMenuNode | undefined): node is ExplorerMenuNode {
    if (!node || node.ref.type !== 'object' || node.kind === 'folder' || node.lost || !this.reads.isLive(node.connectionId)) return false
    if (isPeekKind(node.kind)) return true
    return isBigQueryPropertyKind(node.kind) && bigQueryObjectIdentity(node.ref.object) !== undefined && !!this.reads.api.bigQueryProperties
  }

  /** Opens the card on `node`, replacing any other; peeking the object already shown only changes how it was asked for. */
  peek(node: ExplorerMenuNode | undefined, source: PeekSource): void {
    this.cancelHover()
    if (this.disposed || !this.canPeek(node) || node.ref.type !== 'object' || !isAnyPeekKind(node.kind)) return
    const open = this.getSnapshot().open
    // A card that followed a dependency keeps its row's place but shows another object: peeking the row shows the row's own.
    if (open && open.rowId === node.id && open.node.connectionId === node.connectionId && sameObject(open.node, node)) {
      if (source !== 'hover' && open.source === 'hover') this.publish({ open: { ...open, source } })
      return
    }
    this.load(node, node.kind, source, false, { anchor: null })
  }

  /**
   * Opens the card on `node` beside `anchor` (a name in a query editor), replacing any other; the object already shown there
   * moves to the new anchor without reading it again. False when Peek cannot describe the object.
   */
  peekAt(node: ExplorerMenuNode, anchor: PeekAnchor, source: PeekSource): boolean {
    this.cancelHover()
    if (this.disposed || !this.canPeek(node) || !isAnyPeekKind(node.kind)) return false
    const open = this.getSnapshot().open
    if (open?.anchor && !open.back.length && open.node.connectionId === node.connectionId && sameObject(open.node, node)) {
      this.publish({ open: { ...open, anchor, source: source === 'hover' ? open.source : source } })
      return true
    }
    this.load(node, node.kind, source, false, { anchor })
    return true
  }

  /**
   * A query editor's Peek on Hover rests on a name (`key` tells one from another): `open` runs after `peekLimits.hoverMs` on the
   * row hover's timer, so whatever cancels that (the modifier released, another key, `cancelHover`) cancels this too. `open`
   * gets `wanted`, which turns false once the hover is cancelled, for the lookup it starts.
   */
  hoverAt(key: string, open: (wanted: () => boolean) => void): void {
    if (this.disposed || (this.hoverTimer !== undefined && this.hoverKey === key)) return
    this.cancelHover()
    this.hoverKey = key
    const epoch = this.hoverEpoch
    this.hoverTimer = this.timers.setTimeout(() => { this.hoverTimer = undefined; this.hoverKey = undefined; open(() => !this.disposed && this.hoverEpoch === epoch) }, peekLimits.hoverMs)
  }

  /** A view of a promoted tab's own, sharing the card's script cache. */
  createView(): PeekView { return new PeekView(this.reads, 'keep') }

  /** The pointer rests on a row with Ctrl (⌘ on macOS) held: the card opens after `peekLimits.hoverMs`. */
  hover(node: ExplorerMenuNode | undefined, delayMs: number = peekLimits.hoverMs): void {
    if (!this.canPeek(node)) { this.cancelHover(); return }
    if (this.hoverRow === node.id) return
    this.cancelHover()
    // A card the keyboard or the menu opened has focus: a pointer passing over the tree with Ctrl held leaves it alone.
    const open = this.getSnapshot().open
    if (open && (open.rowId === node.id || open.source !== 'hover')) return
    this.hoverRow = node.id
    this.hoverTimer = this.timers.setTimeout(() => { this.hoverTimer = undefined; this.hoverRow = undefined; this.peek(node, 'hover') }, delayMs)
  }

  /** The pointer left the row, or Ctrl (⌘) was released (the key dispatcher's `keyUp`): a card not yet open stays closed. */
  cancelHover(): void {
    if (this.hoverTimer !== undefined) this.timers.clearTimeout(this.hoverTimer)
    this.hoverTimer = undefined
    this.hoverRow = undefined
    this.hoverEpoch++
  }

  /**
   * The pointer moved over a row (`node` reads it then; `held`: whether Peek on Hover's modifier was held) or left the
   * tree's rows (undefined). The modifier's state from a pointer event also corrects `armed` after a press or release the
   * window did not see (it had no focus then).
   */
  pointer(node: (() => ExplorerMenuNode | undefined) | undefined, held?: boolean): void {
    this.pointerRow = node
    if (held !== undefined) this.armedStore.set(held)
    if (node && held) this.hover(node())
    else this.cancelHover()
  }

  private isModifier(key: string): boolean {
    return this.options.gestures ? this.options.gestures.isModifierKey('explorer.peekHover', key) : key === (this.options.platform === 'darwin' ? 'Meta' : 'Control')
  }
  private isHoverModifier(key: string): boolean {
    return this.options.hoverModifier ? this.options.hoverModifier(key) : this.isModifier(key)
  }
  /**
   * A key went down anywhere in the window (the key dispatcher's `keyDown`). Peek on Hover's modifier pressed with the
   * pointer resting on a row peeks it after `peekLimits.pressMs`, not the longer hover delay: the pointer is still, so the
   * press is the request. Any other key before then makes it a chord (Ctrl+N), not a peek. Any other key also forgets the
   * pointer's row until the pointer moves again: a pointer left resting on the tree while typing elsewhere is not a request,
   * so a shortcut whose modifier is held a while there (Ctrl+S in the editor) does not peek.
   */
  keyDown(key: string, repeat = false): void {
    if (!this.isModifier(key)) {
      // The query editor's own Peek on Hover modifier (when remapped apart) is held, not typed, while its hover waits; for a
      // row's hover it is part of a chord (Ctrl+Shift+N), which cancels as any other key does. Either way the pointer row is
      // forgotten: the editor's hover does not need it, and a chord must not leave a row for the next press to peek.
      if (!(this.isHoverModifier(key) && this.hoverRow === undefined)) this.cancelHover()
      this.pointerRow = undefined
      return
    }
    if (repeat && this.armedStore.getSnapshot()) return
    this.armedStore.set(true)
    const node = this.pointerRow?.()
    if (!this.canPeek(node)) return
    const open = this.getSnapshot().open
    // As `hover`: a card the keyboard or the menu opened keeps its place.
    if (open && open.source !== 'hover') return
    this.hover(node, peekLimits.pressMs)
  }

  /** A key went up anywhere in the window: releasing the hover's modifier forgets a hover not yet open; an open card stays, so the pointer can move into it. */
  keyUp(key: string): void {
    if (this.isModifier(key)) this.armedStore.set(false)
    // Releasing either Peek on Hover modifier forgets a hover not yet open, the query editor's included.
    if (this.isHoverModifier(key)) this.cancelHover()
  }

  /** The window lost focus: a held modifier's release would go unseen. */
  blur(): void {
    this.armedStore.set(false)
    this.cancelHover()
  }

  /**
   * Reads `target`'s properties and definition for a caller other than a view (a Search Objects tab's details pane), sharing
   * the card's kept and background scripts. `update` gets each part as it arrives, until the reader is released.
   */
  read(target: PeekTarget, fresh: boolean, update: (change: PeekChange) => void, maxChars?: number): PeekReader {
    return this.disposed ? { release: () => {} } : this.reads.read(target, fresh, update, maxChars)
  }

  override close(): void {
    this.cancelHover()
    super.close()
  }

  override dispose(): void {
    if (this.disposed) return
    this.cancelHover()
    this.pointerRow = undefined
    this.armedStore.clear()
    super.dispose()
    this.reads.dispose()
  }
}

/** The tabs read apart from the properties by one request each, kept on the view under their own names. */
type TabPart = 'dependencies'
type PartValue<K extends TabPart> = NonNullable<OpenPeek[K]> extends PeekPart<infer V> ? V : never
const sameObject = (a: ExplorerMenuNode, b: ExplorerMenuNode) => a.ref.type === 'object' && b.ref.type === 'object' && a.kind === b.kind
  && a.ref.object.database === b.ref.object.database && a.ref.object.schema === b.ref.object.schema && a.ref.object.name === b.ref.object.name
  && a.ref.object.project === b.ref.object.project && a.ref.object.dataset === b.ref.object.dataset && a.ref.object.table === b.ref.object.table
  && a.ref.object.parent?.kind === b.ref.object.parent?.kind && a.ref.object.parent?.schema === b.ref.object.parent?.schema && a.ref.object.parent?.name === b.ref.object.parent?.name
/** Validates a BigQuery cross-object navigation ref against its scope and name rules. */
function validBigQueryPeekRef(target: ObjectRef): boolean {
  if (!isBigQueryPropertyKind(target.kind) || !target.project || !target.name) return false
  if (!isBigQueryName('project', target.project)) return false
  if (target.kind === 'bqDataset') {
    return target.dataset === undefined && isBigQueryName('dataset', target.name)
  }
  return !!target.dataset && isBigQueryName('dataset', target.dataset)
    && isBigQueryName(target.kind === 'bqRoutine' ? 'routine' : 'table', target.name)
}
/** Whether Script As writes CREATE for the target, as its menu would offer it. */
const scriptable = (target: PeekTarget) => scriptMenuState({ kind: target.kind, ...(target.subtype === undefined ? {} : { subtype: target.subtype }),
  ...(target.object.parent ? { parentKind: target.object.parent.kind } : {}) }).verbs.create === 'enabled'
/** A scripted object's place in the cache: its connection, its kind and its names (a child's with its parent's). */
const scriptKey = (connectionId: string, object: ObjectRef) =>
  JSON.stringify([connectionId, object.kind, object.database ?? null, object.schema ?? null, object.parent?.kind ?? null, object.parent?.schema ?? null, object.parent?.name ?? null, object.name ?? null])
const validName = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 128 && !value.includes('\0')
/** Validates a cross-object navigation ref against its catalogue scope (required fields non-empty, forbidden absent). */
function validPeekObjectRef(target: ObjectRef): boolean {
  const { required, forbidden } = scopeFields[kindSpecs[target.kind].scope]
  const record = target as unknown as Record<string, unknown>
  for (const field of forbidden) if (record[field] !== undefined) return false
  for (const field of required) {
    if (field === 'parent') {
      const parent = target.parent
      if (!parent || !childParentKinds(target.kind).includes(parent.kind) || !validName(parent.name)) return false
      if (kindSpecs[parent.kind].scope === 'schemaObject' && !validName(parent.schema)) return false
    } else if (!validName(record[field])) {
      return false
    }
  }
  return true
}
/** Cancels are fire and forget: a failure is reported, never shown. */
const report = (result: Promise<ApiResult<unknown>>) => { void result.then(value => { if (!value.ok) onUnexpectedError(new Error(value.error)) }, onUnexpectedError) }
/** A request that throws (a lost IPC channel) settles as a failure value, as every other failure does. */
const settle = <T>(request: Promise<ApiResult<T>>): Promise<ApiResult<T>> => request.catch((error: unknown) => ({ ok: false as const, error: error instanceof Error ? error.message : String(error) }) as ApiResult<T>)
