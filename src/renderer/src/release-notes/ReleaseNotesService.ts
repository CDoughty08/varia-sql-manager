import { releaseCategories, releaseVersionSchema } from '../../../shared/releases/schema'
import { releaseNotesFor } from '../../../shared/releases/catalog'
import { SnapshotStore } from '../core/store'
import type { Disposable } from '../core/types'
import { initialFrameState, type FrameState } from '../kit/document-frame'
import type { DocumentService } from '../services/documents'

export interface ReleaseNotesState { readonly documentId?: string; readonly version?: string; readonly frame: FrameState }
export const releaseSections = (version: string | undefined) => Object.entries(releaseCategories).filter(([category]) => releaseNotesFor(version)?.changes.some(change => change.category === category)).map(([id, title]) => ({ id, title }))

/** A single read-only tab. Its selection is explicit: an unknown future version never falls back to another release. */
export class ReleaseNotesService extends SnapshotStore<ReleaseNotesState> implements Disposable {
  private readonly registration: Disposable
  constructor(private readonly documents: Pick<DocumentService, 'registerProvider' | 'openCustom' | 'get' | 'activate'>, private readonly runningVersion: () => string, private readonly focus: (id: string) => void) {
    super({ frame: initialFrameState([]) })
    this.registration = documents.registerProvider({
      kind: 'releaseNotes', inSaveAll: false, saves: false, save: async () => false, canClose: () => undefined, revision: () => 0,
      follows: () => false, focus, closed: id => { if (this.getSnapshot().documentId === id) this.publish({ frame: initialFrameState([]) }) }
    })
  }
  open(requestedVersion?: string): void {
    const requested = requestedVersion ?? this.runningVersion()
    const version = requested ? releaseVersionSchema.parse(requested) : undefined
    let documentId = this.getSnapshot().documentId
    if (!documentId || !this.documents.get(documentId)) documentId = this.documents.openCustom('releaseNotes', 'Release Notes', undefined, '').id
    this.publish({ documentId, version, frame: initialFrameState(releaseSections(version)) })
    this.documents.activate(documentId)
    this.focus(documentId)
  }
  select(version: string): void { this.open(version) }
  setFrame(frame: FrameState): void { this.publish({ ...this.getSnapshot(), frame }) }
  dispose(): void { this.registration.dispose(); this.clearListeners() }
}
