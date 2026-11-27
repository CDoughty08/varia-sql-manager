import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { observeResize } from '../core/windows'
import { followPointerDrag } from './pointer-drag'
import {
  clampSplitWidth, dynamicSplitMax, isSplitNarrowStacked, loadSplitWidth, saveSplitWidth, splitWidthKey,
  type SplitBounds, type SplitSide
} from './resizable-split'

export interface ResizableSplitProps {
  readonly id?: string
  readonly className?: string
  readonly railClassName?: string
  readonly mainClassName?: string
  readonly side: SplitSide
  readonly defaultWidth: number
  readonly minWidth: number
  readonly maxWidth: number
  readonly minOtherWidth: number
  readonly narrowStackWidth?: number
  readonly railOpen?: boolean
  readonly label: string
  readonly railLabel?: string
  readonly storageKey?: string
  readonly width?: number
  readonly onWidthChange?: (width: number) => void
  readonly onWidthReset?: () => void
  readonly rail: ReactNode
  readonly children: ReactNode
}

/**
 * Reusable two-pane split layout with a draggable, keyboard-accessible vertical separator (`role="separator"`).
 * Supports both self-persisted (`storageKey` -> `varia.split.<id>`) and controlled (`width` / `onWidthChange` / `onWidthReset`) modes.
 */
export default function ResizableSplit({
  id, className, railClassName, mainClassName, side, defaultWidth, minWidth, maxWidth, minOtherWidth,
  narrowStackWidth, railOpen = true, label, railLabel, storageKey, width, onWidthChange, onWidthReset, rail, children
}: ResizableSplitProps) {
  const bounds: SplitBounds = { defaultWidth, minWidth, maxWidth, minOtherWidth }
  const controlled = width !== undefined
  const splitRef = useRef<HTMLDivElement>(null)
  const [containerWidth, setContainerWidth] = useState<number | undefined>(undefined)

  useEffect(() => {
    const split = splitRef.current
    if (!split) return
    const measure = () => {
      const measured = split.clientWidth
      setContainerWidth(measured > 0 ? measured : undefined)
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
  }, [controlled, storageKey, defaultWidth, minWidth, maxWidth, minOtherWidth])

  const [dragWidth, setDragWidth] = useState<number | undefined>(undefined)
  const dragWidthRef = useRef<number | undefined>(undefined)

  const baseWidth = controlled ? width : storedWidth
  const dynamicMax = dynamicSplitMax(bounds, containerWidth)
  const effectiveWidth = clampSplitWidth(dragWidth ?? baseWidth, bounds, containerWidth)
  const stacked = isSplitNarrowStacked(containerWidth, narrowStackWidth)

  useEffect(() => {
    if (!railOpen || stacked) {
      dragWidthRef.current = undefined
      setDragWidth(undefined)
    }
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

  const handleSashPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    const startX = event.clientX
    const startWidth = effectiveWidth
    const splitWidth = splitRef.current?.clientWidth || containerWidth
    let moved = false
    dragWidthRef.current = startWidth
    setDragWidth(startWidth)
    const started = followPointerDrag(
      event.currentTarget,
      event.pointerId,
      moveEvent => {
        const delta = moveEvent.clientX - startX
        const raw = side === 'left' ? startWidth + delta : startWidth - delta
        const next = clampSplitWidth(raw, bounds, splitWidth)
        if (next !== startWidth) moved = true
        dragWidthRef.current = next
        setDragWidth(next)
      },
      () => {
        const final = dragWidthRef.current
        dragWidthRef.current = undefined
        setDragWidth(undefined)
        // A click with no drag movement must never overwrite a persisted wider width with a temporarily clamped value.
        if (moved && final !== undefined && final !== startWidth) commitWidth(final)
      }
    )
    if (!started) {
      dragWidthRef.current = undefined
      setDragWidth(undefined)
    }
  }

  const handleSashKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return
    if (event.shiftKey && event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    const next = splitWidthKey(effectiveWidth, event.key, side, bounds, containerWidth, event.shiftKey)
    if (next === undefined) return
    event.preventDefault()
    event.stopPropagation()
    if (event.key === 'Home') {
      resetWidth()
      return
    }
    // Only commit when the arrow key actually moved the rendered width (never shrink a persisted width when pinned at narrow max).
    if (next !== effectiveWidth) commitWidth(next)
  }

  const railEl = (
    <div
      className={['varia-split-rail', railClassName].filter(Boolean).join(' ')}
      role={railLabel ? 'region' : undefined}
      aria-label={railLabel || undefined}
      style={stacked ? undefined : { width: `${effectiveWidth}px` }}
    >
      {rail}
    </div>
  )
  const mainEl = (
    <div className={['varia-split-main', mainClassName].filter(Boolean).join(' ')}>
      {children}
    </div>
  )
  const sashEl = (
    <div
      className="varia-sash"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={bounds.minWidth}
      aria-valuemax={dynamicMax}
      aria-valuenow={effectiveWidth}
      tabIndex={0}
      data-dragging={dragWidth !== undefined || undefined}
      title={`Drag to resize · Double-click to reset (${defaultWidth} px)`}
      onPointerDown={handleSashPointerDown}
      onKeyDown={handleSashKeyDown}
      onDoubleClick={resetWidth}
    />
  )

  return (
    <div
      ref={splitRef}
      id={id}
      className={['varia-split', className].filter(Boolean).join(' ')}
      data-side={side}
      data-stacked={stacked || undefined}
    >
      {railOpen && side === 'left' && railEl}
      {railOpen && !stacked && side === 'left' && sashEl}
      {mainEl}
      {railOpen && !stacked && side === 'right' && sashEl}
      {railOpen && side === 'right' && railEl}
    </div>
  )
}
