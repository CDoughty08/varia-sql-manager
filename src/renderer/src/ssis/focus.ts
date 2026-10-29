import type { SsisPropertiesState } from './SsisPropertiesService'

export interface SsisFocusHost {
  /** The document's frame, while it is the one shown. */
  readonly root: (id: string) => HTMLElement | null | undefined
  readonly activeElement: () => Element | null
  /** The page itself, where focus falls when the element that had it goes (a menu item, say). */
  readonly body: () => Element | null
  readonly modalOpen: () => boolean
  /** Runs the callback after React has drawn the latest state (the next frame); returns a cancel function. */
  readonly frame: (callback: () => void) => () => void
}
interface Documents { get(id: string | undefined): SsisPropertiesState | undefined; subscribe(listener: () => void): () => void }

/** A document's first control: its current section in the list, else its first enabled button (Refresh). */
const target = (root: HTMLElement) => root.querySelector<HTMLElement>('.document-nav-item[tabindex="0"]') ?? root.querySelector<HTMLElement>('button:not(:disabled)')

/**
 * Focuses a properties document as it opens or is shown. While its first read runs it has neither a section list nor an
 * enabled Refresh, so it takes focus when that read ends instead, provided focus is still where it was then (the tree or
 * the page, where the menu that opened it left it): someone who moved on meanwhile keeps their place, and F5 then
 * refreshes the document they just opened rather than the tree. One wait at a time; a newer request replaces it.
 */
export function ssisFocuser(documents: Documents, host: SsisFocusHost): { readonly focus: (id: string) => void; readonly dispose: () => void } {
  let waiting: (() => void) | undefined
  let cancelFrame: (() => void) | undefined
  const stop = () => { waiting?.(); waiting = undefined; cancelFrame?.(); cancelFrame = undefined }
  const attempt = (id: string, from?: Element | null) => {
    cancelFrame = host.frame(() => {
      cancelFrame = undefined
      if (host.modalOpen()) return
      const root = host.root(id)
      if (!root) return
      const active = host.activeElement()
      // A later attempt focuses only if nothing else took focus meanwhile.
      if (from !== undefined && active !== from && active !== host.body() && active !== null) return
      const control = target(root)
      if (control) { control.focus(); return }
      if (from !== undefined || !documents.get(id)?.loading) return
      const unsubscribe = documents.subscribe(() => {
        const state = documents.get(id)
        if (state?.loading) return
        stop()
        if (state) attempt(id, active)
      })
      waiting = unsubscribe
    })
  }
  return { focus: id => { stop(); attempt(id) }, dispose: stop }
}
