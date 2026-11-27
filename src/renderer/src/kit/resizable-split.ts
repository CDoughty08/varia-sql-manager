// Pure geometry, clamping, keyboard stepping, and localStorage persistence for ResizableSplit (AP-1).
export interface SplitBounds {
  readonly defaultWidth: number
  readonly minWidth: number
  readonly maxWidth: number
  readonly minOtherWidth: number
}

export type SplitSide = 'left' | 'right'

export const splitLimits = {
  step: 12,
  shiftStep: 24,
  storagePrefix: 'varia.split.'
} as const

const splitStorage = (): Storage | undefined => {
  try { return globalThis.localStorage } catch { return undefined }
}

/** Normalizes a split ID or storage key into `varia.split.<id>`. */
export function splitStorageKey(storageKey: string): string {
  return storageKey.startsWith(splitLimits.storagePrefix) ? storageKey : `${splitLimits.storagePrefix}${storageKey}`
}

/** Maximum rail width (px) that keeps at least `minOtherWidth` for the opposite pane when container width is known. */
export function dynamicSplitMax(bounds: Pick<SplitBounds, 'minWidth' | 'maxWidth' | 'minOtherWidth'>, containerWidth?: number): number {
  const fixedMax = Math.max(bounds.minWidth, bounds.maxWidth)
  if (containerWidth === undefined || !Number.isFinite(containerWidth) || containerWidth <= 0) return fixedMax
  return Math.max(bounds.minWidth, Math.min(fixedMax, Math.floor(containerWidth - bounds.minOtherWidth)))
}

/** Clamps a rail width (px) to `[minWidth, dynamicSplitMax(bounds, containerWidth)]`, falling back to `defaultWidth` when non-finite. */
export function clampSplitWidth(width: number, bounds: SplitBounds, containerWidth?: number): number {
  const max = dynamicSplitMax(bounds, containerWidth)
  const fallback = Number.isFinite(bounds.defaultWidth) ? Math.round(bounds.defaultWidth) : bounds.minWidth
  const raw = Number.isFinite(width) ? Math.round(width) : fallback
  return Math.max(bounds.minWidth, Math.min(max, raw))
}

/** Reads a persisted rail width from `localStorage` safely, clamping and falling back to `defaultWidth` on missing/corrupt values. */
export function loadSplitWidth(storageKey: string, bounds: SplitBounds, containerWidth?: number): number {
  try {
    const raw = splitStorage()?.getItem(splitStorageKey(storageKey))
    if (raw === null || raw === undefined || raw.trim() === '') return clampSplitWidth(bounds.defaultWidth, bounds, containerWidth)
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? clampSplitWidth(parsed, bounds, containerWidth) : clampSplitWidth(bounds.defaultWidth, bounds, containerWidth)
  } catch {
    return clampSplitWidth(bounds.defaultWidth, bounds, containerWidth)
  }
}

/** Saves a rail width to `localStorage` safely, clamping to fixed `[minWidth, maxWidth]` and ignoring unavailable storage. */
export function saveSplitWidth(storageKey: string, width: number, bounds: SplitBounds): void {
  if (!Number.isFinite(width)) return
  try {
    splitStorage()?.setItem(splitStorageKey(storageKey), String(clampSplitWidth(width, bounds)))
  } catch { /* Ignored when storage is unavailable or quota-limited. */ }
}

/** Computes the next rail width (px) for a keyboard resize gesture on the separator, or `undefined` if unhandled. */
export function splitWidthKey(
  width: number,
  key: string,
  side: SplitSide,
  bounds: SplitBounds,
  containerWidth?: number,
  shiftKey = false
): number | undefined {
  if (key === 'Home') return clampSplitWidth(bounds.defaultWidth, bounds, containerWidth)
  if (key !== 'ArrowLeft' && key !== 'ArrowRight') return undefined
  const step = shiftKey ? splitLimits.shiftStep : splitLimits.step
  const direction = key === 'ArrowRight' ? 1 : -1
  const delta = side === 'left' ? direction * step : -direction * step
  return clampSplitWidth(width + delta, bounds, containerWidth)
}

/** Returns whether the split should stack vertically without a horizontal sash at the current container width. */
export function isSplitNarrowStacked(containerWidth: number | undefined, narrowStackWidth?: number): boolean {
  return narrowStackWidth !== undefined && containerWidth !== undefined && Number.isFinite(containerWidth) && containerWidth > 0 && containerWidth <= narrowStackWidth
}
