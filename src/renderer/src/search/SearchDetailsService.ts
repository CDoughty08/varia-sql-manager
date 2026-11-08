import type { ApiResult, ExplorerNode, VariaApi } from '../../../shared/contracts'
import { isPeekKind, type PeekKind, type PeekResult } from '../../../shared/explorer/peek.ts'
import type { ObjectSearchHit } from '../../../shared/explorer/search.ts'
import { scriptMenuState } from '../../../shared/scripting/catalog.ts'
import type { ScriptingOptions } from '../../../shared/scripting/options.ts'
import { onUnexpectedError } from '../core/errors'
import { SnapshotStore } from '../core/store'
import { browserTimers, type Timers } from '../core/timers'
import type { Disposable, ExternalStore } from '../core/types'
import { peekMessages, type PeekChange, type PeekDefinition, type PeekPart, type PeekReader, type PeekTarget } from '../explorer/PeekService'
import { hitKey } from './ObjectSearchService'

export const searchDetailsLimits = {
  /** How long the selection rests before the pane reads it, so arrowing through the hits starts no reads on the way. */
  settleMs: 80,
  /** A table's or view's columns the pane lists: one page of Object Explorer's Columns folder. */
  columns: 500,
  /** The pane's share of the tab's width, by its sash. */
  minimum: 0.2,
  maximum: 0.8,
  initial: 0.45,
  /** What one arrow key on the sash moves it by. */
  step: 0.05
} as const

const clampDetails = (size: number): number =>
  Number.isFinite(size) ? Math.round(Math.min(searchDetailsLimits.maximum, Math.max(searchDetailsLimits.minimum, size)) * 100) / 100 : searchDetailsLimits.initial
/** The pane's share of the tab's body for a drag of its sash to `pointerX`: from the pointer to the body's right edge (px). */
export function detailsDrag(pointerX: number, left: number, right: number): number {
  const width = right - left
  return width > 0 ? clampDetails((right - pointerX) / width) : searchDetailsLimits.initial
}
/**
 * The sash as a window splitter: Left widens the pane (the sash moves left) and Right narrows it, a step at a time; Home and
 * End go to its widest and narrowest. Undefined for any other key.
 */
export function detailsKey(size: number, key: string): number | undefined {
  switch (key) {
    case 'ArrowLeft': return clampDetails(size + searchDetailsLimits.step)
    case 'ArrowRight': return clampDetails(size - searchDetailsLimits.step)
    case 'Home': return searchDetailsLimits.maximum
    case 'End': return searchDetailsLimits.minimum
    default: return undefined
  }
}

/** What the pane shows of a table or view: its definition (or CREATE script) or its columns. */
export type SearchDetailsView = 'definition' | 'columns'
export type DefinitionPart = PeekPart<PeekDefinition> | { readonly status: 'none' }
/** One column row as Object Explorer lists it: the name, and the type and nullability it shows beside it. */
export interface DetailsColumn { readonly name: string; readonly detail?: string }
/**
 * A tab's selected hit as the pane shows it. `kind` is set for the kinds Peek describes, whose properties (`facts`) come from
 * explorer.peek; every other scriptable kind's definition is its Script As CREATE script; `columns` is read for a table or a view
 * when the pane shows its columns.
 */
export interface SearchDetails {
  /** Increments with every hit shown, so the pane knows a new hit from a refresh. */
  readonly id: number
  readonly key: string
  readonly connectionId: string
  readonly hit: ObjectSearchHit
  readonly kind?: PeekKind
  readonly facts?: PeekPart<PeekResult['facts']>
  readonly definition: DefinitionPart
  readonly columns?: PeekPart<readonly DetailsColumn[]>
  /** Its server was lost: whatever had not arrived says so, and the hit is read again when the server comes back. */
  readonly lost?: true
}
export interface SearchDetailsSnapshot {
  readonly documents: Readonly<Record<string, SearchDetails>>
  /** The pane is hidden in every Search Objects tab (its Details button). */
  readonly hidden: boolean
  /** The pane's share of the tab's width; undefined until its sash moves. */
  readonly size?: number
  readonly view: SearchDetailsView
}

export interface SearchDetailsOptions {
  readonly api: Pick<VariaApi, 'scriptObjects' | 'cancelScripting' | 'explorerChildren' | 'explorerCancel'>
  readonly peek: { read(target: PeekTarget, fresh: boolean, update: (change: PeekChange) => void): PeekReader }
  readonly connections: ExternalStore<readonly { readonly id: string; readonly lost?: boolean }[]>
  /** The search documents, so a closed tab's details go with it. */
  readonly searches: ExternalStore<{ readonly documents: Readonly<Record<string, unknown>> }>
  readonly scriptingOptions: ExternalStore<{ readonly options: ScriptingOptions }>
  readonly timers?: Timers
  readonly newId?: () => string
}

/** A tab's reads: Peek's reader, a Script As request, a Columns page. */
interface Reads { peek?: PeekReader; script?: string; columns?: string; timer?: unknown }

export const columnsOf = (object: ObjectSearchHit['object']): boolean => object.kind === 'table' || object.kind === 'view'
/** Whether Script As can write `hit`'s CREATE script, as its menu would offer it. */
export const scriptable = (hit: ObjectSearchHit): boolean =>
  scriptMenuState({ kind: hit.object.kind, subtype: hit.subtype, parentKind: hit.object.parent?.kind }).verbs.create === 'enabled'

/**
 * The details pane of each Search Objects tab: the selected hit's properties and its definition, read once the selection
 * settles (`searchDetailsLimits.settleMs`). Tables, views, procedures and functions are read as Peek reads them (sharing its
 * kept table scripts); any other kind Script As can write shows its CREATE script; a table's or view's columns are one page of
 * Object Explorer's Columns folder. Nothing is read while the pane is hidden; a new hit, a closed tab or a lost server cancels
 * the tab's reads.
 */
export class SearchDetailsService extends SnapshotStore<SearchDetailsSnapshot> implements Disposable {
  private next = 0
  private readonly reads = new Map<string, Reads>()
  private readonly timers: Timers
  private readonly newId: () => string
  private disposed = false
  private readonly unsubscribe: () => void

  constructor(private readonly options: SearchDetailsOptions) {
    super({ documents: {}, hidden: false, view: 'definition' })
    this.timers = options.timers ?? browserTimers
    this.newId = options.newId ?? (() => crypto.randomUUID())
    const searches = options.searches.subscribe(() => {
      const open = options.searches.getSnapshot().documents
      for (const id of Object.keys(this.getSnapshot().documents)) if (!Object.hasOwn(open, id)) this.drop(id)
      for (const id of [...this.reads.keys()]) if (!Object.hasOwn(open, id)) this.drop(id)
    })
    const connections = options.connections.subscribe(() => {
      for (const [id, details] of Object.entries(this.getSnapshot().documents)) {
        const live = this.isLive(details.connectionId)
        if (!live && !details.lost) this.lost(id)
        else if (live && details.lost) this.load(id, details.connectionId, details.hit, false, false)
      }
    })
    this.unsubscribe = () => { searches(); connections() }
  }

  /**
   * The tab's selected hit is now `hit` (none when undefined): the pane shows its name at once and reads it once the selection
   * settles. The hit already shown, on the same server, reads nothing again.
   */
  show(documentId: string, connectionId: string, hit: ObjectSearchHit | undefined): void {
    // A hidden pane keeps nothing; showing it again calls this for each tab's selection.
    if (this.disposed || this.getSnapshot().hidden) return
    const shown = this.getSnapshot().documents[documentId]
    if (!hit) { if (shown || this.reads.has(documentId)) this.drop(documentId); return }
    const key = hitKey(hit)
    if (shown && shown.key === key && shown.connectionId === connectionId) {
      if (shown.hit !== hit) this.put(documentId, { ...shown, hit })
      return
    }
    this.load(documentId, connectionId, hit, false, true)
  }

  /** Reads the tab's hit again, a table's script included (Refresh never takes a kept script). */
  refresh(documentId: string): void {
    const shown = this.getSnapshot().documents[documentId]
    if (shown) this.load(documentId, shown.connectionId, shown.hit, true, false)
  }

  setHidden(hidden: boolean): void {
    if (hidden === this.getSnapshot().hidden) return
    // A hidden pane reads nothing: its tabs' reads stop, and showing it again reads each tab's selection afresh.
    if (hidden) for (const id of Object.keys(this.getSnapshot().documents)) this.drop(id)
    this.publish({ ...this.getSnapshot(), ...(hidden ? { documents: {} } : {}), hidden })
  }

  setSize(size: number | undefined): void {
    const next = size === undefined ? undefined : clampDetails(size)
    if (next !== this.getSnapshot().size) this.publish({ ...this.getSnapshot(), size: next })
  }

  /** Shows a table's or view's definition or its columns; the columns are read the first time each hit shows them, and again after failing. */
  setView(view: SearchDetailsView): void {
    if (view === this.getSnapshot().view) return
    this.publish({ ...this.getSnapshot(), view })
    if (view !== 'columns') return
    for (const [id, details] of Object.entries(this.getSnapshot().documents)) {
      if (!columnsOf(details.hit.object) || details.columns && details.columns.status !== 'error') continue
      if (this.reads.get(id)?.timer === undefined) this.readColumns(id, details)
    }
  }

  dispose(): void {
    if (this.disposed) return
    for (const id of [...this.reads.keys()]) this.release(id)
    this.disposed = true
    this.unsubscribe()
    this.clearListeners()
  }

  private isLive(connectionId: string): boolean {
    return this.options.connections.getSnapshot().some(connection => connection.id === connectionId && !connection.lost)
  }

  private load(documentId: string, connectionId: string, hit: ObjectSearchHit, fresh: boolean, settle: boolean): void {
    this.release(documentId)
    const id = ++this.next, kind = isPeekKind(hit.object.kind) ? hit.object.kind : undefined
    const live = this.isLive(connectionId)
    const definition: DefinitionPart = !live ? { status: 'error', message: peekMessages.notConnected } : kind || scriptable(hit) ? { status: 'loading' } : { status: 'none' }
    const details: SearchDetails = { id, key: hitKey(hit), connectionId, hit, definition, ...(kind ? { kind, facts: live ? { status: 'loading' } : { status: 'error', message: peekMessages.notConnected } } : {}), ...(live ? {} : { lost: true as const }) }
    this.put(documentId, details)
    if (!live || this.getSnapshot().hidden) return
    const start = () => {
      const reads = this.reads.get(documentId)
      if (reads) reads.timer = undefined
      if (kind) this.readPeek(documentId, details, kind, fresh)
      else if (definition.status === 'loading') this.readScript(documentId, details)
      if (this.getSnapshot().view === 'columns' && columnsOf(hit.object)) this.readColumns(documentId, details)
    }
    if (!settle) { start(); return }
    this.reads.set(documentId, { timer: this.timers.setTimeout(start, searchDetailsLimits.settleMs) })
  }

  /** `change` for the tab's details, while they are still those of read `id`. */
  private update(documentId: string, id: number, change: Partial<SearchDetails>): void {
    const details = this.getSnapshot().documents[documentId]
    if (details && details.id === id) this.put(documentId, { ...details, ...change })
  }

  private readPeek(documentId: string, details: SearchDetails, kind: PeekKind, fresh: boolean): void {
    const reads = this.readsOf(documentId)
    reads.peek = this.options.peek.read({ connectionId: details.connectionId, object: details.hit.object, kind }, fresh, change => this.update(documentId, details.id, change))
  }

  private readScript(documentId: string, details: SearchDetails): void {
    const requestId = this.newId(), reads = this.readsOf(documentId)
    reads.script = requestId
    const options = this.options.scriptingOptions.getSnapshot().options
    void settled(this.options.api.scriptObjects({ connectionId: details.connectionId, requestId, targets: [details.hit.object], verb: 'create', options })).then(result => {
      if (this.reads.get(documentId)?.script !== requestId) return
      this.readsOf(documentId).script = undefined
      const definition: DefinitionPart = !result.ok ? { status: 'error', message: result.error }
        : result.value.error ? { status: 'error', message: result.value.error.message }
        : { status: 'ready', value: result.value.text === undefined ? {} : { text: result.value.text } }
      this.update(documentId, details.id, { definition })
    }).catch(onUnexpectedError)
  }

  private readColumns(documentId: string, details: SearchDetails): void {
    const { object } = details.hit
    if (!this.isLive(details.connectionId) || object.kind !== 'table' && object.kind !== 'view') return
    const requestId = this.newId(), reads = this.readsOf(documentId)
    reads.columns = requestId
    this.update(documentId, details.id, { columns: { status: 'loading' } })
    const node = { type: 'folder' as const, owner: object, folder: 'columns' as const }
    void settled(this.options.api.explorerChildren({ connectionId: details.connectionId, requestId, node, pageSize: searchDetailsLimits.columns })).then(result => {
      if (this.reads.get(documentId)?.columns !== requestId) return
      this.readsOf(documentId).columns = undefined
      const columns: PeekPart<readonly DetailsColumn[]> = !result.ok ? { status: 'error', message: result.error }
        : result.value.error ? { status: 'error', message: result.value.error.message }
        : { status: 'ready', value: result.value.nodes.map(columnOf) }
      this.update(documentId, details.id, { columns })
    }).catch(onUnexpectedError)
  }

  private readsOf(documentId: string): Reads {
    let reads = this.reads.get(documentId)
    if (!reads) { reads = {}; this.reads.set(documentId, reads) }
    return reads
  }

  /** Ends the tab's reads: the settle timer, Peek's reader (which keeps a table's script for its cache), the script and the columns. */
  private release(documentId: string): void {
    const reads = this.reads.get(documentId)
    if (!reads) return
    this.reads.delete(documentId)
    if (reads.timer !== undefined) this.timers.clearTimeout(reads.timer)
    reads.peek?.release(true)
    try {
      if (reads.script) report(this.options.api.cancelScripting([reads.script]))
      if (reads.columns) report(this.options.api.explorerCancel([reads.columns]))
    } catch (error) { onUnexpectedError(error) }
  }

  /** The tab's server went: its reads end, and what had not arrived says so. */
  private lost(documentId: string): void {
    const details = this.getSnapshot().documents[documentId]
    this.release(documentId)
    if (!details) return
    const gone = { status: 'error' as const, message: peekMessages.notConnected }
    const loading = (part: { readonly status: string } | undefined) => part?.status === 'loading'
    this.put(documentId, { ...details, lost: true, ...(loading(details.facts) ? { facts: gone } : {}), ...(loading(details.definition) ? { definition: gone } : {}), ...(loading(details.columns) ? { columns: gone } : {}) })
  }

  private drop(documentId: string): void {
    this.release(documentId)
    const { [documentId]: _dropped, ...documents } = this.getSnapshot().documents
    if (_dropped) this.publish({ ...this.getSnapshot(), documents })
  }

  private put(documentId: string, details: SearchDetails): void {
    this.publish({ ...this.getSnapshot(), documents: { ...this.getSnapshot().documents, [documentId]: details } })
  }
}

/** Object Explorer's column row: its label is the name; its sublabel the keys, type and nullability, as `(PK, int, not null)`. */
const columnOf = (node: ExplorerNode): DetailsColumn => {
  const detail = node.sublabel ?? node.detail
  return detail ? { name: node.label, detail } : { name: node.label }
}
/** Cancels are fire and forget: a failure is reported, never shown. */
const report = (result: Promise<ApiResult<unknown>>) => { void result.then(value => { if (!value.ok) onUnexpectedError(new Error(value.error)) }, onUnexpectedError) }
/** A request that throws (a lost IPC channel) settles as a failure value. */
const settled = <T>(request: Promise<ApiResult<T>>): Promise<ApiResult<T>> => request.catch((error: unknown) => ({ ok: false as const, error: error instanceof Error ? error.message : String(error) }) as ApiResult<T>)
