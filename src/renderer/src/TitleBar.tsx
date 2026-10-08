import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { AppMenu } from '../../shared/contracts'
import { menuShortcut } from '../../shared/shortcuts'
import Icon from './Icon'

const menus: { id: AppMenu; label: string }[] = [
  { id: 'file', label: 'File' }, { id: 'edit', label: 'Edit' }, { id: 'view', label: 'View' }, { id: 'window', label: 'Window' }
]
interface ControlsOverlay extends EventTarget { visible: boolean }

export default function TitleBar({ title }: { title: string }) {
  const root = useRef<HTMLElement>(null)
  const previousFocus = useRef<HTMLElement | null>(null)
  const pending = useRef(false)
  const [focusedMenu, setFocusedMenu] = useState<AppMenu>('file')
  const [openMenu, setOpenMenu] = useState<AppMenu | null>(null)
  const [error, setError] = useState('')
  const [overlayVisible, setOverlayVisible] = useState(false)

  const restoreFocus = useCallback(() => {
    if (previousFocus.current?.isConnected) previousFocus.current.focus({ preventScroll: true })
  }, [])
  const open = useCallback(async (id: AppMenu) => {
    if (pending.current) return
    const button = root.current?.querySelector<HTMLButtonElement>('[data-menu="' + id + '"]')
    if (!button) return
    pending.current = true
    setFocusedMenu(id)
    setOpenMenu(id)
    setError('')
    const box = button.getBoundingClientRect()
    // Native editing actions must retain the editor/input that was focused before the menu.
    restoreFocus()
    try {
      const result = await window.varia.showMenu({ menu: id, x: Math.max(0, Math.round(box.left)), y: Math.max(0, Math.round(box.bottom)) })
      if (!result.ok) setError(result.error)
    } catch { setError('Could not open the application menu.') }
    finally { pending.current = false; setOpenMenu(null) }
  }, [restoreFocus])

  useEffect(() => {
    const rememberFocus = (event: FocusEvent) => {
      if (event.target instanceof HTMLElement && !root.current?.contains(event.target)) previousFocus.current = event.target
    }
    document.addEventListener('focusin', rememberFocus)
    return () => { document.removeEventListener('focusin', rememberFocus) }
  }, [])
  const activateMenu = useCallback((menu: AppMenu | null) => {
    // Application menus act on the workbench, which is unavailable while a dialog is open.
    if (document.querySelector('[aria-modal="true"]')) return
    if (menu) void open(menu)
    else {
      setFocusedMenu('file')
      root.current?.querySelector<HTMLButtonElement>('[data-menu="file"]')?.focus()
    }
  }, [open])
  useEffect(() => window.varia.onMenuFocus(activateMenu), [activateMenu])
  useEffect(() => {
    // Also handle browser-dispatched keys; native Electron keys are intercepted in main.
    const keyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.shiftKey) return
      const key = event.key.toLowerCase()
      const menu = event.altKey ? menuShortcut(key) : undefined
      if (menu || (key === 'f10' && !event.altKey)) {
        event.preventDefault()
        event.stopPropagation()
        activateMenu(menu ?? null)
      }
    }
    document.addEventListener('keydown', keyDown, true)
    return () => { document.removeEventListener('keydown', keyDown, true) }
  }, [activateMenu])
  useEffect(() => {
    const overlay = (navigator as Navigator & { windowControlsOverlay?: ControlsOverlay }).windowControlsOverlay
    if (!overlay) return
    const update = () => setOverlayVisible(overlay.visible)
    update()
    overlay.addEventListener('geometrychange', update)
    return () => { overlay.removeEventListener('geometrychange', update) }
  }, [])

  function menuKey(event: ReactKeyboardEvent<HTMLButtonElement>, index: number) {
    const destination = event.key === 'ArrowRight' ? (index + 1) % menus.length : event.key === 'ArrowLeft' ? (index + menus.length - 1) % menus.length : event.key === 'Home' ? 0 : event.key === 'End' ? menus.length - 1 : undefined
    if (destination !== undefined) {
      event.preventDefault()
      const id = menus[destination].id
      setFocusedMenu(id)
      root.current?.querySelector<HTMLButtonElement>('[data-menu="' + id + '"]')?.focus()
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      void open(menus[index].id)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      restoreFocus()
    }
  }

  return <>
    <header ref={root} className="title-bar" data-platform={window.varia.platform} data-overlay={overlayVisible}>
      <div className="title-bar-content">
        <div className="title-bar-left">
          <span className="title-bar-brand" title="Varia SQL Manager"><Icon name="database" /></span>
          <nav className="title-bar-menus" role="menubar" aria-label="Application menu">
            {menus.map((menu, index) => <button key={menu.id} data-menu={menu.id} role="menuitem" aria-haspopup="menu" aria-expanded={openMenu === menu.id} tabIndex={focusedMenu === menu.id ? 0 : -1} className={openMenu === menu.id ? 'active' : ''} onPointerDown={event => event.preventDefault()} onFocus={() => setFocusedMenu(menu.id)} onClick={() => void open(menu.id)} onKeyDown={event => menuKey(event, index)}>{menu.label}</button>)}
          </nav>
        </div>
        <span className="title-bar-caption" title={title}>{title}</span>
        <span className="title-bar-spacer" />
      </div>
    </header>
    {error && <div className="global-error" role="alert"><span>{error}</span><button aria-label="Dismiss menu error" onClick={() => setError('')}><Icon name="close" /></button></div>}
  </>
}
