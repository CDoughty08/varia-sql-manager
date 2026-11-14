import type { VariaApi } from '../../../shared/contracts'
import type { ConnectionTargetService } from './connection-targets'
import type { DocumentService } from './documents'

/** Restore all document references before collecting hidden targets or releasing their main authentication pins. */
export function bindConnectionPruning({ registry, documents, api, ready }: {
  registry: ConnectionTargetService
  documents: Pick<DocumentService, 'getSnapshot' | 'subscribe'>
  api: Pick<VariaApi, 'pruneConnectionTargets'>
  ready: Promise<void>
}) {
  let restored = false, disposed = false, pruning = false
  const prune = () => {
    if (!restored || disposed || pruning || documents.getSnapshot().busy) return
    pruning = true
    try {
      const references = new Set(documents.getSnapshot().documents.flatMap(document => document.targetId ? [document.targetId] : []))
      const ids = registry.pruneUnreferenced(references)
      if (ids.length) void api.pruneConnectionTargets(ids).catch(() => {})
    } finally { pruning = false }
  }
  const stopTargets = registry.subscribe(prune), stopDocuments = documents.subscribe(prune)
  void ready.then(() => { if (!disposed) { restored = true; prune() } })
  return { dispose: () => { disposed = true; stopTargets(); stopDocuments() } }
}
