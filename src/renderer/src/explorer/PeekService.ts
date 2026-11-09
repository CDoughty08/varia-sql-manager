import type { ApiResult, ExplorerError, ExplorerNode, VariaApi } from '../../../shared/contracts'
import { isPeekKind, peekLimits, peekSpecs, peekTabsOf, type PeekDependency, type PeekKind, type PeekResult, type PeekTab } from '../../../shared/explorer/peek.ts'
import type { ObjectRef } from '../../../shared/explorer/refs.ts'
import type { ScriptingOptions } from '../../../shared/scripting/options.ts'
import { selectTopRowsScript } from '../../../shared/sql/identifiers'
import { onUnexpectedError } from '../core/errors'
import { SnapshotStore } from '../core/store'
import type { ExternalStore } from '../core/types'
import type { ExplorerMenuNode } from '../menus/targets'
import type { ResultsService } from '../results/ResultsService'

/** How a peek was asked for: a hover opens the card without moving focus; the keyboard and the menu focus it. */
export type PeekSource = 'hover' | 'keyboard' | 'menu'
export type PeekPart<T> = { readonly status: 'loading' } | { readonly status: 'ready'; readonly value: T } | { readonly status: 'error'; readonly message: string }
export interface PeekDefinition { readonly text?: string; readonly truncated?: boolean }
/** The Columns or Parameters folder as the tree lists it: its first page, `more` when the folder has others. */
export interface PeekMembers { readonly nodes: readonly ExplorerNode[]; readonly more: boolean }
export interface PeekDependencies {
  readonly uses: readonly PeekDependency[]
  readonly usesTruncated: boolean
  readonly usedBy: readonly PeekDependency[]
  readonly usedByTruncated: boolean
}
/** Top rows: the ResultsService entry the view's run owns, by its key, which the results grid shows. */
export interface PeekRows { readonly key: string }
/** A card the user moved on from by following a dependency, which Back returns to. */
export interface PeekStep { readonly node: ExplorerMenuNode; readonly kind: PeekKind; readonly tab: PeekTab }
export interface OpenPeek {
  /** Increments with every peek, so the card knows a new one from a refresh of the same. */
  readonly id: number
  readonly rowId: number
  readonly node: ExplorerMenuNode
  readonly kind: PeekKind
  readonly source: PeekSource
  readonly facts: PeekPart<PeekResult['facts']>
  readonly definition: PeekPart<PeekDefinition>
  /** The tab shown; every tab but Definition is read the first time it is chosen, and again when it is chosen after failing. */
  readonly tab: PeekTab
  readonly members?: PeekPart<PeekMembers>
  readonly dependencies?: PeekPart<PeekDependencies>
  readonly rows?: PeekPart<PeekRows>
  /** The cards before this one, oldest first, when a dependency was followed. */
  readonly back: readonly PeekStep[]
}
export interface PeekSnapshot { readonly open?: OpenPeek }
/** What a read describes: a table, view, procedure or function on a connection. */
export interface PeekTarget { readonly connectionId: string; readonly object: ObjectRef; readonly kind: PeekKind }
/** A read's parts as they arrive. */
export type PeekChange = Partial<{ readonly facts: PeekPart<PeekResult['facts']>; readonly definition: PeekPart<PeekDefinition> }>
/**
 * A running read: a Search Objects tab's details pane's. Releasing it cancels the properties read, and the table's script
 * unless `keep` and the facts gave its modified time, when it finishes in the background to be cached.
 */
export interface PeekReader { release(keep: boolean): void }
/** What a view's Top rows run needs of the results: it follows its run as a query tab's, under a key of its own, and releases it. */
export type PeekResults = Pick<ResultsService, 'begin' | 'finish' | 'release'>

export interface PeekServiceOptions {
  readonly api: Pick<VariaApi, 'explorerPeek' | 'explorerPeekDependencies' | 'explorerChildren' | 'explorerCancel' | 'scriptObjects' | 'cancelScripting' | 'writeClipboardText'
    | 'tableColumns' | 'execute' | 'closeQuerySession'>
  readonly connections: ExternalStore<readonly { readonly id: string; readonly lost?: boolean }[]>
  /** Tools › Options › Scripting, which a table's CREATE script follows, as Script As does. */
  readonly scriptingOptions: ExternalStore<{ readonly options: ScriptingOptions }>
  /** Where Top rows' result sets live; without it the tab says it cannot read them. */
  readonly results?: PeekResults
  readonly timers?: { setTimeout(callback: () => void, ms: number): unknown; clearTimeout(handle: unknown): void }
  readonly newId?: () => string
  /** Ctrl+hover peeks; on macOS ⌘+hover, as ⌘ is macOS's Ctrl. */
  readonly platform?: string
  /** The clock kept scripts expire by; defaults to `Date.now`. */
  readonly now?: () => number
}

export const peekMessages = {
  notConnected: 'The server is not connected.',
  noDefinition: 'The definition is encrypted, or the login does not have VIEW DEFINITION permission on it.',
  noRows: 'It has no rows.',
  noMembers: 'None.',
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
/** A read's requests still running: the properties read, the table's script, and (a view's only) its tabs' reads. */
type Requests = { peek?: string; script?: ScriptJob } & { [tab in TabPart]?: string }
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
    return this.options.connections.getSnapshot().some(connection => connection.id === connectionId && !connection.lost)
  }

  /**
   * Reads `target`'s properties and definition for a caller other than a view (a Search Objects tab's details pane), sharing
   * the kept and background scripts. `update` gets each part as it arrives, until the reader is released.
   */
  read(target: PeekTarget, fresh: boolean, update: (change: PeekChange) => void): PeekReader {
    const requests: Requests = {}
    let released = this.disposed
    const reader: PeekReader = { release: keep => { if (released) return; released = true; this.release(requests, keep) } }
    if (!released) this.begin(target, fresh, requests, () => !this.disposed && !released, update)
    return reader
  }

  /**
   * Starts reading `target`'s properties (explorer.peek) and its definition: a module's text comes with them; a table's from
   * Script As CREATE, taken from the window's cache while the table's modified time still matches (never when `fresh`), or
   * from a replaced read's script still running for it. The reads' ids go in `requests`; `update` runs while `current()`.
   */
  begin(target: PeekTarget, fresh: boolean, requests: Requests, current: () => boolean, update: (change: PeekChange) => void): void {
    const { connectionId, object, kind } = target
    const key = peekSpecs[kind].definition === 'script' ? scriptKey(connectionId, object) : undefined
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
      const value = result.value, modified = typeof value.facts.modified === 'string' ? value.facts.modified : undefined
      tell({ facts: { status: 'ready', value: value.facts },
        ...(key === undefined ? { definition: { status: 'ready', value: value.definition === undefined ? {} : { text: value.definition, ...(value.definitionTruncated ? { truncated: true } : {}) } } } : {}) })
      if (key === undefined) return
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
   * A read ends (a view's, or a reader's): the properties and tab reads are cancelled, and so is the table's script unless
   * `keep` and the facts gave its modified time, when it finishes in the background to be cached (the oldest background
   * script gives way past the limit).
   */
  release(requests: Requests, keep: boolean): void {
    const { peek, script, members, dependencies } = requests
    for (const name of ['peek', 'script', 'members', 'dependencies'] as const) requests[name] = undefined
    try {
      const reads = [peek, members, dependencies].filter((request): request is string => request !== undefined)
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

/**
 * One object's Peek, as the card or a promoted tab shows it: its properties and definition, its tabs' parts, the dependencies
 * followed (Back), and its Top rows run. Top rows runs `selectTopRowsScript` (Select Top N Rows' script, with
 * `peekLimits.rows`) through query.execute in a session of its own, which closes as soon as the run settles: the backend keeps
 * the run's results until they are released (results.close), so the view owns only a ResultsService entry under its run's key.
 * It releases that entry, and closes the session if the run still holds it, when it closes, moves to another object, refreshes
 * or reads the rows again after a failure, and when its server is lost (a lost backend loses its connections too).
 */
export class PeekView extends SnapshotStore<PeekSnapshot> {
  private next = 0
  private requests: Requests = {}
  private rowsRun: RowsRun | undefined
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
  get connected(): boolean { const open = this.getSnapshot().open; return !!open && this.reads.isLive(open.node.connectionId) }

  /** Shows `node` (a table, view, procedure or function), replacing whatever the view showed, on `tab` when its kind has it. */
  show(node: ExplorerMenuNode, tab?: PeekTab): void {
    if (this.disposed || node.ref.type !== 'object' || node.kind === 'folder' || !isPeekKind(node.kind)) return
    this.load(node, node.kind, 'keyboard', false, tab ? { tab } : {})
  }

  /** Shows another tab, reading it the first time; choosing a tab whose read failed reads it again. */
  selectTab(tab: PeekTab): void {
    const open = this.getSnapshot().open
    if (!open || !peekTabsOf(open.kind).includes(tab)) return
    if (open.tab !== tab) this.publish({ open: { ...open, tab } })
    this.loadTab()
  }

  /**
   * Whether a dependency can be peeked from the view: an object of a kind Peek describes, in the view's database. The backend
   * names no server or database for an object SQL Server resolved there, however the code spelled the database.
   */
  canFollow(dependency: PeekDependency): boolean {
    return dependency.kind !== undefined && isPeekKind(dependency.kind) && dependency.server === undefined && dependency.database === undefined && dependency.schema !== undefined
  }

  /** Peeks a dependency in the same view (the card stays beside the same row); Back returns to this one. */
  follow(dependency: PeekDependency): void {
    const open = this.getSnapshot().open
    if (!open || open.node.ref.type !== 'object' || !this.canFollow(dependency) || !dependency.kind || !isPeekKind(dependency.kind)) return
    const object = { kind: dependency.kind, ...(open.node.ref.object.database === undefined ? {} : { database: open.node.ref.object.database }), schema: dependency.schema!, name: dependency.name }
    const { subtype: _subtype, status: _status, database: _database, listedAt: _listedAt, filtered: _filtered, insertable: _insertable, ...rest } = open.node
    // The dependency's own subtype, as the tree lists it, so Script As offers its verbs and Columns reads its folder.
    const node: ExplorerMenuNode = { ...rest, kind: dependency.kind, ...(dependency.subtype === undefined ? {} : { subtype: dependency.subtype }), ref: { type: 'object', object }, label: `${dependency.schema}.${dependency.name}` }
    const back = [...open.back, { node: open.node, kind: open.kind, tab: open.tab }].slice(-peekLimits.backSteps)
    this.load(node, dependency.kind, open.source === 'hover' ? 'keyboard' : open.source, false, { back })
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
    if (this.disposed || !open || open.node.connectionId === connectionId) return
    const move = (node: ExplorerMenuNode): ExplorerMenuNode => ({ ...node, connectionId, lost: false })
    this.publish({ open: { ...open, node: move(open.node), back: open.back.map(step => ({ ...step, node: move(step.node) })) } })
    this.refresh()
  }

  /** Reads the object again, its script and its rows included: Refresh never takes a kept script. */
  refresh(): void {
    const open = this.getSnapshot().open
    if (open && this.reads.isLive(open.node.connectionId)) this.load(open.node, open.kind, open.source, true, { back: open.back, tab: open.tab })
  }

  /** Copies the definition, once the view has all of it: a cut module is copied whole by Script to New Query. */
  async copyDefinition(): Promise<void> {
    const definition = this.getSnapshot().open?.definition
    if (definition?.status !== 'ready' || definition.value.text === undefined || definition.value.truncated) return
    const result = await this.reads.api.writeClipboardText(definition.value.text)
    if (!result.ok) throw new Error(result.error)
  }

  close(): void {
    this.reads.release(this.requests, true)
    this.releaseRows()
    if (this.getSnapshot().open) this.publish({})
  }

  dispose(): void {
    if (this.disposed) return
    this.reads.release(this.requests, false)
    this.releaseRows()
    if (this.getSnapshot().open) this.publish({})
    this.disposed = true
    this.unsubscribeConnections()
    this.clearListeners()
  }

  protected load(node: ExplorerMenuNode, kind: PeekKind, source: PeekSource, fresh: boolean, carry: { readonly back?: readonly PeekStep[]; readonly tab?: PeekTab } = {}): void {
    if (node.ref.type !== 'object') return
    // A refresh asks for the same script again, so the one running is not worth keeping.
    this.reads.release(this.requests, !fresh)
    this.releaseRows()
    const id = ++this.next
    const requests: Requests = this.requests = {}
    // A row's own card opens on Definition; Back and Refresh keep the tab they had.
    const tab = carry.tab && peekTabsOf(kind).includes(carry.tab) ? carry.tab : 'definition'
    // Rows the row's card does not own (a followed dependency) still anchor at that row.
    const rowId = carry.back?.length ? carry.back[0]!.node.id : node.id
    this.publish({ open: { id, rowId, node, kind, source, facts: { status: 'loading' }, definition: { status: 'loading' }, tab, back: carry.back ?? [] } })
    this.reads.begin({ connectionId: node.connectionId, object: node.ref.object, kind }, fresh, requests, () => !this.disposed && this.getSnapshot().open?.id === id, change => {
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
    if (this.onLost === 'close') { this.close(); return }
    const gone = <T>(part: PeekPart<T> | undefined): PeekPart<T> | undefined => part && part.status === 'loading' ? { status: 'error', message: peekMessages.notConnected } : part
    const rows: PeekPart<PeekRows> | undefined = open.rows && { status: 'error', message: peekMessages.notConnected }
    this.publish({ open: { ...open, facts: gone(open.facts)!, definition: gone(open.definition)!, members: gone(open.members), dependencies: gone(open.dependencies), rows } })
  }

  /**
   * Reads the shown tab's part when this view has none or its read failed: the Columns or Parameters folder as the tree lists
   * it (its first `peekLimits.members` rows), the dependencies (apart from the properties, since a login may read those and
   * not sys.sql_expression_dependencies), or the top rows.
   */
  private loadTab(): void {
    const open = this.getSnapshot().open
    if (!open || open.node.ref.type !== 'object' || this.disposed || open.tab === 'definition') return
    const connectionId = open.node.connectionId, target = open.node.ref.object, subtype = open.node.subtype
    switch (open.tab) {
      case 'members': return this.loadPart(open, 'members', requestId => this.reads.api.explorerChildren({ connectionId, requestId,
        node: { type: 'folder', owner: target, folder: peekSpecs[open.kind].members }, ...(subtype === undefined ? {} : { subtype }), pageSize: peekLimits.members }),
        value => ({ nodes: value.nodes, more: value.cursor !== undefined }))
      case 'dependencies': return this.loadPart(open, 'dependencies', requestId => this.reads.api.explorerPeekDependencies({ connectionId, requestId, target }),
        value => ({ uses: value.uses, usesTruncated: !!value.usesTruncated, usedBy: value.usedBy, usedByTruncated: !!value.usedByTruncated }))
      case 'rows': return peekSpecs[open.kind].rows ? this.loadRows(open) : undefined
    }
  }

  private loadPart<K extends TabPart, R extends { readonly error?: ExplorerError }>(open: OpenPeek, key: K, request: (requestId: string) => Promise<ApiResult<R>>, value: (result: R) => PartValue<K>): void {
    if (open[key] && open[key].status !== 'error') return
    const id = open.id, requestId = this.reads.newId()
    const update = (part: PeekPart<PartValue<K>>) => { const now = this.getSnapshot().open; if (!this.disposed && now?.id === id) this.publish({ open: { ...now, [key]: part } }) }
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
    const update = (part: PeekPart<PeekRows>) => { const now = this.getSnapshot().open; if (!this.disposed && now?.id === id) this.publish({ open: { ...now, rows: part } }) }
    const object = open.node.ref.type === 'object' ? open.node.ref.object : undefined
    const results = this.reads.results
    if (!results || object?.database === undefined || object.schema === undefined || object.name === undefined) { update({ status: 'error', message: peekMessages.rowsUnavailable }); return }
    this.releaseRows()
    const api = this.reads.api, connectionId = open.node.connectionId, { database, schema, name } = object
    const run: RowsRun = { key: this.reads.newId(), queryId: this.reads.newId(), session: false }
    this.rowsRun = run
    update({ status: 'loading' })
    // The run's events are followed before the script is sent, as a query tab's are.
    results.begin(run.key, run.queryId)
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
  private readonly timers: NonNullable<PeekServiceOptions['timers']>

  constructor(private readonly options: PeekServiceOptions) {
    super(new PeekReads(options), 'close')
    this.timers = options.timers ?? { setTimeout: (callback, ms) => setTimeout(callback, ms), clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) }
  }

  /** Whether a node can be peeked: a table, view, procedure or function on a live server. */
  canPeek(node: ExplorerMenuNode | undefined): node is ExplorerMenuNode {
    return !!node && node.ref.type === 'object' && node.kind !== 'folder' && isPeekKind(node.kind) && !node.lost && this.reads.isLive(node.connectionId)
  }

  /** Opens the card on `node`, replacing any other; peeking the object already shown only changes how it was asked for. */
  peek(node: ExplorerMenuNode | undefined, source: PeekSource): void {
    this.cancelHover()
    if (this.disposed || !this.canPeek(node) || node.ref.type !== 'object') return
    const open = this.getSnapshot().open
    // A card that followed a dependency keeps its row's place but shows another object: peeking the row shows the row's own.
    if (open && open.rowId === node.id && open.node.connectionId === node.connectionId && sameObject(open.node, node)) {
      if (source !== 'hover' && open.source === 'hover') this.publish({ open: { ...open, source } })
      return
    }
    this.load(node, node.kind as PeekKind, source, false)
  }

  /** A view of a promoted tab's own, sharing the card's script cache. */
  createView(): PeekView { return new PeekView(this.reads, 'keep') }

  /** The pointer rests on a row with Ctrl (⌘ on macOS) held: the card opens after `peekLimits.hoverMs`. */
  hover(node: ExplorerMenuNode | undefined): void {
    if (!this.canPeek(node)) { this.cancelHover(); return }
    if (this.hoverRow === node.id) return
    this.cancelHover()
    // A card the keyboard or the menu opened has focus: a pointer passing over the tree with Ctrl held leaves it alone.
    const open = this.getSnapshot().open
    if (open && (open.rowId === node.id || open.source !== 'hover')) return
    this.hoverRow = node.id
    this.hoverTimer = this.timers.setTimeout(() => { this.hoverTimer = undefined; this.hoverRow = undefined; this.peek(node, 'hover') }, peekLimits.hoverMs)
  }

  /** The pointer left the row, or Ctrl (⌘) was released (the key dispatcher's `keyUp`): a card not yet open stays closed. */
  cancelHover(): void {
    if (this.hoverTimer !== undefined) this.timers.clearTimeout(this.hoverTimer)
    this.hoverTimer = undefined
    this.hoverRow = undefined
  }

  /** A key went up anywhere in the window: releasing the hover's modifier with the pointer still forgets the hover. */
  keyUp(key: string): void {
    if (key === (this.options.platform === 'darwin' ? 'Meta' : 'Control')) this.cancelHover()
  }

  /**
   * Reads `target`'s properties and definition for a caller other than a view (a Search Objects tab's details pane), sharing
   * the card's kept and background scripts. `update` gets each part as it arrives, until the reader is released.
   */
  read(target: PeekTarget, fresh: boolean, update: (change: PeekChange) => void): PeekReader {
    return this.disposed ? { release: () => {} } : this.reads.read(target, fresh, update)
  }

  override close(): void {
    this.cancelHover()
    super.close()
  }

  override dispose(): void {
    if (this.disposed) return
    this.cancelHover()
    super.dispose()
    this.reads.dispose()
  }
}

/** The tabs read apart from the properties by one request each, kept on the view under their own names. */
type TabPart = Exclude<PeekTab, 'definition' | 'rows'>
type PartValue<K extends TabPart> = NonNullable<OpenPeek[K]> extends PeekPart<infer V> ? V : never
const sameObject = (a: ExplorerMenuNode, b: ExplorerMenuNode) => a.ref.type === 'object' && b.ref.type === 'object' && a.kind === b.kind
  && a.ref.object.database === b.ref.object.database && a.ref.object.schema === b.ref.object.schema && a.ref.object.name === b.ref.object.name
/** A table's place in the cache: its connection and its three-part name. */
const scriptKey = (connectionId: string, object: { readonly database?: string; readonly schema?: string; readonly name?: string }) =>
  JSON.stringify([connectionId, object.database ?? null, object.schema ?? null, object.name ?? null])
/** Cancels are fire and forget: a failure is reported, never shown. */
const report = (result: Promise<ApiResult<unknown>>) => { void result.then(value => { if (!value.ok) onUnexpectedError(new Error(value.error)) }, onUnexpectedError) }
/** A request that throws (a lost IPC channel) settles as a failure value, as every other failure does. */
const settle = <T>(request: Promise<ApiResult<T>>): Promise<ApiResult<T>> => request.catch((error: unknown) => ({ ok: false as const, error: error instanceof Error ? error.message : String(error) }) as ApiResult<T>)
