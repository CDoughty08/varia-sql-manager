/** A popout window's place on screen, as the saved layout keeps it. */
export interface PopoutPlace { readonly x: number; readonly y: number }

/**
 * Notices popout windows that moved, which no DOM event reports, between ticks of DockWorkspace's check. A window seen for
 * the first time is compared with the place last saved for it: the first popout starts the check, and a move before its
 * first tick used to become the place compared with, so that move was never saved.
 */
export class PopoutMoves {
  private readonly places = new Map<string, string>()
  /** Whether window `id` is now somewhere else than at the last tick or, seen for the first time, than `saved`. */
  moved(id: string, now: PopoutPlace, saved: PopoutPlace | undefined): boolean {
    const place = now.x + ',' + now.y, before = this.places.get(id) ?? (saved ? saved.x + ',' + saved.y : undefined)
    this.places.set(id, place)
    return before !== undefined && before !== place
  }
  /** Forgets the windows not in `open`. */
  keep(open: ReadonlySet<string>): void { for (const id of this.places.keys()) if (!open.has(id)) this.places.delete(id) }
}
