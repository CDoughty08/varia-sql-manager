import { memo, useEffect, useRef, type DragEvent, type FocusEvent, type KeyboardEvent, type MouseEvent, type ReactNode, type RefCallback, type SyntheticEvent } from 'react'
import { explorerLimits, folderSpecs, kindSpecs } from '../../../shared/explorer/catalog.ts'
import { displayText } from '../../../shared/explorer/refs.ts'
import { codiconClass } from '../../../shared/icons'
import Icon from '../Icon'
import { useConnectionAccent } from '../core/WorkbenchContext'
import { useCommandEnabled } from '../core/useCommand'
import ExplorerIcon, { type BadgeName } from './ExplorerIcon'
import { RowKind, type TreeNode } from './tree-model'

const numbers = new Intl.NumberFormat('en-US')

/** Row actions the tree carries out: selection, the chevron, and a lost server's buttons. */
export interface RowActions {
  select(rowId: number): void
  toggle(rowId: number): void
  reconnect(rowId: number): void
  remove(rowId: number): void
  /** Fills a drag's data with the row's insert text; false cancels the drag. */
  dragStart(rowId: number, transfer: DataTransfer): boolean
  /** The Rename box's Enter (`refocus`: focus returns to the tree) or blur; false keeps the box open (an invalid name). */
  commitRename(rowId: number, text: string, refocus: boolean): Promise<boolean>
  /** Escape in the Rename box, or the box going away: nothing is sent. */
  cancelRename(refocus: boolean): void
}
export interface RowProps {
  readonly rowId: number
  readonly kind: RowKind
  /** The row's offset from the top of the tree, in px (servers are taller than other rows). */
  readonly top: number
  readonly level: number
  readonly posinset: number
  readonly setsize: number
  /** The node, for node rows; its `rev` makes a changed node render again. */
  readonly node: TreeNode | undefined
  readonly rev: number
  /** A synthetic row's text, already through `displayText` (ExplorerService.rowText). */
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
  /** The label is the inline Rename box. */
  readonly renaming?: boolean
  /** The Filter loaded objects text (`filterText`), whose match in the label is highlighted. */
  readonly match?: string
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

/**
 * How many objects a listing folder holds, as its first page counted them (with any Filter Settings applied), without
 * its static subfolders; undefined for other rows and before the folder has loaded.
 */
export function itemCount(node: Pick<TreeNode, 'kind' | 'folder' | 'total' | 'staticCount'>): number | undefined {
  if (node.kind !== 'folder' || !node.folder || !folderSpecs[node.folder].list || node.total === undefined) return undefined
  return Math.max(0, node.total - node.staticCount)
}
const items = (value: number) => `${numbers.format(value)} item${value === 1 ? '' : 's'}`
/** A server's connection, as the dot at the end of its row shows it. */
export type ConnectionState = 'online' | 'error' | 'lost'
export const connectionState = (node: Pick<TreeNode, 'lost' | 'connectionError'>): ConnectionState => node.lost ? 'lost' : node.connectionError ? 'error' : 'online'
const connectionWords: Readonly<Record<ConnectionState, string>> = { online: 'Connected', error: 'Connection failed', lost: 'Connection lost' }

/** What the tooltip says after the name: kind and creation date, facts, item count, status, and any error. */
function tooltipFacts(node: TreeNode): string[] {
  const kind = node.kind === 'folder' ? undefined : [kindSpecs[node.kind].title, node.created && `Created ${node.created.replace('T', ' ')}`].filter(Boolean).join(' · ')
  const error = node.error ?? node.connectionError, count = itemCount(node)
  return [kind, node.detail && displayText(node.detail), count !== undefined && items(count), node.lost ? lostSentence : node.status && statusSentences[node.status],
    error && `Could not load: ${displayText(error.message)}`].filter((line): line is string => !!line)
}
/** The row's tooltip: name, kind and creation date, facts, status, and any error. */
export function rowTooltip(node: TreeNode): string {
  const name = node.lost ? `${node.label} (connection lost)` : node.sublabel ? `${node.label} ${node.sublabel}` : node.label
  return clip([displayText(name), ...tooltipFacts(node)].join('\n'))
}
/**
 * The row's accessible description: the tooltip without the name, which the accessible name already says (a title
 * alone would be the description, so screen readers would read the name twice).
 */
export function rowDescription(node: TreeNode): string | undefined {
  return clip(tooltipFacts(node).join('\n')) || undefined
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
    <button tabIndex={-1} disabled={!canReconnect} aria-label={'Reconnect ' + label} title="Reconnect…" onMouseDown={stop} onClick={() => actions.reconnect(rowId)}><Icon name="plug" /></button>
    <button tabIndex={-1} disabled={!canRemove} aria-label={'Remove ' + label} title="Remove" onMouseDown={stop} onClick={() => actions.remove(rowId)}><Icon name="close" /></button>
  </span>
}
function Accent({ color }: { color: string | undefined }) {
  const accent = useConnectionAccent(color)
  return accent ? <span className="oe-accent" style={{ background: accent }} /> : null
}

const stop = (event: SyntheticEvent) => event.stopPropagation()
/**
 * SSMS's inline Rename: the object's name without its schema, all selected. Enter commits, Escape cancels, and leaving
 * the box commits. Its keys, presses and clipboard events stay in the box, so the tree neither navigates nor copies the
 * node's name; a box whose row goes away (scrolled out, refreshed, removed) cancels without a request.
 */
function RenameBox({ rowId, name, title, actions }: { rowId: number; name: string; title: string; actions: RowActions }) {
  const input = useRef<HTMLInputElement>(null), settled = useRef(false)
  useEffect(() => {
    const element = input.current
    element?.focus()
    element?.select()
    // StrictMode replays this effect with the element still in the document; only a removed box cancels.
    return () => queueMicrotask(() => { if (!settled.current && !element?.isConnected) { settled.current = true; actions.cancelRename(false) } })
  }, [actions])
  const commit = async (refocus: boolean) => {
    if (settled.current) return
    settled.current = true
    if (!await actions.commitRename(rowId, input.current?.value ?? '', refocus)) { settled.current = false; input.current?.focus() }
  }
  // The box's own context menu (Cut, Paste…) takes focus without leaving the box; focus comes back when it closes.
  const blur = (event: FocusEvent<HTMLInputElement>) => { if (!(event.relatedTarget instanceof Element && event.relatedTarget.closest('.menu-layer'))) void commit(false) }
  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation()
    if (event.key === 'Enter') { event.preventDefault(); void commit(true) }
    else if (event.key === 'Escape') { event.preventDefault(); settled.current = true; actions.cancelRename(true) }
  }
  return <input ref={input} className="explorer-rename" maxLength={128} aria-label={'Rename ' + title} defaultValue={name} spellCheck={false} autoComplete="off"
    onKeyDown={keyDown} onBlur={blur} onMouseDown={stop} onDoubleClick={stop} onCopy={stop} onCut={stop} onPaste={stop} onDragStart={stop} />
}

/** The label, with the part that matches the Filter loaded objects box in bold. */
export function Label({ text, match }: { text: string; match: string | undefined }) {
  const shown = displayText(text), lower = shown.toLocaleLowerCase()
  // Only where lower-casing keeps the length, so offsets in the lower-cased text are the shown text's.
  const at = match && lower.length === shown.length ? lower.indexOf(match) : -1
  if (at < 0) return <bdi className="oe-label">{shown}</bdi>
  const end = at + match!.length
  return <bdi className="oe-label">{shown.slice(0, at)}<span className="oe-match">{shown.slice(at, end)}</span>{shown.slice(end)}</bdi>
}

/** The text after a node's label: a server's version and login in brief (its name keeps SSMS's full text), or a lost one's state. */
export const shownSublabel = (node: Pick<TreeNode, 'lost' | 'brief' | 'sublabel'>): string | undefined => node.lost ? '(connection lost)' : node.brief ?? node.sublabel

/**
 * The row's end, right-aligned and never shrunk: first the indicators later PRs add (`children`: E3's state chips, E2's
 * environment tag), then the item count and the connection dot, then `actions` (a lost server's buttons).
 */
export function RowEnd({ count, connection, children, actions }: { count?: number; connection?: ConnectionState; children?: ReactNode; actions?: ReactNode }) {
  return <span className="oe-end">
    {children}
    {count !== undefined && <span className="oe-count" aria-hidden="true">{numbers.format(count)}</span>}
    {connection && <span className="oe-dot" data-state={connection} title={connectionWords[connection]} aria-hidden="true" />}
    {actions}
  </span>
}

/** One windowed row of the tree: a node, or a loading, error, progress, stopped, capped, or paused row. */
function ExplorerRow({ rowId, kind, top, level, posinset, setsize, node, text, selected, draggable, active, color, actions, menuTarget, renaming, match }: RowProps) {
  const style = { transform: `translateY(${top}px)` }
  const indent = <span className="oe-indent" style={{ width: (level - 1) * explorerLimits.indent }} />
  const select = (event: MouseEvent) => { if (!(event.target as Element).closest('.oe-twistie')) actions.select(rowId) }
  if (kind !== RowKind.Node || !node) {
    // Loading rows do nothing; the capped row's Enter opens Filter Settings, so it is not announced as unavailable.
    const inert = kind === RowKind.Loading || kind === RowKind.More
    const tone = kind === RowKind.Error || kind === RowKind.MoreError ? ' error' : kind === RowKind.More || kind === RowKind.Loading ? ' progress' : ''
    const icon = kind === RowKind.Error || kind === RowKind.MoreError ? 'error' : kind === RowKind.Loading || kind === RowKind.More ? 'loading' : 'info'
    return <div ref={menuTarget} role="treeitem" id={`oe-${rowId}`} data-row-id={rowId} className={'explorer-row synthetic' + tone} aria-level={level} aria-selected={selected}
      aria-disabled={inert || undefined} aria-label={text} title={text} style={style} onMouseDown={select}>
      {indent}<span className="oe-twistie" /><span className="oe-icon" aria-hidden="true"><Icon name={icon} /></span><bdi className="oe-text">{text}</bdi>
    </div>
  }
  const expandable = node.hasChildren && !node.lost, folder = node.kind === 'folder', root = node.parent === 0
  const toggle = (event: MouseEvent) => { event.stopPropagation(); if (expandable) actions.toggle(rowId) }
  const dimmed = node.status === 'disabled' || node.status === 'unavailable' || node.status === 'noAccess' || node.lost
  const sublabel = shownSublabel(node)
  return <div ref={menuTarget} role="treeitem" id={`oe-${rowId}`} data-row-id={rowId}
    className={`explorer-row${folder ? ' folder' : ''}${root ? ' server' : ''}${node.lost ? ' lost' : ''}${active ? ' active-connection' : ''}${dimmed ? ' dimmed' : ''}`}
    aria-level={level} aria-setsize={setsize || undefined} aria-posinset={posinset || undefined} aria-expanded={expandable ? node.expanded : undefined} aria-selected={selected}
    aria-busy={node.load === 'loading' || undefined} aria-label={rowName(node)} aria-description={rowDescription(node)} title={rowTooltip(node)} style={style} draggable={(draggable && !renaming) || undefined}
    onMouseDown={select} onDoubleClick={() => { if (expandable) actions.toggle(rowId) }}
    onDragStart={draggable ? (event: DragEvent) => { if (!actions.dragStart(rowId, event.dataTransfer)) event.preventDefault() } : undefined}>
    {root && <Accent color={color} />}
    {indent}
    <span className={`oe-twistie${expandable ? ' ' + codiconClass(node.expanded ? 'chevron-down' : 'chevron-right') : ''}`} aria-hidden="true" onClick={toggle} />
    <ExplorerIcon name={folder && node.expanded ? 'folder-opened' : node.icon} folder={folder} badge={badgeOf(node)} />
    {renaming && node.ref.type === 'object' && node.kind !== 'folder'
      ? <RenameBox rowId={rowId} name={node.ref.object.name ?? ''} title={kindSpecs[node.kind].title} actions={actions} />
      : <Label text={node.label} match={match} />}
    {node.filtered && <span className="oe-filtered">(filtered)</span>}
    {sublabel && <span className="oe-sublabel">{displayText(sublabel)}</span>}
    <RowEnd count={itemCount(node)} connection={root ? connectionState(node) : undefined} actions={node.lost && <LostActions rowId={rowId} label={node.label} actions={actions} />} />
  </div>
}

export default memo(ExplorerRow)
