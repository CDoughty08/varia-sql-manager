import { memo, type DragEvent, type MouseEvent, type RefCallback } from 'react'
import { explorerLimits, kindSpecs } from '../../../shared/explorer/catalog.ts'
import { displayText } from '../../../shared/explorer/refs.ts'
import { useConnectionAccent } from '../core/WorkbenchContext'
import { useCommandEnabled } from '../core/useCommand'
import ExplorerIcon, { type BadgeName } from './ExplorerIcon'
import { RowKind, type TreeNode } from './tree-model'

/** Row actions the tree carries out: selection, the chevron, and a lost server's buttons. */
export interface RowActions {
  select(rowId: number): void
  toggle(rowId: number): void
  reconnect(rowId: number): void
  remove(rowId: number): void
  /** Fills a drag's data with the row's insert text; false cancels the drag. */
  dragStart(rowId: number, transfer: DataTransfer): boolean
}
export interface RowProps {
  readonly rowId: number
  readonly kind: RowKind
  readonly index: number
  readonly level: number
  readonly posinset: number
  readonly setsize: number
  /** The node, for node rows; its `rev` makes a changed node render again. */
  readonly node: TreeNode | undefined
  readonly rev: number
  /** A synthetic row's text. */
  readonly text: string
  readonly selected: boolean
  /** The row has a name to drag into a query. */
  readonly draggable: boolean
  /** The server of the active query. */
  readonly active: boolean
  /** The connection's color, for a server row. */
  readonly color: string | undefined
  readonly actions: RowActions
  readonly menuTarget: RefCallback<HTMLDivElement>
}

const statusWords = { disabled: ', disabled', unavailable: ', unavailable', noAccess: ', no access', readOnly: '' } as const
const statusSentences = {
  disabled: 'It is disabled.',
  unavailable: 'The database is not available. Bring it online, then refresh Databases.',
  noAccess: 'The current login cannot open this database.',
  readOnly: ''
} as const
const lostSentence = 'The connection was lost when the SQL backend restarted. Reconnect, or remove the server.'
const clip = (text: string) => text.length > explorerLimits.detail ? text.slice(0, explorerLimits.detail - 1) + '…' : text

/** The row's tooltip: name, kind and creation date, facts, status, and any error. */
export function rowTooltip(node: TreeNode): string {
  const name = node.lost ? `${node.label} (connection lost)` : node.sublabel ? `${node.label} ${node.sublabel}` : node.label
  const kind = node.kind === 'folder' ? undefined : [kindSpecs[node.kind].title, node.created && `Created ${node.created.replace('T', ' ')}`].filter(Boolean).join(' · ')
  const error = node.error ?? node.connectionError
  return clip([displayText(name), kind, node.detail && displayText(node.detail), node.lost ? lostSentence : node.status && statusSentences[node.status], error && `Could not load: ${error.message}`].filter(Boolean).join('\n'))
}
/** The row's accessible name: the label and sublabel as shown, then its state. */
export function rowName(node: TreeNode): string {
  const sublabel = node.lost ? '(connection lost)' : node.sublabel
  const state = node.load === 'error' || node.more === 'error' || node.connectionError ? ', could not load' : node.status ? statusWords[node.status] : ''
  return `${displayText(node.label)}${node.filtered ? ' (filtered)' : ''}${sublabel ? ' ' + displayText(sublabel) : ''}${state}`
}
function badgeOf(node: TreeNode): BadgeName | undefined {
  if (node.lost) return 'lost'
  if (node.load === 'error' || node.more === 'error' || node.connectionError) return 'error'
  if (node.showLoading) return 'loading'
  return node.status === 'readOnly' ? undefined : node.status
}

/** A lost server's Reconnect… and Remove buttons; the tree keeps its one tab stop, so they are not tabbable (Enter and the menu are). */
function LostActions({ rowId, label, actions }: { rowId: number; label: string; actions: RowActions }) {
  const canReconnect = useCommandEnabled('connection.reconnect'), canRemove = useCommandEnabled('connection.removeLost')
  const stop = (event: MouseEvent) => event.stopPropagation()
  return <span className="oe-actions">
    <button tabIndex={-1} disabled={!canReconnect} aria-label={'Reconnect ' + label} title="Reconnect…" onMouseDown={stop} onClick={() => actions.reconnect(rowId)}><span className="codicon codicon-plug" aria-hidden="true" /></button>
    <button tabIndex={-1} disabled={!canRemove} aria-label={'Remove ' + label} title="Remove" onMouseDown={stop} onClick={() => actions.remove(rowId)}><span className="codicon codicon-close" aria-hidden="true" /></button>
  </span>
}
function Accent({ color }: { color: string | undefined }) {
  const accent = useConnectionAccent(color)
  return accent ? <span className="oe-accent" style={{ background: accent }} /> : null
}

/** One windowed row of the tree: a node, or a loading, error, progress, stopped, capped, or paused row. */
function ExplorerRow({ rowId, kind, index, level, posinset, setsize, node, text, selected, draggable, active, color, actions, menuTarget }: RowProps) {
  const style = { transform: `translateY(${index * explorerLimits.rowHeight}px)` }
  const indent = <span className="oe-indent" style={{ width: (level - 1) * explorerLimits.indent }} />
  const select = (event: MouseEvent) => { if (!(event.target as Element).closest('.oe-twistie')) actions.select(rowId) }
  if (kind !== RowKind.Node || !node) {
    const inert = kind === RowKind.Loading || kind === RowKind.More || kind === RowKind.Capped
    const tone = kind === RowKind.Error || kind === RowKind.MoreError ? ' error' : kind === RowKind.More || kind === RowKind.Loading ? ' progress' : ''
    const icon = kind === RowKind.Error || kind === RowKind.MoreError ? 'error' : kind === RowKind.Loading || kind === RowKind.More ? 'loading' : 'info'
    return <div ref={menuTarget} role="treeitem" id={`oe-${rowId}`} data-row-id={rowId} className={'explorer-row synthetic' + tone} aria-level={level} aria-selected={selected}
      aria-disabled={inert || undefined} aria-label={text} title={text} style={style} onMouseDown={select}>
      {indent}<span className="oe-twistie" /><span className="oe-icon" aria-hidden="true"><span className={`codicon codicon-${icon}`} /></span><span className="oe-text">{text}</span>
    </div>
  }
  const expandable = node.hasChildren && !node.lost, folder = node.kind === 'folder', root = node.parent === 0
  const toggle = (event: MouseEvent) => { event.stopPropagation(); if (expandable) actions.toggle(rowId) }
  const dimmed = node.status === 'disabled' || node.status === 'unavailable' || node.status === 'noAccess' || node.lost
  return <div ref={menuTarget} role="treeitem" id={`oe-${rowId}`} data-row-id={rowId}
    className={`explorer-row${folder ? ' folder' : ''}${root ? ' server' : ''}${node.lost ? ' lost' : ''}${active ? ' active-connection' : ''}${dimmed ? ' dimmed' : ''}`}
    aria-level={level} aria-setsize={setsize || undefined} aria-posinset={posinset || undefined} aria-expanded={expandable ? node.expanded : undefined} aria-selected={selected}
    aria-busy={node.load === 'loading' || undefined} aria-label={rowName(node)} title={rowTooltip(node)} style={style} draggable={draggable || undefined}
    onMouseDown={select} onDoubleClick={() => { if (expandable) actions.toggle(rowId) }}
    onDragStart={draggable ? (event: DragEvent) => { if (!actions.dragStart(rowId, event.dataTransfer)) event.preventDefault() } : undefined}>
    {root && <Accent color={color} />}
    {indent}
    <span className={`oe-twistie${expandable ? ` codicon codicon-chevron-${node.expanded ? 'down' : 'right'}` : ''}`} aria-hidden="true" onClick={toggle} />
    <ExplorerIcon name={folder && node.expanded ? 'folder-opened' : node.icon} folder={folder} badge={badgeOf(node)} />
    <bdi className="oe-label">{displayText(node.label)}</bdi>
    {node.filtered && <span className="oe-filtered">(filtered)</span>}
    {node.lost ? <span className="oe-sublabel">(connection lost)</span> : node.sublabel && <span className="oe-sublabel">{displayText(node.sublabel)}</span>}
    {node.lost && <LostActions rowId={rowId} label={node.label} actions={actions} />}
  </div>
}

export default memo(ExplorerRow)
