/** The widths Search Objects' filter row is laid out from, in CSS pixels, as the hidden measuring row draws them. */
export interface FilterWidths {
  /** The row's own width. */
  readonly available: number
  /** What the scope row's other controls take (the tab's server picker), with the gap before them. */
  readonly options: number
  /** The Match in segments. */
  readonly scope: number
  /** Each type chip, in order, the All types chip first. */
  readonly chips: readonly number[]
  /** The "+n more" button at its widest. */
  readonly more: number
  /** The gap between chips. */
  readonly gap: number
}
/**
 * `collapsed`: the scope and chips give way to one Filters button that shows them on demand. `shown`: the chips drawn in one
 * line (the rest behind "+n more"), every chip when they all fit.
 */
export interface FilterLayout { readonly collapsed: boolean; readonly shown: number }

/** Fewer chips than this in a line (All types and one more) and the row collapses to the Filters button. */
export const minimumChips = 2

/**
 * How the filter row fits: every chip in one line when they all fit; otherwise as many as fit before "+n more"; and when the
 * scope's segments do not fit beside the options, or fewer than `minimumChips` chips would show, the Filters button alone.
 * Widths come from measuring the real controls, so fonts, density and pressed chips' checks are all accounted for.
 */
export function layoutFilters({ available, options, scope, chips, more, gap }: FilterWidths): FilterLayout {
  if (available <= 0 || scope + options > available) return { collapsed: true, shown: 0 }
  let used = 0
  const ends = chips.map((width, index) => (used += (index ? gap : 0) + width))
  if (!chips.length || ends[chips.length - 1] <= available) return { collapsed: false, shown: chips.length }
  let shown = 0
  while (shown < chips.length && ends[shown] + gap + more <= available) shown++
  return shown < minimumChips ? { collapsed: true, shown: 0 } : { collapsed: false, shown }
}
