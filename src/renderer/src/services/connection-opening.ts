import type { ConnectionOptions } from '../../../shared/contracts'
import { changedConnectionDetails, type ConnectionDetailField, type ConnectionDetails } from '../../../shared/connection-targets'
import { detailsOf, type ConnectionAssociationHandoff, type ConnectionAttempt, type ConnectionService, type LiveConnection, type TargetConnectionInfo } from './connections'
import type { ConnectionCompletion } from './connection-targets'
import { isQueryDocument } from '../documents'
import type { DocumentService } from './documents'
import type { TargetService } from './targets'
import type { QueryService } from './queries'

export interface OpenedConnection {
  readonly association?: ConnectionAssociationHandoff
  readonly id: string
  readonly targetId?: string
  readonly generation: number
  readonly bindingRevision: number
  readonly previousId?: string
  readonly sourceTargetId?: string
  readonly reused: boolean
  readonly current: ConnectionDetails
  readonly selected: ConnectionDetails
}

/** Waiting happens outside document tasks: close captures must refuse an unfinished association, never wait on it. */
export async function whenConnectionDocumentsIdle(documents: Pick<DocumentService, 'getSnapshot' | 'subscribe'>, signal: AbortSignal): Promise<boolean> {
  while (!signal.aborted && documents.getSnapshot().busy) {
    const ready = await new Promise<boolean>(resolve => {
      const finish = (ready: boolean) => { stop(); signal.removeEventListener('abort', abort); resolve(ready) }
      const abort = () => finish(false)
      const stop = documents.subscribe(() => { if (!documents.getSnapshot().busy) finish(!signal.aborted) })
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) finish(false)
      else if (!documents.getSnapshot().busy) finish(true)
    })
    // An earlier file waiter can start its next task before this continuation resumes.
    if (!ready) return false
  }
  return !signal.aborted
}

/** A successful main receipt is the sole equivalence evidence. Never compare profile keys or submitted settings here. */
export function adoptConnection(connections: ConnectionService, info: TargetConnectionInfo, options: ConnectionOptions, selected = detailsOf(options), attempt?: ConnectionAttempt, rejected?: (completion: ConnectionCompletion) => void): OpenedConnection | undefined {
  if (!info.targetId || !info.authentication) return undefined
  const authoritativeTarget = info.targetId
  const previous = connections.get(authoritativeTarget)
  const current = previous ? connections.details(previous.id)! : selected
  const result = connections.accept(info, options, authoritativeTarget, info.authentication, attempt)
  if (result.status !== 'accepted' && result.status !== 'already-current') { if (attempt) connections.failAttempt(attempt); rejected?.(result); return undefined }
  const connection = connections.get(authoritativeTarget)
  if (!connection || !connections.isLive(connection.id)) return undefined
  const reused = !!previous && !(attempt?.created && previous.targetId === attempt.operation.targetId)
  if (!reused) connections.setDetails(connection.id, selected)
  return { id: connection.id, targetId: connection.targetId, generation: connection.generation, bindingRevision: connections.bindingRevision(connection), previousId: reused ? previous?.id : undefined, sourceTargetId: attempt?.operation.targetId, reused, current, selected }
}

/** Labels the user changed in Connect, and only those, for a reused connection: its other labels (a connection-only
 *  environment) stay. A new connection already has every selected detail. */
export function withChangedDetails(opened: OpenedConnection, fields: readonly ConnectionDetailField[]): OpenedConnection {
  if (!opened.reused) return opened
  return { ...opened, selected: { ...opened.current, ...Object.fromEntries(fields.map(field => [field, opened.selected[field]])) } }
}

export function needsDetailsConfirmation(opened: OpenedConnection): boolean {
  return opened.reused && changedConnectionDetails(opened.current, opened.selected).length > 0
}

/** A dialog may outlive a disconnect, removal, backend loss or replacement connect. None may resurrect its target. */
/** While its details review is open, a close or reload going ahead cancels it as Cancel would, then `hide`s the dialog. */
export function yieldReviewToClose(opened: OpenedConnection, hide: () => void): () => void {
  return opened.association?.yieldTo(() => { opened.association?.abandon(true); hide() }) ?? (() => {})
}
export function finishConnectionDetails(connections: ConnectionService, opened: OpenedConnection, choice: 'selected' | 'current' | 'cancel'): LiveConnection | undefined {
  if (choice === 'cancel') return undefined
  const connection = connections.get(opened.targetId ?? opened.id)
  if (!connection || !connections.isLive(connection.id) || connection.inExplorer === false || connection.id !== opened.id || connection.generation !== opened.generation) return undefined
  if (connections.bindingRevision(connection) !== opened.bindingRevision) return undefined
  if (changedConnectionDetails(connections.details(connection.id)!, opened.current).length && opened.reused) return undefined
  if (choice === 'selected') connections.setDetails(connection.id, opened.selected)
  return connections.get(connection.id)
}

/** Only the query whose explicit Execute opened Connect may run after the accepted connection is ready. */
export async function executePendingQuery({ tabId, opened, connections, documents, targets, queries }: {
  tabId: string
  opened: OpenedConnection
  connections: Pick<ConnectionService, 'get' | 'isLive' | 'bindingRevision'>
  documents: Pick<DocumentService, 'get' | 'getSnapshot'>
  targets: Pick<TargetService, 'changeConnection'>
  queries: Pick<QueryService, 'isRunning' | 'execute'>
}): Promise<void> {
  const accepted = connections.get(opened.targetId ?? opened.id), waiting = documents.get(tabId)
  if (accepted?.id !== opened.id || accepted.generation !== opened.generation || !connections.isLive(opened.id)) return
  if (connections.bindingRevision(accepted) !== opened.bindingRevision) return
  if (!waiting || !isQueryDocument(waiting) || documents.getSnapshot().busy || queries.isRunning(tabId)) return
  if (waiting.connectionId !== opened.id) {
    // A different explicit connection made while the picker was open must never be silently replaced.
    if (connections.isLive(waiting.connectionId ?? '')) return
    await targets.changeConnection(tabId, opened.id)
  }
  const attached = documents.get(tabId), connection = connections.get(opened.targetId ?? opened.id)
  if (attached?.connectionId === opened.id && attached.targetId === opened.targetId && attached.attachWanted
    && connection?.id === opened.id && connection.generation === opened.generation && connections.isLive(opened.id)
    && connections.bindingRevision(connection) === opened.bindingRevision
    && !documents.getSnapshot().busy && !queries.isRunning(tabId)) void queries.execute(tabId)
}
