import { useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import type { MemoryFeature } from '../../../shared/ipc/port-messages'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import { modalOpen } from '../core/modal'
import { watchModals } from '../core/windows'
import Icon from '../Icon'
import { memoryLevel, type MemoryUsage, type MemoryUsageService } from './memory'
import { anyCompressed, nerdMetrics, panelBytes, resultNames } from './memory-details'
import { NerdDetails, NerdMetrics } from './NerdMetrics'
import { SavedTrend } from './SavedTrend'

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
  const packed: Packed | undefined = detail && anyCompressed(detail)
    ? { givenBack: Math.max(0, detail.logicalBytes - detail.storedBytes - detail.cacheBytes), logicalBytes: detail.logicalBytes, memoryBytes: detail.storedBytes + detail.cacheBytes } : undefined
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
    </>}
  </section>
}

const nerdKey = 'environment.statusBar.memoryNerdMetrics'

/** The section, mounted only while the panel shows: it follows the setting, so the status bar never re-renders for it
 *  while the panel is closed. Collapsed, it reads nothing else. */
function NerdSection({ memory, service, pinned }: { memory: MemoryUsage; service: MemoryUsageService; pinned: boolean }) {
  const { settings } = useWorkbench()
  const open = useServiceSnapshot(settings).values[nerdKey]
  // One NerdMetrics whatever the state, so the heading's button keeps focus when Enter or Space opens or closes it.
  return <NerdMetrics open={open} pinned={pinned} onToggle={() => void settings.toggle(nerdKey)}
    trend={open && anyCompressed(memory.detail) ? <SavedTrend memory={service} /> : undefined}>
    {open && <OpenNerdBody memory={memory} />}
  </NerdMetrics>
}

/** The open section's body: only now does it follow the Results tabs and documents that name the largest results. */
function OpenNerdBody({ memory }: { memory: MemoryUsage }) {
  const { results, documents } = useWorkbench()
  const tabs = useServiceSnapshot(results)
  const { documents: docs } = useServiceSnapshot(documents)
  const { detail, generation } = memory
  const model = useMemo(() => {
    if (!detail) return undefined
    const names = new Map(docs.map(document => [document.id, document.name]))
    return nerdMetrics(detail, resultNames(tabs, id => names.get(id), generation))
  }, [detail, generation, tabs, docs])
  return model ? <NerdDetails model={model} /> : <p className="memory-nerd-empty">Waiting for the backend's first report.</p>
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
  const index = reading('index', useServiceSnapshot(indexMemory))
  const resultUsage = useServiceSnapshot(resultMemory)
  const results = reading('results', resultUsage)
  const readings = [index, results]
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
      aria-label={`Memory usage. ${summary}.${alert ? ` ${levelLabels[alert]}.` : ''}`} aria-expanded={open} aria-controls={id}
      onFocus={event => { if (event.currentTarget.matches(':focus-visible')) peek() }}
      onClick={() => { if (!modalOpen() && !menus.ownsKeyboard()) setMode(current => current === 'pinned' ? undefined : 'pinned') }}>
      {alert && <Icon name="warning" />}
      {readings.map(item => <Ring key={item.feature} reading={item} />)}
      <span>Memory</span>
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
      {open && <NerdSection memory={resultUsage} service={resultMemory} pinned={mode === 'pinned'} />}
      {mode === 'pinned' && <span tabIndex={0} className="visually-hidden" onFocus={event => {
        const from = event.relatedTarget, details = panel.current!, leaving = from === null ? pressed.current : from instanceof Node && details.contains(from)
        pressed.current = false
        if (!leaving) details.querySelector<HTMLElement>('.memory-nerd-toggle')?.focus({ preventScroll: true })
        else onward(enter.current ?? details, details, enter.current)?.focus({ preventScroll: true })
      }} />}
    </section>, document.body)}
  </div>
}
