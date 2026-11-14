import { memo, useEffect, useRef, type DragEvent, type FocusEvent, type KeyboardEvent, type MouseEvent, type ReactNode, type RefCallback, type SyntheticEvent } from 'react'
import { explorerLimits, folderSpecs, kindSpecs } from '../../../shared/explorer/catalog.ts'
import { displayText } from '../../../shared/explorer/refs.ts'
import { environmentTag } from '../../../shared/environments'
import EnvironmentTag from '../EnvironmentTag'
import { loginChips, type StatusChip } from '../../../shared/explorer/status.ts'
import { codiconClass } from '../../../shared/icons'
import Icon from '../Icon'
import StatusPill from '../kit/StatusPill'
import { useConnectionAccent, useWorkbench } from '../core/WorkbenchContext'
import { useCommandEnabled } from '../core/useCommand'
import { useMenuTarget } from '../menus/useMenuTarget'
import type { GestureEvent } from '../core/gestures'
import ExplorerIcon, { type BadgeName } from './ExplorerIcon'
import type { RowStatus } from './ExplorerStatusService'
import { RowKind, type TreeAction, type TreeNode } from './tree-model'
import { serverConnectionStatus } from './connection-state'

const numbers = new Intl.NumberFormat('en-US')

/** Row actions the tree carries out: selection, the chevron, and a lost server's buttons. */
/** A row's click, for Open Peek as Tab's gesture: not on the twistie, and not a double-click's second click (Ctrl+double-click opens one tab). */
export function rowClick(actions: Pick<RowActions, 'click'>, rowId: number, event: GestureEvent & { readonly detail: number; readonly target: EventTarget | null }): void {
  if (event.detail <= 1 && !(event.target as Element | null)?.closest?.('.oe-twistie')) actions.click(rowId, event)
}

/** Recovery buttons expose the synthetic row's Enter action while the tree keeps its single keyboard stop. */
export function recoveryLabel(action: TreeAction): string | undefined {
  return action.type === 'retry' ? 'Retry' : action.type === 'continue' ? 'Continue loading' : action.type === 'filter' ? 'Filter…' : undefined
}

export interface RowActions {
  select(rowId: number): void
  toggle(rowId: number): void
  /** A double-click on a node that does not expand: its kind's default action, if it has one. */
  activate(rowId: number): void
  reconnect(rowId: number): void
  remove(rowId: number): void
  /** Fills a drag's data with the row's insert text; false cancels the drag. */
  dragStart(rowId: number, transfer: DataTransfer): boolean
  /** The Rename box's Enter (`refocus`: focus returns to the tree) or blur; false keeps the box open (an invalid name). */
  commitRename(rowId: number, text: string, refocus: boolean): Promise<boolean>
  /** Escape in the Rename box, or the box going away: nothing is sent. */
  cancelRename(refocus: boolean): void
  /** The pointer moved over a node row (with the keys held then) or left it (`held` absent): Peek on Hover's gesture peeks (Ctrl, ⌘ on macOS). */
  peekHover(rowId: number, held?: GestureEvent): void
  /** A click on a node row: Open Peek as Tab's gesture (Ctrl+click, ⌘-click on macOS) opens the object in a Peek tab. A
   *  double-click's second click is not one: Ctrl+double-click opens one tab. */
  click(rowId: number, event: GestureEvent): void
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
  /** The connection's environment label, for a server row: a tag at the row's end, also in its name and tooltip. */
  readonly environment?: string
  readonly actions: RowActions
  readonly menuTarget: RefCallback<HTMLDivElement>
  /** The label is the inline Rename box. */
  readonly renaming?: boolean
  /** Live status (ExplorerStatusService): chips at the row's end; for a database, its state in place of the listing's. */
  readonly status?: RowStatus
  readonly recovery?: { readonly label: string; run(): void }
}

const statusWords = { disabled: ', disabled', unavailable: ', unavailable', noAccess: ', no access', readOnly: '' } as const
const statusSentences = {
  disabled: 'It is disabled.',
  unavailable: 'The database is not available. Bring it online, then refresh Databases.',
  noAccess: 'The current login cannot open this database.',
  readOnly: ''
} as const
/** A row's static chips, from its listing rather than a probe: a login's Disabled and Connect denied (D4a). */
const listedChips = (node: Pick<TreeNode, 'kind' | 'status' | 'connectDenied'>): StatusChip[] => node.kind === 'login' ? loginChips(node.status, node.connectDenied) : []
/** A database whose live state is not the one Databases listed it with (its chevron and folders are the list's). */
export const changedSentence = 'Its state changed since Databases loaded. Refresh Databases to update it.'
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
export type ConnectionState = 'online' | 'error' | 'lost' | 'connecting' | 'disconnecting'
export const connectionState = (node: Pick<TreeNode, 'lost' | 'connectionError' | 'connectionLifecycle'>): ConnectionState => node.connectionLifecycle?.state === 'connecting' ? 'connecting' : node.connectionLifecycle?.state === 'disconnecting' ? 'disconnecting' : node.lost ? 'lost' : node.connectionError ? 'error' : 'online'
const connectionWords: Readonly<Record<ConnectionState, string>> = { online: 'Connected', error: 'Connection failed', lost: 'Disconnected', connecting: 'Connecting', disconnecting: 'Disconnecting' }

/**
 * What the tooltip says after the name: kind and creation date, facts, item count, status, and any error.
 */
function tooltipFacts(node: TreeNode, note?: string): string[] {
  const kind = node.kind === 'folder' ? undefined : [kindSpecs[node.kind].title, node.created && `Created ${node.created.replace('T', ' ')}`].filter(Boolean).join(' · ')
  const error = node.error ?? node.connectionError, count = itemCount(node)
  const listed = listedChips(node)
  const status = serverConnectionStatus(node)?.sentence ?? (listed.length ? listed.map(chip => chip.title).join('\n') : node.status && statusSentences[node.status])
  return [kind, node.lost && node.sublabel && displayText(node.sublabel), node.detail && displayText(node.detail), count !== undefined && items(count), status, note,
    error && `Could not load: ${displayText(error.message)}`, node.note && displayText(node.note.sentence)].filter((line): line is string => !!line)
}
/** The row's tooltip: name, kind and creation date, facts, status, `note` (such as a live state), any error, and another
 *  service's note on the node. */
export function rowTooltip(node: TreeNode, note?: string): string {
  const name = [node.label, serverConnectionStatus(node) ? shownSublabel(node) : node.sublabel, !node.lost && node.note?.label].filter(Boolean).join(' ')
  return clip([displayText(name), ...tooltipFacts(node, note)].join('\n'))
}
/**
 * The row's accessible description: the tooltip without the name, which the accessible name already says (a title
 * alone would be the description, so screen readers would read the name twice).
 */
export function rowDescription(node: TreeNode, note?: string): string | undefined {
  return clip(tooltipFacts(node, note).join('\n')) || undefined
}

/**
 * A database row as its live status shows it: the chips' words in place of the listing's sublabel, and the live state as
 * its status (a login that cannot open the database keeps noAccess, unless the database is unavailable to everyone).
 * `changed` when that status is not the one the list loaded, whose chevron and folders the row still has.
 */
export function liveDatabase(node: TreeNode, status: RowStatus): { node: TreeNode; changed: boolean } {
  const effective = status.state === 'unavailable' ? 'unavailable' : node.status === 'noAccess' ? 'noAccess' : status.state
  return { node: { ...node, sublabel: status.words ? `(${status.words})` : undefined, status: effective }, changed: effective !== node.status }
}

/** A row's live chips. Their words are in the row's accessible name, so the chips are hidden from screen readers. */
function StatusChips({ chips }: { chips: readonly StatusChip[] }) {
  return <span className="oe-chips" aria-hidden="true">
    {chips.map(chip => <StatusPill key={chip.id} tone={chip.tone} label={displayText(chip.label)} {...chip.value !== undefined ? { value: displayText(chip.value) } : {}} size="small" title={chip.title.split('\n').map(displayText).join('\n')} {...chip.icon !== undefined ? { icon: chip.icon } : {}} />)}
  </span>
}
/** The row's accessible name: the label and sublabel as shown, then its state (a static chip's words, as a server's chips say theirs). */
export function rowName(node: TreeNode): string {
  const sublabel = serverConnectionStatus(node) ? shownSublabel(node) : node.sublabel
  const listed = listedChips(node)
  const state = node.load === 'error' || node.more === 'error' || node.connectionError ? ', could not load'
    : listed.length ? listed.map(chip => ', ' + chip.words).join('') : node.status ? statusWords[node.status] : ''
  const note = !node.lost && node.note ? ' ' + displayText(node.note.label) : ''
  return `${displayText(node.label)}${node.filtered ? ' (filtered)' : ''}${sublabel ? ' ' + displayText(sublabel) : ''}${note}${state}`
}
function badgeOf(node: TreeNode): BadgeName | undefined {
  if (serverConnectionStatus(node)?.busy) return 'loading'
  if (node.lost) return 'lost'
  if (node.load === 'error' || node.more === 'error' || node.connectionError) return 'error'
  if (node.showLoading) return 'loading'
  return node.status === 'readOnly' ? undefined : node.status
}

/** A lost server's Reconnect… and Remove buttons; the tree keeps its one tab stop, so they are not tabbable (Enter and the menu are). */
function LostActions({ rowId, label, actions }: { rowId: number; label: string; actions: RowActions }) {
  const explorer = useWorkbench().explorer, node = explorer.menuNode(rowId), args = node ? { target: { kind: 'explorer' as const, node } } : undefined
  const canReconnect = useCommandEnabled('connection.reconnect', args), canRemove = useCommandEnabled('connection.removeFromExplorer', args)
  const status = explorer.node(rowId), action = status ? serverConnectionStatus(status)?.action ?? 'Reconnect' : 'Reconnect'
  const stop = (event: MouseEvent) => event.stopPropagation()
  return <span className="oe-actions">
    <button tabIndex={-1} disabled={!canReconnect} aria-label={action === 'Reconnect' ? 'Reconnect ' + label : `${action} for ${label}`} title={action + '…'} onMouseDown={stop} onClick={() => actions.reconnect(rowId)}><Icon name="plug" /></button>
    <button tabIndex={-1} disabled={!canRemove} aria-label={'Remove ' + label + ' from Explorer'} title="Remove from Explorer" onMouseDown={stop} onClick={() => actions.remove(rowId)}><Icon name="close" /></button>
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
  const blur = (event: FocusEvent<HTMLInputElement>) => { if (!(event.relatedTarget as Element | null)?.closest?.('.menu-layer')) void commit(false) }
  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation()
    if (event.key === 'Enter') { event.preventDefault(); void commit(true) }
    else if (event.key === 'Escape') { event.preventDefault(); settled.current = true; actions.cancelRename(true) }
  }
  return <input ref={input} className="explorer-rename" maxLength={128} aria-label={'Rename ' + title} defaultValue={name} spellCheck={false} autoComplete="off"
    onKeyDown={keyDown} onBlur={blur} onMouseDown={stop} onDoubleClick={stop} onCopy={stop} onCut={stop} onPaste={stop} onDragStart={stop} />
}

/** The label, with hidden characters shown as displayText marks them. */
export function Label({ text }: { text: string }) {
  return <bdi className="oe-label">{displayText(text)}</bdi>
}

/** The text after a node's label: a server's version and login in brief (its name keeps SSMS's full text), or a lost one's state. */
export const shownSublabel = (node: Pick<TreeNode, 'lost' | 'brief' | 'sublabel' | 'connectionLifecycle'>): string | undefined => {
  const status = serverConnectionStatus(node)
  return status ? `(${status.label})` : node.brief ?? node.sublabel
}

/**
 * The row's end, right-aligned: first the indicators (`children`: E3's state chips, then E2's environment tag), then the
 * active query's glyph (`active`), the item count and the connection dot, then `actions` (a lost server's buttons). It
 * takes the room the label leaves (the label keeps a share, see `.oe-label`); an indicator shrinks within that
 * (`flex: 0 1 auto; min-width: 0`) under a cap such as `max-width: min(40cqw, 12em)` (the row is an inline-size
 * container), never a percentage, which would resolve against this content-sized box (explorer-smoke 10b measures the
 * environment tag here).
 */
export function RowEnd({ count, connection, active, children, actions }: { count?: number; connection?: ConnectionState; active?: boolean; children?: ReactNode; actions?: ReactNode }) {
  return <span className="oe-end">
    {children}
    {active && <span className="oe-active" title="Server of the active query" aria-hidden="true"><Icon name="file-code" /></span>}
    {count !== undefined && <span className="oe-count" aria-hidden="true">{numbers.format(count)}</span>}
    {connection && <span className="oe-dot" data-state={connection} title={connectionWords[connection]} aria-hidden="true" />}
    {actions}
  </span>
}

/** A shortcut to the server's real tree row, with the same connection indicators. */
export function PinnedServerRow({ node, edge, current, active, color, environment, status, menu, top, jump }: {
  node: TreeNode; edge: 'top' | 'bottom'; current: boolean; active: boolean; color: string | undefined; environment?: string; status?: RowStatus; menu: boolean; top?: number; jump(): void
}) {
  const { explorer } = useWorkbench()
  const menuTarget = useMenuTarget<HTMLButtonElement>(button => {
    const target = explorer.menuNode(node.id)
    // A popover is above the custom menu layer. Dismiss the shortcut list before opening the node's full menu.
    button.closest<HTMLElement>('[popover]')?.hidePopover()
    return target ? { kind: 'explorer', node: target } : null
  }, button => {
    const popup = button.closest<HTMLElement>('[popover]')
    return popup ? button.ownerDocument.querySelector<HTMLButtonElement>(`[popovertarget="${CSS.escape(popup.id)}"]`) ?? undefined : button
  })
  const sublabel = shownSublabel(node), tag = environmentTag(environment)
  const facts = [status?.words && displayText(status.words), tag?.description]
  const name = [`Jump to ${rowName(node)}`, ...facts, active && 'server of the active query', current && 'current section'].filter(Boolean).join(', ')
  return <button ref={menuTarget} type="button" className={`explorer-row server explorer-pinned-server${active ? ' active-connection' : ''}${node.lost ? ' lost dimmed' : ''}`}
    style={{ top }} data-current-section={current || undefined} role={menu ? 'menuitem' : undefined} tabIndex={menu ? -1 : undefined}
    aria-label={name} title={clip([rowTooltip(node), ...facts].filter(Boolean).join('\n'))} onClick={jump}>
    <Accent color={color} />
    <span className="oe-twistie"><Icon name={edge === 'top' ? 'chevron-up' : 'chevron-down'} /></span>
    <ExplorerIcon name={node.icon} badge={badgeOf(node)} />
    <Label text={node.label} />
    {sublabel && <span className="oe-sublabel">{displayText(sublabel)}</span>}
    <RowEnd connection={connectionState(node)} active={active}>
      {!!status?.chips.length && <StatusChips chips={status.chips} />}
      {tag && <EnvironmentTag environment={environment} place="explorer" />}
    </RowEnd>
  </button>
}

/** One windowed row of the tree: a node, or a loading, error, progress, stopped, capped, or paused row. */
function ExplorerRow({ rowId, kind, top, level, posinset, setsize, node: listed, text, selected, draggable, active, color, environment, actions, menuTarget, renaming, status, recovery }: RowProps) {
  const style = { transform: `translateY(${top}px)` }
  const indent = <span className="oe-indent" style={{ width: (level - 1) * explorerLimits.indent }} />
  const select = (event: MouseEvent) => { if (!(event.target as Element).closest('.oe-twistie')) actions.select(rowId) }
  if (kind !== RowKind.Node || !listed) {
    // Loading rows do nothing; the capped row's Enter opens Filter Settings, so it is not announced as unavailable.
    const inert = kind === RowKind.Loading || kind === RowKind.More
    const tone = kind === RowKind.Error || kind === RowKind.MoreError ? ' error' : kind === RowKind.More || kind === RowKind.Loading ? ' progress' : ''
    const icon = kind === RowKind.Error || kind === RowKind.MoreError ? 'error' : kind === RowKind.Loading || kind === RowKind.More ? 'loading' : 'info'
    return <div ref={menuTarget} role="treeitem" id={`oe-${rowId}`} data-row-id={rowId} className={'explorer-row synthetic' + tone} aria-level={level} aria-selected={selected}
      aria-disabled={inert || undefined} aria-label={text} title={text} style={style} onMouseDown={select}>
      {indent}<span className="oe-twistie" /><span className="oe-icon" aria-hidden="true"><Icon name={icon} /></span><bdi className="oe-text">{text}</bdi>
      {!inert && recovery && <button type="button" className="oe-recovery-action" tabIndex={-1} title={`${recovery.label} (Enter)`}
        onMouseDown={event => { event.preventDefault(); event.stopPropagation(); actions.select(rowId) }} onClick={() => { actions.select(rowId); recovery.run() }}>{recovery.label}</button>}
    </div>
  }
  // A database the live status covers shows its state from the chips; any other row keeps the list's.
  const live = status?.live && listed.kind === 'database' ? liveDatabase(listed, status) : undefined
  const node = live?.node ?? listed, note = live?.changed ? changedSentence : undefined
  const expandable = node.hasChildren && !node.lost, folder = node.kind === 'folder', root = node.parent === 0
  const toggle = (event: MouseEvent) => { event.stopPropagation(); if (expandable) actions.toggle(rowId) }
  const dimmed = node.status === 'disabled' || node.status === 'unavailable' || node.status === 'noAccess' || node.lost
  const sublabel = shownSublabel(node)
  const tag = root ? environmentTag(environment) : undefined
  // A server's chips (running jobs, availability groups) follow its name and come before its environment. Server and database
  // rows show live chips (group names are the server's text); a login shows its listing's static chips.
  const staticChips = live || root ? undefined : listedChips(node)
  const chips = staticChips ?? status?.chips
  const serverWords = root && status?.words ? displayText(status.words) : undefined
  const name = [rowName(node), serverWords, tag?.description].filter(Boolean).join(', ')
  const tooltip = [rowTooltip(node, note), serverWords, tag?.description].filter(Boolean).join('\n')
  return <div ref={menuTarget} role="treeitem" id={`oe-${rowId}`} data-row-id={rowId}
    className={`explorer-row${folder ? ' folder' : ''}${root ? ' server' : ''}${node.lost ? ' lost' : ''}${active ? ' active-connection' : ''}${dimmed ? ' dimmed' : ''}${staticChips?.length ? ' static-chips' : ''}`}
    aria-level={level} aria-setsize={setsize || undefined} aria-posinset={posinset || undefined} aria-expanded={expandable ? node.expanded : undefined} aria-selected={selected}
    aria-busy={node.load === 'loading' || serverConnectionStatus(node)?.busy || undefined} aria-label={name} aria-description={rowDescription(node, note)} title={clip(tooltip)} style={style} draggable={(draggable && !renaming) || undefined}
    onMouseDown={select} onDoubleClick={() => { if (expandable) actions.toggle(rowId); else actions.activate(rowId) }}
    onClick={(event: MouseEvent) => rowClick(actions, rowId, event)}
    onMouseMove={(event: MouseEvent) => actions.peekHover(rowId, event)} onMouseLeave={() => actions.peekHover(rowId)}
    onDragStart={draggable ? (event: DragEvent) => { if (!actions.dragStart(rowId, event.dataTransfer)) event.preventDefault() } : undefined}>
    {root && <Accent color={color} />}
    {indent}
    <span className={`oe-twistie${expandable ? ' ' + codiconClass(node.expanded ? 'chevron-down' : 'chevron-right') : ''}`} aria-hidden="true" onClick={toggle} />
    <ExplorerIcon name={folder && node.expanded ? 'folder-opened' : node.icon} folder={folder} badge={badgeOf(node)} />
    {renaming && node.ref.type === 'object' && node.kind !== 'folder'
      ? <RenameBox rowId={rowId} name={node.ref.object.name ?? ''} title={kindSpecs[node.kind].title} actions={actions} />
      : <Label text={node.label} />}
    {node.filtered && <span className="oe-filtered">(filtered)</span>}
    {sublabel && !live && <span className="oe-sublabel">{displayText(sublabel)}</span>}
    {!node.lost && node.note && <span className="oe-sublabel">{displayText(node.note.label)}</span>}
    <RowEnd count={itemCount(node)} connection={root ? connectionState(node) : undefined} active={active} actions={node.lost && <LostActions rowId={rowId} label={node.label} actions={actions} />}>
      {chips && chips.length > 0 && <StatusChips chips={chips} />}
      {tag && <EnvironmentTag environment={environment} place="explorer" />}
    </RowEnd>
  </div>
}

export default memo(ExplorerRow)
