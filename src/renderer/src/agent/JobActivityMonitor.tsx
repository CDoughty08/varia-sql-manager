// Job Activity Monitor (AG-3, docs/sql-server-agent.md): the header (where, the live pill and Refresh), Agent's banner while it
// cannot run jobs, slim 52px clickable KPI tiles, the single grouped toolbar (FilterBox, Clear filters, selection count, Start, Stop,
// Enable / Disable ▾, More actions ▾, and right-pinned Last run), the live grid of jobs, the split Last Run drawer with inline
// step message preview, and bulk forms / result lines. JobActivityService keeps every state; this only draws it.
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { agentLimits } from '../../../shared/agent/catalog'
import {
  agentBanner, agentBulkCommands, agentBulkTitles, agentJobFilterColumns, agentJobFilterLimits, agentJobTiles, agentJobsProbe, agentServiceProbe,
  agentStatusOverride, jobActivityTitle, tileValue
} from '../../../shared/agent/jobs'
import type { IconId } from '../../../shared/icons'
import { liveProbes, type LiveTone } from '../../../shared/live/catalog'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import { gridTarget } from '../grid/anchor'
import Icon from '../Icon'
import DocumentFrame from '../kit/DocumentFrame'
import EmptyState from '../kit/EmptyState'
import InlineError from '../kit/InlineError'
import { LivePill, StaleBadge } from '../kit/LivePill'
import ResizableSplit from '../kit/ResizableSplit'
import Tile, { tileName } from '../kit/Tile'
import type { LiveGrid, LiveGridSnapshot } from '../live/LiveGrid'
import { LiveGridPane, type LiveFilters } from '../live/LiveGridPane'
import { useMenuTarget } from '../menus/useMenuTarget'
import type { LiveHandle, LiveSnapshot, LiveTable } from '../live/LiveService'
import { probePillStatus } from '../live/status'
import { formatCount, plural } from '../results/status'
import { activeFilters, listProblems, pillNote, type BulkLine, type JobActivityService, type JobActivityState } from './JobActivityService'
import JobBulkForm from './JobBulkForms'

declare const CloseWatcher: (new () => EventTarget & { destroy(): void }) | undefined

const listSpec = liveProbes[agentJobsProbe]
const lastRunColumns = listSpec.tables![1]!.columns
const lastRunColIndex = Object.fromEntries(lastRunColumns.map((column, index) => [column.id, index])) as Record<string, number>
const noSubscribe = () => () => {}
const noLive: LiveSnapshot = { status: 'connecting', probes: {}, connectionId: '' }
const noLiveSnapshot = () => noLive
const emptyGridSnapshot: LiveGridSnapshot = { newRows: 0, following: true, lost: false }
const noGridSnapshot = () => emptyGridSnapshot
/** What a screen reader hears for a toned row. */
const toneWords: Partial<Record<LiveTone, string>> = { error: 'last run failed', running: 'running', warning: 'between retries', muted: 'disabled' }
const toneLabel = (tone: LiveTone): string | undefined => toneWords[tone]
const lineWords: Readonly<Record<BulkLine['state'], string>> = { waiting: 'Waiting', running: 'Running…', done: 'Done', failed: 'Failed', skipped: 'Not sent' }

interface LastRunRow {
  readonly key: string
  readonly instance: number
  readonly stepId: string
  readonly stepName: string
  readonly outcome: string
  readonly started: string
  readonly duration: string
  readonly message: string
  readonly tone: string
}

interface JamMenuItem {
  readonly id: string
  readonly label: string
  readonly icon?: IconId
  readonly disabled?: boolean
  readonly title?: string
  readonly separatorBefore?: boolean
  readonly onSelect: () => void
}

function JamToolbarMenu({ label, disabled, title, items }: {
  readonly label: string
  readonly disabled?: boolean
  readonly title?: string
  readonly items: readonly JamMenuItem[]
}) {
  const menuId = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [coords, setCoords] = useState<{ readonly top: number; readonly left: number }>()
  const openedByKeyboard = useRef(false)
  const focusTarget = useRef<'first' | 'last'>(undefined)

  const placed = !!coords
  const focusMenuItem = (target: 'first' | 'last') => {
    const popover = menu.current
    if (!popover) return
    const choices = [...popover.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
    const chosen = target === 'last' ? choices.at(-1) : choices[0]
    chosen?.focus({ preventScroll: true })
  }

  const close = (returnFocus: boolean) => {
    setOpen(false)
    setCoords(undefined)
    if (returnFocus) trigger.current?.focus({ preventScroll: true })
    openedByKeyboard.current = false
  }
  const openMenu = (keyboard: 'first' | 'last' | false) => {
    if (disabled) return
    openedByKeyboard.current = keyboard !== false
    if (open && placed && keyboard && menu.current) {
      focusTarget.current = undefined
      focusMenuItem(keyboard)
      return
    }
    focusTarget.current = keyboard || undefined
    setOpen(true)
  }

  useEffect(() => {
    if (disabled && open) { setOpen(false); setCoords(undefined) }
  }, [disabled, open])

  useLayoutEffect(() => {
    if (!open || !placed) return
    const target = focusTarget.current
    if (!target || !menu.current) return
    focusTarget.current = undefined
    focusMenuItem(target)
  }, [open, placed])

  useLayoutEffect(() => {
    if (!open) return
    const button = trigger.current, popover = menu.current
    if (!button || !popover) return
    const place = () => {
      const own = button.ownerDocument, view = own.defaultView ?? window, box = button.getBoundingClientRect()
      const inset = 8, gap = 4
      const width = popover.offsetWidth || 200, height = popover.offsetHeight || 120
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
    return () => {
      own.removeEventListener('pointerdown', onOutside, true)
      watcher?.destroy()
      view.removeEventListener('resize', place)
      own.removeEventListener('scroll', place, true)
      view.removeEventListener('blur', onBlur)
    }
  }, [open])

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
    const choices = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
    if (!choices.length) return
    const at = choices.indexOf(event.currentTarget.ownerDocument.activeElement as HTMLButtonElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1
      : event.key === 'ArrowDown' ? (at + 1) % choices.length : (at <= 0 ? choices.length - 1 : at - 1)
    event.preventDefault()
    event.stopPropagation()
    choices[next]?.focus({ preventScroll: true })
  }

  const host = open ? trigger.current?.ownerDocument.body : undefined
  return <>
    <button ref={trigger} type="button" className="activity-tool" aria-label={label} aria-haspopup="menu" aria-expanded={open}
      aria-controls={open ? menuId : undefined} disabled={disabled} title={title} onKeyDown={triggerKeyDown}
      onClick={event => {
        if (open) close(event.detail === 0)
        else openMenu(event.detail === 0 ? 'first' : false)
      }}>
      {label}<Icon name="chevron-down" />
    </button>
    {open && host && createPortal(
      <div ref={menu} id={menuId} className="agent-jobs-menu" role="menu" aria-label={label}
        style={coords ? { top: `${coords.top}px`, left: `${coords.left}px` } : { visibility: 'hidden' }}
        onKeyDown={menuKeyDown}>
        {items.map(item => <div key={item.id}>
          {item.separatorBefore && <div className="agent-jobs-menu-sep" role="separator" />}
          <button type="button" role="menuitem" className="agent-jobs-menu-item" disabled={item.disabled} title={item.title}
            onClick={event => { close(event.detail === 0); item.onSelect() }}>
            {item.icon && <Icon name={item.icon} />}<span>{item.label}</span>
          </button>
        </div>)}
      </div>,
      host
    )}
  </>
}

/** The filter box: sent when typing pauses, on Enter, or on leaving it; Escape puts back what was sent. */
function FilterBox({ id, value, onCommit }: { readonly id: string; readonly value: string; readonly onCommit: (text: string) => void }) {
  const [draft, setDraft] = useState(value)
  const commit = useRef(onCommit)
  commit.current = onCommit
  useEffect(() => setDraft(value), [value])
  // Typing settles before a filter goes out, so each keystroke is not a live.update of its own.
  useEffect(() => {
    if (draft === value) return
    const timer = window.setTimeout(() => commit.current(draft), 300)
    return () => window.clearTimeout(timer)
  }, [draft, value])
  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') { event.preventDefault(); onCommit(draft) }
    else if (event.key === 'Escape' && draft !== value) { event.preventDefault(); event.stopPropagation(); setDraft(value) }
  }
  const inputId = `agent-jobs-${id}-filter`
  return <span className="activity-filter-box">
    <Icon name="search" />
    <label htmlFor={inputId} className="visually-hidden">Filter jobs</label>
    <input id={inputId} type="search" spellCheck={false} placeholder="Filter jobs" value={draft} maxLength={128} onChange={event => setDraft(event.target.value)} onKeyDown={keyDown}
      onBlur={() => { if (draft !== value) onCommit(draft) }} />
  </span>
}

function LastRunDrawer({ connectionId, expanded, lastRun, problem, waiting, errorCode, service, handle, onRefresh, onOpenJob, onOpenHistory, onHide }: {
  readonly connectionId?: string
  readonly expanded: { readonly id: string; readonly name: string }
  readonly lastRun: LiveTable | undefined
  readonly problem?: string
  readonly waiting?: { readonly text: string; readonly failed: boolean }
  readonly errorCode?: string
  readonly service: JobActivityService
  readonly handle: LiveHandle
  readonly onRefresh: () => void
  readonly onOpenJob: () => void
  readonly onOpenHistory: () => void
  readonly onHide: () => void
}) {
  const [lastRunGrid, setLastRunGrid] = useState<LiveGrid | undefined>(undefined)
  const gridSnap = useSyncExternalStore(lastRunGrid?.subscribe ?? noSubscribe, lastRunGrid?.getSnapshot ?? noGridSnapshot, lastRunGrid?.getSnapshot ?? noGridSnapshot)
  const isWaiting = !!waiting
  const [rowsState, setRowsState] = useState<{ readonly jobId: string; readonly rows: readonly LastRunRow[] }>({ jobId: expanded.id, rows: [] })
  const [fullMessage, setFullMessage] = useState<{ readonly key: string; readonly text: string } | undefined>(undefined)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    setRowsState({ jobId: expanded.id, rows: [] })
    setFullMessage(undefined)
    setCopied(false)
  }, [isWaiting, expanded.id])

  const rows = !isWaiting && rowsState.jobId === expanded.id ? rowsState.rows : []

  const tableKey = lastRun ? `${lastRun.descriptor.generation}:${lastRun.descriptor.resultId}:${lastRun.descriptor.rowsAvailable}` : ''
  useEffect(() => {
    let cancelled = false
    if (isWaiting || !lastRun || lastRun.descriptor.rowsAvailable === 0) { setRowsState({ jobId: expanded.id, rows: [] }); return }
    const count = Math.min(lastRun.descriptor.rowsAvailable, agentLimits.stepsPerJob * 4)
    const cols = lastRunColumns.length
    void lastRun.handle.getWindow(0, count, { colStart: 0, colEnd: cols, display: false }).then(window => {
      if (cancelled) return
      const next: LastRunRow[] = []
      for (let r = 0; r < window.count; r++) {
        const cell = (col: string) => {
          const idx = r * cols + lastRunColIndex[col]!
          return (window.flags[idx] & 1) !== 0 ? '' : window.text[idx] ?? ''
        }
        const key = cell('runInstance')
        const instance = Number(key)
        next.push({
          key,
          instance: Number.isFinite(instance) ? instance : 0,
          stepId: cell('runStep'),
          stepName: cell('runStepName'),
          outcome: cell('runOutcome'),
          started: cell('runStarted'),
          duration: cell('runDuration'),
          message: cell('runMessage'),
          tone: cell('runTone')
        })
      }
      setRowsState({ jobId: expanded.id, rows: next })
    }, () => { if (!cancelled) setRowsState({ jobId: expanded.id, rows: [] }) })
    return () => { cancelled = true }
  }, [lastRun, tableKey, isWaiting, expanded.id])

  const activeRow = useMemo(() => {
    if (!rows.length) return undefined
    if (gridSnap.activeKey !== undefined) {
      const byKey = rows.find(row => row.key === gridSnap.activeKey)
      if (byKey) return byKey
    }
    const activeIndex = gridSnap.selection?.active.row
    if (activeIndex !== undefined && activeIndex >= 0 && activeIndex < rows.length) return rows[activeIndex]
    return rows.find(row => (row.tone === 'error' || row.outcome === 'Failed') && row.stepId !== '0')
      ?? rows.find(row => row.tone === 'error' || row.outcome === 'Failed')
      ?? rows[0]
  }, [rows, gridSnap.activeKey, gridSnap.selection])

  const cacheKey = activeRow ? `${expanded.id}:${activeRow.key}` : ''
  useEffect(() => {
    if (!activeRow || !connectionId) { setFullMessage(undefined); return }
    const cut = activeRow.message.length >= agentLimits.gridMessageChars && activeRow.message.endsWith('…')
    if (!cut || activeRow.instance <= 0) { setFullMessage(undefined); return }
    let cancelled = false
    void service.readLastRunMessage(connectionId, expanded.id, activeRow.instance).then(text => {
      if (!cancelled && text !== undefined) setFullMessage({ key: cacheKey, text })
    }, () => {})
    return () => { cancelled = true }
  }, [activeRow, cacheKey, connectionId, expanded.id, service])

  const previewText = activeRow ? (fullMessage?.key === cacheKey ? fullMessage.text : activeRow.message) : ''
  useEffect(() => { setCopied(false) }, [cacheKey, previewText])
  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1600)
    return () => window.clearTimeout(timer)
  }, [copied])

  const stepTitle = !activeRow ? 'Step message' : activeRow.stepId === '0' ? (activeRow.stepName || '(Job outcome)') : `Step ${activeRow.stepId} · ${activeRow.stepName}`

  return <section className="agent-last-run" aria-label={`Last run of ${expanded.name}`}>
    <div className="agent-last-run-head">
      <strong>Last run: {expanded.name}</strong>
      <div className="agent-last-run-actions">
        <button type="button" className="activity-tool" disabled={!connectionId} title={`Open ${expanded.name}`} onClick={onOpenJob}>
          <Icon name="go-to-file" />Open Job
        </button>
        <button type="button" className="activity-tool" disabled={!connectionId} title={`Open Log File Viewer for ${expanded.name}`} onClick={onOpenHistory}>
          <Icon name="history" />Log File Viewer
        </button>
      </div>
      <button type="button" aria-label="Hide the last run" title="Hide the last run" onClick={onHide}><Icon name="close" /></button>
    </div>
    {problem ? <InlineError role="status" message={problem} code={errorCode} actions={[{ label: 'Retry', run: onRefresh }]} />
      : waiting?.failed ? <InlineError role="status" message={waiting.text} code={errorCode} actions={[{ label: 'Retry', run: onRefresh }]} />
      : waiting ? <p className="agent-last-run-empty" role="status">{waiting.text}</p>
      : lastRun && lastRun.descriptor.rowsAvailable === 0 ? <p className="agent-last-run-empty">{lastRun.descriptor.truncated
        ? 'The newest history rows hold no finished run (the run in progress wrote them all), so the last run is not shown.'
        : 'This job has no finished run in its history.'}</p>
      : <ResizableSplit className="agent-last-run-split" storageKey="agent.jam.lastRunMessage" side="right" defaultWidth={440} minWidth={260} maxWidth={720} minOtherWidth={320}
        label="Resize last run message" railLabel="Step message preview"
        rail={<div className="agent-last-run-preview">
          <div className="agent-last-run-preview-head">
            <span className="agent-last-run-preview-title" title={stepTitle}>{stepTitle}</span>
            {activeRow && (activeRow.duration || activeRow.outcome) && <span className="agent-last-run-preview-meta agent-mono">{activeRow.duration || activeRow.outcome}</span>}
            <button type="button" className="activity-tool agent-last-run-copy" disabled={!previewText} onClick={() => { void service.copyText(previewText).then(ok => { if (ok) setCopied(true) }) }}>
              <Icon name="copy" />{copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <pre className="agent-last-run-message agent-mono">{previewText || 'No message recorded for this step.'}</pre>
        </div>}>
        <div className="agent-last-run-grid">
          {lastRun?.descriptor.truncated && <p className="agent-last-run-empty" role="note">Only this run's newest steps are shown: the rest are past what one read keeps.</p>}
          <LiveGridPane live={handle} probe={agentJobsProbe} table={1} label={`Last run of ${expanded.name}`}
            toneLabel={tone => tone === 'error' ? 'failed' : tone === 'running' ? 'in progress' : undefined}
            onGrid={setLastRunGrid} />
        </div>
      </ResizableSplit>}
  </section>
}

/** The bulk verbs' result lines: one per job, each with its own outcome; Stop sends no more, Close hides them once done. */
function BulkResults({ state, onStop, onClose }: { readonly state: JobActivityState; readonly onStop: () => void; readonly onClose: () => void }) {
  const bulk = state.bulk
  if (!bulk) return null
  const done = bulk.lines.filter(line => line.state === 'done').length
  const failed = bulk.lines.filter(line => line.state === 'failed').length
  const title = agentBulkTitles[bulk.verb].dialog
  return <section className="agent-bulk" aria-label={title}>
    <div className="agent-bulk-head">
      <strong>{title}</strong>
      <span>{bulk.running ? `${done + failed} of ${bulk.lines.length}` : `${done} done${failed ? `, ${failed} failed` : ''}`}</span>
      {bulk.running && <button type="button" disabled={bulk.stopping} onClick={onStop}>{bulk.stopping ? 'Stopping…' : 'Stop'}</button>}
      <button type="button" onClick={onClose} disabled={bulk.running && bulk.stopping}>Close</button>
    </div>
    <ol className="agent-bulk-lines" role="log" aria-label={`${title} results`}>
      {bulk.lines.map(line => <li key={line.id} data-state={line.state}>
        <span className="agent-bulk-name">{line.name}</span>
        <span className="agent-bulk-state">{lineWords[line.state]}</span>
        {line.message && <span className="agent-bulk-message">{line.message}</span>}
      </li>)}
    </ol>
  </section>
}

/** A Job Activity Monitor document. */
type StartAgentWorkbench = Pick<ReturnType<typeof useWorkbench>, 'explorer' | 'explorerStatus' | 'longRuns' | 'dialogs' | 'commands' | 'jobActivity'>
/** Start Agent's state in a monitor's banner, as a string that changes only when the button would (AG-10). */
function startAgentKey(workbench: StartAgentWorkbench, documentId: string): string {
  const start = workbench.jobActivity.startAgentTarget(documentId)
  return start ? `${workbench.commands.isEnabled('explorer.startAgent', start.args)}|${start.reason ?? ''}|${!!workbench.dialogs.current}` : ''
}
/** Followed only while the banner offers Start (`offered`): otherwise the tree's and the status's publishes cost nothing here. */
function useStartAgentButton(workbench: StartAgentWorkbench, documentId: string, offered: boolean): string {
  const subscribe = useCallback((listener: () => void) => {
    if (!offered) return () => {}
    const stops = [workbench.explorer.subscribe(listener), workbench.explorerStatus.subscribe(listener), workbench.longRuns.subscribe(listener), workbench.dialogs.subscribe(listener)]
    return () => stops.forEach(stop => stop())
  }, [workbench, offered])
  const snapshot = () => offered ? startAgentKey(workbench, documentId) : ''
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

export default function JobActivityMonitor({ documentId }: { readonly documentId: string }) {
  const workbench = useWorkbench()
  const service = workbench.jobActivity
  const { documents } = useServiceSnapshot(service)
  const state = documents[documentId]
  const handle = service.handle(documentId)
  const live = useSyncExternalStore(handle?.subscribe ?? noSubscribe, handle?.getSnapshot ?? noLiveSnapshot, handle?.getSnapshot ?? noLiveSnapshot)
  // The list's row menu (AG-10, agent.jobs.context through MenuService): the job verbs on the jobs selected there.
  const menuTarget = useMenuTarget<HTMLDivElement>(() => ({ kind: 'jobActivity', tabId: documentId }))
  // Start in the Agent-stopped banner (AG-10) follows the Agent node's service verb and its rules (a Linux server, Varia off Windows, a cluster).
  // A start, stop or restart beginning or ending, a status sample or a dialog opening changes it without changing the monitor's own
  // state: the monitor redraws when the button's enabled state or reason changes, not on every tree or status publish.
  const offered = service.startAgentOffered(documentId)
  useStartAgentButton(workbench, documentId, offered)
  if (!state || !handle) return <EmptyState className="workspace-empty" icon="agent-activity" title={jobActivityTitle} detail="This document has closed." />
  const probe = live.probes[agentJobsProbe]
  const table = handle.table(agentJobsProbe, 0)
  const lastRun = handle.table(agentJobsProbe, 1)
  const rows = table?.descriptor.rowsAvailable
  const end = service.ended(documentId)
  // Tiles and the Status note keep the last reading while lost (it is what the grid shows); the banner and pill wait.
  const availability = service.availability(documentId), shown = service.shownAvailability(documentId)
  const start = offered ? service.startAgentTarget(documentId) : undefined
  const canStart = !!start && workbench.commands.isEnabled('explorer.startAgent', start.args)
  const startWhy = canStart ? undefined : start?.reason ?? (workbench.dialogs.current ? 'Close the open dialog first.' : 'Start SQL Server Agent is not available right now.')
  const banner = agentBanner(shown, state.service, !!start, state.linux)
  const override = agentStatusOverride(availability)
  const problems = listProblems(probe)
  const waiting = service.lastRunWaiting(documentId)
  const failure = !end ? problems.failure : undefined
  const unavailable = probe?.state === 'unavailable' ? probe.note ?? 'Job Activity Monitor is not available on this server.' : undefined
  const stale = !end && problems.stale ? { since: probe?.lastSampleAt ?? Date.now() } : undefined
  const filtersOn = activeFilters(state)
  const selected = state.selected
  const bulkWhy = service.bulkUnavailable(documentId)
  const one = selected.length === 1 ? selected[0] : undefined
  const expandedHere = !!one && state.expanded?.id === one.id
  const filters: LiveFilters = {
    columns: agentJobFilterColumns,
    filters: state.columnFilters,
    facet: column => state.facets[column],
    apply: (column, next) => service.setColumnFilter(documentId, column as typeof agentJobFilterColumns[number], next),
    clear: () => { for (const column of agentJobFilterColumns) service.setColumnFilter(documentId, column, undefined) },
    maxValues: agentJobFilterLimits.values
  }
  const verbs = [{ command: 'agent.refreshJobs' as const, args: { tabId: documentId }, label: 'Refresh' }]
  const pillProbe = live.probes[agentJobsProbe] ? agentJobsProbe : agentServiceProbe
  // While Agent cannot run jobs the pill says so in place of the interval: the list's rows are msdb's last reading.
  const note = pillNote(shown, end)
  const pill = note ? <span className="live-pill" data-state="paused"><Icon name={end?.denied ? 'lock' : 'warning'} /><span>{note}</span></span>
    : <LivePill {...probePillStatus(live, pillProbe, listSpec.intervalMs.default)} />
  const enableMenuItems: JamMenuItem[] = [
    {
      id: 'enable', label: agentBulkTitles.enable.button, icon: 'check', disabled: !!bulkWhy, title: bulkWhy ?? agentBulkTitles.enable.dialog,
      onSelect: () => void workbench.commands.execute(agentBulkCommands.enable, { tabId: documentId }, 'toolbar')
    },
    {
      id: 'disable', label: agentBulkTitles.disable.button, icon: 'circle-slash', disabled: !!bulkWhy, title: bulkWhy ?? agentBulkTitles.disable.dialog,
      onSelect: () => void workbench.commands.execute(agentBulkCommands.disable, { tabId: documentId }, 'toolbar')
    }
  ]
  const moreMenuItems: JamMenuItem[] = [
    {
      id: 'changeOwner', label: agentBulkTitles.changeOwner.button, icon: 'person', disabled: !!bulkWhy, title: bulkWhy ?? agentBulkTitles.changeOwner.dialog,
      onSelect: () => void workbench.commands.execute(agentBulkCommands.changeOwner, { tabId: documentId }, 'toolbar')
    },
    {
      id: 'attachSchedule', label: agentBulkTitles.attachSchedule.button, icon: 'agent-schedule', disabled: !!bulkWhy, title: bulkWhy ?? agentBulkTitles.attachSchedule.dialog,
      onSelect: () => void workbench.commands.execute(agentBulkCommands.attachSchedule, { tabId: documentId }, 'toolbar')
    },
    {
      id: 'viewHistory', label: 'View history', icon: 'history', separatorBefore: true, disabled: !selected.length || state.overCap,
      title: selected.length ? 'Open the Log File Viewer with the selected jobs checked' : 'Select one or more jobs to view their history',
      onSelect: () => void workbench.commands.execute('agent.viewHistory', { tabId: documentId }, 'toolbar')
    },
    {
      id: 'createJobLike', label: 'Create Job Like This…', icon: 'copy', disabled: !one,
      title: one ? `Create a job like ${one.name}` : 'Select one job to create a job like it',
      onSelect: () => void workbench.commands.execute('agent.createJobLike', { tabId: documentId }, 'toolbar')
    }
  ]
  return <DocumentFrame id={`agent-jobs-${documentId}`} title={jobActivityTitle} subtitle="SQL Server Agent"
    crumbs={[{ label: state.label }, { label: 'SQL Server Agent' }]}
    state={pill}
    tools={stale && <StaleBadge updatedAt={probe?.lastSampleAt} stale={stale} />} verbs={verbs} attributes={{ 'data-agent-jobs': documentId }}>
    <div className="agent-jobs">
      {banner && <div className="agent-banner" role="status"><Icon name="warning" /><span>{banner.text}</span>
        {banner.start && start && <button type="button" className="agent-banner-start" disabled={!canStart} title={startWhy ?? 'Start SQL Server Agent'}
          onClick={() => void workbench.commands.execute('explorer.startAgent', start.args, 'toolbar')}><Icon name="play" />Start Agent…</button>}
      </div>}
      {end ? <div className="agent-jobs-ended">
        {end.denied ? <div role="status"><EmptyState icon="lock" title="No access to SQL Server Agent" detail={end.message} /></div>
          : <InlineError role="status" message={end.message} code={end.code} actions={[{ label: 'Retry', run: () => service.refresh(documentId) }]} />}
      </div> : <>
        {failure && <InlineError role="status" message={failure.message} code={failure.code} actions={[{ label: 'Retry', run: () => service.refresh(documentId) }]} />}
        <div className="agent-tiles" role="group" aria-label="Job counts">
          {agentJobTiles.map(tile => {
            const raw = tileValue(tile, state.counts?.[tile.series], availability)
            const value = raw === undefined ? undefined : raw === '—' ? '—' : formatCount(raw)
            const pressed = service.tilePressed(documentId, tile.applies)
            return <button key={tile.id} type="button" className="agent-tile" data-tone={tile.tone} aria-pressed={pressed} aria-label={tileName({ caption: tile.label, value })}
              title={pressed ? 'Show every job' : `Show only ${tile.label.toLowerCase()} jobs`} onClick={() => service.applyTile(documentId, tile.applies)}>
              <Tile caption={tile.label} value={value} />
            </button>
          })}
        </div>
        <div className="agent-jobs-toolbar" role="toolbar" aria-label="Job actions">
          <FilterBox id={documentId} value={state.text} onCommit={text => service.setText(documentId, text)} />
          <button type="button" className="activity-tool icon-only" disabled={filtersOn === 0} onClick={() => service.clearFilters(documentId)}
            aria-label="Clear filters" title="Clear filters: the view, the filter box and the column filters"><Icon name="clear-all" /></button>
          <span className="agent-jobs-toolbar-sep" aria-hidden="true" />
          <span className="agent-bulk-count">{state.overCap ? `More than ${formatCount(selected.length)} jobs selected: select at most ${formatCount(selected.length)}` : selected.length ? `${formatCount(selected.length)} ${plural(selected.length, 'job')} selected` : 'Select a job'}</span>
          <button type="button" className="activity-tool" disabled={!!bulkWhy} title={bulkWhy ?? agentBulkTitles.startJob.dialog}
            onClick={() => void workbench.commands.execute(agentBulkCommands.startJob, { tabId: documentId }, 'toolbar')}><Icon name="play" />{agentBulkTitles.startJob.button}</button>
          <button type="button" className="activity-tool" disabled={!!bulkWhy} title={bulkWhy ?? agentBulkTitles.stopJob.dialog}
            onClick={() => void workbench.commands.execute(agentBulkCommands.stopJob, { tabId: documentId }, 'toolbar')}><Icon name="debug-stop" />{agentBulkTitles.stopJob.button}</button>
          <JamToolbarMenu label="Enable / Disable" disabled={!!bulkWhy} title={bulkWhy ?? 'Enable or disable selected jobs'} items={enableMenuItems} />
          <JamToolbarMenu label="More actions" disabled={!selected.length || state.overCap} title={selected.length ? 'More actions for the selected jobs' : 'Select one or more jobs'} items={moreMenuItems} />
          <button type="button" className="activity-tool agent-chevron" aria-expanded={expandedHere} disabled={!one} title={one ? 'Show the last run of the selected job below the list' : 'Select one job to see its last run'}
            onClick={() => service.toggleExpanded(documentId, one)}><Icon name={expandedHere ? 'chevron-down' : 'chevron-right'} />Last run</button>
        </div>
        <JobBulkForm id={documentId} service={service} form={state.form} />
        <div className="agent-jobs-grid" ref={menuTarget} onDoubleClick={event => {
          // Only on a job's row (GridView's own hit test): a header's border fits its column, and the area below the rows is no job.
          // The grid's pointer layer lies over its rows, so every element under the pointer is asked, not just the event's target.
          const root = (event.target as Element).closest('[role="grid"]')
          const onRow = !!root && root.ownerDocument.elementsFromPoint(event.clientX, event.clientY).some(element => root.contains(element) && gridTarget(root, element).target?.row !== undefined)
          if (onRow) void workbench.commands.execute('agent.openJob', { tabId: documentId }, 'toolbar')
        }}>
          {unavailable ? <EmptyState icon="agent-activity" title="Job Activity Monitor is not available" detail={unavailable} />
            : <>
              <LiveGridPane live={handle} probe={agentJobsProbe} label="Jobs" toneLabel={toneLabel} filters={filters} state={service.gridState(documentId)} onGrid={grid => service.attachGrid(documentId, grid)} />
              {rows === 0 && <EmptyState className="agent-jobs-empty" icon="agent-activity"
                title={filtersOn ? 'No jobs match the filters' : 'No jobs'}
                detail={filtersOn ? 'Clear the filters to see every job this login can see.' : 'msdb shows this login no SQL Server Agent jobs: a SQLAgentUserRole member sees only the jobs it owns.'}
                actions={filtersOn ? [{ label: 'Clear filters', run: () => service.clearFilters(documentId), primary: true }] : []} />}
            </>}
        </div>
        {override && <p className="agent-jobs-note" role="note">Status: {override}. The Status column shows msdb's last reading.</p>}
        {state.expanded && <LastRunDrawer
          connectionId={state.connectionId}
          expanded={state.expanded}
          lastRun={lastRun}
          problem={problems.lastRun}
          waiting={waiting}
          errorCode={probe?.error?.code}
          service={service}
          handle={handle}
          onRefresh={() => service.refresh(documentId)}
          onOpenJob={() => { if (state.connectionId && state.expanded) workbench.jobDocuments.openJob(state.connectionId, state.expanded.name) }}
          onOpenHistory={() => { if (state.connectionId && state.expanded) workbench.logViewer.open(state.connectionId, { jobs: [state.expanded.id] }) }}
          onHide={() => { service.toggleExpanded(documentId, undefined); service.focus(documentId) }}
        />}
      </>}
      <BulkResults state={state} onStop={() => service.stopBulk(documentId)} onClose={() => service.closeBulk(documentId)} />
    </div>
  </DocumentFrame>
}
