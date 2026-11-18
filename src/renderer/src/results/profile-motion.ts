// The column profile's card motion: when its list changes (Selected Columns Only, a peek, the selection while filtered),
// cards that stay slide from where they were drawn to their new place, cards that leave fade out where they were, and
// cards that arrive fade in. FLIP (measure first, change, invert with a transform, play to none) through the Web
// Animations API, animating only transform and opacity, so the compositor runs it. It lasts as long as the theme's
// `--varia-motion-move` says when it starts, so it is off wherever the theme turns motion off (0 ms under reduced motion).
import { motionEasing } from '../../../shared/theme/metrics'

/** Where a card is drawn: its top plus the scroller's scroll then (so a scroll between measures cancels out), left and width. */
export interface CardPlace { readonly top: number; readonly left: number; readonly width: number }

/** How long a move lasts at `element` now: the theme's `--varia-motion-move` in ms, which the theme sets to 0 while motion
 *  is reduced; 0 too where elements cannot animate (a test DOM) or the value cannot be read. */
export function moveDuration(element: Element): number {
  const animates = typeof (element as HTMLElement).animate === 'function' && typeof (element as HTMLElement).getAnimations === 'function'
  const value = animates ? element.ownerDocument.defaultView?.getComputedStyle(element).getPropertyValue('--varia-motion-move').trim() ?? '' : ''
  const match = /^(\d+(?:\.\d+)?)(ms|s)$/.exec(value)
  return match ? Number(match[1]) * (match[2] === 's' ? 1000 : 1) : 0
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

const timing = (duration: number, extra: KeyframeAnimationOptions = {}): KeyframeAnimationOptions => ({ duration, easing: motionEasing, ...extra })

/**
 * Plays the change from `before` to the cards now in place. `left` holds the elements of cards that went (React removed
 * them): a copy of each fades out in `ghosts`, a layer in the scroller that React leaves empty.
 */
export function playCardMoves(o: { readonly before: ReadonlyMap<number, CardPlace>; readonly cards: ReadonlyMap<number, HTMLElement>; readonly left: ReadonlyMap<number, HTMLElement>; readonly scroller: HTMLElement; readonly ghosts: HTMLElement }): void {
  const { before, cards, scroller, ghosts } = o
  const duration = moveDuration(scroller)
  if (duration <= 0) return
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
    const fade = ghost.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(0.97)' }], timing(duration, { fill: 'forwards' }))
    const remove = () => ghost.remove()
    fade.onfinish = remove
    fade.oncancel = remove
  }
  for (const [column, card] of cards) {
    const place = before.get(column)
    for (const running of card.getAnimations()) running.cancel()
    if (!place) {
      card.animate([{ opacity: 0, transform: 'translateY(-4px) scale(0.98)' }, { opacity: 1, transform: 'none' }], timing(duration, { delay: duration / 4, fill: 'backwards' }))
      continue
    }
    const shift = place.top - (card.getBoundingClientRect().top + scroller.scrollTop)
    if (Math.abs(shift) > 0.5) card.animate([{ transform: `translateY(${shift}px)` }, { transform: 'none' }], timing(duration))
  }
}

/** Scrolls the scroller as little as it takes to show `card` (by its layout place, which a running move's transform does not
 *  change), smoothly while the theme has motion. */
export function revealCard(card: HTMLElement, scroller: HTMLElement, gap = 6): void {
  const top = card.offsetTop - gap, bottom = card.offsetTop + card.offsetHeight + gap
  const to = top < scroller.scrollTop ? top : bottom > scroller.scrollTop + scroller.clientHeight ? bottom - scroller.clientHeight : undefined
  if (to === undefined) return
  if (typeof scroller.scrollTo === 'function') scroller.scrollTo({ top: to, behavior: moveDuration(scroller) > 0 ? 'smooth' : 'auto' })
  else scroller.scrollTop = to
}
