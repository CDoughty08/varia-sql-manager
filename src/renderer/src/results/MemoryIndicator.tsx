import { useCallback, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import type { MemoryFeature } from '../../../shared/ipc/port-messages'
import { SnapshotStore } from '../core/store'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import { modalOpen } from '../core/modal'
import { watchModals } from '../core/windows'
import Icon from '../Icon'
import { memoryLevel, memoryTotalLabel, type MemoryUsage, type MemoryUsageService } from './memory'
import { anyCompressed, indexNerdMetrics, indexStoreLine, nerdMetrics, panelBytes, resultNames, resultTargets, type ResultTarget } from './memory-details'
import { IndexDetails, NerdDetails, NerdMetrics } from './NerdMetrics'
import { SavedTrend } from './SavedTrend'

// Fallback store for isolated unit tests that mount MemoryIndicator without a QueriesService.
const emptyQueries = new SnapshotStore<Readonly<Record<string, { readonly running?: unknown }>>>({})

// Chromium handles Escape through close requests, independently of the panel's visual layer.
declare const CloseWatcher: new () => EventTarget & { destroy(): void }

const labels = { index: 'Search Indexer', results: 'Results' }
const levelLabels = { unavailable: 'Unavailable', normal: 'Normal', warning: 'Near limit', critical: 'Critical' }

/** What compression gave back: the bytes and the rows as read they stand for, while any page is compressed. */
interface Packed { readonly givenBack: number; readonly logicalBytes: number; readonly memoryBytes: number }

function reading(feature: MemoryFeature, memory: MemoryUsage) {
  const level = memoryLevel(memory, feature)
  const percent = memory.globalBytes > 0 ? 100 * memory.usedBytes / memory.globalBytes : 0
  const percentage = percent > 0 && percent < 1 ? '<1%' : `${Math.floor(percent)}%`
  const detail = memory.detail
  // Windowed BigQuery results' block caches hold rows too, as the Nerd metrics count them: in the rows and in what holds them.
  const window = detail?.windowCacheBytes ?? 0
  const packed: Packed | undefined = detail && anyCompressed(detail)
    ? { givenBack: Math.max(0, detail.logicalBytes - detail.storedBytes - detail.cacheBytes), logicalBytes: detail.logicalBytes + window, memoryBytes: detail.storedBytes + detail.cacheBytes + window } : undefined
  // The ring's faint second tone: the rows as read on the budget's scale, beyond the memory that holds them.
  const asRead = packed && memory.globalBytes > 0 ? 100 * (memory.usedBytes + packed.givenBack) / memory.globalBytes : undefined
  return { ...memory, feature, level, percent, percentage, packed, asRead }
}

type Reading = ReturnType<typeof reading>

function Ring({ reading: { feature, percent, level, asRead } }: { reading: Reading }) {
  return <span className="memory-ring" data-feature={feature} data-level={level} data-packed={asRead === undefined ? undefined : ''}
    style={{ '--memory-fill': `${Math.min(100, percent)}%`, ...asRead === undefined ? {} : { '--memory-read': `${Math.min(100, asRead)}%` } } as CSSProperties} aria-hidden="true" />
}

function MemoryRow({ item }: { item: Reading }) {
  const { feature, level, percentage, usedBytes, globalBytes, packed } = item
  const saved = feature === 'index' && item.store ? indexStoreLine(item.store) : undefined
  // One unit for the row, by its budget: "2.31 GB / 8.00 GB", "92 MB / 512 MB".
  const bytes = panelBytes(globalBytes)
  const available = level !== 'unavailable'
  const note = feature === 'index'
    ? level === 'critical' ? 'Objects or databases may be skipped.' : level === 'warning' ? 'Module definitions may be omitted.' : 'Shared across connections.'
    : level === 'warning' || level === 'critical' ? 'New results may be truncated.' : ''
  const action = feature === 'index' ? 'Disconnect a server to release its index.' : 'Close result sets or query tabs to free memory.'
  return <section className="memory-row" data-feature={feature} data-level={level}>
    <Ring reading={item} />
    <h3>{labels[feature]}</h3>
    <span className="memory-level">{available ? `${percentage} · ` : ''}{levelLabels[level]}</span>
    {available && <>
      <span className="memory-usage">{bytes(usedBytes)} / {bytes(globalBytes)}</span>
      <span className="memory-remaining">{bytes(Math.max(0, globalBytes - usedBytes))} left</span>
      {packed && <span className="memory-packed">
        <span className="memory-packed-chip">−{bytes(packed.givenBack)} packed</span> {bytes(packed.logicalBytes)} of rows held in {bytes(packed.memoryBytes)}
      </span>}
      <p>{note ? note + ' ' : ''}{action}</p>
      {saved && <span className="memory-store" data-store={saved.mode}>
        <Icon name={saved.icon} /><span className="memory-store-label">Saved on disk</span>
        {saved.usage && <span className="memory-store-usage">{saved.usage}</span>}<span className="memory-store-state">{saved.state}</span>
      </span>}
    </>}
  </section>
}

const nerdKey = 'environment.statusBar.memoryNerdMetrics'

/** The section, mounted only while the panel shows: it follows the setting, so the status bar never re-renders for it
 *  while the panel is closed. Collapsed, it reads nothing else. */
function NerdSection({ memory, service, pinned, onFocusFallback }: { memory: MemoryUsage; service: MemoryUsageService; pinned: boolean; onFocusFallback: () => void }) {
  const { settings } = useWorkbench()
  const open = useServiceSnapshot(settings).values[nerdKey]
  // One NerdMetrics whatever the state, so the heading's button keeps focus when Enter or Space opens or closes it.
  return <NerdMetrics open={open} pinned={pinned} onToggle={() => void settings.toggle(nerdKey)}
    trend={open && anyCompressed(memory.detail) ? <SavedTrend memory={service} /> : undefined}>
    {open && <OpenNerdBody memory={memory} pinned={pinned} onFocusFallback={onFocusFallback} />}
  </NerdMetrics>
}

/** The open section's body: only now does it follow the Results tabs and documents that name the largest results, and
 *  the Search Indexer's detail below them. */
function OpenNerdBody({ memory, pinned, onFocusFallback }: { memory: MemoryUsage; pinned: boolean; onFocusFallback: () => void }) {
  const { results, documents, indexMemory, queries } = useWorkbench()
  const { index } = useServiceSnapshot(indexMemory)
  const indexModel = useMemo(() => index && indexNerdMetrics(index), [index])
  const tabs = useServiceSnapshot(results)
  const queryState = useServiceSnapshot(queries ?? emptyQueries)
  const { documents: docs } = useServiceSnapshot(documents)
  const { detail, generation } = memory
  // Entries just released from this panel, hidden immediately so a removed row never flashes "Unlisted result" before
  // the backend's next results.memory report arrives.
  const [released, setReleased] = useState<ReadonlySet<string>>(() => new Set())
  const isTabRunning = useCallback((tabId: string) => !!queryState[tabId]?.running, [queryState])
  const targets = useMemo(() => typeof results.removeEntry === 'function' ? resultTargets(tabs, generation, isTabRunning) : undefined, [results, tabs, generation, isTabRunning])
  const canCloseAll = useMemo(() => {
    if (typeof results.closeAllResults !== 'function') return false
    return Object.entries(tabs).some(([tabId, tab]) =>
      !tab.bare && tab.status !== 'running' && tab.status !== 'closed' && !isTabRunning(tabId)
      && (tab.sets.length > 0 || (tab.planSets?.length ?? 0) > 0))
  }, [results, tabs, isTabRunning])
  const model = useMemo(() => {
    if (!detail) return undefined
    const effective = generation !== undefined && released.size > 0
      ? { ...detail, largest: detail.largest.filter(entry => !released.has(`${generation}:${entry.resultId}`)) }
      : detail
    const names = new Map(docs.map(document => [document.id, document.name]))
    return nerdMetrics(effective, resultNames(tabs, id => names.get(id), generation))
  }, [detail, generation, tabs, docs, released])
  const handleRemove = useCallback((resultId: number, target: ResultTarget) => {
    if (typeof results.removeEntry !== 'function') return false
    const owned = typeof results.closing === 'function'
      ? results.closing(target.tabId, target.entryKey).map(entry => entry.descriptor.resultId)
      : [resultId]
    const removed = results.removeEntry(target.tabId, target.entryKey)
    if (removed === false) return false
    if (generation !== undefined) {
      setReleased(current => {
        const next = new Set(current)
        next.add(`${generation}:${resultId}`)
        for (const id of owned) next.add(`${generation}:${id}`)
        return next
      })
    }
    return true
  }, [results, generation])
  const handleCloseAll = useCallback(() => {
    if (typeof results.closeAllResults !== 'function') return
    const closingIds: number[] = []
    if (generation !== undefined) {
      for (const [tabId, tab] of Object.entries(tabs)) {
        if (tab.bare || tab.status === 'running' || tab.status === 'closed' || isTabRunning(tabId)) continue
        for (const set of tab.sets) if (set.descriptor.generation === generation) closingIds.push(set.descriptor.resultId)
      }
    }
    const closed = results.closeAllResults(isTabRunning)
    if (closed > 0 && generation !== undefined && closingIds.length > 0) {
      setReleased(current => {
        const next = new Set(current)
        for (const id of closingIds) next.add(`${generation}:${id}`)
        return next
      })
    }
  }, [results, tabs, generation, isTabRunning])
  return <>
    {model ? <NerdDetails model={model} pinned={pinned} targets={targets} onRemove={targets ? handleRemove : undefined} canCloseAll={canCloseAll} onCloseAll={canCloseAll ? handleCloseAll : undefined} onFocusFallback={onFocusFallback} />
      : <p className="memory-nerd-empty">Waiting for the backend's first report.</p>}
    {indexModel && <IndexDetails model={indexModel} />}
  </>
}

const tabbableSelector = 'button, input, select, textarea, a[href], [tabindex], [contenteditable="true"]'
/** The elements Tab stops at in the page's order, outside `skip` and other than `except`. */
function tabbables(doc: Document, skip: HTMLElement, except?: HTMLElement | null): HTMLElement[] {
  return [...doc.querySelectorAll<HTMLElement>(tabbableSelector)].filter(element => element !== except && !skip.contains(element) && element.tabIndex >= 0
    && !(element as HTMLButtonElement).disabled && !element.closest('[inert], fieldset:disabled') && element.getClientRects().length > 0)
}
/** Where Tab goes on from `from` outside `skip`: the next stop in the page's order, wrapping to the first. */
function onward(from: HTMLElement, skip: HTMLElement, except?: HTMLElement | null): HTMLElement | undefined {
  const stops = tabbables(from.ownerDocument, skip, except)
  return stops.find(element => from.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING) ?? stops[0]
}

export default function MemoryIndicator() {
  const { indexMemory, resultMemory, menus } = useWorkbench()
  const indexUsage = useServiceSnapshot(indexMemory)
  const index = reading('index', indexUsage)
  const resultUsage = useServiceSnapshot(resultMemory)
  const results = reading('results', resultUsage)
  const readings = [index, results]
  const totalLabel = memoryTotalLabel(indexUsage, resultUsage)
  const alert = readings.some(item => item.level === 'critical') ? 'critical' : readings.some(item => item.level === 'warning') ? 'warning' : undefined
  const summary = readings.map(item => `${labels[item.feature]} ${item.level === 'unavailable' ? 'unavailable' : item.percentage}`).join(', ')
  const [mode, setMode] = useState<'preview' | 'pinned'>()
  const open = mode !== undefined
  const group = useRef<HTMLDivElement>(null), panel = useRef<HTMLElement>(null), trigger = useRef<HTMLButtonElement>(null), enter = useRef<HTMLSpanElement>(null), pressed = useRef(false)
  const id = useId(), heading = useId()
  const peek = () => { if (!modalOpen() && !menus.ownsKeyboard()) setMode(current => current ?? 'preview') }
  /** Focus inside the panel goes back to the Memory control before the panel hides, rather than to the page's body. */
  const keepFocus = () => { if (panel.current?.contains(panel.current.ownerDocument.activeElement)) trigger.current?.focus({ preventScroll: true }) }
  const endPreview = () => { if (mode === 'preview') { keepFocus(); setMode(undefined) } }
  const focusPanelHeader = useCallback(() => {
    const headerButton = panel.current?.querySelector<HTMLElement>('.memory-nerd-toggle')
    if (headerButton && headerButton.tabIndex >= 0) { headerButton.focus({ preventScroll: true }); return }
    trigger.current?.focus({ preventScroll: true })
  }, [])

  useLayoutEffect(() => {
    const trigger = group.current, details = panel.current
    if (!open || !trigger || !details) return
    const dismiss = () => setMode(undefined)
    if (modalOpen() || menus.ownsKeyboard()) { dismiss(); return }
    // Escape returns focus to the Memory control; a press elsewhere, a menu or a dialog takes focus where it goes.
    const escape = () => { keepFocus(); dismiss() }
    const doc = details.ownerDocument
    const outside = (event: PointerEvent) => {
      const path = event.composedPath()
      if (!path.includes(trigger) && !path.includes(details)) dismiss()
    }
    doc.addEventListener('pointerdown', outside, true)
    const watcher = new CloseWatcher()
    watcher.addEventListener('close', escape)
    const observer = watchModals(doc, dismiss)
    const stopWatchingMenus = menus.controller.subscribe(() => { if (menus.ownsKeyboard()) dismiss() })
    return () => {
      doc.removeEventListener('pointerdown', outside, true)
      watcher.destroy()
      stopWatchingMenus()
      observer.dispose()
    }
  }, [menus, open])

  return <div ref={group} className="memory-status"
    onPointerEnter={event => { if (event.pointerType !== 'touch') peek() }}
    onPointerLeave={() => { if (!group.current?.querySelector(':focus-visible') && !panel.current?.matches(':focus-visible')) endPreview() }}
    onBlur={event => {
      if (group.current?.contains(event.relatedTarget) || panel.current?.contains(event.relatedTarget)) return
      if (!group.current?.matches(':hover') && !panel.current?.matches(':hover')) endPreview()
    }}>
    <button ref={trigger} type="button" className="memory-indicator" data-level={alert}
      aria-label={`Memory usage${totalLabel ? `, ${totalLabel}` : ''}. ${summary}.${alert ? ` ${levelLabels[alert]}.` : ''}`} aria-expanded={open} aria-controls={id}
      onFocus={event => { if (event.currentTarget.matches(':focus-visible')) peek() }}
      onClick={() => { if (!modalOpen() && !menus.ownsKeyboard()) setMode(current => current === 'pinned' ? undefined : 'pinned') }}>
      {alert && <Icon name="warning" />}
      {readings.map(item => <Ring key={item.feature} reading={item} />)}
      <span className="memory-indicator-label">{totalLabel ?? 'Memory'}</span>
    </button>
    {/* The panel is portaled to the end of the page, so while it is pinned these stops carry Tab into it right after the
        Memory control, and out of it back to what follows the control. Each only hands focus on: no key listener. */}
    {mode === 'pinned' && <span ref={enter} tabIndex={0} className="visually-hidden"
      onFocus={() => panel.current?.querySelector<HTMLElement>('.memory-nerd-toggle')?.focus({ preventScroll: true })} />}
    {/* Escape the footer's clipping while letting other workbench surfaces take priority. */}
    {/* A press inside a preview pins it: the pointer leaving no longer closes what the user is working in. */}
    {createPortal(<section ref={panel} id={id} className="memory-details" hidden={!open} aria-labelledby={heading}
      onPointerDown={() => { pressed.current = true; setMode(current => current === 'preview' ? 'pinned' : current) }}>
      {/* Which way focus came decides where a stop sends it: from inside the panel it leaves (back to the Memory control,
          or on to what follows it); from the page it was passing by, so it goes on (forward) or into the panel (backward).
          With nothing focused before (a press on the panel's text), Tab starts from the press: at the start stop that is
          only Shift+Tab, and at the end stop a press inside means leaving. */}
      {mode === 'pinned' && <span tabIndex={0} className="visually-hidden" onFocus={event => {
        const from = event.relatedTarget, details = panel.current!
        pressed.current = false
        if (from === null || (from instanceof Node && details.contains(from))) trigger.current?.focus({ preventScroll: true })
        else onward(details, details, enter.current)?.focus({ preventScroll: true })
      }} />}
      <div className="memory-heading"><h2 id={heading}>Memory usage</h2><span>SQL backend</span></div>
      {readings.map(item => <MemoryRow key={item.feature} item={item} />)}
      {open && <NerdSection memory={resultUsage} service={resultMemory} pinned={mode === 'pinned'} onFocusFallback={focusPanelHeader} />}
      {mode === 'pinned' && <span tabIndex={0} className="visually-hidden" onFocus={event => {
        const from = event.relatedTarget, details = panel.current!, leaving = from === null ? pressed.current : from instanceof Node && details.contains(from)
        pressed.current = false
        if (!leaving) {
          const inner = [...details.querySelectorAll<HTMLElement>('button:not(:disabled)')].filter(element => element.tabIndex >= 0)
          ;(inner.at(-1) ?? details.querySelector<HTMLElement>('.memory-nerd-toggle'))?.focus({ preventScroll: true })
        } else onward(enter.current ?? details, details, enter.current)?.focus({ preventScroll: true })
      }} />}
    </section>, document.body)}
  </div>
}
