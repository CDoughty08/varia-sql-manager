/** The kinds an overview bucket's bits name (results.diff's `overview`: 1 changed, 2 added, 4 removed), each drawn in its own
 *  lane of the strip: removed on the left, changed in the middle, added on the right. */
export const overviewLanes: readonly { readonly bit: number; readonly kind: 'changed' | 'added' | 'removed' }[] = [
  { bit: 4, kind: 'removed' }, { bit: 1, kind: 'changed' }, { bit: 2, kind: 'added' }
]

/** One mark of the strip: a run of neighbouring buckets that hold a kind, as a share of the strip's height. */
export interface OverviewMark { readonly kind: 'changed' | 'added' | 'removed'; readonly first: number; readonly last: number }

/** The marks an overview draws: per lane, each run of buckets that hold its kind, so at most half the buckets a lane. */
export function overviewMarks(buckets: readonly number[]): OverviewMark[] {
  const marks: OverviewMark[] = []
  for (const { bit, kind } of overviewLanes) {
    let first = -1
    for (let at = 0; at <= buckets.length; at++) {
      const on = at < buckets.length && (buckets[at] & bit) !== 0
      if (on && first < 0) first = at
      else if (!on && first >= 0) { marks.push({ kind, first, last: at - 1 }); first = -1 }
    }
  }
  return marks
}

/**
 * A comparison's overview strip, as an editor's overview ruler: beside the grid's vertical scroll bar, a mark in a kind's
 * colour (styles.css, from the theme's diff tokens) for each run of the comparison's stored rows that holds that kind.
 * Pressing a mark scrolls the grid to the part of it pressed (`pick`, with the bucket and the bucket count). It repeats what
 * the gutter and the chips say, so it is hidden from assistive technology. Built once per grid with plain elements: the
 * marks change only when the comparison does.
 */
export class OverviewStrip {
  readonly el: HTMLElement
  private buckets = 0
  private drawn = ''
  private placed = ''

  constructor(doc: Document, pick: (bucket: number, buckets: number) => void) {
    this.el = doc.createElement('div')
    this.el.className = 'rg-overview'
    this.el.setAttribute('aria-hidden', 'true')
    this.el.hidden = true
    // A press on a mark scrolls there, without taking the focus or starting a selection in the grid under it.
    this.el.addEventListener('pointerdown', event => {
      const mark = (event.target as Element | null)?.closest<HTMLElement>('.rg-overview-mark')
      if (!mark || event.button !== 0 || this.buckets === 0) return
      event.preventDefault()
      event.stopPropagation()
      const box = this.el.getBoundingClientRect(), first = Number(mark.dataset.first), last = Number(mark.dataset.last)
      const at = box.height > 0 ? Math.floor((event.clientY - box.top) / box.height * this.buckets) : first
      pick(Math.min(last, Math.max(first, at)), this.buckets)
    })
  }

  /** Draws the marks of `buckets` (replacing those of other buckets). */
  draw(buckets: readonly number[]): void {
    const key = buckets.join(',')
    if (key === this.drawn) return
    this.drawn = key
    this.buckets = buckets.length
    const doc = this.el.ownerDocument
    this.el.replaceChildren(...overviewMarks(buckets).map(mark => {
      const element = doc.createElement('span')
      element.className = `rg-overview-mark is-${mark.kind}`
      element.dataset.first = String(mark.first)
      element.dataset.last = String(mark.last)
      element.style.top = `${mark.first / buckets.length * 100}%`
      element.style.height = `${(mark.last - mark.first + 1) / buckets.length * 100}%`
      return element
    }))
  }

  /** Shows the strip between `top` and `bottom` px of the grid, `right` px from its right edge (left of the vertical scroll
   *  bar), or hides it. Written only when it changes. */
  place(shown: boolean, top: number, right: number, bottom: number): void {
    const key = shown ? `${top}|${right}|${bottom}` : ''
    if (key === this.placed) return
    this.placed = key
    this.el.hidden = !shown
    if (!shown) return
    this.el.style.top = `${top}px`
    this.el.style.right = `${right}px`
    this.el.style.bottom = `${bottom}px`
  }
}
