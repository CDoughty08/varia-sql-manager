import { CustomDocumentTargets, type CustomDocumentTargetOptions } from '../services/custom-document-targets'
import { isPeekKind, type PeekTab } from '../../../shared/explorer/peek.ts'
import { displayText } from '../../../shared/explorer/refs.ts'
import { peekObjectName } from './peek-format'
import { onUnexpectedError } from '../core/errors'
import { SnapshotStore } from '../core/store'
import type { Disposable } from '../core/types'
import type { ExplorerMenuNode } from '../menus/targets'
import type { CustomDocumentProvider, DocumentService } from '../services/documents'
import type { PeekService, PeekView } from './PeekService'

export interface PeekTabSnapshot { readonly views: Readonly<Record<string, PeekView>> }
export interface PeekTabServiceOptions extends CustomDocumentTargetOptions {
  readonly peek: Pick<PeekService, 'createView' | 'canPeek'>
  readonly documents: Pick<DocumentService, 'openCustom' | 'registerProvider' | 'update' | 'get' | 'subscribe'>
  /** Connection metadata for the tab header. */
  readonly connections: { get(id: string): { readonly server: string } | undefined }
  readonly focus?: (id: string) => void
}

/** A promoted tab's name, as the card's header shows it: the object's schema and name, a child's below its parent's. */
export function peekTabName(node: ExplorerMenuNode): string {
  return node.ref.type === 'object' ? peekObjectName(node.ref.object) : displayText(node.label)
}

/**
 * Peek promoted to a document tab (Ctrl+click on a row, Ctrl+Enter, or the card's Open as Tab): the card's parts with more
 * room, Refresh, Script As and Properties. Each tab has a view of its own (`PeekService.createView`), which owns its reads and
 * its Top rows run, so closing the tab releases them; a tab has nothing to save and never reaches AutoRecover.
 */
export class PeekTabService extends SnapshotStore<PeekTabSnapshot> implements CustomDocumentProvider, Disposable {
  readonly kind = 'peek' as const
  readonly inSaveAll = false
  readonly saves = false
  private readonly watchers = new Map<string, () => void>()
  private readonly targetBindings: CustomDocumentTargets
  private readonly registration: Disposable
  private readonly unsubscribeDocuments: () => void
  private disposed = false

  constructor(private readonly o: PeekTabServiceOptions) {
    super({ views: {} })
    this.targetBindings = new CustomDocumentTargets(o)
    this.registration = o.documents.registerProvider(this)
    // Reconnect moves a following document to the new connection (DocumentService.update): its view moves with it.
    this.unsubscribeDocuments = o.documents.subscribe(() => {
      for (const [id, view] of Object.entries(this.getSnapshot().views)) {
        const connectionId = this.o.documents.get(id)?.connectionId
        if (this.targetBindings.matchesConnection(id, connectionId)) view.rebind(connectionId!)
        else view.detach()
      }
    })
  }

  /** Whether `node` can open in a tab: what the card can peek. */
  canOpen(node: ExplorerMenuNode | undefined): node is ExplorerMenuNode { return this.o.peek.canPeek(node) }

  /** Opens `node` in a new tab, active, on `tab` when its kind has it; resolves to the document's id. */
  open(node: ExplorerMenuNode | undefined, tab?: PeekTab): string | undefined {
    if (this.disposed || !this.canOpen(node) || node.ref.type !== 'object' || node.kind === 'folder' || !isPeekKind(node.kind)) return undefined
    const view = this.o.peek.createView()
    // A database's tab is in that database, as a query opened from it would be.
    const database = node.kind === 'database' ? node.ref.object.name ?? '' : node.ref.object.database ?? ''
    const document = this.o.documents.openCustom('peek', peekTabName(node), node.connectionId, database)
    this.targetBindings.bind(document.id, node.connectionId)
    this.publish({ views: { ...this.getSnapshot().views, [document.id]: view } })
    view.show(node, tab)
    // A followed dependency names the tab after the object it shows.
    let name = document.name
    this.watchers.set(document.id, view.subscribe(() => {
      const open = view.getSnapshot().open
      const next = open ? peekTabName(open.node) : name
      if (next === name || !this.o.documents.get(document.id)) return
      name = next
      try { this.o.documents.update(document.id, { name }) } catch (error) { onUnexpectedError(error) }
    }))
    return document.id
  }

  view(id: string): PeekView | undefined { return this.getSnapshot().views[id] }

  // --- CustomDocumentProvider ------------------------------------------------------------------------------------------
  save(): Promise<boolean> { return Promise.resolve(false) }
  canClose(): string | undefined { return undefined }
  revision(): number { return 0 }
  focus(id: string): void { this.o.focus?.(id) }
  /** Server names cannot prove account or settings identity. */
  follows(_id: string, _server: string): boolean { return false }
  canFollowTarget(id: string, targetId: string): boolean { return this.targetBindings.canFollowTarget(id, targetId) }
  coalesceTarget(id: string, fromTargetId: string, toTargetId: string): boolean { return this.targetBindings.coalesceTarget(id, fromTargetId, toTargetId) }
  closed(id: string): void {
    const view = this.view(id)
    if (!view) return
    this.watchers.get(id)?.()
    this.watchers.delete(id)
    this.targetBindings.forget(id)
    view.dispose()
    const { [id]: _closed, ...views } = this.getSnapshot().views
    this.publish({ views })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.targetBindings.clear()
    for (const unwatch of this.watchers.values()) unwatch()
    this.watchers.clear()
    this.unsubscribeDocuments()
    for (const view of Object.values(this.getSnapshot().views)) view.dispose()
    this.registration.dispose()
    this.clearListeners()
  }
}
