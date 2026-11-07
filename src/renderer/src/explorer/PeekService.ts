import type { ApiResult, ExplorerError, ExplorerNode, VariaApi } from '../../../shared/contracts'
import { isPeekKind, peekLimits, peekSpecs, peekTabsOf, type PeekDependency, type PeekKind, type PeekResult, type PeekRowsResult, type PeekTab } from '../../../shared/explorer/peek.ts'
import type { ScriptingOptions } from '../../../shared/scripting/options.ts'
import { onUnexpectedError } from '../core/errors'
import { SnapshotStore } from '../core/store'
import type { ExternalStore } from '../core/types'
import type { ExplorerMenuNode } from '../menus/targets'

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
  readonly rows?: PeekPart<PeekRowsResult>
  /** The cards before this one, oldest first, when a dependency was followed. */
  readonly back: readonly PeekStep[]
}
export interface PeekSnapshot { readonly open?: OpenPeek }

export interface PeekServiceOptions {
  readonly api: Pick<VariaApi, 'explorerPeek' | 'explorerPeekDependencies' | 'explorerPeekRows' | 'explorerChildren' | 'explorerCancel' | 'scriptObjects' | 'cancelScripting' | 'writeClipboardText'>
  readonly connections: ExternalStore<readonly { readonly id: string; readonly lost?: boolean }[]>
  /** Tools › Options › Scripting, which a table's CREATE script follows, as Script As does. */
  readonly scriptingOptions: ExternalStore<{ readonly options: ScriptingOptions }>
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
  unreadCell: 'This value could not be read. The results grid shows it as NULL, with a warning.'
} as const

type ScriptReply = Awaited<ReturnType<VariaApi['scriptObjects']>>
/**
 * A table's finished CREATE script, good while the table's modified time is still `modified`, the scripting options are still
 * those it was made with, and it is younger than `peekLimits.scriptCacheMs`.
 */
interface CachedScript { readonly connectionId: string; readonly text: string; readonly modified: string; readonly optionsKey: string; readonly at: number }
/** A table's script request: the open card's, or one a replaced card left running so that its script can be cached. */
interface ScriptJob {
  readonly requestId: string
  readonly connectionId: string
  readonly key: string
  /** The scripting options it was asked with. */
  readonly optionsKey: string
  /** The card it answers, while one waits for it; a background job has none until a card takes it over. */
  deliver?: (result: ScriptReply) => void
  /** The table's modified time, from the peek's facts, once they are in. */
  modified?: string
  /** The script, when it came before the facts did. */
  text?: string
  done: boolean
}

/**
 * Object Explorer's Peek: at most one card, on one object. It reads the object's properties (explorer.peek) and its
 * definition (a module's text comes with them; a table's from Script As CREATE), and closes the card when its server
 * disconnects. A closed or replaced card cancels its reads, but a table's script whose modified time is known finishes in
 * the background (at most `peekLimits.backgroundScripts`), so that peeking the table again while it is unchanged takes the
 * script from the window's cache instead of starting another SMO job.
 */
export class PeekService extends SnapshotStore<PeekSnapshot> {
  private next = 0
  private requests: { peek?: string; script?: ScriptJob } & { [tab in TabPart]?: string } = {}
  private background: ScriptJob[] = []
  /** Least recently used first. */
  private readonly scripts = new Map<string, CachedScript>()
  private scriptChars = 0
  private hoverTimer: unknown
  private hoverRow: number | undefined
  private disposed = false
  private readonly timers: NonNullable<PeekServiceOptions['timers']>
  private readonly newId: () => string
  private readonly now: () => number
  private readonly unsubscribe: () => void

  constructor(private readonly options: PeekServiceOptions) {
    super({})
    this.timers = options.timers ?? { setTimeout: (callback, ms) => setTimeout(callback, ms), clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) }
    this.newId = options.newId ?? (() => crypto.randomUUID())
    this.now = options.now ?? Date.now
    const connections = options.connections.subscribe(() => {
      const open = this.getSnapshot().open
      if (open && !this.isLive(open.node.connectionId)) this.close()
      this.forget(connectionId => !this.isLive(connectionId))
    })
    // Scripts follow Tools > Options > Scripting: a change there (not to any other setting, which the store also announces)
    // makes every kept or background script stale.
    let optionsKey = this.optionsKey()
    const scripting = options.scriptingOptions.subscribe(() => {
      const next = this.optionsKey()
      if (next !== optionsKey) { optionsKey = next; this.forget(() => true) }
    })
    this.unsubscribe = () => { connections(); scripting() }
  }

  /** Whether a node can be peeked: a table, view, procedure or function on a live server. */
  canPeek(node: ExplorerMenuNode | undefined): node is ExplorerMenuNode {
    return !!node && node.ref.type === 'object' && node.kind !== 'folder' && isPeekKind(node.kind) && !node.lost && this.isLive(node.connectionId)
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
    this.load(node, isPeekKindOf(node), source, false)
  }

  /** Shows another tab of the open card, reading it the first time; choosing a tab whose read failed reads it again. */
  selectTab(tab: PeekTab): void {
    const open = this.getSnapshot().open
    if (!open || !peekTabsOf(open.kind).includes(tab)) return
    if (open.tab !== tab) this.publish({ open: { ...open, tab } })
    this.loadTab()
  }

  /** Whether a dependency can be peeked from the card: an object of a kind Peek describes, in the card's database. */
  canFollow(dependency: PeekDependency): boolean {
    return dependency.kind !== undefined && isPeekKind(dependency.kind) && dependency.database === undefined && dependency.server === undefined && dependency.schema !== undefined
  }

  /** Peeks a dependency in the same card, beside the same row; Back returns to this one. */
  follow(dependency: PeekDependency): void {
    const open = this.getSnapshot().open
    if (!open || open.node.ref.type !== 'object' || !this.canFollow(dependency) || !dependency.kind || !isPeekKind(dependency.kind)) return
    const object = { kind: dependency.kind, ...(open.node.ref.object.database === undefined ? {} : { database: open.node.ref.object.database }), schema: dependency.schema!, name: dependency.name }
    const { subtype: _subtype, status: _status, database: _database, listedAt: _listedAt, filtered: _filtered, insertable: _insertable, ...rest } = open.node
    const node: ExplorerMenuNode = { ...rest, kind: dependency.kind, ref: { type: 'object', object }, label: `${dependency.schema}.${dependency.name}` }
    const back = [...open.back, { node: open.node, kind: open.kind, tab: open.tab }].slice(-peekLimits.backSteps)
    this.load(node, dependency.kind, open.source === 'hover' ? 'keyboard' : open.source, false, { back })
  }

  /** Returns to the card a dependency was followed from, on the tab it showed. */
  goBack(): void {
    const open = this.getSnapshot().open
    const step = open?.back[open.back.length - 1]
    if (!open || !step) return
    this.load(step.node, step.kind, open.source, false, { back: open.back.slice(0, -1), tab: step.tab })
  }

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

  /** Reads the open card's object again, its script included: Refresh never takes a kept script. */
  refresh(): void {
    const open = this.getSnapshot().open
    if (open) this.load(open.node, open.kind, open.source, true, { back: open.back, tab: open.tab })
  }

  /** Copies the open card's definition, once it has all of it: a cut module is copied whole by Script to New Query. */
  async copyDefinition(): Promise<void> {
    const definition = this.getSnapshot().open?.definition
    if (definition?.status !== 'ready' || definition.value.text === undefined || definition.value.truncated) return
    const result = await this.options.api.writeClipboardText(definition.value.text)
    if (!result.ok) throw new Error(result.error)
  }

  close(): void {
    this.cancelHover()
    this.release(true)
    if (this.getSnapshot().open) this.publish({})
  }

  dispose(): void {
    if (this.disposed) return
    this.cancelHover()
    this.release(false)
    this.forget(() => true)
    if (this.getSnapshot().open) this.publish({})
    this.disposed = true
    this.unsubscribe()
    this.clearListeners()
  }

  private isLive(connectionId: string): boolean {
    return this.options.connections.getSnapshot().some(connection => connection.id === connectionId && !connection.lost)
  }

  private load(node: ExplorerMenuNode, kind: PeekKind, source: PeekSource, fresh: boolean, carry: { readonly back?: readonly PeekStep[]; readonly tab?: PeekTab } = {}): void {
    if (node.ref.type !== 'object') return
    // A refresh asks for the same script again, so the one running is not worth keeping.
    this.release(!fresh)
    const id = ++this.next, object = node.ref.object, connectionId = node.connectionId
    const key = peekSpecs[kind].definition === 'script' ? scriptKey(connectionId, object) : undefined
    const cached = key === undefined || fresh ? undefined : this.kept(key)
    const peekId = this.newId()
    this.requests = { peek: peekId }
    // A row's own card opens on Definition; Back and Refresh keep the tab they had.
    const tab = carry.tab && peekTabsOf(kind).includes(carry.tab) ? carry.tab : 'definition'
    // Rows the row's card does not own (a followed dependency) still anchor at that row.
    const rowId = carry.back?.length ? carry.back[0]!.node.id : node.id
    this.publish({ open: { id, rowId, node, kind, source, facts: { status: 'loading' }, definition: { status: 'loading' }, tab, back: carry.back ?? [] } })
    this.loadTab()
    const current = () => !this.disposed && this.getSnapshot().open?.id === id
    const update = (change: Partial<Pick<OpenPeek, 'facts' | 'definition'>>) => { const open = this.getSnapshot().open; if (open && open.id === id) this.publish({ open: { ...open, ...change } }) }
    const deliver = (result: ScriptReply) => {
      if (!current()) return
      if (!result.ok) { update({ definition: { status: 'error', message: result.error } }); return }
      const value = result.value
      if (value.error) { update({ definition: { status: 'error', message: value.error.message } }); return }
      update({ definition: { status: 'ready', value: value.text === undefined ? {} : { text: value.text } } })
    }
    const startScript = (key: string, modified?: string): ScriptJob => {
      const options = this.options.scriptingOptions.getSnapshot().options
      const job: ScriptJob = { requestId: this.newId(), connectionId, key, optionsKey: JSON.stringify(options), deliver, ...(modified === undefined ? {} : { modified }), done: false }
      this.requests = { ...this.requests, script: job }
      void settle(this.options.api.scriptObjects({ connectionId, requestId: job.requestId, targets: [object], verb: 'create', options })).then(result => {
        job.done = true
        this.background = this.background.filter(other => other !== job)
        if (this.requests.script === job) this.requests = { ...this.requests, script: undefined }
        if (result.ok && !result.value.error && result.value.text !== undefined) {
          if (job.modified === undefined) job.text = result.value.text
          else this.keep(job, result.value.text)
        }
        job.deliver?.(result)
      }).catch(onUnexpectedError)
      return job
    }
    // A replaced card's script for this table, still running, answers this card instead of a second SMO job.
    const adopt = (key: string): ScriptJob | undefined => {
      const job = this.background.find(other => other.key === key && !other.done && other.optionsKey === this.optionsKey())
      if (!job) return undefined
      this.background = this.background.filter(other => other !== job)
      job.deliver = deliver
      this.requests = { ...this.requests, script: job }
      return job
    }
    // Without a kept script the table is scripted at once (or by the script already running for it); with one, the facts'
    // modified time says whether it still holds.
    let job = key === undefined || cached ? undefined : (fresh ? undefined : adopt(key)) ?? startScript(key)
    void settle(this.options.api.explorerPeek({ connectionId, requestId: peekId, target: object })).then(result => {
      if (!current()) return
      if (this.requests.peek === peekId) this.requests = { ...this.requests, peek: undefined }
      if (!result.ok || result.value.error) {
        const message = result.ok ? result.value.error?.message ?? '' : result.error
        update({ facts: { status: 'error', message }, ...(key === undefined ? { definition: { status: 'error', message } } : {}) })
        // A kept script cannot be checked without the facts, so the table is scripted again.
        if (key !== undefined && cached) startScript(key)
        return
      }
      const value = result.value, modified = typeof value.facts.modified === 'string' ? value.facts.modified : undefined
      update({ facts: { status: 'ready', value: value.facts },
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
        update({ definition: { status: 'ready', value: { text: cached.text } } })
      } else startScript(key, modified)
    }).catch(onUnexpectedError)
  }

  /**
   * Reads the shown tab's part when this card has none or its read failed: the Columns or Parameters folder as the tree lists
   * it (its first `peekLimits.members` rows), the dependencies (apart from the properties, since a login may read those and
   * not sys.sql_expression_dependencies), or the top rows.
   */
  private loadTab(): void {
    const open = this.getSnapshot().open
    if (!open || open.node.ref.type !== 'object' || this.disposed || open.tab === 'definition') return
    const connectionId = open.node.connectionId, target = open.node.ref.object, subtype = open.node.subtype
    switch (open.tab) {
      case 'members': return this.loadPart(open, 'members', requestId => this.options.api.explorerChildren({ connectionId, requestId,
        node: { type: 'folder', owner: target, folder: peekSpecs[open.kind].members }, ...(subtype === undefined ? {} : { subtype }), pageSize: peekLimits.members }),
        value => ({ nodes: value.nodes, more: value.cursor !== undefined }))
      case 'dependencies': return this.loadPart(open, 'dependencies', requestId => this.options.api.explorerPeekDependencies({ connectionId, requestId, target }),
        value => ({ uses: value.uses, usesTruncated: !!value.usesTruncated, usedBy: value.usedBy, usedByTruncated: !!value.usedByTruncated }))
      case 'rows': return peekSpecs[open.kind].rows ? this.loadPart(open, 'rows', requestId => this.options.api.explorerPeekRows({ connectionId, requestId, target }), value => value) : undefined
    }
  }

  private loadPart<K extends TabPart, R extends { readonly error?: ExplorerError }>(open: OpenPeek, key: K, request: (requestId: string) => Promise<ApiResult<R>>, value: (result: R) => PartValue<K>): void {
    if (open[key] && open[key].status !== 'error') return
    const id = open.id, requestId = this.newId()
    const update = (part: PeekPart<PartValue<K>>) => { const now = this.getSnapshot().open; if (!this.disposed && now?.id === id) this.publish({ open: { ...now, [key]: part } }) }
    this.requests = { ...this.requests, [key]: requestId }
    update({ status: 'loading' })
    void settle(request(requestId)).then(result => {
      if (this.requests[key] !== requestId) return
      this.requests = { ...this.requests, [key]: undefined }
      if (!result.ok || result.value.error) update({ status: 'error', message: result.ok ? result.value.error?.message ?? '' : result.error })
      else update({ status: 'ready', value: value(result.value) })
    }).catch(onUnexpectedError)
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

  /**
   * The card's reads end: the properties read is cancelled, and so is the table's script unless `keep` and the facts gave
   * its modified time, when it finishes in the background to be cached (the oldest background script gives way past the limit).
   */
  private release(keep: boolean): void {
    const { peek, script, members, dependencies, rows } = this.requests
    this.requests = {}
    try {
      const reads = [peek, members, dependencies, rows].filter((request): request is string => request !== undefined)
      if (reads.length) report(this.options.api.explorerCancel(reads))
      if (!script || script.done) return
      if (!keep || script.modified === undefined) { this.cancelScript(script); return }
      script.deliver = undefined
      this.background.push(script)
      while (this.background.length > peekLimits.backgroundScripts) this.cancelScript(this.background.shift()!)
    } catch (error) { onUnexpectedError(error) }
  }

  private cancelScript(job: ScriptJob): void {
    if (job.done) return
    try { report(this.options.api.cancelScripting([job.requestId])) } catch (error) { onUnexpectedError(error) }
  }
}

const isPeekKindOf = (node: ExplorerMenuNode): PeekKind => node.kind as PeekKind
/** The tabs read apart from the properties, each kept on the card under its own name. */
type TabPart = Exclude<PeekTab, 'definition'>
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
