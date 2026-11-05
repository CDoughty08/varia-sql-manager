// Dragging a query tab along the document strip to reorder it. The drag carries Varia's own type, and the tab being
// dragged is kept here rather than read from the drag data, so only a drag that started on this page's strip moves a
// tab; Monaco, Dockview and other apps ignore the type.
import { useRef, type DragEvent } from 'react'

export const tabDragType = 'application/x-varia-document-tab'

export type DropSide = 'before' | 'after'

/** Which side of a tab a drag at `clientX` is on: its left half drops before it, its right half after. */
export function dropSide(clientX: number, box: { readonly left: number; readonly width: number }): DropSide {
  return clientX < box.left + box.width / 2 ? 'before' : 'after'
}

/**
 * The index the dragged tab ends up at, dropping it on the `side` of the tab at `over`, with the dragged tab at `from`
 * (both in the current order). Dropping it next to itself leaves it where it is.
 */
export function dropIndex(from: number, over: number, side: DropSide): number {
  const insert = over + (side === 'after' ? 1 : 0)
  return insert > from ? insert - 1 : insert
}

export interface TabDragHandlers {
  readonly draggable: true
  onDragStart(event: DragEvent<HTMLElement>): void
  onDragOver(event: DragEvent<HTMLElement>): void
  onDragLeave(event: DragEvent<HTMLElement>): void
  onDrop(event: DragEvent<HTMLElement>): void
  onDragEnd(event: DragEvent<HTMLElement>): void
}

const clearMarks = (strip: Element | null | undefined) => strip?.querySelectorAll('[data-drop]').forEach(element => element.removeAttribute('data-drop'))

/**
 * Drag handlers for each tab (`tab(id)`) and for the strip's empty end (`strip`), which drops after the last tab. A tab
 * shows where the drop goes with `data-drop="before|after"`. `ids` reads the order now; `move` puts a tab at an index.
 */
export function useTabDrag(ids: () => readonly string[], move: (id: string, index: number) => void): { tab: (id: string) => TabDragHandlers; strip: Pick<TabDragHandlers, 'onDragOver' | 'onDrop'> } {
  const dragging = useRef<string | undefined>(undefined)
  const ours = (event: DragEvent<HTMLElement>) => !!dragging.current && Array.from(event.dataTransfer.types).includes(tabDragType)
  const finish = (event: DragEvent<HTMLElement>) => { dragging.current = undefined; clearMarks(event.currentTarget.closest('[role="tablist"]')) }
  const tab = (id: string): TabDragHandlers => ({
    draggable: true,
    onDragStart: event => {
      dragging.current = id
      event.dataTransfer.effectAllowed = 'move'
      event.dataTransfer.setData(tabDragType, id)
    },
    onDragOver: event => {
      if (!ours(event)) return
      event.preventDefault()
      event.stopPropagation()
      event.dataTransfer.dropEffect = 'move'
      const side = dropSide(event.clientX, event.currentTarget.getBoundingClientRect())
      if (event.currentTarget.dataset.drop === side) return
      clearMarks(event.currentTarget.parentElement)
      if (dragging.current !== id) event.currentTarget.dataset.drop = side
    },
    onDragLeave: event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) event.currentTarget.removeAttribute('data-drop') },
    onDrop: event => {
      if (!ours(event)) return
      event.preventDefault()
      event.stopPropagation()
      const order = ids(), from = order.indexOf(dragging.current!), over = order.indexOf(id)
      if (from >= 0 && over >= 0) move(dragging.current!, dropIndex(from, over, dropSide(event.clientX, event.currentTarget.getBoundingClientRect())))
      finish(event)
    },
    onDragEnd: finish
  })
  const strip: Pick<TabDragHandlers, 'onDragOver' | 'onDrop'> = {
    onDragOver: event => {
      if (!ours(event)) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      clearMarks(event.currentTarget)
    },
    onDrop: event => {
      if (!ours(event)) return
      event.preventDefault()
      move(dragging.current!, ids().length - 1)
      finish(event)
    }
  }
  return { tab, strip }
}
