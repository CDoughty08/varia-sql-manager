import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import Keybinding from '../Keybinding'
import type { MatchRange } from './fuzzy'
import type { QuickInputRow, QuickInputView } from './QuickInputService'

const rowHeight = 24, visibleRows = 12, overscan = 6, windowedAbove = 100

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

function accessibleName({ item, group }: QuickInputRow): string {
  const name = item.ariaLabel ?? [item.label, item.description, item.keybinding?.aria, group].filter(Boolean).join(', ')
  return item.disabled ? `${name}, unavailable` : name
}

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
  const statusText = view.loading && !rows.length ? '' : rows.length ? `${rows.length.toLocaleString('en-US')} result${rows.length === 1 ? '' : 's'}` : `No matching ${view.noun}`
  useEffect(() => {
    const timer = setTimeout(() => setStatus(statusText), 300)
    return () => clearTimeout(timer)
  }, [statusText])

  function keyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    const mac = platform === 'darwin', plain = !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey
    const page = Math.min(visibleRows, rows.length)
    let handled = true
    switch (event.key) {
      case 'ArrowDown': if (mac && event.metaKey) quickInput.move('last'); else if (plain) quickInput.move('next'); else handled = false; break
      case 'ArrowUp': if (mac && event.metaKey) quickInput.move('first'); else if (plain) quickInput.move('previous'); else handled = false; break
      case 'PageDown': quickInput.move('pageNext', page); break
      case 'PageUp': quickInput.move('pagePrevious', page); break
      case 'Home': if (!mac && event.ctrlKey) quickInput.move('first'); else handled = false; break
      case 'End': if (!mac && event.ctrlKey) quickInput.move('last'); else handled = false; break
      case 'Enter': if (plain) quickInput.accept(); else handled = false; break
      case 'Escape': quickInput.hide('cancel'); break
      // Focus stays in the input.
      case 'Tab': break
      default: handled = false
    }
    if (handled) { event.preventDefault(); event.stopPropagation() }
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
      style={windowed ? { position: 'absolute', top: index * rowHeight, left: 0, right: 0 } : undefined} onClick={() => quickInput.accept(index)}>
      {icons && <span className={`quick-input-icon${item.icon ? ` codicon codicon-${item.icon}` : ''}`} aria-hidden="true" />}
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
    <div className={`quick-input-message${view.message?.severity === 'error' ? ' error' : ''}`} aria-live="polite">{view.message?.text}</div>
    <div ref={list} id="quick-input-list" className="quick-input-list" role="listbox" aria-label={view.ariaLabel} aria-busy={view.loading || undefined}
      onScroll={event => setScrollTop(event.currentTarget.scrollTop)}>
      {windowed ? <div role="presentation" style={{ position: 'relative', height: rows.length * rowHeight }}>{rendered}</div> : rendered}
    </div>
    <div className="quick-input-status" role="status">{status}</div>
  </div>
}
