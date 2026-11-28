import {
  useEffect, useRef, useState,
  type FocusEvent, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode
} from 'react'
import { observeResize } from '../core/windows'
import { followPointerDrag } from './pointer-drag'
import {
  clampSplitWidth, dynamicSplitMax, isSplitNarrowStacked, loadSplitWidth, saveSplitWidth,
  splitWidthKey, type SplitBounds, type SplitSide
} from './resizable-split'

export interface SplitSashProps {
  readonly className?: string
  readonly side: SplitSide
  readonly label: string
  readonly value: number
  readonly bounds: SplitBounds
  readonly containerWidth?: number
  readonly getContainerWidth?: () => number | undefined
  readonly step?: number
  readonly shiftStep?: number
  readonly homeAction?: 'default' | 'min'
  readonly endToMax?: boolean
  readonly disabled?: boolean
  readonly revertOnCancel?: boolean
  readonly focusOnPointerDown?: boolean
  readonly title?: string | null
  readonly onDragPreview?: (width: number | undefined) => void
  readonly onDragCancel?: (startWidth: number) => void
  readonly onCommit: (width: number) => void
  readonly onReset?: () => void
}

/**
 * Shared vertical draggable and keyboard-accessible separator (`role="separator"`) powered by `followPointerDrag`.
 * Used by `ResizableSplit` and standalone split surfaces (such as dual-rail Plan Viewer and CSS-grid Connect Dialog).
 */
export function SplitSash({
  className, side, label, value, bounds, containerWidth, getContainerWidth, step, shiftStep,
  homeAction = 'default', endToMax = false, disabled = false, revertOnCancel = false,
  focusOnPointerDown = false, title, onDragPreview, onDragCancel, onCommit, onReset
}: SplitSashProps) {
  const [dragging, setDragging] = useState(false)
  const mountedRef = useRef(true)
  const activeDragRef = useRef<{
    target: HTMLDivElement
    pointerId: number
    startWidth: number
    previewed: boolean
    aborted: boolean
  } | undefined>(undefined)
  const onDragPreviewRef = useRef(onDragPreview)
  onDragPreviewRef.current = onDragPreview
  const onDragCancelRef = useRef(onDragCancel)
  onDragCancelRef.current = onDragCancel
  const revertOnCancelRef = useRef(revertOnCancel)
  revertOnCancelRef.current = revertOnCancel
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      const drag = activeDragRef.current
      if (drag) {
        drag.aborted = true
        activeDragRef.current = undefined
      }
    }
  }, [])
  useEffect(() => {
    if (!disabled) return
    const drag = activeDragRef.current
    if (!drag) return
    drag.aborted = true
    activeDragRef.current = undefined
    try {
      if (drag.target.hasPointerCapture?.(drag.pointerId)) drag.target.releasePointerCapture(drag.pointerId)
    } catch { /* Pointer capture may already be released. */ }
    setDragging(false)
    if (drag.previewed) onDragPreviewRef.current?.(undefined)
    if (revertOnCancelRef.current) onDragCancelRef.current?.(drag.startWidth)
  }, [disabled])

  const dynamicMax = dynamicSplitMax(bounds, containerWidth)

  const handleReset = () => {
    if (disabled) return
    if (onReset) onReset()
    else onCommit(clampSplitWidth(bounds.defaultWidth, bounds))
  }

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    if (disabled) return
    event.preventDefault()
    if (focusOnPointerDown) event.currentTarget.focus()
    const target = event.currentTarget
    const pointerId = event.pointerId
    const startX = event.clientX
    const startWidth = value
    const splitWidth = getContainerWidth?.() ?? containerWidth
    let moved = false
    let latest = startWidth
    const drag = { target, pointerId, startWidth, previewed: false, aborted: false }
    activeDragRef.current = drag
    const started = followPointerDrag(
      event.currentTarget,
      event.pointerId,
      moveEvent => {
        if (!mountedRef.current || drag.aborted || activeDragRef.current !== drag) return
        const delta = moveEvent.clientX - startX
        const raw = side === 'left' ? startWidth + delta : startWidth - delta
        const next = clampSplitWidth(raw, bounds, splitWidth)
        if (next !== startWidth) moved = true
        latest = next
        drag.previewed = true
        onDragPreviewRef.current?.(next)
      },
      ended => {
        if (!mountedRef.current || drag.aborted || activeDragRef.current !== drag) return
        activeDragRef.current = undefined
        setDragging(false)
        const cancelled = revertOnCancelRef.current && (ended.type === 'pointercancel' || ended.type === 'lostpointercapture')
        if (drag.previewed) onDragPreviewRef.current?.(undefined)
        if (cancelled) {
          onDragCancelRef.current?.(startWidth)
          return
        }
        // A click with no drag movement must never overwrite a persisted wider width with a temporarily clamped value.
        if (moved && latest !== startWidth) onCommit(latest)
      }
    )
    if (started) {
      setDragging(true)
    } else if (activeDragRef.current === drag) {
      activeDragRef.current = undefined
    }
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (disabled || event.altKey || event.ctrlKey || event.metaKey) return
    if (event.shiftKey && event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    const next = splitWidthKey(value, event.key, side, bounds, containerWidth, event.shiftKey, {
      step, shiftStep, homeAction, endToMax
    })
    if (next === undefined) return
    event.preventDefault()
    event.stopPropagation()
    if (event.key === 'Home' && homeAction !== 'min') {
      handleReset()
      return
    }
    // Only commit when the key actually moved the rendered width (never shrink a persisted width when pinned at narrow max).
    if (next !== value) onCommit(next)
  }

  const resolvedTitle = disabled || title === null
    ? undefined
    : (title ?? `Drag to resize · Double-click to reset (${bounds.defaultWidth} px)`)

  return (
    <div
      className={['varia-sash', className].filter(Boolean).join(' ')}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={bounds.minWidth}
      aria-valuemax={dynamicMax}
      aria-valuenow={value}
      aria-disabled={disabled || undefined}
      tabIndex={0}
      data-dragging={dragging || undefined}
      title={resolvedTitle}
      onPointerDown={handlePointerDown}
      onKeyDown={handleKeyDown}
      onDoubleClick={disabled ? undefined : handleReset}
    />
  )
}

export interface ResizableSplitProps {
  readonly id?: string
  readonly className?: string
  readonly railClassName?: string
  readonly mainClassName?: string
  readonly sashClassName?: string
  readonly railId?: string
  readonly railAs?: 'div' | 'aside'
  readonly side: SplitSide
  readonly defaultWidth: number
  readonly minWidth: number
  readonly maxWidth: number
  readonly minOtherWidth: number
  readonly maxShare?: number
  readonly step?: number
  readonly shiftStep?: number
  readonly narrowStackWidth?: number
  readonly railOpen?: boolean
  readonly label: string
  readonly railLabel?: string
  readonly storageKey?: string
  readonly width?: number
  readonly onWidthChange?: (width: number) => void
  readonly onWidthReset?: () => void
  readonly onContainerWidthChange?: (width: number | undefined) => void
  readonly onPointerLeave?: () => void
  readonly onBlur?: (event: FocusEvent<HTMLDivElement>) => void
  readonly rail: ReactNode
  readonly children: ReactNode
}

/**
 * Reusable two-pane split layout with a draggable, keyboard-accessible vertical separator (`role="separator"`).
 * Supports both self-persisted (`storageKey` -> `varia.split.<id>`) and controlled (`width` / `onWidthChange` / `onWidthReset`) modes.
 */
export default function ResizableSplit({
  id, className, railClassName, mainClassName, sashClassName, railId, railAs = 'div',
  side, defaultWidth, minWidth, maxWidth, minOtherWidth, maxShare, step, shiftStep,
  narrowStackWidth, railOpen = true, label, railLabel, storageKey, width,
  onWidthChange, onWidthReset, onContainerWidthChange, onPointerLeave, onBlur, rail, children
}: ResizableSplitProps) {
  const bounds: SplitBounds = { defaultWidth, minWidth, maxWidth, minOtherWidth, maxShare }
  const controlled = width !== undefined
  const splitRef = useRef<HTMLDivElement>(null)
  const [containerWidth, setContainerWidth] = useState<number | undefined>(undefined)
  const containerCbRef = useRef(onContainerWidthChange)
  containerCbRef.current = onContainerWidthChange

  useEffect(() => {
    const split = splitRef.current
    if (!split) return
    const measure = () => {
      const measured = split.clientWidth
      const next = measured > 0 ? measured : undefined
      setContainerWidth(next)
      containerCbRef.current?.(next)
    }
    measure()
    const observer = observeResize(split, measure)
    return () => observer.dispose()
  }, [])

  const [storedWidth, setStoredWidth] = useState<number>(() =>
    storageKey ? loadSplitWidth(storageKey, bounds) : clampSplitWidth(defaultWidth, bounds)
  )
  useEffect(() => {
    if (controlled) return
    setStoredWidth(storageKey ? loadSplitWidth(storageKey, bounds) : clampSplitWidth(defaultWidth, bounds))
  }, [controlled, storageKey, defaultWidth, minWidth, maxWidth, minOtherWidth, maxShare])

  const [dragWidth, setDragWidth] = useState<number | undefined>(undefined)

  const baseWidth = controlled ? width : storedWidth
  const effectiveWidth = clampSplitWidth(dragWidth ?? baseWidth, bounds, containerWidth)
  const stacked = isSplitNarrowStacked(containerWidth, narrowStackWidth)

  useEffect(() => {
    if (!railOpen || stacked) setDragWidth(undefined)
  }, [railOpen, stacked])

  const commitWidth = (next: number) => {
    const clamped = clampSplitWidth(next, bounds)
    if (controlled) {
      onWidthChange?.(clamped)
      return
    }
    setStoredWidth(clamped)
    if (storageKey) saveSplitWidth(storageKey, clamped, bounds)
  }

  const resetWidth = () => {
    if (controlled) {
      if (onWidthReset) onWidthReset()
      else onWidthChange?.(clampSplitWidth(defaultWidth, bounds))
      return
    }
    const next = clampSplitWidth(defaultWidth, bounds)
    setStoredWidth(next)
    if (storageKey) saveSplitWidth(storageKey, next, bounds)
  }

  const RailTag = railAs
  const railEl = (
    <RailTag
      id={railId}
      className={['varia-split-rail', railClassName].filter(Boolean).join(' ')}
      role={railAs === 'div' && railLabel ? 'region' : undefined}
      aria-label={railLabel || undefined}
      style={stacked ? undefined : { width: `${effectiveWidth}px` }}
    >
      {rail}
    </RailTag>
  )
  const mainEl = (
    <div className={['varia-split-main', mainClassName].filter(Boolean).join(' ')}>
      {children}
    </div>
  )
  const sashEl = (
    <SplitSash
      className={sashClassName}
      side={side}
      label={label}
      value={effectiveWidth}
      bounds={bounds}
      containerWidth={containerWidth}
      getContainerWidth={() => splitRef.current?.clientWidth || containerWidth}
      step={step}
      shiftStep={shiftStep}
      onDragPreview={setDragWidth}
      onCommit={commitWidth}
      onReset={resetWidth}
    />
  )

  return (
    <div
      ref={splitRef}
      id={id}
      className={['varia-split', className].filter(Boolean).join(' ')}
      data-side={side}
      data-stacked={stacked || undefined}
      onPointerLeave={onPointerLeave}
      onBlur={onBlur}
    >
      {railOpen && side === 'left' && railEl}
      {railOpen && !stacked && side === 'left' && sashEl}
      {mainEl}
      {railOpen && !stacked && side === 'right' && sashEl}
      {railOpen && side === 'right' && railEl}
    </div>
  )
}
