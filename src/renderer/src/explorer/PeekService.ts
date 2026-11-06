import type { ApiResult, VariaApi } from '../../../shared/contracts'
import { isPeekKind, peekLimits, peekSpecs, type PeekKind, type PeekResult } from '../../../shared/explorer/peek.ts'
import type { ScriptingOptions } from '../../../shared/scripting/options.ts'
import { onUnexpectedError } from '../core/errors'
import { SnapshotStore } from '../core/store'
import type { ExternalStore } from '../core/types'
import type { ExplorerMenuNode } from '../menus/targets'

/** How a peek was asked for: a hover opens the card without moving focus; the keyboard and the menu focus it. */
export type PeekSource = 'hover' | 'keyboard' | 'menu'
export type PeekPart<T> = { readonly status: 'loading' } | { readonly status: 'ready'; readonly value: T } | { readonly status: 'error'; readonly message: string }
export interface PeekDefinition { readonly text?: string; readonly truncated?: boolean }
export interface OpenPeek {
  /** Increments with every peek, so the card knows a new one from a refresh of the same. */
  readonly id: number
  readonly rowId: number
  readonly node: ExplorerMenuNode
  readonly kind: PeekKind
  readonly source: PeekSource
  readonly facts: PeekPart<PeekResult['facts']>
  readonly definition: PeekPart<PeekDefinition>
}
export interface PeekSnapshot { readonly open?: OpenPeek }

export interface PeekServiceOptions {
  readonly api: Pick<VariaApi, 'explorerPeek' | 'explorerCancel' | 'scriptObjects' | 'cancelScripting' | 'writeClipboardText'>
  readonly connections: ExternalStore<readonly { readonly id: string; readonly lost?: boolean }[]>
  /** Tools › Options › Scripting, which a table's CREATE script follows, as Script As does. */
  readonly scriptingOptions: ExternalStore<{ readonly options: ScriptingOptions }>
  readonly timers?: { setTimeout(callback: () => void, ms: number): unknown; clearTimeout(handle: unknown): void }
  readonly newId?: () => string
  /** Ctrl+hover peeks; on macOS ⌘+hover, as ⌘ is macOS's Ctrl. */
  readonly platform?: string
}

export const peekMessages = {
  notConnected: 'The server is not connected.',
  noDefinition: 'The definition is encrypted, or the login does not have VIEW DEFINITION permission on it.'
} as const

/**
 * Object Explorer's Peek: at most one card, on one object. It reads the object's properties (explorer.peek) and its
 * definition (a module's text comes with them; a table's from Script As CREATE), cancels both when the card closes or
 * another peek replaces it, and closes the card when its server disconnects.
 */
export class PeekService extends SnapshotStore<PeekSnapshot> {
  private next = 0
  private requests: { peek?: string; script?: string } = {}
  private hoverTimer: unknown
  private hoverRow: number | undefined
  private disposed = false
  private readonly timers: NonNullable<PeekServiceOptions['timers']>
  private readonly newId: () => string
  private readonly unsubscribe: () => void

  constructor(private readonly options: PeekServiceOptions) {
    super({})
    this.timers = options.timers ?? { setTimeout: (callback, ms) => setTimeout(callback, ms), clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) }
    this.newId = options.newId ?? (() => crypto.randomUUID())
    this.unsubscribe = options.connections.subscribe(() => {
      const open = this.getSnapshot().open
      if (open && !this.isLive(open.node.connectionId)) this.close()
    })
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
    if (open && open.rowId === node.id && open.node.connectionId === node.connectionId) {
      if (source !== 'hover' && open.source === 'hover') this.publish({ open: { ...open, source } })
      return
    }
    this.load(node, isPeekKindOf(node), source)
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

  /** Reads the open card's object again. */
  refresh(): void {
    const open = this.getSnapshot().open
    if (open) this.load(open.node, open.kind, open.source)
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
    this.cancelRequests()
    if (this.getSnapshot().open) this.publish({})
  }

  dispose(): void {
    if (this.disposed) return
    this.close()
    this.disposed = true
    this.unsubscribe()
    this.clearListeners()
  }

  private isLive(connectionId: string): boolean {
    return this.options.connections.getSnapshot().some(connection => connection.id === connectionId && !connection.lost)
  }

  private load(node: ExplorerMenuNode, kind: PeekKind, source: PeekSource): void {
    if (node.ref.type !== 'object') return
    this.cancelRequests()
    const id = ++this.next, object = node.ref.object, connectionId = node.connectionId
    const script = peekSpecs[kind].definition === 'script'
    const peekId = this.newId(), scriptId = script ? this.newId() : undefined
    this.requests = { peek: peekId, script: scriptId }
    this.publish({ open: { id, rowId: node.id, node, kind, source, facts: { status: 'loading' }, definition: { status: 'loading' } } })
    const current = () => !this.disposed && this.getSnapshot().open?.id === id
    const update = (change: Partial<Pick<OpenPeek, 'facts' | 'definition'>>) => { const open = this.getSnapshot().open; if (open && open.id === id) this.publish({ open: { ...open, ...change } }) }
    void settle(this.options.api.explorerPeek({ connectionId, requestId: peekId, target: object })).then(result => {
      if (!current()) return
      if (this.requests.peek === peekId) this.requests = { ...this.requests, peek: undefined }
      if (!result.ok) { update({ facts: { status: 'error', message: result.error }, ...(script ? {} : { definition: { status: 'error', message: result.error } }) }); return }
      const value = result.value
      if (value.error) { update({ facts: { status: 'error', message: value.error.message }, ...(script ? {} : { definition: { status: 'error', message: value.error.message } }) }); return }
      update({ facts: { status: 'ready', value: value.facts },
        ...(script ? {} : { definition: { status: 'ready', value: value.definition === undefined ? {} : { text: value.definition, ...(value.definitionTruncated ? { truncated: true } : {}) } } }) })
    }).catch(onUnexpectedError)
    if (!scriptId) return
    const options = this.options.scriptingOptions.getSnapshot().options
    void settle(this.options.api.scriptObjects({ connectionId, requestId: scriptId, targets: [object], verb: 'create', options })).then(result => {
      if (!current()) return
      if (this.requests.script === scriptId) this.requests = { ...this.requests, script: undefined }
      if (!result.ok) { update({ definition: { status: 'error', message: result.error } }); return }
      const value = result.value
      if (value.error) { update({ definition: { status: 'error', message: value.error.message } }); return }
      update({ definition: { status: 'ready', value: value.text === undefined ? {} : { text: value.text } } })
    }).catch(onUnexpectedError)
  }

  /** Requests still running are cancelled on the backend: their answers would be dropped anyway. */
  private cancelRequests(): void {
    const { peek, script } = this.requests
    this.requests = {}
    const report = (result: Promise<ApiResult<unknown>>) => { void result.then(value => { if (!value.ok) onUnexpectedError(new Error(value.error)) }, onUnexpectedError) }
    try {
      if (peek) report(this.options.api.explorerCancel([peek]))
      if (script) report(this.options.api.cancelScripting([script]))
    } catch (error) { onUnexpectedError(error) }
  }
}

const isPeekKindOf = (node: ExplorerMenuNode): PeekKind => node.kind as PeekKind
/** A request that throws (a lost IPC channel) settles as a failure value, as every other failure does. */
const settle = <T>(request: Promise<ApiResult<T>>): Promise<ApiResult<T>> => request.catch((error: unknown) => ({ ok: false as const, error: error instanceof Error ? error.message : String(error) }) as ApiResult<T>)
