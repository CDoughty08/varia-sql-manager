import { useSyncExternalStore } from 'react'
import { actionMenuState } from '../../../shared/actions/catalog.ts'
import { kindSpecs } from '../../../shared/explorer/catalog.ts'
import { insertTextFor } from '../../../shared/explorer/refs.ts'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import type { CommandArgs } from '../core/types'
import Icon from '../Icon'
import DocumentFrame, { type Verb } from '../kit/DocumentFrame'
import { selectionContextOf } from './ExplorerService'
import { PeekBody, peekName } from './PeekCard'
import { peekMessages } from './PeekService'

const unsubscribed = () => () => {}

/**
 * Peek promoted to a document tab: the card's body (PeekBody: the kind's tabs, from Definition to its lists, and
 * the properties) with the room of a tab, under a header with Refresh, Script As… and, for a kind that has one, the full
 * Properties dialog. Script As and Properties act on the tab's object, with the selection keys it stands in for the tree's.
 */
export default function PeekTab({ documentId }: { readonly documentId: string }) {
  const { peekTabs, connections } = useWorkbench()
  const view = useServiceSnapshot(peekTabs).views[documentId]
  const connectionList = useServiceSnapshot(connections)
  const open = useSyncExternalStore(view?.subscribe ?? unsubscribed, () => view?.getSnapshot().open)
  if (!view || !open) return null
  const node = open.node, connection = connectionList.find(item => item.id === node.connectionId)
  const object = node.ref.type === 'object' ? node.ref.object : undefined
  const args: CommandArgs = { target: { kind: 'explorer', node }, state: selectionContextOf(node, { insertable: insertTextFor(node.ref) !== undefined }) }
  const verbs: Verb[] = [{ command: 'peek.refresh', label: 'Refresh' }, { command: 'explorer.scriptAs', args, label: 'Script As…' },
    ...actionMenuState(node).properties !== '' ? [{ command: 'explorer.properties', args } satisfies Verb] : []]
  const server = connection?.displayName || connection?.server
  const crumbs = [{ label: server ?? peekMessages.notConnected }, ...object?.database === undefined ? [] : [{ label: object.database }]]
  const back = open.back.length > 0 && <button type="button" className="icon-button" aria-label="Back" title="Back" onClick={() => view.goBack()}><Icon name="arrow-left" /></button>
  return <DocumentFrame id={`peek-${documentId}`} title={peekName(open)} subtitle={kindSpecs[open.kind].title} crumbs={crumbs} tools={back || undefined} verbs={verbs}
    attributes={{ 'data-peek-tab': documentId }}>
    <div className="peek-view peek-tab-body"><PeekBody view={view} open={open} idPrefix={`peek-${documentId}`} /></div>
  </DocumentFrame>
}
