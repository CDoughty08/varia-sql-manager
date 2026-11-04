// Object Explorer's search band: its hits sit above the tree, sized by their content (up to half the pane) until the
// person drags or keys the splitter under them; from then on the band keeps that share of the pane's height.

export const paneBandLimits = {
  /** The band's share of Object Explorer's height once sized by hand. */
  minimum: 0.15,
  maximum: 0.85,
  /** What one arrow key on the splitter moves it by. */
  step: 0.05
} as const

export const clampPaneBand = (size: number): number =>
  Number.isFinite(size) ? Math.round(Math.min(paneBandLimits.maximum, Math.max(paneBandLimits.minimum, size)) * 100) / 100 : paneBandLimits.minimum

/** The band's share of the pane for a drag to `pointerY`, from the band's top to the pane's bottom (px). */
export function paneBandDrag(pointerY: number, bandTop: number, paneTop: number, paneBottom: number): number {
  const height = paneBottom - paneTop
  return height > 0 ? clampPaneBand((pointerY - bandTop) / height) : paneBandLimits.minimum
}

/**
 * The splitter as a window splitter: Down makes the band taller (the splitter moves down) and Up shorter, a step at a
 * time; Home and End go to its smallest and largest. `size` is the band's share now, measured when it still sizes by
 * content. Undefined for any other key.
 */
export function paneBandKey(size: number, key: string): number | undefined {
  switch (key) {
    case 'ArrowDown': return clampPaneBand(size + paneBandLimits.step)
    case 'ArrowUp': return clampPaneBand(size - paneBandLimits.step)
    case 'Home': return paneBandLimits.minimum
    case 'End': return paneBandLimits.maximum
    default: return undefined
  }
}
