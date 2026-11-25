import { useSyncExternalStore } from 'react'
import { actionMenuState } from '../../../shared/actions/catalog.ts'
import { insertTextFor } from '../../../shared/explorer/refs.ts'
import type { CommandArgs } from '../core/types'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import Icon from '../Icon'
import type { Verb } from '../kit/DocumentFrame'
import { selectionContextOf } from './ExplorerService'
import { peekCrumbs } from './peek-inspector'
import { PeekBody } from './PeekCard'
import { peekMessages } from './PeekService'

const unsubscribed = () => () => {}

/**
 * Peek promoted to a document tab: renders the unified `ObjectInspectorFrame` (`surface="full"`) with Hero KPIs,
 * breadcrumbs, Back, Refresh, Script As… and, for a kind that has one, Properties, plus the separate `full` Vitals rail.
 * Script As and Properties act on the tab's object, with the selection keys it stands in for the tree's.
 */
export default function PeekTab({ documentId }: { readonly documentId: string }) {
  const { peekTabs, connections } = useWorkbench()
  const view = useServiceSnapshot(peekTabs).views[documentId]
  const connectionList = useServiceSnapshot(connections)
  const open = useSyncExternalStore(view?.subscribe ?? unsubscribed, () => view?.getSnapshot().open)
  if (!view || !open) return null
  const node = open.node, connection = connectionList.find(item => item.id === node.connectionId)
  const args: CommandArgs = { target: { kind: 'explorer', node }, state: selectionContextOf(node, { insertable: insertTextFor(node.ref) !== undefined }) }
  const verbs: Verb[] = [{ command: 'peek.refresh', label: 'Refresh' }, { command: 'explorer.scriptAs', args, label: 'Script As…' },
    ...actionMenuState(node).properties !== '' ? [{ command: 'explorer.properties', args } satisfies Verb] : []]
  const server = connection?.displayName || connection?.server || peekMessages.notConnected
  const crumbs = peekCrumbs(open, server)
  const back = open.back.length > 0 && <button type="button" className="icon-button" aria-label="Back" title="Back" onClick={() => view.goBack()}><Icon name="arrow-left" /></button>
  return <PeekBody
    view={view}
    open={open}
    idPrefix={`peek-${documentId}`}
    surface="full"
    crumbs={crumbs}
    tools={back || undefined}
    verbs={verbs}
    attributes={{ 'data-peek-tab': documentId }}
    inEditorPane
  />
}
