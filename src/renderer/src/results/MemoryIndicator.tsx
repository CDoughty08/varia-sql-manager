import { useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import type { MemoryFeature } from '../../../shared/ipc/port-messages'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import { modalOpen } from '../core/modal'
import { watchModals } from '../core/windows'
import Icon from '../Icon'
import { memoryLevel, type MemoryUsage } from './memory'
import { formatBytes } from './status'

// Chromium handles Escape through close requests, independently of the panel's visual layer.
declare const CloseWatcher: new () => EventTarget & { destroy(): void }

const labels = { index: 'Search Indexer', results: 'Results' }
const levelLabels = { unavailable: 'Unavailable', normal: 'Normal', warning: 'Near limit', critical: 'Critical' }
const bytes = (value: number) => value === 0 ? '0 MB' : formatBytes(value)

function reading(feature: MemoryFeature, memory: MemoryUsage) {
  const level = memoryLevel(memory, feature)
  const percent = memory.globalBytes > 0 ? 100 * memory.usedBytes / memory.globalBytes : 0
  const percentage = percent > 0 && percent < 1 ? '<1%' : `${Math.floor(percent)}%`
  return { ...memory, feature, level, percent, percentage }
}

type Reading = ReturnType<typeof reading>

function Ring({ reading: { feature, percent, level } }: { reading: Reading }) {
  return <span className="memory-ring" data-feature={feature} data-level={level}
    style={{ '--memory-fill': `${Math.min(100, percent)}%` } as CSSProperties} aria-hidden="true" />
}

function MemoryRow({ item }: { item: Reading }) {
  const { feature, level, percentage, usedBytes, globalBytes } = item
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
      <p>{note ? note + ' ' : ''}{action}</p>
    </>}
  </section>
}

export default function MemoryIndicator() {
  const { indexMemory, resultMemory, menus } = useWorkbench()
  const index = reading('index', useServiceSnapshot(indexMemory))
  const results = reading('results', useServiceSnapshot(resultMemory))
  const readings = [index, results]
  const alert = readings.some(item => item.level === 'critical') ? 'critical' : readings.some(item => item.level === 'warning') ? 'warning' : undefined
  const summary = readings.map(item => `${labels[item.feature]} ${item.level === 'unavailable' ? 'unavailable' : item.percentage}`).join(', ')
  const [mode, setMode] = useState<'preview' | 'pinned'>()
  const open = mode !== undefined
  const group = useRef<HTMLDivElement>(null), panel = useRef<HTMLElement>(null)
  const id = useId(), heading = useId()
  const peek = () => { if (!modalOpen() && !menus.ownsKeyboard()) setMode(current => current ?? 'preview') }
  const endPreview = () => setMode(current => current === 'preview' ? undefined : current)

  useLayoutEffect(() => {
    const trigger = group.current, details = panel.current
    if (!open || !trigger || !details) return
    const dismiss = () => setMode(undefined)
    if (modalOpen() || menus.ownsKeyboard()) { dismiss(); return }
    const doc = details.ownerDocument
    const outside = (event: PointerEvent) => {
      const path = event.composedPath()
      if (!path.includes(trigger) && !path.includes(details)) dismiss()
    }
    doc.addEventListener('pointerdown', outside, true)
    const watcher = new CloseWatcher()
    watcher.addEventListener('close', dismiss)
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
    <button type="button" className="memory-indicator" data-level={alert}
      aria-label={`Memory usage. ${summary}.${alert ? ` ${levelLabels[alert]}.` : ''}`} aria-expanded={open} aria-controls={id}
      onFocus={event => { if (event.currentTarget.matches(':focus-visible')) peek() }}
      onClick={() => { if (!modalOpen() && !menus.ownsKeyboard()) setMode(current => current === 'pinned' ? undefined : 'pinned') }}>
      {alert && <Icon name="warning" />}
      {readings.map(item => <Ring key={item.feature} reading={item} />)}
      <span>Memory</span>
    </button>
    {/* Escape the footer's clipping while letting other workbench surfaces take priority. */}
    {createPortal(<section ref={panel} id={id} className="memory-details" hidden={!open} aria-labelledby={heading}>
      <div className="memory-heading"><h2 id={heading}>Memory usage</h2><span>SQL backend</span></div>
      {readings.map(item => <MemoryRow key={item.feature} item={item} />)}
    </section>, document.body)}
  </div>
}
