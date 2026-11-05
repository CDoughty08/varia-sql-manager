import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { IconId } from '../../../shared/icons'
import Icon from '../Icon'

interface Props {
  readonly label: string
  readonly title: string
  readonly icon: IconId
  readonly active?: boolean
  readonly compact?: boolean
  readonly children: ReactNode
  readonly trigger?: ReactNode
}

/** A nonmodal search picker in Chromium's top layer, outside the search band's clipping and scroll containers. */
export default function SearchPopover({ label, title, icon, active, compact, children, trigger }: Props) {
  const id = useId(), heading = useId()
  const button = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const place = () => {
    const invoker = button.current, popover = panel.current
    const query = invoker?.closest<HTMLElement>('.object-search-query')
    if (!invoker || !popover || !query) return
    const box = invoker.getBoundingClientRect(), bounds = query.getBoundingClientRect(), style = getComputedStyle(query)
    if (!box.width || !bounds.width) { popover.hidePopover(); return }
    const inset = 8, gap = 4, viewport = document.documentElement
    const width = Math.min(bounds.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight), compact ? 280 : 360, viewport.clientWidth - inset * 2)
    popover.style.width = `${Math.max(0, width)}px`
    const left = compact ? bounds.right - parseFloat(style.paddingRight) - width : bounds.left + parseFloat(style.paddingLeft)
    popover.style.left = `${Math.max(inset, Math.min(left, viewport.clientWidth - width - inset))}px`
    const below = Math.max(0, viewport.clientHeight - box.bottom - gap - inset), above = Math.max(0, box.top - gap - inset)
    const up = popover.scrollHeight > below && above > below
    popover.style.maxHeight = `${up ? above : below}px`
    popover.style.top = `${up ? Math.max(inset, box.top - gap - Math.min(popover.scrollHeight + 2, above)) : box.bottom + gap}px`
  }
  useLayoutEffect(() => {
    const popover = panel.current
    if (!open || !popover?.matches(':popover-open')) return
    place()
    // Toggle events are queued. If focus has already left the invoker, opening must not take it back.
    if (document.activeElement === button.current) {
      const first = popover.querySelector<HTMLElement>('input:checked') ?? popover.querySelector<HTMLElement>('input') ?? popover.querySelector<HTMLElement>('button')
      first?.focus()
    }
    const observer = new ResizeObserver(place)
    const query = button.current?.closest('.object-search-query')
    if (query) observer.observe(query)
    window.addEventListener('resize', place)
    document.addEventListener('scroll', place, true)
    return () => { observer.disconnect(); window.removeEventListener('resize', place); document.removeEventListener('scroll', place, true) }
  }, [open])
  return <>
    <button ref={button} type="button" className={compact ? 'icon-button object-search-popover-button' : 'object-search-filter-button object-search-type-button'}
      aria-label={label} title={label} aria-haspopup="dialog" aria-expanded={open} aria-controls={id} data-active={active || undefined} popoverTarget={id}>
      <Icon name={icon} />{trigger}{!compact && <Icon name="chevron-down" />}
    </button>
    <div ref={panel} id={id} className="object-search-popover" popover="auto" role="dialog" aria-labelledby={heading}
      onBeforeToggle={event => { if (event.newState === 'open') place() }} onToggle={event => setOpen(event.currentTarget.matches(':popover-open'))}>
      <div className="object-search-popover-heading"><span id={heading}>{title}</span>
        <button type="button" className="icon-button" aria-label={`Close ${title.toLowerCase()}`} title="Close (Escape)" popoverTarget={id} popoverTargetAction="hide"><Icon name="close" /></button>
      </div>
      {children}
    </div>
  </>
}
