import { useLayoutEffect, useRef, type CSSProperties, type FocusEvent, type KeyboardEvent, type PointerEvent } from 'react'
import { documentKind, documentProvider, type QueryTab } from './documents'
import { useConnectionAccent, useServiceSnapshot, useWorkbench } from './core/WorkbenchContext'
import type { CommandArgs } from './core/types'
import { useCommandEnabled, useCommandsToggled, useKeybindingLabel } from './core/useCommand'
import { environmentTag } from '../../shared/environments'
import EnvironmentTag from './EnvironmentTag'
import Icon from './Icon'
import ClientStatisticsToggle from './statistics/ClientStatisticsToggle'
import BigQueryCostChip from './BigQueryCostChip'
import { lostHint, queryContextModel, toolbarMove, toolbarReturn, toolbarStop, withKey, type QueryContextModel } from './query-context'
import { documentUri } from './services/documents'

/** Selection metadata only: the execution service remains the source of the SQL that actually runs. */
export function useExecutionScope(tabId?: string): { readonly title: string; readonly detail: string } {
  const { documents, editorStatus } = useWorkbench()
  const { activeId } = useServiceSnapshot(documents), status = useServiceSnapshot(editorStatus)
  const targetId = tabId ?? activeId
  const selection = targetId && status?.selection?.uri === documentUri(targetId) ? status.selection : undefined
  return selection ? { title: 'Execute selection', detail: selection.startLine === selection.endLine ? `Line ${selection.startLine}` : `Lines ${selection.startLine}–${selection.endLine}` }
    : { title: 'Execute', detail: 'Entire query' }
}

/** A query document's server and database lists, scoped to `tabId` (or the active document for the classic toolbar). */
export function useQueryContext(tabId?: string): { readonly tab: QueryTab | undefined; readonly model: QueryContextModel; readonly running: boolean } {
  const workbench = useWorkbench()
  const { documents: tabs, activeId, busy } = useServiceSnapshot(workbench.documents)
  const queryState = useServiceSnapshot(workbench.queries)
  const connections = useServiceSnapshot(workbench.connections)
  const rememberedTargets = useServiceSnapshot(workbench.targets)
  const databaseLists = useServiceSnapshot(workbench.databaseList)
  const targetId = tabId ?? activeId
  const tab = tabs.find(value => value.id === targetId)
  const running = !!tab && !!queryState[tab.id]?.running
  const model = queryContextModel({
    connectionId: tab?.connectionId, targetId: tab?.targetId, target: rememberedTargets.find(target => target.id === tab?.targetId), lastServer: tab?.lastServer,
    database: tab?.database ?? 'master', connections, databases: tab?.connectionId ? databaseLists.get(tab.connectionId) ?? [] : [],
    query: !!tab && documentKind(tab) === 'sql', running, busy
  })
  return { tab, model, running }
}

/**
 * The server and database lists. In the query bar they sit in the connection pill; in the classic toolbar each has its
 * visible label. Either way a choice goes through the document's targets, which end its session first. The server list
 * describes the server's environment ("Production environment"), which the bar's tag shows but no control names. Each
 * database is its option's value: an option without one takes its text with spaces collapsed, another database's name.
 */
export function QueryPickers({ variant, tabId, onActivate }: { variant: 'bar' | 'classic'; tabId?: string; onActivate?: () => void }) {
  const { targets } = useWorkbench()
  const { tab, model } = useQueryContext(tabId)
  const classic = variant === 'classic'
  const environment = environmentTag(model.environment)
  const serverId = classic || !tabId ? 'query-server' : `query-server-${tabId}`
  const databaseId = classic || !tabId ? 'query-database' : `query-database-${tabId}`
  return <>
    {classic && <label className="context-field" htmlFor={serverId}>Server</label>}
    <select id={serverId} className="ui-field" aria-label="Query server" aria-description={environment?.description} title={classic ? undefined : model.serverName ? `Server: ${model.serverName}` : 'This query is not connected'} disabled={!tab || model.serverDisabled}
      value={model.serverValue} onChange={event => { if (tab) { onActivate?.(); void targets.changeConnection(tab.id, event.target.value || undefined) } }}>
      {model.servers.map(server => {
        const text = !classic && server.id === model.serverValue ? server.shortLabel : server.label
        return <option key={server.id} value={server.id} disabled={server.disabled} title={text !== server.label ? server.label : undefined}>{text}</option>
      })}
    </select>
    {classic ? <label className="context-field" htmlFor={databaseId}>{model.datasets ? 'Dataset' : 'Database'}</label> : <><span className="query-connection-divider" aria-hidden="true" /><Icon name="database" className="query-connection-icon" /></>}
    {/* A BigQuery query's box lists the project's datasets (its default dataset), with none as a choice. */}
    <select id={databaseId} className="ui-field" aria-label={model.datasets ? 'Query dataset' : 'Query database'} title={classic ? undefined : model.datasets ? `Default dataset: ${model.database || 'none'}` : `Database: ${model.database}`} disabled={model.databaseDisabled} value={model.database}
      onChange={event => { if (tab) { onActivate?.(); targets.changeDatabase(tab.id, event.target.value) } }}>
      {model.databases.map(name => <option key={name} value={name}>{name || (model.datasets ? '<no default dataset>' : name)}</option>)}
    </select>
  </>
}

// A press on a button keeps focus where it was (the query, usually), as SSMS's toolbars do: F5 and typing carry on, and
// no focus is lost when Execute turns disabled under the pointer.
const keepFocus = (event: PointerEvent<HTMLButtonElement>) => { if (event.button === 0) event.preventDefault() }
type Control = HTMLButtonElement | HTMLSelectElement
const isControl = (target: EventTarget | null): target is Control => target instanceof HTMLButtonElement || target instanceof HTMLSelectElement

export function ActualPlanToggle({ classic = false, live = false, args, onBeforeExecute }: { classic?: boolean; live?: boolean; args?: CommandArgs; onBeforeExecute?: () => void }) {
  const { commands } = useWorkbench()
  const id = live ? 'query.includeLivePlan' : 'query.includeActualPlan'
  const title = live ? 'Include Live Execution Plan' : 'Include Actual Execution Plan'
  const enabled = useCommandEnabled(id, args), [pressed] = useCommandsToggled([id], args), key = useKeybindingLabel(id)
  return <button type="button" className={classic ? 'ui-button actual-plan-toggle' : 'ui-button query-bar-action actual-plan-toggle'}
    aria-label={title} aria-keyshortcuts={key?.aria} aria-pressed={pressed} disabled={!enabled}
    title={withKey(title, key)} onPointerDown={keepFocus} onClick={() => { onBeforeExecute?.(); void commands.execute(id, args, 'toolbar') }}>
    <Icon name="execution-plan" /><span className="query-bar-label">{live ? 'Live Plan' : 'Actual Plan'}</span>
  </button>
}

export function EstimatedPlanButton({ classic = false, args, onBeforeExecute }: { classic?: boolean; args?: CommandArgs; onBeforeExecute?: () => void }) {
  const { commands } = useWorkbench()
  const id = 'query.estimatePlan', enabled = useCommandEnabled(id, args), key = useKeybindingLabel(id)
  return <button type="button" className={classic ? 'ui-button' : 'ui-button query-bar-action estimated-plan-button'} aria-label="Display Estimated Execution Plan"
    aria-keyshortcuts={key?.aria} disabled={!enabled} title={withKey('Display Estimated Execution Plan', key)}
    onPointerDown={keepFocus} onClick={() => { onBeforeExecute?.(); void commands.execute(id, args, 'toolbar') }}>
    <Icon name="execution-plan" /><span className="query-bar-label">Estimated Plan</span>
  </button>
}

/**
 * A query document's own bar holds Execute, Cancel, Actual Plan and the connection pickers, mounted inside the SQL
 * document below its editor group's tab strip. One tab stop enters the toolbar, then the arrow keys, Home and End move
 * between enabled controls. Pickers keep Up and Down and open with Alt+Down. When a control becomes disabled, focus
 * moves to its nearest enabled neighbor. F5 runs the query from the bar or editor. With the classic toolbar enabled,
 * it hosts these controls instead.
 */
export default function QueryBar({ tabId, onActivate }: { tabId?: string; onActivate?: () => void }) {
  const { commands, documents } = useWorkbench()
  const { tab, model, running } = useQueryContext(tabId)
  const scope = useExecutionScope(tabId)
  const commandArgs: CommandArgs | undefined = tabId && tab ? {
    tabId,
    state: {
      activeDocumentIsQuery: documentKind(tab) === 'sql',
      activeDocumentProvider: documentProvider(tab),
      activeDocumentConnected: model.live,
      queryRunning: running,
      includeActualPlan: documentKind(tab) === 'sql' && !!tab.includeActualPlan,
      includeLivePlan: documentKind(tab) === 'sql' && !!tab.includeLivePlan,
      includeClientStatistics: documentKind(tab) === 'sql' && !!tab.includeClientStatistics
    }
  } : undefined
  const canExecute = useCommandEnabled('query.execute', commandArgs), canCancel = useCommandEnabled('query.cancel', commandArgs)
  const keys = { execute: useKeybindingLabel('query.execute'), cancel: useKeybindingLabel('query.cancel') }
  const accent = useConnectionAccent(model.color)
  const accentStyle = accent ? { '--query-bar-accent': accent } as CSSProperties : undefined
  const environment = model.environment
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
  const activate = (focusEditor = false) => {
    if (!tabId) return
    if (documents.getSnapshot().activeId === tabId) return
    onActivate?.()
    if (documents.getSnapshot().activeId !== tabId) documents.activate(tabId)
    if (focusEditor) documents.focusActive()
  }
  const beforeButtonExecute = () => {
    const focusInBar = !!bar.current?.contains(document.activeElement)
    activate(!focusInBar)
  }
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
    activate(false)
    last.current = focused.current = control
    settle()
  }
  // Chromium can blur a control that turns disabled after the render that disabled it; that blur has no related target.
  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (isControl(event.target) && event.target.disabled && !event.relatedTarget) queueMicrotask(settle)
    else if (focused.current && focused.current === (event.target as EventTarget)) focused.current = undefined
  }
  const tag = environmentTag(environment)
  return <div className="query-bar" role="toolbar" aria-label="SQL Editor" data-query-bar="" data-tab-id={tabId} data-connection-accent={accent ? '' : undefined} style={accentStyle} ref={bar} onKeyDown={onKeyDown} onFocus={onFocus} onBlur={onBlur}>
    <div className="query-bar-actions">
      <button type="button" className="ui-button query-bar-action execute primary" aria-label={scope.title} aria-keyshortcuts={keys.execute?.aria} disabled={!canExecute}
        title={model.connection?.lost ? lostHint : withKey(scope.title === 'Execute' ? scope.title : `${scope.title} · ${scope.detail}`, keys.execute)} onPointerDown={keepFocus} onClick={() => { beforeButtonExecute(); void commands.execute('query.execute', commandArgs, 'toolbar') }}>
        <Icon name="play" /><span className="query-bar-label">{scope.title}</span>{keys.execute && <kbd aria-hidden="true">{keys.execute.text}</kbd>}
      </button>
      <span className="query-scope">{scope.detail}</span>
      <button type="button" className="ui-button query-bar-action" aria-label="Cancel" aria-keyshortcuts={keys.cancel?.aria} disabled={!canCancel} title={withKey('Cancel Executing Query', keys.cancel)}
        onPointerDown={keepFocus} onClick={() => { beforeButtonExecute(); void commands.execute('query.cancel', commandArgs, 'toolbar') }}>
        <Icon name="debug-stop" /><span className="query-bar-label">Cancel</span>
      </button>
      <BigQueryCostChip tabId={tab?.id} />
      <ActualPlanToggle args={commandArgs} onBeforeExecute={beforeButtonExecute} />
      <ActualPlanToggle live args={commandArgs} onBeforeExecute={beforeButtonExecute} />
      <EstimatedPlanButton args={commandArgs} onBeforeExecute={beforeButtonExecute} />
      <ClientStatisticsToggle args={commandArgs} onBeforeExecute={beforeButtonExecute} />
    </div>
    <div className="query-connection" role="group" aria-label="Connection" data-lost={model.connection?.lost || undefined} data-connection-accent={accent ? '' : undefined} style={accentStyle}>
      {accent && <span className="connection-swatch" style={{ background: accent }} aria-hidden="true" />}
      {tag && <span className="query-bar-environment"><span className="visually-hidden">Environment: </span><EnvironmentTag environment={environment} place="query" about={model.serverName} /></span>}
      <QueryPickers variant="bar" tabId={tabId} onActivate={() => activate(false)} />
    </div>
  </div>
}
