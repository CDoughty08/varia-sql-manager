import type { PopoutPaneId } from '../../../shared/layouts'

/**
 * A popout tab dragged back to the main window. The drag is the browser's own (HTML drag and drop works across the OS
 * windows of one page), so the main window gets `dragover` and `drop` at its own coordinates; which panel it carries is
 * kept here, since every window runs this page's code, and the data type marks the drag as Varia's.
 */
export const paneDragType = 'application/x-varia-pane'
let dragging: PopoutPaneId | undefined
export const paneDrag = {
  start(id: PopoutPaneId, transfer: DataTransfer | null): void {
    dragging = id
    transfer?.setData(paneDragType, id)
    if (transfer) transfer.effectAllowed = 'move'
  },
  end(): void { dragging = undefined },
  /** The panel a drag over a window carries, if it is a popout tab's. */
  carried(transfer: DataTransfer | null): PopoutPaneId | undefined { return dragging && transfer?.types.includes(paneDragType) ? dragging : undefined }
}
