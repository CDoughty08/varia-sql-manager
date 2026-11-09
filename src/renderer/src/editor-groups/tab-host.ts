/** What a document tab writes on Dockview's tab element around it. */
export interface TabHostState { readonly tooltip: string; readonly description: string | undefined }
type Subscribe = (listener: () => void) => { dispose(): void }

/**
 * Keeps Dockview's tab element (`.dv-tab`, the one with the tab role and roving focus) marked as a document tab, with the
 * tab's tooltip and accessible description. Dockview builds a new tab element when a panel moves to another group (a split,
 * a move, a drag) and moves the same React header into it, so nothing the header renders changes: each event in `moved`
 * (Dockview's layout and group changes) checks the element again. F2's `documentTabFocus` key relies on the marker.
 */
export function followTabHost(content: HTMLElement, moved: readonly Subscribe[]): { update(state: TabHostState): void; dispose(): void } {
  let state: TabHostState = { tooltip: '', description: undefined }, synced: HTMLElement | undefined
  const sync = () => {
    const host = content.closest<HTMLElement>('.dv-tab')
    if (!host || host === synced) return
    host.dataset.documentTab = ''
    host.title = state.tooltip
    if (state.description) host.setAttribute('aria-description', state.description)
    else host.removeAttribute('aria-description')
    synced = host
  }
  // Group changes fire while Dockview is still moving the header; its new element holds it once that move is done.
  const subscriptions = moved.map(subscribe => subscribe(() => queueMicrotask(sync)))
  return {
    update: next => { state = next; synced = undefined; sync() },
    dispose: () => subscriptions.forEach(subscription => subscription.dispose())
  }
}
