/** Whether a range covers some of a fact's text: a triple-click's paragraph ends at the next fact's start, which touches it
 *  without selecting any of it. */
function covers(range: Range, fact: HTMLElement): boolean {
  if (!range.intersectsNode(fact)) return false
  const part = fact.ownerDocument.createRange()
  part.selectNodeContents(fact)
  if (range.compareBoundaryPoints(Range.START_TO_START, part) > 0) part.setStart(range.startContainer, range.startOffset)
  if (range.compareBoundaryPoints(Range.END_TO_END, part) < 0) part.setEnd(range.endContainer, range.endOffset)
  return part.toString().trim() !== ''
}
/** The facts (`selector`, each a `<dt>` and `<dd>`) in `pane` whose text the document's selection covers. */
export function selectedFacts(pane: HTMLElement, selector: string): HTMLElement[] {
  const selection = pane.ownerDocument.getSelection()
  if (!selection || selection.isCollapsed) return []
  const ranges = Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index))
  return [...pane.querySelectorAll<HTMLElement>(selector)].filter(fact => ranges.some(range => covers(range, fact)))
}
/** A fact's name and value as shown. */
export const factText = (fact: HTMLElement) => [fact.querySelector('dt')?.textContent ?? '', fact.querySelector('dd')?.textContent ?? ''] as const
