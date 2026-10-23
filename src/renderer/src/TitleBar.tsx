import { useEffect, useLayoutEffect, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { applicationMenus, mnemonicIndex, type MenubarId } from '../../shared/commands/menus'
import { useServiceSnapshot, useWorkbench } from './core/WorkbenchContext'
import Icon from './Icon'
import { Mnemonic } from './menus/MenuLayer'

interface ControlsOverlay extends EventTarget { visible: boolean }
const point = (event: ReactPointerEvent) => ({ x: event.clientX, y: event.clientY })

/**
 * The title bar: the menubar on Windows and Linux (macOS uses its native menu bar, so there it is only the caption), the
 * caption, and room for the native window controls. The menubar has no key handlers: `KeybindingService` routes keys
 * to the menus while they own the keyboard, and focus follows the menus' state.
 */
export default function TitleBar({ title }: { title: string }) {
  const { menus, platform } = useWorkbench()
  const view = useServiceSnapshot(menus.controller)
  const { altHeld } = useServiceSnapshot(menus.access)
  const [overlayVisible, setOverlayVisible] = useState(false)
  const { focused, open } = view.menubar
  const dropdown = view.source === 'menubar' ? view.levels[0] : undefined
  // Tab enters the menubar at File. A button that keeps focus after the menus let go (Tab on its way out) stays the tab
  // stop, so the browser moves on from it, not from File.
  const [holdsFocus, setHoldsFocus] = useState<MenubarId | null>(null)

  // The focused menubar button holds keyboard focus while no menu is open (F10, Alt, or Escape from a menu).
  useLayoutEffect(() => {
    if (focused && !view.levels.length) document.getElementById('menubar-' + focused)?.focus({ preventScroll: true })
  }, [focused, view.levels.length])
  useEffect(() => {
    const overlay = (navigator as Navigator & { windowControlsOverlay?: ControlsOverlay }).windowControlsOverlay
    if (!overlay) return
    const update = () => setOverlayVisible(overlay.visible)
    update()
    overlay.addEventListener('geometrychange', update)
    return () => { overlay.removeEventListener('geometrychange', update) }
  }, [])

  const button = (id: MenubarId, label: string, mnemonic: string) => <button key={id} id={'menubar-' + id} data-menu={id} role="menuitem" aria-haspopup="menu"
    aria-expanded={open === id} aria-controls={open === id ? dropdown?.id : undefined} tabIndex={(focused ?? holdsFocus ?? 'file') === id ? 0 : -1} className={open === id ? 'active' : ''}
    onFocus={() => setHoldsFocus(id)} onBlur={() => setHoldsFocus(current => current === id ? null : current)}
    // Pressing a menubar button never moves focus: Cut or Undo in its menu acts on the editor or field focused before.
    onPointerDown={event => { event.preventDefault(); if (event.button === 0) menus.controller.menubarPointerDown(id, point(event)) }}
    onPointerEnter={() => menus.controller.menubarPointerEnter(id)}
    // A pointer press has already opened or closed the menu; a click without one comes from assistive technology.
    onClick={event => { if (event.detail === 0) menus.toggleMenubarMenu(id) }}>
    <Mnemonic title={label} index={mnemonicIndex(label, mnemonic)} />
  </button>

  return <header className="title-bar" data-platform={platform} data-overlay={overlayVisible}>
    <div className="title-bar-content">
      <div className="title-bar-left">
        <span className="title-bar-brand" title="Varia SQL Manager"><Icon name="varia" /></span>
        {platform !== 'darwin' && <nav className="title-bar-menus" role="menubar" aria-label="Application menu" data-mnemonics={altHeld || (view.mnemonics && focused) ? 'visible' : 'hidden'}>
          {applicationMenus.map(menu => button(menu.id, menu.label, menu.mnemonic))}
        </nav>}
      </div>
      <span className="title-bar-caption" title={title}>{title}</span>
      <span className="title-bar-spacer" />
    </div>
  </header>
}
