// Pure logic for ObjectInspectorFrame: shortcut digit mapping, roving tab focus, horizontal tab overflow geometry,
// and instant reveal without spurious scrolling.
import type { Platform } from '../../../shared/commands/keybindings'
export {
  clampVitalsWidth, defaultInspectorVitals, defaultInspectorVitalsPrefs, vitalsLimits, vitalsMaxWidth, vitalsWidthKey,
  type InspectorSurface, type InspectorVitalsPrefs, type VitalsSurfacePrefs
} from '../../../shared/inspector-vitals'

/** Width of the edge fade on an overflowing tab strip (--varia-space-4). */
export const inspectorStripFade = 16

export interface TabBox {
  readonly id: string
  readonly left: number
  readonly width: number
}

export interface StripMetrics {
  readonly scrollLeft: number
  readonly clientWidth: number
  readonly scrollWidth: number
}

export interface StripClipState {
  readonly start: boolean
  readonly end: boolean
  readonly overflow: boolean
}

/**
 * Numeric shortcut badge for tab at `index` of `total`:
 * - Tabs 0..7 map to digits 1..8.
 * - The last tab maps to 9 when there are 9 or more tabs (matching Ctrl+1..8 and Ctrl+9 = last tab).
 * - Middle tabs beyond index 7 carry no digit badge.
 */
export function tabShortcutDigit(index: number, total: number): number | undefined {
  if (!Number.isInteger(index) || !Number.isInteger(total) || total <= 0 || index < 0 || index >= total) return undefined
  if (index < 8) return index + 1
  if (index === total - 1) return 9
  return undefined
}

/** Resolves a `Ctrl+1..8` (0..7) or `Ctrl+9` (`'last'`) jump target to a valid tab index, or undefined when out of range. */
export function resolveTabShortcutTarget(target: number | 'last', total: number): number | undefined {
  if (!Number.isInteger(total) || total <= 0) return undefined
  if (target === 'last') return total - 1
  return Number.isInteger(target) && target >= 0 && target < total ? target : undefined
}

/** Formatted shortcut hint for tooltips and the overflow jump menu ("Ctrl+3" or "⌘3"). */
export function tabShortcutLabel(digit: number, platform: Platform = 'win32'): string {
  return platform === 'darwin' ? `⌘${digit}` : `Ctrl+${digit}`
}

/**
 * Roving focus movement along the horizontal tab strip (ArrowLeft/ArrowRight wrap; Home/End jump to ends).
 * Moves focus without selecting so lazy tabs never fire while arrowing past them.
 */
export function inspectorTabKey(key: string, ids: readonly string[], focusedId: string): string | undefined {
  if (!ids.length) return undefined
  const index = ids.indexOf(focusedId)
  const at = index >= 0 ? index : 0
  switch (key) {
    case 'ArrowRight': return ids[(at + 1) % ids.length]
    case 'ArrowLeft': return ids[(at + ids.length - 1) % ids.length]
    case 'Home': return ids[0]
    case 'End': return ids[ids.length - 1]
    default: return undefined
  }
}

/** Which edges of the tab strip clip tabs, and whether any horizontal overflow exists. */
export function stripClipState(metrics: StripMetrics): StripClipState {
  const maxScroll = Math.max(0, metrics.scrollWidth - metrics.clientWidth)
  return {
    start: metrics.scrollLeft > 1,
    end: metrics.scrollLeft < maxScroll - 1,
    overflow: maxScroll > 1
  }
}

/**
 * Instant scrollLeft offset that reveals a tab completely inside the strip, clear of the edge fade.
 * When the tab is already completely visible, returns `metrics.scrollLeft` unchanged (no spurious scrolling).
 */
export function revealSelectedTabOffset(metrics: StripMetrics, tab: Pick<TabBox, 'left' | 'width'>, fade: number = inspectorStripFade): number {
  const maxScroll = Math.max(0, metrics.scrollWidth - metrics.clientWidth)
  if (maxScroll <= 0 || metrics.clientWidth <= 0) return 0
  const viewLeft = metrics.scrollLeft
  const viewRight = viewLeft + metrics.clientWidth
  const tabLeft = tab.left
  const tabRight = tabLeft + tab.width
  if (tabLeft >= viewLeft && tabRight <= viewRight) return viewLeft
  if (tab.width >= metrics.clientWidth || tabLeft < viewLeft) {
    return Math.max(0, Math.min(maxScroll, tabLeft - fade))
  }
  return Math.max(0, Math.min(maxScroll, tabRight + fade - metrics.clientWidth))
}

/** Ids of tabs that are partially or wholly outside the strip's visible viewport. */
export function offEdgeTabIds(metrics: StripMetrics, tabs: readonly TabBox[], tolerance = 2): ReadonlySet<string> {
  const viewLeft = metrics.scrollLeft
  const viewRight = viewLeft + metrics.clientWidth
  const off = new Set<string>()
  for (const tab of tabs) {
    if (tab.left < viewLeft - tolerance || tab.left + tab.width > viewRight + tolerance) off.add(tab.id)
  }
  return off
}

/** Reads tab boxes from a rendered horizontal tab strip. */
export function measureStripTabs(strip: HTMLElement): TabBox[] {
  const boxes: TabBox[] = []
  for (const tab of strip.querySelectorAll<HTMLElement>('[role="tab"][data-inspector-tab]')) {
    const id = tab.dataset.inspectorTab
    if (id) boxes.push({ id, left: tab.offsetLeft, width: tab.offsetWidth })
  }
  return boxes
}

/** Counts how many tabs in `strip` are clipped or scrolled off either edge. */
export function hiddenTabs(strip: HTMLElement | null): number {
  if (!strip) return 0
  const metrics: StripMetrics = { scrollLeft: strip.scrollLeft, clientWidth: strip.clientWidth, scrollWidth: strip.scrollWidth }
  return offEdgeTabIds(metrics, measureStripTabs(strip)).size
}

/**
 * Reveals the selected tab in `strip` instantaneously if it is off-edge; returns true if `scrollLeft` changed.
 * Leaves `scrollLeft` untouched when the selected tab is already completely visible.
 */
export function revealSelectedTab(strip: HTMLElement | null): boolean {
  if (!strip) return false
  const active = strip.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
  if (!active) return false
  const metrics: StripMetrics = { scrollLeft: strip.scrollLeft, clientWidth: strip.clientWidth, scrollWidth: strip.scrollWidth }
  const next = revealSelectedTabOffset(metrics, { left: active.offsetLeft, width: active.offsetWidth })
  if (next === strip.scrollLeft) return false
  strip.scrollLeft = next
  return true
}

/** Step scroll distance (px) for the contextual ‹ / › overflow steppers. */
export function stepScrollDelta(clientWidth: number, direction: -1 | 1): number {
  return Math.max(120, Math.round(Math.max(0, clientWidth) * 0.6)) * direction
}
