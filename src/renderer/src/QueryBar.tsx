import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type FocusEvent, type KeyboardEvent, type PointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { documentKind, documentProvider, type QueryTab } from './documents'
import { useConnectionAccent, useServiceSnapshot, useWorkbench } from './core/WorkbenchContext'
import type { CommandArgs, CommandId } from './core/types'
import { useCommandEnabled, useCommandsToggled, useKeybindingLabel } from './core/useCommand'
import { useTicker } from './core/useTicker'
import { modalOpen } from './core/modal'
import { watchModals, windows } from './core/windows'
import { environmentPreset, environmentTag } from '../../shared/environments'
import EnvironmentTag from './EnvironmentTag'
import Icon from './Icon'
import MultiTargetPopover, { multiTargetTriggerSummary, resolveMultiTargets } from './MultiTargetPopover'
import ClientStatisticsToggle from './statistics/ClientStatisticsToggle'
import BigQueryCostChip from './BigQueryCostChip'
import { formatElapsed, lostHint, planButtonState, queryContextModel, toolbarMove, toolbarReturn, toolbarStop, withKey, type QueryContextModel } from './query-context'
import { documentUri } from './services/documents'

/** Selection metadata only: the execution service remains the source of the SQL that actually runs. */
export function useExecutionScope(tabId?: string): { readonly selected: boolean; readonly title: string; readonly label: string; readonly detail: string; readonly pill: string; readonly tooltip?: string } {
  const { documents, editorStatus } = useWorkbench()
  const { documents: tabs, activeId } = useServiceSnapshot(documents), status = useServiceSnapshot(editorStatus)
  const targetId = tabId ?? activeId
  const tab = tabs.find(value => value.id === targetId)
  if (tab?.multiMode === 'cross') {
    return {
      selected: false,
      title: 'Execute',
      label: 'Execute',
      detail: 'Both dialects',
      pill: 'Both dialects',
      tooltip: 'Cross-Engine always executes both full Transact-SQL and GoogleSQL panes.'
    }
  }
  const selection = targetId && status?.selection?.uri === documentUri(targetId) ? status.selection : undefined
  if (!selection) return { selected: false, title: 'Execute', label: 'Execute', detail: 'Entire query', pill: 'All' }
  const range = selection.startLine === selection.endLine ? `Line ${selection.startLine}` : `Lines ${selection.startLine}–${selection.endLine}`
  return { selected: true, title: 'Execute selection', label: 'Run Selection', detail: range, pill: range }
}

/** A query document's server and database lists, scoped to `tabId` (or the active document for the classic toolbar). */
export function useQueryContext(tabId?: string): { readonly tab: QueryTab | undefined; readonly model: QueryContextModel; readonly running: boolean; readonly startedAt: number | undefined } {
  const workbench = useWorkbench()
  const { documents: tabs, activeId, busy } = useServiceSnapshot(workbench.documents)
  const queryState = useServiceSnapshot(workbench.queries)
  const connections = useServiceSnapshot(workbench.connections)
  const rememberedTargets = useServiceSnapshot(workbench.targets)
  const databaseLists = useServiceSnapshot(workbench.databaseList)
  const targetId = tabId ?? activeId
  const tab = tabs.find(value => value.id === targetId)
  const startedAt = tab ? queryState[tab.id]?.running?.startedAt : undefined
  const running = startedAt !== undefined
  const baseModel = queryContextModel({
    connectionId: tab?.connectionId, targetId: tab?.targetId, target: rememberedTargets.find(target => target.id === tab?.targetId), lastServer: tab?.lastServer,
    database: tab?.database ?? 'master', connections, databases: tab?.connectionId ? databaseLists.get(tab.connectionId) ?? [] : [],
    query: !!tab && documentKind(tab) === 'sql', running, busy
  })
  if (!tab?.multiMode) return { tab, model: baseModel, running, startedAt }
  const summary = multiTargetTriggerSummary(tab, connections, rememberedTargets)
  const resolved = resolveMultiTargets(tab, connections, rememberedTargets).filter(item => item.target.enabled)
  const prod = resolved.find(item => environmentPreset(item.environment) === 'Production')
  const color = prod ? (prod.color ?? 'red') : tab.multiMode === 'cross' ? 'purple' : resolved.find(item => item.color)?.color
  const environment = summary.prodCount > 0 ? 'Production' : undefined
  const model: QueryContextModel = {
    ...baseModel,
    live: summary.ready,
    color,
    environment,
    serverName: summary.label
  }
  return { tab, model, running, startedAt }
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

// Chromium handles Escape through close requests, independently of the menu's visual layer.
declare const CloseWatcher: (new () => EventTarget & { destroy(): void }) | undefined

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
    <Icon name={live ? 'execution-plan-live' : 'execution-plan-actual'} /><span className="query-bar-label">{live ? 'Live Plan' : 'Actual Plan'}</span>
  </button>
}

export function EstimatedPlanButton({ classic = false, args, onBeforeExecute }: { classic?: boolean; args?: CommandArgs; onBeforeExecute?: () => void }) {
  const { commands } = useWorkbench()
  const id = 'query.estimatePlan', enabled = useCommandEnabled(id, args), key = useKeybindingLabel(id)
  return <button type="button" className={classic ? 'ui-button' : 'ui-button query-bar-action estimated-plan-button'} aria-label="Display Estimated Execution Plan"
    aria-keyshortcuts={key?.aria} disabled={!enabled} title={withKey('Display Estimated Execution Plan', key)}
    onPointerDown={keepFocus} onClick={() => { onBeforeExecute?.(); void commands.execute(id, args, 'toolbar') }}>
    <Icon name="execution-plan-estimated" /><span className="query-bar-label">Estimated Plan</span>
  </button>
}

/**
 * Unified `Plan ▾` menu trigger for the modern per-tab QueryBar: consolidates Actual Plan, Live Plan and Estimated Plan
 * behind one calm popover while executing the exact catalog commands so shortcuts, the Query menu and the palette stay
 * synced. Portaled to the document body so `.query-bar`'s overflow clipping never truncates it.
 */
function PlanMenuButton({ args, onBeforeExecute }: { args?: CommandArgs; onBeforeExecute?: () => void }) {
  const { commands, menus } = useWorkbench()
  const canActual = useCommandEnabled('query.includeActualPlan', args)
  const canLive = useCommandEnabled('query.includeLivePlan', args)
  const canEstimate = useCommandEnabled('query.estimatePlan', args)
  const [actual, live] = useCommandsToggled(['query.includeActualPlan', 'query.includeLivePlan'], args)
  const keys = {
    actual: useKeybindingLabel('query.includeActualPlan'),
    estimate: useKeybindingLabel('query.estimatePlan')
  }
  const disabled = !canActual && !canLive && !canEstimate
  const state = planButtonState(actual, live)
  const menuId = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const focusTarget = useRef<'first' | 'last' | undefined>(undefined)
  const openedByKeyboard = useRef(false)
  const [open, setOpen] = useState(false)
  const [coords, setCoords] = useState<{ top: number; left: number } | undefined>()

  const close = (returnFocus = false) => {
    setOpen(false)
    setCoords(undefined)
    focusTarget.current = undefined
    if (returnFocus) trigger.current?.focus({ preventScroll: true })
    openedByKeyboard.current = false
  }
  const openMenu = (keyboard: 'first' | 'last' | false) => {
    if (disabled || modalOpen() || menus?.ownsKeyboard?.()) return
    openedByKeyboard.current = keyboard !== false
    focusTarget.current = keyboard || undefined
    setOpen(true)
  }

  useEffect(() => {
    if (disabled && open) { setOpen(false); setCoords(undefined) }
  }, [disabled, open])

  const placed = !!coords
  useLayoutEffect(() => {
    if (!open || !placed) return
    const target = focusTarget.current, popover = menu.current
    if (!target || !popover) return
    focusTarget.current = undefined
    const items = [...popover.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
    const chosen = target === 'last' ? items.at(-1) : items[0]
    chosen?.focus({ preventScroll: true })
  }, [open, placed])

  useLayoutEffect(() => {
    if (!open) return
    const button = trigger.current, popover = menu.current
    if (!button || !popover) return
    const place = () => {
      const own = button.ownerDocument, view = own.defaultView ?? window, box = button.getBoundingClientRect()
      const inset = 8, gap = 4
      const width = popover.offsetWidth || 244, height = popover.offsetHeight || 168
      const left = Math.max(inset, Math.min(box.left, view.innerWidth - width - inset))
      const below = view.innerHeight - box.bottom - gap - inset, above = box.top - gap - inset
      const up = height > below && above > below
      const top = up ? Math.max(inset, box.top - gap - height) : box.bottom + gap
      setCoords(current => current && current.top === top && current.left === left ? current : { top, left })
    }
    place()
    const own = button.ownerDocument, view = own.defaultView ?? window
    const onOutside = (event: globalThis.PointerEvent) => {
      const path = event.composedPath()
      if (!path.includes(button) && !path.includes(popover)) close(false)
    }
    const onCloseRequest = () => close(openedByKeyboard.current || popover.contains(own.activeElement))
    const onBlur = () => close(false)
    own.addEventListener('pointerdown', onOutside, true)
    const watcher = typeof CloseWatcher === 'function' ? new CloseWatcher() : undefined
    watcher?.addEventListener('close', onCloseRequest)
    view.addEventListener('resize', place)
    own.addEventListener('scroll', place, true)
    view.addEventListener('blur', onBlur)
    const modals = watchModals(own, () => close(false))
    const adoption = windows.onDidAdopt(() => close(false))
    const stopMenus = menus?.controller?.subscribe?.(() => { if (menus.ownsKeyboard()) close(false) })
    return () => {
      own.removeEventListener('pointerdown', onOutside, true)
      watcher?.destroy()
      view.removeEventListener('resize', place)
      own.removeEventListener('scroll', place, true)
      view.removeEventListener('blur', onBlur)
      modals.dispose()
      adoption.dispose()
      stopMenus?.()
    }
  }, [menus, open])

  const triggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    if (event.key === 'ArrowDown') { event.preventDefault(); openMenu('first') }
    else if (event.key === 'ArrowUp') { event.preventDefault(); openMenu('last') }
    else if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); close(true) }
  }

  const menuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return }
    if (event.key === 'Tab') { event.stopPropagation(); close(true); return }
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
    if (!items.length) return
    const at = items.indexOf(event.currentTarget.ownerDocument.activeElement as HTMLButtonElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
      : event.key === 'ArrowDown' ? (at + 1) % items.length : (at <= 0 ? items.length - 1 : at - 1)
    event.preventDefault()
    event.stopPropagation()
    items[next]?.focus({ preventScroll: true })
  }

  const runItem = (id: CommandId, fromKeyboard: boolean) => {
    close(fromKeyboard)
    onBeforeExecute?.()
    void commands.execute(id, args, 'toolbar')
  }

  const host = open ? trigger.current?.ownerDocument.body : undefined
  return <>
    <button ref={trigger} type="button" className="ui-button query-bar-action plan-menu-trigger"
      aria-label={state.label} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
      data-active={state.active ? '' : undefined} disabled={disabled}
      title={state.active ? `Execution plan options (${state.label})` : 'Execution plan options'}
      onPointerDown={keepFocus}
      onKeyDown={triggerKeyDown}
      onClick={event => {
        if (open) close(event.detail === 0)
        else openMenu(event.detail === 0 ? 'first' : false)
      }}>
      <Icon name={state.icon} /><span className="query-bar-label">{state.label}</span><Icon name="chevron-down" className="plan-menu-chevron" />
    </button>
    {open && host && createPortal(
      <div ref={menu} id={menuId} className="plan-menu-popover" role="menu" aria-label="Execution Plan Options"
        style={coords ? { top: `${coords.top}px`, left: `${coords.left}px` } : { visibility: 'hidden' }}
        onKeyDown={menuKeyDown}>
        <div className="plan-menu-header" aria-hidden="true">Execution Plan Options</div>
        <button type="button" role="menuitemcheckbox" className="plan-menu-item"
          aria-label="Include Actual Plan" aria-checked={actual} aria-keyshortcuts={keys.actual?.aria} disabled={!canActual}
          title={withKey('Include Actual Execution Plan', keys.actual)}
          onPointerDown={keepFocus} onClick={event => runItem('query.includeActualPlan', event.detail === 0)}>
          <Icon name="execution-plan-actual" />
          <span className="plan-menu-body">
            <span className="plan-menu-title">Include Actual Plan</span>
            <span className="plan-menu-sub">{keys.actual ? `${keys.actual.text} · ` : ''}Captures runtime stats</span>
          </span>
          {actual && <Icon name="check" className="plan-menu-check" />}
        </button>
        <button type="button" role="menuitemcheckbox" className="plan-menu-item"
          aria-label="Include Live Plan" aria-checked={live} disabled={!canLive}
          title="Include Live Execution Plan"
          onPointerDown={keepFocus} onClick={event => runItem('query.includeLivePlan', event.detail === 0)}>
          <Icon name="execution-plan-live" />
          <span className="plan-menu-body">
            <span className="plan-menu-title">Include Live Plan</span>
            <span className="plan-menu-sub">Streams operator progress live</span>
          </span>
          {live && <Icon name="check" className="plan-menu-check" />}
        </button>
        <div className="plan-menu-sep" role="separator" />
        <button type="button" role="menuitem" className="plan-menu-item"
          aria-label="Display Estimated Plan" aria-keyshortcuts={keys.estimate?.aria} disabled={!canEstimate}
          title={withKey('Display Estimated Execution Plan', keys.estimate)}
          onPointerDown={keepFocus} onClick={event => runItem('query.estimatePlan', event.detail === 0)}>
          <Icon name="execution-plan-estimated" />
          <span className="plan-menu-body">
            <span className="plan-menu-title">Display Estimated Plan</span>
            <span className="plan-menu-sub">{keys.estimate ? `${keys.estimate.text} · ` : ''}Compile without executing</span>
          </span>
        </button>
      </div>,
      host
    )}
  </>
}

/**
 * A query document's own bar holds Execute (morphing to Cancel with live elapsed time while running), the anchored
 * Execution Scope pill, the unified Plan ▾ menu, Client Statistics and the connection pickers, mounted inside the SQL
 * document below its editor group's tab strip. One tab stop enters the toolbar, then the arrow keys, Home and End move
 * between enabled controls. Pickers keep Up and Down and open with Alt+Down. When a control becomes disabled, focus
 * moves to its nearest enabled neighbor. F5 runs the query from the bar or editor. With the classic toolbar enabled,
 * it hosts these controls instead.
 */
export default function QueryBar({ tabId, onActivate }: { tabId?: string; onActivate?: () => void }) {
  const { commands, documents } = useWorkbench()
  const { tab, model, running, startedAt } = useQueryContext(tabId)
  const scope = useExecutionScope(tabId)
  const now = useTicker(running, 100)
  const elapsed = running && startedAt !== undefined ? formatElapsed(now - startedAt) : undefined
  const isMulti = !!tab?.multiMode
  const isCross = tab?.multiMode === 'cross'
  const commandArgs: CommandArgs | undefined = tabId && tab ? {
    tabId,
    state: {
      activeDocumentIsQuery: documentKind(tab) === 'sql',
      activeDocumentProvider: documentProvider(tab),
      activeDocumentConnected: model.live,
      activeDocumentIsMultiServer: isMulti,
      activeDocumentCrossFile: isCross && tab.crossView === 'file',
      queryRunning: running,
      includeActualPlan: documentKind(tab) === 'sql' && !isMulti && !!tab.includeActualPlan,
      includeLivePlan: documentKind(tab) === 'sql' && !isMulti && !!tab.includeLivePlan,
      includeClientStatistics: documentKind(tab) === 'sql' && !isMulti && !!tab.includeClientStatistics
    }
  } : undefined
  const canExecute = useCommandEnabled('query.execute', commandArgs) && (!isMulti || model.live)
  const canCancel = useCommandEnabled('query.cancel', commandArgs)
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
  const multiUnreadyHint = isCross
    ? 'Select at least 1 connected SQL Server and 1 connected BigQuery target to execute.'
    : 'Select at least 1 connected target to execute.'
  return <div className="query-bar" role="toolbar" aria-label="SQL Editor" data-query-bar="" data-tab-id={tabId} data-multi-server={isMulti ? '' : undefined} data-cross-engine={isCross ? '' : undefined} data-connection-accent={accent ? '' : undefined} style={accentStyle} ref={bar} onKeyDown={onKeyDown} onFocus={onFocus} onBlur={onBlur}>
    <div className="query-bar-actions">
      {/* Same button element across Execute ↔ Cancel so keyboard focus rides the morph without dropping to body. */}
      <button type="button"
        className={running ? 'ui-button query-bar-action cancel' : 'ui-button query-bar-action execute primary'}
        aria-label={running ? 'Cancel' : scope.label}
        aria-keyshortcuts={running ? keys.cancel?.aria : keys.execute?.aria}
        disabled={running ? !canCancel : !canExecute}
        title={running
          ? withKey('Cancel Executing Query', keys.cancel)
          : isMulti && !model.live
            ? multiUnreadyHint
            : model.connection?.lost ? lostHint : withKey(scope.selected ? `${scope.label} · ${scope.detail}` : scope.label, keys.execute)}
        onPointerDown={keepFocus}
        onClick={() => { beforeButtonExecute(); void commands.execute(running ? 'query.cancel' : 'query.execute', commandArgs, 'toolbar') }}>
        {running
          ? <><Icon name="debug-stop" /><span className="query-bar-label">Cancel</span>{elapsed && <span className="query-elapsed" aria-hidden="true">{elapsed}</span>}</>
          : <><Icon name="play" /><span className="query-bar-label">{scope.label}</span>{keys.execute && <kbd aria-hidden="true">{keys.execute.text}</kbd>}</>}
      </button>
      <span className="query-scope" data-selection={scope.selected ? '' : undefined} data-cross-scope={isCross ? '' : undefined} title={scope.tooltip ?? (scope.selected ? `Execution scope: ${scope.detail}` : 'Execution scope: Entire query')}>{scope.pill}</span>
      {isCross && <span className="query-readonly-pill" title="Cross-Engine queries are read-only (SELECT / WITH only).">
        <Icon name="lock" /><span className="query-readonly-label">SELECT-only</span>
      </span>}
      <BigQueryCostChip tabId={tab?.id} />
      {!isMulti && <>
        <span className="query-bar-sep" aria-hidden="true" />
        <PlanMenuButton args={commandArgs} onBeforeExecute={beforeButtonExecute} />
        <ClientStatisticsToggle args={commandArgs} onBeforeExecute={beforeButtonExecute} />
      </>}
    </div>
    <div className="query-connection" role="group" aria-label={isMulti ? 'Targets' : 'Connection'} data-multi-server={isMulti ? '' : undefined} data-lost={!isMulti && model.connection?.lost || undefined} data-connection-accent={accent ? '' : undefined} style={accentStyle}>
      {isMulti && tab ? <MultiTargetPopover tabId={tab.id} variant="bar" onActivate={() => activate(false)} /> : <>
        {accent && <span className="connection-swatch" style={{ background: accent }} aria-hidden="true" />}
        {tag && <span className="query-bar-environment"><span className="visually-hidden">Environment: </span><EnvironmentTag environment={environment} place="query" about={model.serverName} /></span>}
        <QueryPickers variant="bar" tabId={tabId} onActivate={() => activate(false)} />
      </>}
    </div>
  </div>
}
