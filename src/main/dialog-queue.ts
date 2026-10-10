export interface DialogQueue {
  /** Shows the dialog once every dialog asked for before it has settled, whether it resolved or failed. If reset() comes
   *  first, it is never shown and settles with `cancelled`, the answer its Cancel button would give. */
  <T>(show: () => Promise<T>, cancelled: T): Promise<T>
  /** Settles every dialog not yet shown with its `cancelled` answer. The open one stays: a native file dialog cannot be
   *  closed from main, and the next dialog waits for it as before. */
  reset(): void
}

/**
 * Shows the window's native dialogs one at a time. Windows and Linux show a second modal dialog over one still open, so
 * the user could answer the wrong one; a dialog asked for while another is open (a Script As file whose script arrives
 * during Save Grid Results, or the crash prompt) waits for it instead. A page that crashed or reloaded can no longer use
 * the answers it asked for, so main resets the queue then, and the new page's dialogs do not wait behind them.
 */
export function dialogQueue(): DialogQueue {
  interface Waiting { readonly show: () => Promise<unknown>; readonly cancel: () => void; readonly settle: (shown: Promise<unknown>) => void }
  const waiting: Waiting[] = []
  let open = false
  const next = (): void => {
    const entry = open ? undefined : waiting.shift()
    if (!entry) return
    open = true
    // A dialog that throws before it opens (a destroyed window) is a failure like any other.
    const shown = (async () => entry.show())()
    entry.settle(shown)
    void shown.catch(() => undefined).then(() => { open = false; next() })
  }
  const queue = <T>(show: () => Promise<T>, cancelled: T): Promise<T> => new Promise<T>((resolve, reject) => {
    waiting.push({ show, cancel: () => resolve(cancelled), settle: shown => { (shown as Promise<T>).then(resolve, reject) } })
    queueMicrotask(next)
  })
  return Object.assign(queue, { reset: () => { for (const entry of waiting.splice(0)) entry.cancel() } })
}
