import { useRef, useState } from 'react'

/** Pointer capture follows the element into floating and popout documents. Save only a completed gesture. */
export function PlanPaneSizer({ name, value, minimum, reverse = false, resize, commit }: { name: string; value: number; minimum: number; reverse?: boolean; resize(value: number): void; commit(value: number): void }) {
  const drag = useRef<{ x: number; width: number; current: number } | undefined>(undefined)
  const [resizing, setResizing] = useState(false)
  const clamp = (size: number) => Math.round(Math.max(minimum, Math.min(600, size)))
  return <div className="plan-pane-sizer" role="separator" aria-label={`Resize plan ${name}`} aria-orientation="vertical" tabIndex={0}
    aria-valuemin={minimum} aria-valuemax={600} aria-valuenow={value} data-resizing={resizing || undefined}
    onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
      event.preventDefault(); event.stopPropagation()
      const next = event.key === 'Home' ? minimum : event.key === 'End' ? 600 : clamp(value + (event.key === 'ArrowRight' ? 16 : -16) * (reverse ? -1 : 1))
      resize(next); commit(next)
    }} onPointerDown={event => {
      if (event.button !== 0) return
      event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId)
      drag.current = { x: event.clientX, width: value, current: value }; setResizing(true)
    }} onPointerMove={event => {
      const state = drag.current
      if (state) { state.current = clamp(state.width + (event.clientX - state.x) * (reverse ? -1 : 1)); resize(state.current) }
    }} onPointerUp={event => {
      const state = drag.current; drag.current = undefined; setResizing(false)
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
      if (state) commit(state.current)
    }} onLostPointerCapture={() => { if (drag.current) resize(drag.current.width); drag.current = undefined; setResizing(false) }}
    onPointerCancel={() => { if (drag.current) resize(drag.current.width); drag.current = undefined; setResizing(false) }} />
}
