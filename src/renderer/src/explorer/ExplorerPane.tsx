import { useLayoutEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type Ref } from 'react'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import { useCommandEnabled, useCommandsEnabled, useKeybindingLabel } from '../core/useCommand'
import type { CommandArgs, CommandId } from '../core/types'
import { useMenuTarget } from '../menus/useMenuTarget'
import Icon from '../Icon'
import ExplorerErrorBoundary, { FaultProbe, focusLost } from './ExplorerErrorBoundary'
import ExplorerTree from './ExplorerTree'

interface Tool { readonly id: CommandId; readonly icon: string; readonly label: string; readonly args?: CommandArgs }

function ToolbarButton({ tool, enabled, tabbable, buttonRef, onFocus, onBlur }: {
  tool: Tool; enabled: boolean; tabbable: boolean; buttonRef: Ref<HTMLButtonElement>; onFocus: () => void; onBlur: (event: FocusEvent<HTMLButtonElement>) => void
}) {
  const { commands } = useWorkbench()
  const key = useKeybindingLabel(tool.id)
  const title = key ? `${tool.label} (${key.text})` : tool.label
  return <button ref={buttonRef} className="icon-button" aria-label={tool.label} title={title} disabled={!enabled} tabIndex={tabbable ? 0 : -1} onFocus={onFocus} onBlur={onBlur}
    onClick={() => void commands.execute(tool.id, tool.args, 'toolbar')}>
    <span className={`codicon codicon-${tool.icon}`} aria-hidden="true" />
  </button>
}

/**
 * SSMS's toolbar as an ARIA toolbar: one tab stop (the button used last, or the first enabled one), and the arrow keys,
 * Home and End move between the enabled buttons. A focused button that turns disabled (Stop once loading ends,
 * Disconnect while it runs) would drop focus to the page, so focus moves on to the next enabled button, or the tree.
 */
function ExplorerToolbar({ tools }: { tools: readonly Tool[] }) {
  const enabled = useCommandsEnabled(tools)
  const buttons = useRef<(HTMLButtonElement | null)[]>([])
  const [current, setCurrent] = useState(0)
  const stop = enabled[current] ? current : enabled.indexOf(true)
  const focused = useRef(-1)
  const rescue = () => {
    const index = focused.current, button = buttons.current[index]
    if (!button?.disabled || (document.activeElement !== button && !focusLost())) return
    focused.current = -1
    const count = buttons.current.length
    const next = Array.from({ length: count - 1 }, (_, step) => buttons.current[(index + 1 + step) % count]).find(candidate => candidate && !candidate.disabled)
    if (next) next.focus()
    else document.querySelector<HTMLElement>('[data-explorer-tree]')?.focus()
  }
  useLayoutEffect(rescue)
  // Chromium can also blur the button after this render; that blur has no related target.
  const blurred = (index: number, event: FocusEvent<HTMLButtonElement>) => {
    if (event.currentTarget.disabled && !event.relatedTarget) queueMicrotask(rescue)
    else if (focused.current === index) focused.current = -1
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const order = tools.map((_, index) => index).filter(index => enabled[index])
    const at = order.indexOf(buttons.current.findIndex(button => button === document.activeElement))
    if (at < 0 || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return
    const next = event.key === 'ArrowRight' ? order[(at + 1) % order.length] : event.key === 'ArrowLeft' ? order[(at - 1 + order.length) % order.length]
      : event.key === 'Home' ? order[0] : event.key === 'End' ? order[order.length - 1] : undefined
    if (next === undefined) return
    event.preventDefault()
    setCurrent(next)
    buttons.current[next]?.focus()
  }
  return <div className="explorer-toolbar" role="toolbar" aria-label="Object Explorer toolbar" onKeyDown={onKeyDown}>
    {tools.map((tool, index) => <ToolbarButton key={tool.id} tool={tool} enabled={enabled[index]} tabbable={index === stop}
      buttonRef={button => { buttons.current[index] = button }} onFocus={() => { focused.current = index; setCurrent(index) }} onBlur={event => blurred(index, event)} />)}
  </div>
}

/**
 * Object Explorer: SSMS's toolbar (Connect, Disconnect, Stop, Filter, Refresh, Collapse All) over the tree of connected
 * servers, or a prompt to connect. Disconnect acts on the selected node's server; with nothing selected it asks which.
 * Filter shows a filled funnel while the selected folder has a filter.
 */
export default function ExplorerPane({ error, activeConnectionId }: { readonly error?: string; readonly activeConnectionId?: string }) {
  const { explorer, connections, commands } = useWorkbench()
  const { selected } = useServiceSnapshot(explorer)
  const { explorerSelectionFiltered: filtered } = useServiceSnapshot(explorer.context)
  const servers = useServiceSnapshot(connections)
  const connect = useCommandEnabled('connection.connect')
  const selectedServer = explorer.menuNode(selected)?.connectionId
  const serverNode = selectedServer === undefined ? undefined : explorer.menuNode(explorer.rootIds.find(id => explorer.node(id)?.connectionId === selectedServer))
  const disconnectArgs: CommandArgs | undefined = serverNode ? { target: { kind: 'explorer', node: serverNode } } : undefined
  // The empty area below the servers: Connect… and Refresh. Rows register their own menus.
  const background = useMenuTarget<HTMLDivElement>(() => ({ kind: 'explorer' }))
  const live = servers.filter(value => !value.lost).length
  const tools: Tool[] = [
    { id: 'connection.connect', icon: 'plug', label: 'Connect Object Explorer' },
    { id: 'connection.disconnect', icon: 'debug-disconnect', label: 'Disconnect', ...(disconnectArgs ? { args: disconnectArgs } : {}) },
    { id: 'explorer.stop', icon: 'debug-stop', label: 'Stop' },
    { id: 'explorer.filter', icon: filtered ? 'filter-filled' : 'filter', label: 'Filter Settings' },
    { id: 'explorer.refresh', icon: 'refresh', label: 'Refresh' },
    { id: 'explorer.collapseAll', icon: 'collapse-all', label: 'Collapse All' }
  ]
  // When the last server goes, focus the tree held moves to the empty state's Connect button rather than the page; when
  // the first one comes, focus the Connect button or its dialog held moves to the tree, as SSMS focuses Object Explorer.
  const empty = !servers.length, connectButton = useRef<HTMLButtonElement>(null), wasEmpty = useRef(empty)
  useLayoutEffect(() => {
    if (empty !== wasEmpty.current && focusLost()) {
      if (empty) connectButton.current?.focus()
      else document.querySelector<HTMLElement>('[data-explorer-tree]')?.focus()
    }
    wasEmpty.current = empty
  }, [empty])
  return <>
    <ExplorerToolbar tools={tools} />
    <div className="explorer-body" ref={background}>
      {servers.length ? <ExplorerErrorBoundary onReload={() => explorer.reset()} onReloaded={() => document.querySelector<HTMLElement>('[data-explorer-tree]')?.focus()}>
        <FaultProbe /><ExplorerTree activeConnectionId={activeConnectionId} /></ExplorerErrorBoundary>
        : <div className="explorer-empty"><Icon name="server" /><p>Connect to SQL Server to browse databases and objects.</p><button ref={connectButton} disabled={!connect} onClick={() => void commands.execute('connection.connect', undefined, 'toolbar')}>Connect to server</button></div>}
      {error && <p className="explorer-error" role="alert">{error}</p>}
    </div>
    <div className="explorer-footer">{live ? `${live} connected server${live === 1 ? '' : 's'}` : servers.length ? 'No connected servers' : 'Windows & SQL authentication'}</div>
  </>
}
