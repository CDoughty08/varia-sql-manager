// The column profile's card motion: when its list changes (Selected Columns Only, a peek, the selection while filtered),
// cards that stay slide from where they were drawn to their new place, cards that leave fade out where they were, and
// cards that arrive fade in. FLIP (measure first, change, invert with a transform, play to none) through the Web
// Animations API, animating only transform and opacity, so the compositor runs it. Off under reduced motion.
import { motion, motionEasing } from '../../../shared/theme/metrics'

/** Where a card is drawn: its top plus the scroller's scroll then (so a scroll between measures cancels out), left and width. */
export interface CardPlace { readonly top: number; readonly left: number; readonly width: number }

/** Whether the window asks for less motion, or cannot animate elements (a test DOM). */
export function reducedMotion(element: Element): boolean {
  const view = element.ownerDocument.defaultView
  const animates = typeof (element as HTMLElement).animate === 'function' && typeof (element as HTMLElement).getAnimations === 'function'
  return !animates || !view?.matchMedia || view.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** Every card's place as drawn now, a running move's transform included, so an interrupted move continues from there. */
export function measureCards(cards: ReadonlyMap<number, HTMLElement>, scroller: HTMLElement): Map<number, CardPlace> {
  const places = new Map<number, CardPlace>()
  for (const [column, card] of cards) {
    const rect = card.getBoundingClientRect()
    places.set(column, { top: rect.top + scroller.scrollTop, left: rect.left, width: rect.width })
  }
  return places
}

const timing = (extra: KeyframeAnimationOptions = {}): KeyframeAnimationOptions => ({ duration: motion.move.ms, easing: motionEasing, ...extra })

/**
 * Plays the change from `before` to the cards now in place. `left` holds the elements of cards that went (React removed
 * them): a copy of each fades out in `ghosts`, a layer in the scroller that React leaves empty.
 */
export function playCardMoves(o: { readonly before: ReadonlyMap<number, CardPlace>; readonly cards: ReadonlyMap<number, HTMLElement>; readonly left: ReadonlyMap<number, HTMLElement>; readonly scroller: HTMLElement; readonly ghosts: HTMLElement }): void {
  const { before, cards, scroller, ghosts } = o
  if (reducedMotion(scroller)) return
  const box = scroller.getBoundingClientRect()
  for (const [column, element] of o.left) {
    const place = before.get(column)
    if (!place || cards.has(column)) continue
    const ghost = element.cloneNode(true) as HTMLElement
    // A picture of the card, not the card: nothing names, focuses or finds it.
    for (const attribute of ['id', 'tabindex', 'aria-label', 'aria-current', 'data-column']) ghost.removeAttribute(attribute)
    ghost.setAttribute('aria-hidden', 'true')
    ghost.classList.add('profile-card-ghost')
    ghost.style.top = `${place.top - box.top - scroller.clientTop}px`
    ghost.style.left = `${place.left - box.left - scroller.clientLeft}px`
    ghost.style.width = `${place.width}px`
    ghosts.append(ghost)
    const fade = ghost.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(0.97)' }], timing({ fill: 'forwards' }))
    const remove = () => ghost.remove()
    fade.onfinish = remove
    fade.oncancel = remove
  }
  for (const [column, card] of cards) {
    const place = before.get(column)
    for (const running of card.getAnimations()) running.cancel()
    if (!place) {
      card.animate([{ opacity: 0, transform: 'translateY(-4px) scale(0.98)' }, { opacity: 1, transform: 'none' }], timing({ delay: motion.move.ms / 4, fill: 'backwards' }))
      continue
    }
    const shift = place.top - (card.getBoundingClientRect().top + scroller.scrollTop)
    if (Math.abs(shift) > 0.5) card.animate([{ transform: `translateY(${shift}px)` }, { transform: 'none' }], timing())
  }
}

/** Scrolls the scroller as little as it takes to show `card` (by its layout place, which a running move's transform does not
 *  change), smoothly unless reduced motion. */
export function revealCard(card: HTMLElement, scroller: HTMLElement, gap = 6): void {
  const top = card.offsetTop - gap, bottom = card.offsetTop + card.offsetHeight + gap
  const to = top < scroller.scrollTop ? top : bottom > scroller.scrollTop + scroller.clientHeight ? bottom - scroller.clientHeight : undefined
  if (to === undefined) return
  if (typeof scroller.scrollTo === 'function') scroller.scrollTo({ top: to, behavior: reducedMotion(scroller) ? 'auto' : 'smooth' })
  else scroller.scrollTop = to
}
