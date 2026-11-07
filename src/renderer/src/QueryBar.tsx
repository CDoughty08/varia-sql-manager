import { useLayoutEffect, useRef, type FocusEvent, type KeyboardEvent, type PointerEvent } from 'react'
import { documentKind, type QueryTab } from './documents'
import { useConnectionAccent, useServiceSnapshot, useWorkbench } from './core/WorkbenchContext'
import { useCommandEnabled, useCommandsToggled, useKeybindingLabel } from './core/useCommand'
import { environmentTag } from '../../shared/environments'
import EnvironmentTag from './EnvironmentTag'
import Icon from './Icon'
import ClientStatisticsToggle from './statistics/ClientStatisticsToggle'
import { lostHint, queryContextModel, toolbarMove, toolbarReturn, toolbarStop, withKey, type QueryContextModel } from './query-context'

/** The active document's server and database lists, as its query bar and the classic toolbar show them. */
export function useQueryContext(): { readonly tab: QueryTab | undefined; readonly model: QueryContextModel } {
  const workbench = useWorkbench()
  const { documents: tabs, activeId, busy } = useServiceSnapshot(workbench.documents)
  const queryState = useServiceSnapshot(workbench.queries)
  const connections = useServiceSnapshot(workbench.connections)
  const databaseLists = useServiceSnapshot(workbench.databaseList)
  const tab = tabs.find(value => value.id === activeId)
  const model = queryContextModel({
    connectionId: tab?.connectionId, database: tab?.database ?? 'master', connections, databases: tab?.connectionId ? databaseLists.get(tab.connectionId) ?? [] : [],
    query: !!tab && documentKind(tab) === 'sql', running: !!tab && !!queryState[tab.id]?.running, busy
  })
  return { tab, model }
}

/**
 * The server and database lists. In the query bar they sit in the connection pill; in the classic toolbar each has its
 * visible label. Either way a choice goes through the document's targets, which end its session first. The server list
 * describes the server's environment ("Production environment"), which the bar's tag shows but no control names. Each
 * database is its option's value: an option without one takes its text with spaces collapsed, another database's name.
 */
export function QueryPickers({ variant }: { variant: 'bar' | 'classic' }) {
  const { targets } = useWorkbench()
  const { tab, model } = useQueryContext()
  const classic = variant === 'classic'
  const environment = environmentTag(model.connection?.options.environment)
  return <>
    {classic && <label className="context-field" htmlFor="query-server">Server</label>}
    <select id="query-server" aria-label="Query server" aria-description={environment?.description} title={classic ? undefined : model.serverName ? `Server: ${model.serverName}` : 'This query is not connected'} disabled={!tab || model.serverDisabled}
      value={model.connection?.id ?? ''} onChange={event => { if (tab) void targets.changeConnection(tab.id, event.target.value || undefined) }}>
      {model.servers.map(server => <option key={server.id} value={server.id} disabled={server.disabled}>{server.label}</option>)}
    </select>
    {classic ? <label className="context-field" htmlFor="query-database">Database</label> : <><span className="query-connection-divider" aria-hidden="true" /><Icon name="database" className="query-connection-icon" /></>}
    <select id="query-database" aria-label="Query database" title={classic ? undefined : `Database: ${model.database}`} disabled={model.databaseDisabled} value={model.database}
      onChange={event => { if (tab) targets.changeDatabase(tab.id, event.target.value) }}>
      {model.databases.map(name => <option key={name} value={name}>{name}</option>)}
    </select>
  </>
}

// A press on a button keeps focus where it was (the query, usually), as SSMS's toolbars do: F5 and typing carry on, and
// no focus is lost when Execute turns disabled under the pointer.
const keepFocus = (event: PointerEvent<HTMLButtonElement>) => { if (event.button === 0) event.preventDefault() }
type Control = HTMLButtonElement | HTMLSelectElement
const isControl = (target: EventTarget | null): target is Control => target instanceof HTMLButtonElement || target instanceof HTMLSelectElement

export function ActualPlanToggle({ classic = false }: { classic?: boolean }) {
  const { commands } = useWorkbench()
  const id = 'query.includeActualPlan'
  const enabled = useCommandEnabled(id), [pressed] = useCommandsToggled([id]), key = useKeybindingLabel(id)
  return <button type="button" className={classic ? 'actual-plan-toggle' : 'query-bar-action actual-plan-toggle'}
    aria-label="Include Actual Execution Plan" aria-keyshortcuts={key?.aria} aria-pressed={pressed} disabled={!enabled}
    title={withKey('Include Actual Execution Plan', key)} onPointerDown={keepFocus} onClick={() => void commands.execute(id, undefined, 'toolbar')}>
    <Icon name="execution-plan" /><span className="query-bar-label">Actual Plan</span>
  </button>
}

/**
 * The query document's own bar holds Execute, Cancel, Actual Plan and the connection pickers. One tab stop enters the
 * toolbar, then the arrow keys, Home and End move between enabled controls. Pickers keep Up and Down and open with
 * Alt+Down. When a control becomes disabled, focus moves to its nearest enabled neighbor. F5 runs the query from the
 * bar or editor. With the classic toolbar enabled, it hosts these controls instead.
 */
export default function QueryBar() {
  const { commands } = useWorkbench()
  const { model } = useQueryContext()
  const canExecute = useCommandEnabled('query.execute'), canCancel = useCommandEnabled('query.cancel')
  const keys = { execute: useKeybindingLabel('query.execute'), cancel: useKeybindingLabel('query.cancel') }
  const accent = useConnectionAccent(model.connection?.color)
  const environment = model.connection?.options.environment
  const bar = useRef<HTMLDivElement>(null)
  const last = useRef<Control>(undefined)
  const focused = useRef<Control>(undefined)
  const controls = () => [...bar.current?.querySelectorAll<Control>('button, select') ?? []]
  const settle = () => {
    const all = controls(), stop = toolbarStop(all, last.current)
    for (const control of all) control.tabIndex = control === stop ? 0 : -1
    const lost = focused.current, active = document.activeElement
    if (!lost || (active === lost && !lost.disabled)) return
    // Focus went on by itself (to the query, a dialog): there is nothing to give back.
    if (active !== lost && active !== document.body && active !== null) { focused.current = undefined; return }
    // Undefined while a document task disables every control: the render that ends it settles again.
    const target = toolbarReturn(all, lost)
    if (target && target !== active) target.focus()
  }
  useLayoutEffect(settle)
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const from = event.target
    if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || !isControl(from) || !controls().includes(from)) return
    const next = toolbarMove(controls(), from, event.key)
    if (!next) return
    event.preventDefault()
    next.focus()
  }
  const onFocus = (event: FocusEvent<HTMLDivElement>) => {
    const control = event.target
    if (!isControl(control) || !controls().includes(control)) return
    last.current = focused.current = control
    settle()
  }
  // Chromium can blur a control that turns disabled after the render that disabled it; that blur has no related target.
  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (isControl(event.target) && event.target.disabled && !event.relatedTarget) queueMicrotask(settle)
    else if (focused.current && focused.current === (event.target as EventTarget)) focused.current = undefined
  }
  const tag = environmentTag(environment)
  return <div className="query-bar" role="toolbar" aria-label="SQL Editor" data-query-bar="" ref={bar} onKeyDown={onKeyDown} onFocus={onFocus} onBlur={onBlur}>
    <button type="button" className="query-bar-action execute primary" aria-label="Execute" aria-keyshortcuts={keys.execute?.aria} disabled={!canExecute}
      title={model.connection?.lost ? lostHint : withKey('Execute', keys.execute)} onPointerDown={keepFocus} onClick={() => void commands.execute('query.execute', undefined, 'toolbar')}>
      <Icon name="play" /><span className="query-bar-label">Execute</span>{keys.execute && <kbd aria-hidden="true">{keys.execute.text}</kbd>}
    </button>
    <button type="button" className="query-bar-action" aria-label="Cancel" aria-keyshortcuts={keys.cancel?.aria} disabled={!canCancel} title={withKey('Cancel Executing Query', keys.cancel)}
      onPointerDown={keepFocus} onClick={() => void commands.execute('query.cancel', undefined, 'toolbar')}>
      <Icon name="debug-stop" /><span className="query-bar-label">Cancel</span>
    </button>
    <ActualPlanToggle />
    <ClientStatisticsToggle />
    <div className="query-connection" role="group" aria-label="Connection" data-lost={model.connection?.lost || undefined}>
      {accent && <span className="connection-swatch" style={{ background: accent }} aria-hidden="true" />}
      {tag && <span className="query-bar-environment"><span className="visually-hidden">Environment: </span><EnvironmentTag environment={environment} place="query" about={model.serverName} /></span>}
      <QueryPickers variant="bar" />
    </div>
  </div>
}
