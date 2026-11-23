import { bigQueryDetailKinds, bigQueryPropertyKinds, type BigQueryDetailKind, type BigQueryProperties } from '../../../shared/bigquery/objects'
import type { BigQueryDryRunResult } from '../../../shared/bigquery/dry-run.ts'
import type { ApiResult, VariaApi } from '../../../shared/contracts'
import { isLiveConnection, type ConnectionAvailability } from '../services/connection-availability'
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

/**
 * Characters the details pane shows at most: its definition is a <pre>, not an editor, and a text node of tens of millions of
 * characters stalls layout. Peek's editor (Space) and Script to New Query show all of a longer one, which is read only this far.
 */
export const shownChars = 1_000_000

export const searchDetailsLimits = {
  /** How long the selection rests before the pane reads it, so arrowing through the hits starts no reads on the way. */
  settleMs: 80,
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
/** `billed`: a BigQuery table's CREATE statement, which only a billed query reads, so the pane reads it only when asked (`readCreate`). */
export type DefinitionPart = PeekPart<PeekDefinition> | { readonly status: 'none' } | { readonly status: 'billed' }
/**
 * A tab's selected hit as the pane shows it. `kind` is set for the kinds Peek describes, whose properties (`facts`) come from
 * explorer.peek with the kind's lists (a table's or view's Columns, which the pane's Columns view shows); every other scriptable
 * kind's definition is its Script As CREATE script.
 */
export interface SearchDetails {
  /** Increments with every hit shown, so the pane knows a new hit from a refresh. */
  readonly id: number
  readonly key: string
  readonly connectionId: string
  readonly hit: ObjectSearchHit
  readonly kind?: PeekKind
  readonly facts?: PeekPart<PeekResult['facts']>
  /** The Peek groups the login was refused (index usage), which come with the facts. */
  readonly refused?: PeekResult['refused']
  readonly definition: DefinitionPart
  /** The kind's Peek lists, which come with the facts: Columns for a table or a view. */
  readonly lists?: PeekResult['lists']
  /** A BigQuery table-like object's or routine's facts, view text or body, and columns: bigquery.properties, free. */
  readonly bigQuery?: PeekPart<BigQueryProperties>
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
  readonly api: Pick<VariaApi, 'scriptObjects' | 'cancelScripting'> & Partial<Pick<VariaApi, 'bigQueryProperties'>>
  /** BigQuery's cost prompts before a table's billed CREATE statement is read (BigQueryCostService.beforeScript); without it the pane offers none. */
  readonly billedGate?: (connectionId: string, estimate: BigQueryDryRunResult, signal: AbortSignal) => Promise<{ readonly run: boolean; readonly maximumBytesBilled?: number }>
  readonly peek: { read(target: PeekTarget, fresh: boolean, update: (change: PeekChange) => void, maxChars?: number): PeekReader }
  readonly connections: ExternalStore<readonly (ConnectionAvailability & { readonly id: string })[]>
  /** The search documents, so a closed tab's details go with it. */
  readonly searches: ExternalStore<{ readonly documents: Readonly<Record<string, unknown>> }>
  readonly scriptingOptions: ExternalStore<{ readonly options: ScriptingOptions }>
  readonly timers?: Timers
  readonly newId?: () => string
}

/** A tab's reads: Peek's reader, a Script As request, a BigQuery properties request, a billed CREATE's cost prompt. */
interface Reads { peek?: PeekReader; script?: string; timer?: unknown; properties?: string; prompt?: AbortController }

const isBigQueryTableKind = (kind: string): boolean => (bigQueryPropertyKinds as readonly string[]).includes(kind)
/** The kind bigquery.properties reads for a BigQuery hit: a table-like object or a routine. */
export const bigQueryDetailKind = (object: ObjectSearchHit['object']): BigQueryDetailKind | undefined =>
  object.project !== undefined && object.dataset !== undefined && object.name !== undefined && (bigQueryDetailKinds as readonly string[]).includes(object.kind) ? object.kind as BigQueryDetailKind : undefined
export const columnsOf = (object: ObjectSearchHit['object']): boolean => object.kind === 'table' || object.kind === 'view' || object.project !== undefined && isBigQueryTableKind(object.kind)
/** Whether Script As can write `hit`'s CREATE script, as its menu would offer it. */
export const scriptable = (hit: ObjectSearchHit): boolean =>
  scriptMenuState({ kind: hit.object.kind, subtype: hit.subtype, parentKind: hit.object.parent?.kind }).verbs.create === 'enabled'

/**
 * The details pane of each Search Objects tab: the selected hit's properties and its definition, read once the selection
 * settles (`searchDetailsLimits.settleMs`). Tables, views, procedures and functions are read as Peek reads them (sharing its
 * kept table scripts), a table's or view's columns being Peek's Columns list; any other kind Script As can write shows its CREATE
 * script. A BigQuery hit reads only free metadata (bigquery.properties): its facts, a view's text or a routine's body, and its
 * columns. A table's CREATE statement is a billed query, read only on `readCreate` after its estimate and the cost prompts.
 * Nothing is read while the pane is hidden; a new hit, a closed tab or a lost server cancels the tab's reads.
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

  /** Shows a table's or view's definition or its columns, which came with its properties: switching reads nothing. */
  setView(view: SearchDetailsView): void {
    if (view !== this.getSnapshot().view) this.publish({ ...this.getSnapshot(), view })
  }

  dispose(): void {
    if (this.disposed) return
    for (const id of [...this.reads.keys()]) this.release(id)
    this.disposed = true
    this.unsubscribe()
    this.clearListeners()
  }

  private isLive(connectionId: string): boolean {
    return this.options.connections.getSnapshot().some(connection => connection.id === connectionId && isLiveConnection(connection))
  }

  private load(documentId: string, connectionId: string, hit: ObjectSearchHit, fresh: boolean, settle: boolean): void {
    this.release(documentId)
    if (hit.object.project !== undefined) { this.loadBigQuery(documentId, connectionId, hit, settle); return }
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
    }
    if (!settle) { start(); return }
    this.reads.set(documentId, { timer: this.timers.setTimeout(start, searchDetailsLimits.settleMs) })
  }

  /**
   * A BigQuery hit: its free facts (bigquery.properties) once the selection settles, which bring a view's text or a routine's body.
   * Nothing billed runs here: a table's CREATE statement waits for `readCreate`.
   */
  private loadBigQuery(documentId: string, connectionId: string, hit: ObjectSearchHit, settle: boolean): void {
    const id = ++this.next, live = this.isLive(connectionId)
    const kind = this.options.api.bigQueryProperties ? bigQueryDetailKind(hit.object) : undefined
    const gone = { status: 'error' as const, message: peekMessages.notConnected }
    const definition: DefinitionPart = !live ? gone : kind ? { status: 'loading' } : this.billed(hit)
    const details: SearchDetails = { id, key: hitKey(hit), connectionId, hit, definition, ...(kind ? { bigQuery: live ? { status: 'loading' as const } : gone } : {}), ...(live ? {} : { lost: true as const }) }
    this.put(documentId, details)
    if (!live || !kind || this.getSnapshot().hidden) return
    const start = () => {
      const reads = this.reads.get(documentId)
      if (reads) reads.timer = undefined
      this.readProperties(documentId, details, kind)
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
    // A long module is read only as far as the pane shows: its later pages would cost time and memory for nothing.
    reads.peek = this.options.peek.read({ connectionId: details.connectionId, object: details.hit.object, kind, ...(details.hit.subtype === undefined ? {} : { subtype: details.hit.subtype }) }, fresh,
      change => this.update(documentId, details.id, change), shownChars)
  }

  /** What a BigQuery hit's definition is without a free text: a billed CREATE on request where Script As can write one, else none. */
  private billed(hit: ObjectSearchHit): DefinitionPart {
    return scriptable(hit) && this.options.billedGate ? { status: 'billed' } : { status: 'none' }
  }

  private readProperties(documentId: string, details: SearchDetails, kind: BigQueryDetailKind): void {
    const requestId = this.newId(), reads = this.readsOf(documentId), object = details.hit.object
    reads.properties = requestId
    void settled(this.options.api.bigQueryProperties!({ connectionId: details.connectionId, requestId, kind, project: object.project!, dataset: object.dataset!, name: object.name! })).then(result => {
      if (this.reads.get(documentId)?.properties !== requestId) return
      this.readsOf(documentId).properties = undefined
      if (!result.ok) {
        this.update(documentId, details.id, { bigQuery: { status: 'error', message: result.error }, definition: this.billed(details.hit) })
        return
      }
      const text = result.value.definition
      // A view's text and a routine's body come free with the facts; a table has none, and its CREATE statement is billed.
      const definition: DefinitionPart = text !== undefined ? { status: 'ready', value: { text } }
        : kind === 'bqTable' || kind === 'bqExternalTable' ? this.billed(details.hit) : { status: 'ready', value: {} }
      this.update(documentId, details.id, { bigQuery: { status: 'ready', value: result.value }, definition })
    }).catch(onUnexpectedError)
  }

  /** Whether the tab's hit has a billed CREATE statement to read now (`readCreate`). */
  canReadCreate(documentId: string): boolean {
    const details = this.getSnapshot().documents[documentId]
    return !!details && details.definition.status === 'billed' && !!this.options.billedGate && this.isLive(details.connectionId)
  }

  /**
   * Reads a BigQuery table's CREATE statement, which is a billed query (INFORMATION_SCHEMA.TABLES' ddl): its free estimate, then
   * the cost prompts, then the read under the cap they answer. A declined prompt leaves the pane offering it again.
   */
  async readCreate(documentId: string): Promise<void> {
    const details = this.getSnapshot().documents[documentId]
    const gate = this.options.billedGate
    if (this.disposed || !details || !gate || !this.canReadCreate(documentId)) return
    const reads = this.readsOf(documentId), id = details.id
    const current = () => !this.disposed && this.reads.get(documentId) === reads && this.getSnapshot().documents[documentId]?.id === id
    this.update(documentId, id, { definition: { status: 'loading' } })
    const request = { connectionId: details.connectionId, targets: [details.hit.object], verb: 'create' as const, options: this.options.scriptingOptions.getSnapshot().options }
    const fail = (message: string) => { if (current()) this.update(documentId, id, { definition: { status: 'error', message } }) }
    let requestId = this.newId()
    reads.script = requestId
    const estimated = await settled(this.options.api.scriptObjects({ ...request, requestId, estimateOnly: true }))
    if (!current() || reads.script !== requestId) return
    reads.script = undefined
    if (!estimated.ok) { fail(estimated.error); return }
    if (estimated.value.error) { fail(estimated.value.error.message); return }
    let answer: { readonly run: boolean; readonly maximumBytesBilled?: number } = { run: true }
    if (estimated.value.estimate) {
      const prompt = new AbortController()
      reads.prompt = prompt
      // A prompt that fails is no consent: the button comes back rather than leave the pane loading.
      try { answer = await gate(details.connectionId, estimated.value.estimate, prompt.signal).catch(() => ({ run: false })) } finally { if (reads.prompt === prompt) reads.prompt = undefined }
      if (!current() || prompt.signal.aborted) return
    }
    if (!answer.run) { this.update(documentId, id, { definition: { status: 'billed' } }); return }
    requestId = this.newId()
    reads.script = requestId
    const result = await settled(this.options.api.scriptObjects({ ...request, requestId, ...answer.maximumBytesBilled === undefined ? {} : { maximumBytesBilled: answer.maximumBytesBilled } }))
    if (!current() || reads.script !== requestId) return
    reads.script = undefined
    if (!result.ok) { fail(result.error); return }
    if (result.value.error) { fail(result.value.error.message); return }
    this.update(documentId, id, { definition: { status: 'ready', value: result.value.text === undefined ? {} : { text: result.value.text } } })
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

  private readsOf(documentId: string): Reads {
    let reads = this.reads.get(documentId)
    if (!reads) { reads = {}; this.reads.set(documentId, reads) }
    return reads
  }

  /** Ends the tab's reads: the settle timer, Peek's reader (which keeps a table's script for its cache) and the script. */
  private release(documentId: string): void {
    const reads = this.reads.get(documentId)
    if (!reads) return
    this.reads.delete(documentId)
    if (reads.timer !== undefined) this.timers.clearTimeout(reads.timer)
    reads.peek?.release(true)
    reads.prompt?.abort()
    try {
      if (reads.script) report(this.options.api.cancelScripting([reads.script]))
    } catch (error) { onUnexpectedError(error) }
  }

  /** The tab's server went: its reads end, and what had not arrived says so. */
  private lost(documentId: string): void {
    const details = this.getSnapshot().documents[documentId]
    this.release(documentId)
    if (!details) return
    const gone = { status: 'error' as const, message: peekMessages.notConnected }
    const loading = (part: { readonly status: string } | undefined) => part?.status === 'loading'
    this.put(documentId, {
      ...details, lost: true, ...(loading(details.facts) ? { facts: gone } : {}), ...(loading(details.bigQuery) ? { bigQuery: gone } : {}),
      ...(loading(details.definition) || details.definition.status === 'billed' ? { definition: gone } : {})
    })
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

/** Cancels are fire and forget: a failure is reported, never shown. */
const report = (result: Promise<ApiResult<unknown>>) => { void result.then(value => { if (!value.ok) onUnexpectedError(new Error(value.error)) }, onUnexpectedError) }
/** A request that throws (a lost IPC channel) settles as a failure value. */
const settled = <T>(request: Promise<ApiResult<T>>): Promise<ApiResult<T>> => request.catch((error: unknown) => ({ ok: false as const, error: error instanceof Error ? error.message : String(error) }) as ApiResult<T>)
