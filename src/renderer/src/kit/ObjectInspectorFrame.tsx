import {
  useCallback, useEffect, useLayoutEffect, useRef, useState,
  type CSSProperties, type FocusEvent, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type Ref, type WheelEvent
} from 'react'
import type { Platform } from '../../../shared/commands/keybindings'
import { reducedMotionClass } from '../../../shared/theme/metrics'
import type { GestureService } from '../core/gestures'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import { observeResize, requestFrame } from '../core/windows'
import Icon from '../Icon'
import { formatCount } from '../results/status'
import { DocumentHeader, useHeaderVerbs, type Crumb, type HeaderVerb, type Verb } from './DocumentFrame'
import {
  clampVitalsWidth, defaultInspectorVitals, inspectorStripFade, inspectorTabKey, measureStripTabs, offEdgeTabIds,
  resolveTabShortcutTarget, revealSelectedTab, stepScrollDelta, stripClipState, tabShortcutDigit, tabShortcutLabel,
  vitalsLimits, vitalsMaxWidth, vitalsWidthKey, type InspectorSurface
} from './object-inspector'
import { followPointerDrag } from './pointer-drag'
import { useClearFieldHints } from './PropertyField'
import RatioBar, { type RatioSegment } from './RatioBar'
import ScriptDrawer, { type ScriptDrawerProps } from './ScriptDrawer'

export interface InspectorKpi {
  readonly id: string
  readonly label: string
  readonly value: string
  readonly sub?: string
  readonly title?: string
  readonly ratio?: readonly RatioSegment[]
}

export interface InspectorTab {
  readonly id: string
  readonly title: string
  /** `flow` owns vertical scrolling for prose/fact/form content; `fill` delegates scrolling to a full-bleed grid or Monaco editor. */
  readonly layout: 'flow' | 'fill'
  readonly content: ReactNode
  readonly count?: number | string
  readonly countLabel?: string
  readonly modified?: boolean
  readonly problem?: boolean
  readonly disabled?: boolean
}

export interface ObjectInspectorFrameViewProps {
  readonly id: string
  readonly title: string
  readonly crumbs?: readonly Crumb[]
  readonly subtitle?: string
  readonly state?: ReactNode
  readonly tools?: ReactNode
  readonly verbs?: readonly HeaderVerb[]
  /** `full` (Properties / Peek Tab) renders optional Hero KPIs and uses the `full` Vitals width; `peek` (Peek Card) omits KPIs and shows numeric tab badges. */
  readonly surface?: InspectorSurface
  /** Headline KPIs rendered inside the header band on `surface="full"` only. */
  readonly kpis?: readonly InspectorKpi[]
  readonly banner?: ReactNode
  readonly tabs: readonly InspectorTab[]
  readonly activeTab: string
  readonly onSelectTab: (id: string) => void
  /** Right-docked Vitals rail content; omitted when undefined. */
  readonly vitals?: ReactNode
  readonly vitalsTitle?: string
  readonly vitalsOpen?: boolean
  readonly vitalsWidth?: number
  readonly onVitalsOpenChange?: (open: boolean) => void
  readonly onVitalsWidthChange?: (width: number) => void
  readonly onVitalsWidthReset?: () => void
  /** FieldHintStrip overlay pinned in a zero-height dock above the Script drawer. */
  readonly hint?: ReactNode
  readonly script?: Omit<ScriptDrawerProps, 'id' | 'open' | 'size' | 'onToggle' | 'onResize'>
  readonly scriptOpen?: boolean
  readonly scriptSize?: number
  readonly onScriptToggle?: () => void
  readonly onScriptResize?: (size: number) => void
  /** Shows `1`–`9` tab shortcut cues on `surface="full"` while the platform modifier key is held and this frame holds focus. */
  readonly modHeld?: boolean
  /** Marks this frame as a registered `Ctrl+1`–`9` inspector scope (`data-object-inspector`); enabled automatically by connected `ObjectInspectorFrame`. */
  readonly shortcutScope?: boolean
  readonly platform?: Platform
  readonly gestures?: Pick<GestureService, 'matches'>
  readonly attributes?: Readonly<Record<`data-${string}`, string>>
  readonly className?: string
  readonly style?: CSSProperties
  /** Defaults to `region`; Peek Card passes `dialog` with `ariaLabel` so the floating card is the inspector root itself. */
  readonly role?: 'region' | 'dialog'
  readonly ariaLabel?: string
  readonly ariaModal?: boolean
  readonly tabIndex?: number
  readonly onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void
  readonly rootRef?: Ref<HTMLDivElement>
}

const tabDomId = (frameId: string, tabId: string) => `${frameId}-tab-${tabId}`

function assignRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (!ref) return
  if (typeof ref === 'function') ref(value)
  else (ref as { current: T | null }).current = value
}

function formatTabCount(count: number | string): string {
  return typeof count === 'number' ? formatCount(count) : count
}

/**
 * Pure, props-driven unified object inspector shell shared across Peek Card, Peek Tab, SQL Server Properties and
 * BigQuery Properties: composes `DocumentHeader`, optional Full-only Hero KPIs, horizontal overflow-aware tabs
 * (edge fade, `‹`/`›` steppers, `+N ▾` jump menu, wheel scroll, roving focus with Enter/Space selection),
 * single-scroller `flow`/`fill` panes, resizable right Vitals rail (hides below 680 px), zero-height FieldHintStrip
 * overlay, and optional ScriptDrawer.
 */
export function ObjectInspectorFrameView(props: ObjectInspectorFrameViewProps) {
  const {
    id, title, crumbs, subtitle, state, tools, verbs = [], surface = 'full', kpis = [], banner,
    tabs, activeTab, onSelectTab, vitals, vitalsTitle = 'Vitals', vitalsOpen = true, vitalsWidth,
    onVitalsOpenChange, onVitalsWidthChange, onVitalsWidthReset, hint, script, scriptOpen = false,
    scriptSize = 0.35, onScriptToggle, onScriptResize, modHeld = false, shortcutScope = false, platform = 'win32',
    gestures, attributes, className, style, role = 'region', ariaLabel, ariaModal, tabIndex, onKeyDown, rootRef
  } = props

  const localRootRef = useRef<HTMLDivElement | null>(null)
  const setRoot = useCallback((node: HTMLDivElement | null) => {
    localRootRef.current = node
    assignRef(rootRef, node)
  }, [rootRef])

  const currentTab = tabs.find(tab => tab.id === activeTab) ?? tabs[0]
  const currentId = currentTab?.id ?? ''
  const hasTabs = tabs.length > 0
  const selectableIds = tabs.filter(tab => !tab.disabled).map(tab => tab.id)

  // Track whether focus resides inside this inspector so unmounting a tab panel on Ctrl+1..9 keeps focus inside the frame,
  // and Full-surface shortcut badges only show while this frame holds focus.
  const hadFocusRef = useRef(false)
  const [hasFocus, setHasFocus] = useState(false)
  useEffect(() => {
    const root = localRootRef.current
    const active = root?.ownerDocument.activeElement
    if (root && active && root.contains(active)) {
      hadFocusRef.current = true
      setHasFocus(true)
    }
  }, [])
  const handleRootFocus = () => {
    hadFocusRef.current = true
    setHasFocus(true)
  }
  const handleRootBlur = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget as Node | null
    if (next && event.currentTarget.contains(next)) return
    if (next) hadFocusRef.current = false
    setHasFocus(false)
  }

  // Clear FieldHintStrip immediately on tab switches as well as pointer leave / blur.
  const clearHints = useClearFieldHints()
  useEffect(() => { clearHints?.() }, [currentId, clearHints])

  // Roving tabindex within the horizontal tab strip: ArrowLeft/ArrowRight/Home/End move focus only; Enter/Space selects.
  const [focusedTabId, setFocusedTabId] = useState(currentId)
  useEffect(() => { setFocusedTabId(currentId) }, [currentId])
  const rovingId = tabs.some(tab => tab.id === focusedTabId && !tab.disabled) ? focusedTabId : currentId

  const stripRef = useRef<HTMLDivElement>(null)
  const tabBarRef = useRef<HTMLDivElement>(null)
  const moreButtonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const pendingFrameRef = useRef<(() => void) | undefined>(undefined)
  useEffect(() => () => { pendingFrameRef.current?.(); pendingFrameRef.current = undefined }, [])

  const [clip, setClip] = useState<{ start: boolean; end: boolean; overflow: boolean }>({ start: false, end: false, overflow: false })
  const [offEdge, setOffEdge] = useState<ReadonlySet<string>>(() => new Set())
  const [menuOpen, setMenuOpen] = useState(false)

  const focusTabButton = useCallback((tabId: string, preventScroll = false) => {
    const button = stripRef.current?.querySelector<HTMLElement>(`[role="tab"][data-inspector-tab="${CSS.escape(tabId)}"]`)
    button?.focus(preventScroll ? { preventScroll: true } : undefined)
  }, [])

  const syncStrip = useCallback((reveal: boolean) => {
    const strip = stripRef.current
    if (!strip) return
    if (reveal) revealSelectedTab(strip)
    const metrics = { scrollLeft: strip.scrollLeft, clientWidth: strip.clientWidth, scrollWidth: strip.scrollWidth }
    const nextClip = stripClipState(metrics)
    const nextOff = offEdgeTabIds(metrics, measureStripTabs(strip))
    setClip(prev => prev.start === nextClip.start && prev.end === nextClip.end && prev.overflow === nextClip.overflow ? prev : nextClip)
    setOffEdge(prev => {
      if (prev.size === nextOff.size && [...prev].every(key => nextOff.has(key))) return prev
      return nextOff
    })
  }, [])

  // Include content that affects tab width (title, count, modified, problem) so lazy badge arrival updates overflow.
  const tabSignature = tabs.map(tab => `${tab.id}\x01${tab.title}\x01${tab.count ?? ''}\x01${tab.modified ? 1 : 0}\x01${tab.problem ? 1 : 0}`).join('\0')
  const prevTabRef = useRef<string>(currentId)
  useLayoutEffect(() => {
    const changed = prevTabRef.current !== currentId
    prevTabRef.current = currentId
    // Reveal instantly when the selected tab changes, never scrolling an already-visible tab.
    syncStrip(changed)
    if (!changed || !hadFocusRef.current || !currentId) return
    const root = localRootRef.current, doc = root?.ownerDocument, active = doc?.activeElement
    // Switching tabs can unmount the focused control inside the previous panel, dropping focus to body/null.
    if (!active || active === doc?.body) focusTabButton(currentId, true)
  }, [currentId, tabSignature, syncStrip, focusTabButton])

  useEffect(() => {
    const strip = stripRef.current
    if (!hasTabs || !strip) return
    syncStrip(true)
    const observer = observeResize(strip, () => syncStrip(false))
    return () => observer.dispose()
  }, [hasTabs, syncStrip])

  // If the container widens so overflow disappears while the +N menu is open, close it and rescue focus if it was inside.
  useEffect(() => {
    if (clip.overflow || !menuOpen) return
    const active = localRootRef.current?.ownerDocument.activeElement
    const wasInMenu = !!(active && menuRef.current?.contains(active))
    setMenuOpen(false)
    if (wasInMenu && currentId) focusTabButton(currentId, true)
  }, [clip.overflow, menuOpen, currentId, focusTabButton])

  // Close the overflow menu on outside pointerdown.
  useEffect(() => {
    if (!menuOpen) return
    const doc = localRootRef.current?.ownerDocument ?? document
    const onPointerDown = (event: Event) => {
      const target = event.target as Node | null
      if (!target) return
      if (menuRef.current?.contains(target) || moreButtonRef.current?.contains(target)) return
      setMenuOpen(false)
    }
    doc.addEventListener('pointerdown', onPointerDown, true)
    return () => doc.removeEventListener('pointerdown', onPointerDown, true)
  }, [menuOpen])

  // Move focus into the overflow menu when opened.
  useEffect(() => {
    if (!menuOpen) return
    const selectedItem = menuRef.current?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]')
      ?? menuRef.current?.querySelector<HTMLElement>('[role="menuitemradio"]:not(:disabled)')
    selectedItem?.focus({ preventScroll: true })
  }, [menuOpen])

  const handleTabListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    const target = event.target as HTMLElement
    const from = target.closest<HTMLElement>('[role="tab"][data-inspector-tab]')?.dataset.inspectorTab
    if (!from) return
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      event.stopPropagation()
      if (from !== currentId) onSelectTab(from)
      return
    }
    const next = inspectorTabKey(event.key, selectableIds, from)
    if (!next) return
    event.preventDefault()
    event.stopPropagation()
    setFocusedTabId(next)
    focusTabButton(next)
  }

  const handleTabListBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusedTabId(currentId)
  }

  const handleWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (gestures?.matches('global.wheelZoom', event)) return
    const strip = event.currentTarget
    if (strip.scrollWidth <= strip.clientWidth) return
    // Native Shift+wheel or horizontal trackpad supplies deltaX; map plain vertical wheel deltaY to horizontal scroll.
    // React's onWheel is passive, so scrollLeft updates directly without calling preventDefault (matching ResultsTabs).
    if (event.deltaX !== 0 || event.deltaY === 0) return
    const unit = event.deltaMode === 2 ? strip.clientWidth : event.deltaMode === 1 ? inspectorStripFade : 1
    strip.scrollLeft += event.deltaY * unit
    syncStrip(false)
  }

  const stepScroll = (direction: -1 | 1) => {
    const strip = stripRef.current
    if (!strip) return
    const delta = stepScrollDelta(strip.clientWidth, direction)
    const reduced = strip.ownerDocument.documentElement.classList.contains(reducedMotionClass)
    if (typeof strip.scrollBy === 'function') {
      strip.scrollBy({ left: delta, behavior: reduced ? 'instant' : 'smooth' })
    } else {
      strip.scrollLeft += delta
    }
    syncStrip(false)
  }

  const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      setMenuOpen(false)
      moreButtonRef.current?.focus({ preventScroll: true })
      return
    }
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]:not(:disabled)') ?? [])]
    if (!items.length) return
    const active = event.currentTarget.ownerDocument.activeElement as HTMLButtonElement | null
    const index = active ? items.indexOf(active) : -1
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      items[(index + 1 + items.length) % items.length].focus({ preventScroll: true })
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      items[(index - 1 + items.length) % items.length].focus({ preventScroll: true })
    } else if (event.key === 'Home') {
      event.preventDefault()
      items[0].focus({ preventScroll: true })
    } else if (event.key === 'End') {
      event.preventDefault()
      items[items.length - 1].focus({ preventScroll: true })
    }
  }

  const handleMenuBlur = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget as Node | null
    if (next && (event.currentTarget.contains(next) || moreButtonRef.current?.contains(next))) return
    setMenuOpen(false)
  }

  const chooseFromMenu = (tabId: string) => {
    setMenuOpen(false)
    if (tabId !== currentId) onSelectTab(tabId)
    setFocusedTabId(tabId)
    // Popout-safe frame callback with unmount cleanup to reveal and focus the chosen tab once rendered.
    pendingFrameRef.current?.()
    let cancelled = false
    pendingFrameRef.current = () => { cancelled = true }
    requestFrame(() => {
      if (cancelled) return
      pendingFrameRef.current = undefined
      syncStrip(true)
      focusTabButton(tabId, true)
    })
  }

  // Vitals rail container width tracking + drag resize via followPointerDrag.
  const splitRef = useRef<HTMLDivElement>(null)
  const [containerWidth, setContainerWidth] = useState<number | undefined>(undefined)
  useEffect(() => {
    const split = splitRef.current
    if (!split) return
    const measure = () => {
      const width = split.clientWidth
      setContainerWidth(width > 0 ? width : undefined)
    }
    measure()
    const observer = observeResize(split, measure)
    return () => observer.dispose()
  }, [])

  const baseVitalsWidth = vitalsWidth ?? defaultInspectorVitals[surface].width
  const [dragWidth, setDragWidth] = useState<number | undefined>(undefined)
  const dragWidthRef = useRef<number | undefined>(undefined)
  const maxVitalsWidth = vitalsMaxWidth(containerWidth)
  const effectiveVitalsWidth = clampVitalsWidth(dragWidth ?? baseVitalsWidth, surface, containerWidth)

  const handleSashPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    const startX = event.clientX
    const startWidth = effectiveVitalsWidth
    const splitWidth = splitRef.current?.clientWidth || containerWidth
    let moved = false
    dragWidthRef.current = startWidth
    setDragWidth(startWidth)
    const started = followPointerDrag(
      event.currentTarget,
      event.pointerId,
      moveEvent => {
        const next = clampVitalsWidth(startWidth - (moveEvent.clientX - startX), surface, splitWidth)
        if (next !== startWidth) moved = true
        dragWidthRef.current = next
        setDragWidth(next)
      },
      () => {
        const final = dragWidthRef.current
        dragWidthRef.current = undefined
        setDragWidth(undefined)
        // A click with no drag movement must never overwrite a persisted wider width with a temporarily clamped value.
        if (moved && final !== undefined && final !== startWidth) onVitalsWidthChange?.(final)
      }
    )
    if (!started) {
      dragWidthRef.current = undefined
      setDragWidth(undefined)
    }
  }

  const resetVitals = () => {
    if (onVitalsWidthReset) onVitalsWidthReset()
    else onVitalsWidthChange?.(defaultInspectorVitals[surface].width)
  }

  const handleSashKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    const next = vitalsWidthKey(effectiveVitalsWidth, event.key, surface, containerWidth)
    if (next === undefined) return
    event.preventDefault()
    event.stopPropagation()
    if (event.key === 'Home') {
      resetVitals()
      return
    }
    // Only persist when the arrow key actually moved the rendered width (never shrink a persisted width when pinned at narrow max).
    if (next !== effectiveVitalsWidth) onVitalsWidthChange?.(next)
  }

  const showShortcutCues = surface === 'peek' || (modHeld && hasFocus)
  const hiddenCount = offEdge.size
  const narrow = containerWidth !== undefined && containerWidth <= vitalsLimits.narrowHideWidth
  const showVitals = !!vitals && vitalsOpen && !narrow
  const vitalsToggle = vitals && onVitalsOpenChange && !narrow ? (
    <button type="button" className="document-verb inspector-vitals-toggle" aria-pressed={showVitals}
      aria-controls={`${id}-vitals`} aria-label={showVitals ? `Hide ${vitalsTitle} panel` : `Show ${vitalsTitle} panel`}
      title={showVitals ? `Hide ${vitalsTitle}` : `Show ${vitalsTitle}`}
      onClick={() => onVitalsOpenChange(!vitalsOpen)}>
      <Icon name="layout" /><span className="document-verb-label">{vitalsTitle}</span>
    </button>
  ) : undefined

  const headerTools = tools || vitalsToggle ? <>{tools}{vitalsToggle}</> : undefined

  return <div ref={setRoot} className={['document-frame inspector-frame', className].filter(Boolean).join(' ')} role={role}
    aria-modal={ariaModal} aria-label={ariaLabel} aria-labelledby={ariaLabel ? undefined : `${id}-title`}
    tabIndex={tabIndex} style={style}
    data-document-frame={id} data-object-inspector={shortcutScope ? id : undefined} data-inspector-surface={surface}
    data-mod-held={showShortcutCues || undefined} {...attributes}
    onFocusCapture={handleRootFocus} onBlurCapture={handleRootBlur} onKeyDown={onKeyDown}>
    <DocumentHeader id={id} title={title} crumbs={crumbs} subtitle={subtitle} state={state} tools={headerTools} verbs={verbs} />
    {surface === 'full' && kpis.length > 0 && <dl className="inspector-kpi-strip" aria-label="Key metrics">
      {kpis.map(kpi => (
        <div key={kpi.id} className="inspector-kpi-item" title={kpi.title ?? `${kpi.label}: ${kpi.value}`}>
          <dt className="inspector-kpi-label">{kpi.label}</dt>
          <dd className="inspector-kpi-value">
            <span>{kpi.value}</span>
            {kpi.sub && <span className="inspector-kpi-sub">{kpi.sub}</span>}
            {kpi.ratio && kpi.ratio.length > 0 && <RatioBar mini segments={kpi.ratio} ariaLabel={`${kpi.label}: ${kpi.value}`} />}
          </dd>
        </div>
      ))}
    </dl>}
    {banner && <div className="document-banner">{banner}</div>}
    {hasTabs && <div ref={tabBarRef} className="inspector-tab-bar"
      data-clip-start={clip.start || undefined} data-clip-end={clip.end || undefined} data-overflow={clip.overflow || undefined}>
      <div className="inspector-tab-strip-wrap">
        <div ref={stripRef} className="inspector-tab-strip" role="tablist" aria-label="Object sections"
          onKeyDown={handleTabListKeyDown} onBlur={handleTabListBlur} onScroll={() => syncStrip(false)} onWheel={handleWheel}>
          {tabs.map((tab, index) => {
            const selected = tab.id === currentId
            const digit = tabShortcutDigit(index, tabs.length)
            const shortcut = digit !== undefined ? tabShortcutLabel(digit, platform) : undefined
            const tooltip = [tab.title, tab.modified ? 'Modified' : undefined, tab.problem ? 'Needs attention' : undefined, shortcut].filter(Boolean).join(' · ')
            return <button key={tab.id} type="button" role="tab" className="inspector-tab"
              id={tabDomId(id, tab.id)} data-inspector-tab={tab.id}
              aria-selected={selected} aria-controls={`${id}-panel`}
              tabIndex={tab.id === rovingId ? 0 : -1} disabled={tab.disabled} title={tooltip}
              onClick={() => { if (!tab.disabled && tab.id !== currentId) onSelectTab(tab.id) }}>
              {digit !== undefined && <span className="inspector-tab-idx" aria-hidden="true">{digit}</span>}
              <span className="inspector-tab-label">{tab.title}</span>
              {tab.count !== undefined && <span className="inspector-tab-count">
                {tab.countLabel
                  ? <><span aria-hidden="true">{formatTabCount(tab.count)}</span><span className="visually-hidden"> ({tab.countLabel})</span></>
                  : <span>{formatTabCount(tab.count)}</span>}
              </span>}
              {tab.modified && <><span className="inspector-tab-dot" aria-hidden="true" /><span className="visually-hidden"> (modified)</span></>}
              {tab.problem && <><Icon name="error" /><span className="visually-hidden"> (needs attention)</span></>}
            </button>
          })}
        </div>
      </div>
      {clip.overflow && <div className="inspector-tab-overflow">
        <button type="button" className="inspector-tab-nav" aria-label="Scroll tabs left" title="Scroll tabs left"
          disabled={!clip.start} onClick={() => stepScroll(-1)}>
          <Icon name="chevron-left" />
        </button>
        <button type="button" className="inspector-tab-nav" aria-label="Scroll tabs right" title="Scroll tabs right"
          disabled={!clip.end} onClick={() => stepScroll(1)}>
          <Icon name="chevron-right" />
        </button>
        <button ref={moreButtonRef} type="button" className="inspector-tab-more"
          aria-haspopup="menu" aria-expanded={menuOpen}
          aria-label={hiddenCount > 0 ? `More tabs (${formatCount(hiddenCount)} hidden)` : 'All tabs'}
          title={hiddenCount > 0 ? `All sections (${formatCount(hiddenCount)} hidden)` : 'All sections'}
          onClick={() => setMenuOpen(open => !open)}>
          <span>{hiddenCount > 0 ? `+${formatCount(hiddenCount)}` : 'All'}</span>
          <Icon name="chevron-down" />
        </button>
      </div>}
      {menuOpen && clip.overflow && <div ref={menuRef} className="inspector-tab-menu" role="menu" aria-label="Object sections"
        onKeyDown={handleMenuKeyDown} onBlur={handleMenuBlur}>
        {tabs.map((tab, index) => {
          const selected = tab.id === currentId
          const digit = tabShortcutDigit(index, tabs.length)
          const shortcut = digit !== undefined ? tabShortcutLabel(digit, platform) : undefined
          const isOff = offEdge.has(tab.id)
          return <button key={tab.id} type="button" role="menuitemradio" className="inspector-tab-menu-item"
            aria-checked={selected} disabled={tab.disabled} onClick={() => chooseFromMenu(tab.id)}>
            <span className="inspector-tab-menu-label">{tab.title}</span>
            {tab.count !== undefined && <span className="inspector-tab-menu-count">
              {tab.countLabel
                ? <><span aria-hidden="true">{formatTabCount(tab.count)}</span><span className="visually-hidden"> ({tab.countLabel})</span></>
                : <span>{formatTabCount(tab.count)}</span>}
            </span>}
            {tab.modified && <><span className="inspector-tab-dot" aria-hidden="true" /><span className="visually-hidden"> (modified)</span></>}
            {tab.problem && <><Icon name="error" /><span className="visually-hidden"> (needs attention)</span></>}
            {isOff && <span className="inspector-tab-menu-off">off-edge</span>}
            {shortcut && <span className="inspector-tab-menu-key">{shortcut}</span>}
          </button>
        })}
      </div>}
    </div>}
    <div ref={splitRef} className="inspector-split"
      onPointerLeave={() => clearHints?.('hovered')}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) clearHints?.('focused') }}>
      {currentTab && <div id={`${id}-panel`} role="tabpanel" aria-labelledby={tabDomId(id, currentTab.id)}
        className={currentTab.layout === 'fill' ? 'inspector-pane-fill' : 'inspector-pane-flow'}>
        {currentTab.content}
      </div>}
      {showVitals && <>
        <div className="inspector-vitals-sash" role="separator" aria-orientation="vertical"
          aria-label={`Resize ${vitalsTitle} panel`} aria-valuemin={vitalsLimits.minWidth}
          aria-valuemax={maxVitalsWidth} aria-valuenow={effectiveVitalsWidth} tabIndex={0}
          data-dragging={dragWidth !== undefined || undefined}
          onPointerDown={handleSashPointerDown} onDoubleClick={resetVitals} onKeyDown={handleSashKeyDown} />
        <aside id={`${id}-vitals`} className="inspector-vitals-rail" aria-label={vitalsTitle}
          style={{ width: `${effectiveVitalsWidth}px` }}>
          <div className="inspector-vitals-head">
            <span className="inspector-vitals-title">{vitalsTitle}</span>
            {onVitalsOpenChange && <button type="button" className="icon-button inspector-vitals-close"
              aria-label={`Hide ${vitalsTitle} panel`} title={`Hide ${vitalsTitle}`}
              onClick={() => onVitalsOpenChange(false)}>
              <Icon name="close" />
            </button>}
          </div>
          <div className="inspector-vitals-body">{vitals}</div>
        </aside>
      </>}
    </div>
    {hint && <div className="inspector-hint-overlay" aria-hidden="true">{hint}</div>}
    {script && <ScriptDrawer id={id} open={scriptOpen} size={scriptSize} {...script}
      onToggle={onScriptToggle ?? (() => {})} onResize={onScriptResize ?? (() => {})} />}
  </div>
}

export interface ObjectInspectorFrameProps extends Omit<ObjectInspectorFrameViewProps, 'verbs'> {
  readonly verbs?: readonly Verb[]
  /** Optional trailing non-catalogue header verbs (for example Peek Card's Close button). */
  readonly extraVerbs?: readonly HeaderVerb[]
}

/**
 * Connected `ObjectInspectorFrame`: resolves header verbs from the command catalogue, connects Vitals rail state to
 * `workbench.inspector` (persisted separately for `full` vs `peek`), follows modifier-hold state for shortcut badges,
 * and registers the frame for focus-scoped `Ctrl+1`–`9` tab switching.
 */
export default function ObjectInspectorFrame({ verbs = [], extraVerbs, surface = 'full', ...props }: ObjectInspectorFrameProps) {
  const workbench = useWorkbench()
  const resolvedVerbs = useHeaderVerbs(verbs)
  const allVerbs = extraVerbs?.length ? [...resolvedVerbs, ...extraVerbs] : resolvedVerbs
  const vitalsPrefs = useServiceSnapshot(workbench.inspector.vitals)
  const modHeld = useServiceSnapshot(workbench.inspector.modHeld)
  const surfacePrefs = vitalsPrefs[surface]
  const frameRef = useRef<HTMLDivElement | null>(null)
  const latest = useRef({ tabs: props.tabs, activeTab: props.activeTab, onSelectTab: props.onSelectTab })
  latest.current = { tabs: props.tabs, activeTab: props.activeTab, onSelectTab: props.onSelectTab }

  const combinedRef = useCallback((node: HTMLDivElement | null) => {
    frameRef.current = node
    assignRef(props.rootRef, node)
  }, [props.rootRef])

  useEffect(() => {
    const element = frameRef.current
    if (!element) return
    const registration = workbench.inspector.registerFrame(element, target => {
      const { tabs, activeTab, onSelectTab } = latest.current
      const index = resolveTabShortcutTarget(target, tabs.length)
      if (index === undefined) return false
      const tab = tabs[index]
      if (!tab || tab.disabled) return false
      if (tab.id !== activeTab) onSelectTab(tab.id)
      return true
    })
    return () => registration.dispose()
  }, [workbench.inspector])

  return <ObjectInspectorFrameView
    {...props}
    rootRef={combinedRef}
    surface={surface}
    verbs={allVerbs}
    platform={props.platform ?? workbench.platform}
    gestures={props.gestures ?? workbench.gestures}
    modHeld={props.modHeld ?? modHeld}
    shortcutScope={props.shortcutScope ?? true}
    vitalsOpen={props.vitalsOpen ?? surfacePrefs.open}
    vitalsWidth={props.vitalsWidth ?? surfacePrefs.width}
    onVitalsOpenChange={props.onVitalsOpenChange ?? (open => workbench.inspector.setVitals(surface, { open }))}
    onVitalsWidthChange={props.onVitalsWidthChange ?? (width => workbench.inspector.setVitals(surface, { width }))}
    onVitalsWidthReset={props.onVitalsWidthReset ?? (() => workbench.inspector.resetVitalsWidth(surface))}
  />
}
