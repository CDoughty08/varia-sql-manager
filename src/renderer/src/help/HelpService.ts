import { guideMetadata, isGuideId, type GuideId } from '../../../shared/help/catalog'
import { SnapshotStore } from '../core/store'
import type { Disposable } from '../core/types'
import { initialFrameState, type FrameState } from '../kit/document-frame'
import type { DocumentService } from '../services/documents'

export type HelpRoute = { readonly kind: 'home' } | { readonly kind: 'guide'; readonly id: GuideId } | { readonly kind: 'missing' }
export interface HelpState { readonly documentId?: string; readonly route: HelpRoute; readonly search: string; readonly frame: FrameState }
const emptyState = (): HelpState => ({ route: { kind: 'home' }, search: '', frame: initialFrameState([]) })
export const helpRouteKey = (route: HelpRoute): string => route.kind === 'guide' ? route.id : route.kind

/** Window-local, read-only help. No recovery, model, SQL session or persisted reading history. */
export class HelpService extends SnapshotStore<HelpState> implements Disposable {
  private readonly registration: Disposable
  constructor(private readonly documents: Pick<DocumentService, 'registerProvider' | 'openCustom' | 'get' | 'activate'>, private readonly focus: (id: string) => void) {
    super(emptyState())
    this.registration = documents.registerProvider({
      kind: 'help', inSaveAll: false, saves: false, save: async () => false, canClose: () => undefined, revision: () => 0,
      follows: () => false, focus, closed: id => { if (this.getSnapshot().documentId === id) this.publish(emptyState()) }
    })
  }
  open(id?: string): void {
    const route: HelpRoute = id === undefined ? { kind: 'home' } : isGuideId(id) ? { kind: 'guide', id } : { kind: 'missing' }
    const before = this.getSnapshot()
    let documentId = before.documentId
    if (!documentId || !this.documents.get(documentId)) documentId = this.documents.openCustom('help', 'Getting Started', undefined, '').id
    const same = documentId === before.documentId && helpRouteKey(before.route) === helpRouteKey(route)
    this.publish({ documentId, route, search: same ? before.search : '', frame: same ? before.frame : initialFrameState(route.kind === 'guide' ? guideMetadata(route.id).sections : []) })
    this.documents.activate(documentId)
    this.focus(documentId)
  }
  search(search: string): void { this.publish({ ...this.getSnapshot(), search: search.slice(0, 200) }) }
  /** Lazy pages notify after mounting; the workbench callback checks current ownership and held focus. */
  ready(documentId: string): void { if (this.getSnapshot().documentId === documentId) this.focus(documentId) }
  setFrame(route: HelpRoute, frame: FrameState): void {
    if (helpRouteKey(route) === helpRouteKey(this.getSnapshot().route)) this.publish({ ...this.getSnapshot(), frame })
  }
  dispose(): void { this.registration.dispose(); this.clearListeners() }
}
