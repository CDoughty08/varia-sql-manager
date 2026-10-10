/**
 * Shows the window's native dialogs one at a time: each `show` starts once the one before it has settled, whether it
 * resolved or failed. Windows and Linux show a second modal dialog over one still open, so the user could answer the
 * wrong one; a dialog asked for while another is open (a Script As file whose script arrives during Save Grid Results)
 * waits for it instead.
 */
export function dialogQueue(): <T>(show: () => Promise<T>) => Promise<T> {
  let last: Promise<unknown> = Promise.resolve()
  return show => {
    const shown = last.then(show)
    last = shown.catch(() => undefined)
    return shown
  }
}
