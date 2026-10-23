import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import Icon from '../Icon'
import Keybinding from '../Keybinding'
import type { MatchRange } from './fuzzy'
import type { QuickInputMessage, QuickInputRow, QuickInputView } from './QuickInputService'
import { quickInputKeyAction, resultStatus } from './view-model'

const rowHeight = 24, visibleRows = 12, overscan = 6, windowedAbove = 100
// Each message gets its own text node, so the live region announces a hint again when the same row is accepted again.
const messageKeys = new WeakMap<QuickInputMessage, number>()
let messageCount = 0
function messageKey(message: QuickInputMessage): number {
  let key = messageKeys.get(message)
  if (key === undefined) messageKeys.set(message, key = ++messageCount)
  return key
}

function Highlighted({ text, ranges }: { text: string; ranges: readonly MatchRange[] }) {
  if (!ranges.length) return <>{text}</>
  const parts: ReactNode[] = []
  let at = 0
  ranges.forEach(([start, end], index) => {
    if (start > at) parts.push(text.slice(at, start))
    parts.push(<span key={index} className="quick-input-hl">{text.slice(start, end)}</span>)
    at = end
  })
  if (at < text.length) parts.push(text.slice(at))
  return <>{parts}</>
}

// A disabled row says so through aria-disabled; its hint is announced when it is accepted.
const accessibleName = ({ item, group }: QuickInputRow): string => item.ariaLabel ?? [item.label, item.description, item.keybinding?.aria, group].filter(Boolean).join(', ')

/** The quick input widget, rendered once at the root of the app; it shows whatever picker `QuickInputService` holds. */
export default function QuickInput() {
  const { quickInput } = useWorkbench()
  const view = useServiceSnapshot(quickInput)
  return view.visible ? createPortal(<Widget view={view} />, document.body) : null
}

function Widget({ view }: { view: QuickInputView }) {
  const { quickInput, platform } = useWorkbench()
  const root = useRef<HTMLDivElement>(null), input = useRef<HTMLInputElement>(null), list = useRef<HTMLDivElement>(null)
  const composing = useRef(false)
  /** The session a row was pressed in: a click that began in an earlier picker accepts nothing. */
  const pressed = useRef<number | undefined>(undefined)
  const [scrollTop, setScrollTop] = useState(0)
  const [status, setStatus] = useState('')
  const { rows, activeIndex } = view

  // The input is uncontrolled: the service writes it only to open a picker or switch mode, never while composing.
  useLayoutEffect(() => {
    const element = input.current
    if (!element || composing.current) return
    const { value, selection } = view.input
    if (element.value !== value) element.value = value
    const start = selection === 'all' ? 0 : selection === 'afterPrefix' ? Math.min(view.prefix.length, value.length) : value.length
    element.setSelectionRange(start, value.length)
    // Only a new request moves the selection; a prefix change from typing must leave the caret alone.
  }, [view.input])
  useLayoutEffect(() => { if (document.activeElement !== input.current) input.current?.focus({ preventScroll: true }) }, [view.session])
  // The active row is always scrolled into the list (and so rendered), which keeps aria-activedescendant resolvable.
  useLayoutEffect(() => {
    const element = list.current
    if (!element) return
    if (activeIndex >= 0) {
      const top = activeIndex * rowHeight
      if (top < element.scrollTop) element.scrollTop = top
      else if (top + rowHeight > element.scrollTop + element.clientHeight) element.scrollTop = top + rowHeight - element.clientHeight
    }
    setScrollTop(element.scrollTop)
  }, [activeIndex, rows])
  const statusText = resultStatus(view)
  useEffect(() => {
    const timer = setTimeout(() => setStatus(statusText), 300)
    return () => clearTimeout(timer)
  }, [statusText])

  function keyDown(event: KeyboardEvent<HTMLInputElement>) {
    const { key, ctrlKey, altKey, metaKey, shiftKey, repeat, keyCode } = event
    const action = quickInputKeyAction({ key, ctrlKey, altKey, metaKey, shiftKey, repeat, keyCode, isComposing: event.nativeEvent.isComposing }, platform)
    if (action.move) quickInput.move(action.move, Math.min(visibleRows, rows.length))
    else if (action.accept) quickInput.accept()
    else if (action.cancel) quickInput.hide('cancel')
    if (action.handled) { event.preventDefault(); event.stopPropagation() }
  }

  const windowed = rows.length > windowedAbove
  const indices: number[] = []
  if (windowed) {
    const top = Math.floor(scrollTop / rowHeight)
    for (let index = Math.max(0, top - overscan); index < Math.min(rows.length, top + visibleRows + overscan); index++) indices.push(index)
    if (activeIndex >= 0 && !indices.includes(activeIndex)) indices.push(activeIndex)
  } else rows.forEach((_, index) => indices.push(index))
  const icons = rows.some(row => row.item.icon)
  const rendered = indices.map(index => {
    const row = rows[index], { item } = row
    return <div key={windowed ? index : `${index}:${item.id}`} id={`qi-${index}`} role="option" aria-selected={index === activeIndex} aria-disabled={item.disabled ? true : undefined}
      aria-posinset={index + 1} aria-setsize={rows.length} aria-label={accessibleName(row)} title={item.tooltip}
      className={`quick-input-row${index === activeIndex ? ' active' : ''}${item.disabled ? ' disabled' : ''}${index > 0 && row.group ? ' separated' : ''}`}
      style={windowed ? { position: 'absolute', top: index * rowHeight, left: 0, right: 0 } : undefined}
      onPointerDown={() => { pressed.current = view.session }}
      onClick={event => {
        // The second click of a double-click lands in the picker the first one opened.
        const session = pressed.current ?? view.session
        pressed.current = undefined
        if (event.detail <= 1) quickInput.accept(index, session)
      }}>
      {icons && <span className="quick-input-icon" aria-hidden="true">{item.icon && <Icon name={item.icon} />}</span>}
      <span className="quick-input-label"><Highlighted text={item.label} ranges={row.ranges} /></span>
      {item.description && <span className="quick-input-description"><Highlighted text={item.description} ranges={row.descriptionRanges} /></span>}
      <span className="quick-input-end">
        {item.keybinding && <Keybinding label={item.keybinding} />}
        {row.group && <span className="quick-input-group">{row.group}</span>}
      </span>
    </div>
  })

  return <div ref={root} className="quick-input" role="dialog" aria-label={view.title ?? view.ariaLabel}
    // Clicks inside the widget keep focus in the input (rows accept on click); the input itself still places the caret.
    onMouseDown={event => { if (event.target !== input.current) event.preventDefault() }}>
    {view.title && <div className="quick-input-title">{view.title}</div>}
    <div className="quick-input-header">
      <input ref={input} type="text" role="combobox" aria-expanded="true" aria-controls="quick-input-list" aria-autocomplete="list"
        aria-activedescendant={activeIndex >= 0 ? `qi-${activeIndex}` : undefined} aria-label={view.ariaLabel} placeholder={view.placeholder}
        spellCheck={false} autoComplete="off" maxLength={256}
        onInput={event => { quickInput.filter(event.currentTarget.value) }}
        onCompositionStart={() => { composing.current = true }}
        onCompositionEnd={event => { composing.current = false; quickInput.filter(event.currentTarget.value) }}
        onKeyDown={keyDown}
        onBlur={event => {
          const next = event.relatedTarget
          if (next instanceof Node && root.current?.contains(next)) return
          // Switching windows leaves the widget open; clicking elsewhere in the app closes it.
          if (document.hasFocus()) quickInput.hide('blur')
        }} />
    </div>
    <div className={`quick-input-progress${view.busy ? ' busy' : ''}`} />
    {/* Always rendered: a live region that enters the accessibility tree with its text is often not announced. */}
    <div className={`quick-input-message${view.message?.severity === 'error' ? ' error' : ''}`} aria-live="polite">{view.message && <span key={messageKey(view.message)}>{view.message.text}</span>}</div>
    <div ref={list} id="quick-input-list" className="quick-input-list" role="listbox" aria-label={view.ariaLabel} aria-busy={view.loading || undefined}
      onScroll={event => setScrollTop(event.currentTarget.scrollTop)}>
      {windowed ? <div role="presentation" style={{ position: 'relative', height: rows.length * rowHeight }}>{rendered}</div> : rendered}
    </div>
    {/* The status region announces this. */}
    {!rows.length && !view.loading && !view.message && <div className="quick-input-empty" aria-hidden="true">No matching {view.noun}</div>}
    <div className="quick-input-status" role="status">{status}</div>
  </div>
}
