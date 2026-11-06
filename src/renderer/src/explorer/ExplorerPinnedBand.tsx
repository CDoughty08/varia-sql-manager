import { useCallback, useId, useLayoutEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type ReactNode } from 'react'
import Icon from '../Icon'

function Overflow({ edge, overflow, renderServer }: {
  edge: 'top' | 'bottom'; overflow: readonly number[]; renderServer(index: number, menu: boolean): ReactNode
}) {
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const direction = edge === 'top' ? 'above' : 'below'
  const focusFirst = useCallback(() => {
    if (trigger.current?.ownerDocument.activeElement === trigger.current) panel.current?.querySelector('button')?.focus()
  }, [])
  useLayoutEffect(() => {
    if (open) focusFirst()
  }, [focusFirst, open])
  const blur = (event: FocusEvent<HTMLElement>) => {
    const next = event.relatedTarget, menu = panel.current
    if (next && next !== trigger.current && menu?.matches(':popover-open') && !menu.contains(next)) menu.hidePopover()
  }
  const navigate = (event: KeyboardEvent<HTMLDivElement>) => {
    // Let Tab continue from the invoker after the browser dismisses the menu and restores its focus.
    if (event.key === 'Tab') { event.currentTarget.hidePopover(); return }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const items = [...event.currentTarget.querySelectorAll('button')], count = items.length
    const index = items.findIndex(button => button === button.ownerDocument.activeElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? count - 1
      : (index + (event.key === 'ArrowDown' ? 1 : count - 1)) % count
    event.preventDefault()
    items[next]?.focus()
  }
  return <>
    <button ref={trigger} type="button" className="explorer-pin-more" popoverTarget={id} aria-controls={id} aria-expanded={open} aria-haspopup="menu" onBlur={blur}>
      <span>… {overflow.length} more {direction}</span><Icon name={edge === 'top' ? 'chevron-down' : 'chevron-up'} />
    </button>
    <div ref={panel} id={id} className="explorer-pin-menu" popover="auto" role="menu" aria-label={`More servers ${direction}`}
      onToggle={event => {
        const shown = event.newState === 'open'
        setOpen(shown)
        // A close followed by a quick reopen can arrive as one toggle. The items may already be rendered.
        if (shown) focusFirst()
      }} onKeyDown={navigate} onBlur={blur}>
      {open && overflow.map(index => renderServer(index, true))}
    </div>
  </>
}

/** Pinned shortcuts sit outside the ARIA tree. The overflow is a light-dismiss popover, including in a popout window. */
export default function ExplorerPinnedBand({ edge, headers, overflow, onWheel, renderServer }: {
  edge: 'top' | 'bottom'; headers: readonly number[]; overflow: readonly number[]; onWheel(event: WheelEvent): void; renderServer(index: number, menu: boolean): ReactNode
}) {
  const band = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const element = band.current
    // Keep the non-passive listener off the scrollable tree so Chromium can scroll it directly.
    element?.addEventListener('wheel', onWheel, { passive: false })
    return () => element?.removeEventListener('wheel', onWheel)
  }, [onWheel])
  const more = overflow.length > 0 && <Overflow edge={edge} overflow={overflow} renderServer={renderServer} />
  return <div ref={band} className="explorer-pin-band" data-edge={edge} role="group" aria-label={edge === 'top' ? 'Servers above' : 'Servers below'}>
    {edge === 'top' && more}
    {headers.map(index => renderServer(index, false))}
    {edge === 'bottom' && more}
  </div>
}
