import { memo, useEffect, useRef, type KeyboardEvent } from 'react'
import { kindSpecs } from '../../../shared/explorer/catalog.ts'
import { dependencyDirectionLabels, dependencyDirections, dependencyLeafWords, dependencyLimits } from '../../../shared/explorer/dependencies.ts'
import { displayText } from '../../../shared/explorer/refs.ts'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import { findInWindows, returnFocusTo } from '../core/focus'
import Icon from '../Icon'
import { trapFocus } from '../trap-focus'
import ExplorerIcon from './ExplorerIcon'
import type { OpenDependencies } from './DependenciesService'
import { levelStatus, type DependencyNode } from './dependency-tree'

const iconOf = (node: DependencyNode) => node.ref ? kindSpecs[node.ref.kind].icon : node.leaf === 'linkedServer' ? 'remote' : node.leaf === 'otherDatabase' ? 'database' : 'references'

/**
 * SSMS's View Dependencies (Object Dependencies): two choices, the objects that depend on the selected object and the objects it
 * depends on, over a tree read one level at a time as nodes expand, and the selected node's name, type and dependency type.
 * The tree's keys are the tree view's: Up and Down move, Right expands (or moves to the first child), Left collapses (or moves to
 * the parent), Home and End; Enter or a double-click selects the node in Object Explorer and closes the dialog. Escape closes it,
 * and focus returns to Object Explorer.
 */
export default function DependenciesDialog() {
  const { dependencies } = useWorkbench()
  const { open } = useServiceSnapshot(dependencies)
  const shown = useRef(false)
  useEffect(() => {
    if (open) { shown.current = true; return }
    if (!shown.current) return
    shown.current = false
    if (!document.activeElement || document.activeElement === document.body) returnFocusTo(findInWindows('[data-explorer-tree]'))
  }, [open])
  if (!open) return null
  return <DependenciesForm key={open.id} open={open} />
}

function DependenciesForm({ open }: { open: OpenDependencies }) {
  const { dependencies } = useWorkbench()
  const tree = useRef<HTMLDivElement>(null)
  useEffect(() => { tree.current?.focus() }, [])
  useEffect(() => { tree.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' }) }, [open.selected])
  const name = displayText(open.root.label)
  const rows = open.rows
  const at = Math.max(0, rows.findIndex(row => row.node.id === open.selected))
  const selected = rows[at]?.node
  const close = () => {
    dependencies.close()
    returnFocusTo(findInWindows('[data-explorer-tree]'))
  }
  const formKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    trapFocus(event)
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() }
  }
  const treeKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    const node = rows[at]?.node
    // Keys on a control inside the tree (a failed level's Retry) are that control's: Enter retries rather than revealing the selection.
    if (event.target !== event.currentTarget || !node || event.altKey || event.ctrlKey || event.metaKey) return
    const move = (index: number) => { const row = rows[Math.max(0, Math.min(rows.length - 1, index))]; if (row) dependencies.select(row.node.id) }
    switch (event.key) {
      case 'ArrowDown': move(at + 1); break
      case 'ArrowUp': move(at - 1); break
      case 'Home': move(0); break
      case 'End': move(rows.length - 1); break
      case 'ArrowRight':
        if (!node.expanded && !node.leaf) dependencies.expand(node.id)
        else if (node.expanded && node.children?.length) move(at + 1)
        break
      case 'ArrowLeft':
        if (node.expanded) dependencies.collapse(node.id)
        else if (node.parent !== undefined) dependencies.select(node.parent)
        break
      case 'Enter': dependencies.reveal(node.id); break
      default: return
    }
    event.preventDefault()
    event.stopPropagation()
  }
  return <div className="modal-backdrop"><div className="connection-modal dependencies-dialog" role="dialog" aria-modal="true" aria-labelledby="dependencies-title" onKeyDown={formKeys}>
    <div className="connection-heading"><h2 id="dependencies-title">Object Dependencies – {name}</h2>
      <button type="button" className="icon-button" aria-label="Close Object Dependencies" onClick={close}><Icon name="close" /></button></div>
    <div className="connection-scroll dependencies-body">
      <fieldset className="property-section dependencies-choice">
        <legend className="visually-hidden">Dependencies</legend>
        {dependencyDirections.map(direction => <label key={direction} className="checkbox-label">
          {/* aria-disabled rather than disabled once the server is lost: disabling a focused radio would drop focus out of the dialog. */}
          <input type="radio" name="dependencies-direction" checked={open.direction === direction} aria-disabled={open.lost || undefined} onChange={() => dependencies.setDirection(direction)} />
          {dependencyDirectionLabels[direction](name)}
        </label>)}
      </fieldset>
      {open.lost && <p className="connect-error" role="alert">The server was disconnected. Reconnect, then open View Dependencies again.</p>}
      <div ref={tree} className="dependencies-tree" role="tree" aria-label="Dependencies" tabIndex={0} onKeyDown={treeKeys}
        aria-activedescendant={selected ? `dependency-${open.id}-${selected.id}` : undefined}>
        {rows.map(row => <TreeRow key={row.node.id} dialog={open.id} lost={!!open.lost} node={row.node} index={row.index} count={row.count} selected={row.node.id === open.selected} />)}
      </div>
      {selected && <section className="property-section" aria-label="Selected object">
        <h3 className="peek-group">Selected object</h3>
        <dl className="peek-facts">
          <div className="peek-fact"><dt>Name</dt><dd><bdi>{displayText(selected.label)}</bdi></dd></div>
          <div className="peek-fact"><dt>Type</dt><dd>{selected.type}</dd></div>
          <div className="peek-fact"><dt>Dependency type</dt><dd>{selected.dependencyType ?? '—'}</dd></div>
          {selected.leaf && <div className="peek-fact"><dt>Note</dt><dd>{dependencyLeafWords[selected.leaf]}</dd></div>}
        </dl>
      </section>}
    </div>
    <div className="connection-footer">
      <button type="button" disabled={!selected || !dependencies.canPeek(selected.id)} onClick={() => selected && dependencies.peek(selected.id)}>Peek</button>
      <button type="button" disabled={!selected || open.lost || !dependencies.canReveal(selected.id)} onClick={() => selected && dependencies.reveal(selected.id)}>Show in Object Explorer</button>
      <span />
      <button type="button" className="primary" onClick={close}>OK</button>
    </div>
  </div></div>
}

interface TreeRowProps { readonly dialog: number; readonly lost: boolean; readonly node: DependencyNode; readonly index: number; readonly count: number; readonly selected: boolean }
/** One row and its status line. Memoised: nodes are replaced, never changed, so a move of the selection renders two rows, not the
 *  whole tree (up to `dependencyLimits.nodes`). */
const TreeRow = memo(function TreeRow({ dialog, lost, node, index, count, selected }: TreeRowProps) {
  const { dependencies } = useWorkbench()
  const indent = { paddingInlineStart: `calc(${node.depth} * var(--varia-space-4) + var(--varia-space-1))` }
  const expandable = !node.leaf
  const note = node.leaf ? dependencyLeafWords[node.leaf] : node.id === 0 ? undefined : node.type
  const status = levelStatus(node)
  const pending = status === 'loading', failed = status === 'error', empty = status === 'empty'
  const cut = status === 'level' || status === 'nodes' ? status : undefined
  return <>
    <div id={`dependency-${dialog}-${node.id}`} role="treeitem" className="dependencies-row" aria-level={node.depth + 1} aria-setsize={count} aria-posinset={index + 1}
      aria-label={note ? `${displayText(node.label)}, ${note}` : displayText(node.label)} aria-selected={selected} {...expandable ? { 'aria-expanded': node.expanded } : {}} data-leaf={node.leaf} style={indent}
      onClick={() => dependencies.select(node.id)} onDoubleClick={() => dependencies.reveal(node.id)}>
      <span className="dependencies-twisty" aria-hidden="true" onClick={event => { event.stopPropagation(); dependencies.select(node.id); if (node.expanded) dependencies.collapse(node.id); else dependencies.expand(node.id) }}>
        {expandable && <Icon name={node.expanded ? 'chevron-down' : 'chevron-right'} />}
      </span>
      <ExplorerIcon name={iconOf(node)} />
      <bdi className="peek-item-name">{displayText(node.label)}</bdi>
      {note && <span className="peek-item-note">{note}</span>}
    </div>
    {pending && <div className="dependencies-status" role="status" style={indent}><Icon name="loading" className="object-dialog-spinner" /> Loading dependencies…</div>}
    {failed && <div className="dependencies-status error" role="alert" style={indent}>{node.error}{' '}
      {/* The button goes with the error row: focus the tree first, so Escape and Tab stay in the dialog. */}
      {!lost && <button type="button" className="peek-action" onClick={event => { event.currentTarget.closest<HTMLElement>('[role="tree"]')?.focus(); dependencies.retry(node.id) }}>Retry</button>}</div>}
    {empty && <div className="dependencies-status" style={indent}>No dependencies.</div>}
    {cut && <div className="dependencies-status" style={indent}>{cut === 'level'
      ? `There are more than ${dependencyLimits.perLevel.toLocaleString('en-US')}; only those are listed.`
      : `The tree holds at most ${dependencyLimits.nodes.toLocaleString('en-US')} objects; open View Dependencies on a deeper object to see more.`}</div>}
  </>
})
