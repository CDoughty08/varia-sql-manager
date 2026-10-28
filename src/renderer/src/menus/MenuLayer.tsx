import { Component, useLayoutEffect, useRef, useState, type ErrorInfo, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { onUnexpectedError } from '../core/errors'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import { placeMenu, type Placement, type Rect } from './geometry'
import type { MenuController, MenuLevel, MenuView } from './MenuController'
import type { ResolvedMenuItem } from './resolve'
import { codiconClass, type IconId } from '../../../shared/icons'
import Icon from '../Icon'

interface ControlsOverlay { readonly visible: boolean; getTitlebarAreaRect(): DOMRect }
const point = (event: ReactPointerEvent) => ({ x: event.clientX, y: event.clientY })
const rectOf = (element: Element): Rect => { const { left, top, right, bottom } = element.getBoundingClientRect(); return { left, top, right, bottom } }

/** A title with its access key underlined; `.menu-mnemonic` shows the underline only while access keys are visible. */
export function Mnemonic({ title, index }: { title: string; index: number }) {
  if (index < 0 || index >= title.length) return <>{title}</>
  return <>{title.slice(0, index)}<u className="menu-mnemonic">{title[index]}</u>{title.slice(index + 1)}</>
}

/** Menus stay clear of the native window controls, which Windows and Linux draw over the page's top right corner. */
function controlsArea(): Rect | undefined {
  const overlay = (navigator as Navigator & { windowControlsOverlay?: ControlsOverlay }).windowControlsOverlay
  if (!overlay?.visible) return undefined
  const area = overlay.getTitlebarAreaRect()
  return { left: area.right, top: area.top, right: document.documentElement.clientWidth, bottom: area.bottom }
}

function itemRole(item: Extract<ResolvedMenuItem, { kind: 'command' }>): string {
  return item.radio ? 'menuitemradio' : item.checked !== undefined ? 'menuitemcheckbox' : 'menuitem'
}
function gutterIcon(item: ResolvedMenuItem): IconId | undefined {
  if (item.kind !== 'command') return undefined
  if (item.checked) return item.radio ? 'circle-filled' : 'check'
  return item.checked === undefined ? item.icon ?? undefined : undefined
}

function MenuItemView({ item, level, depth, index, expanded, controller }: {
  item: ResolvedMenuItem; level: MenuLevel; depth: number; index: number; expanded?: string; controller: MenuController
}) {
  if (item.kind === 'separator') return <div className="menu-separator" role="separator" />
  const command = item.kind === 'command' ? item : undefined, icon = gutterIcon(item)
  const keys = command?.keybinding
  return <div className="menu-item" role={command ? itemRole(command) : 'menuitem'} id={`${level.id}-${index}`} data-item-id={item.key} tabIndex={-1}
    aria-disabled={!item.enabled ? true : undefined} aria-checked={command?.checked}
    aria-haspopup={item.kind === 'submenu' ? 'menu' : undefined} aria-expanded={item.kind === 'submenu' ? !!expanded : undefined} aria-controls={expanded}
    aria-keyshortcuts={keys && keys.parts.length === 1 ? keys.aria : undefined} data-active={level.active === index ? '' : undefined}
    onPointerEnter={event => controller.pointerEnterItem(depth, index, point(event))}
    onPointerUp={event => controller.pointerUp(depth, index, point(event), event.button)}
    onClick={event => { if (event.button === 0) controller.click(depth, index) }}>
    <span className="menu-gutter" aria-hidden="true">{icon && <Icon name={icon} />}</span>
    <span className="menu-label"><Mnemonic title={item.title} index={item.mnemonic} /></span>
    <span className="menu-keybinding" aria-hidden="true">{keys?.text}</span>
    <span className={item.kind === 'submenu' ? 'menu-chevron ' + codiconClass('chevron-right') : 'menu-chevron'} aria-hidden="true" />
  </div>
}

/**
 * One open menu. It first renders hidden at the top left, is measured once, and is then placed by `placeMenu` before
 * the browser paints, so it never flickers. The innermost menu holds keyboard focus: its active item, or itself while
 * no item is active.
 */
function MenuLevelView({ view, depth, controller }: { view: MenuView; depth: number; controller: MenuController }) {
  const level = view.levels[depth], child = view.levels[depth + 1]
  const ref = useRef<HTMLDivElement>(null)
  const [placement, setPlacement] = useState<Placement | null>(null)
  const innermost = depth === view.levels.length - 1
  useLayoutEffect(() => {
    const { width, height } = ref.current!.getBoundingClientRect()
    setPlacement(placeMenu(level.anchor, { width, height }, { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight }, controlsArea()))
  }, [level.anchor])
  const report = () => { const element = ref.current; if (element) controller.setLevelRect(depth, rectOf(element), [...element.children].map(rectOf)) }
  useLayoutEffect(() => { if (placement) report() })
  useLayoutEffect(() => {
    const element = ref.current
    if (!placement || !innermost || !element) return
    const target = level.active >= 0 ? element.children[level.active] as HTMLElement | undefined : element
    target?.focus({ preventScroll: true })
    if (target !== element) target?.scrollIntoView({ block: 'nearest' })
  }, [placement, innermost, level.active])
  const labelledBy = depth === 0 && view.source === 'menubar' && view.menubar.open ? 'menubar-' + view.menubar.open : undefined
  return <div ref={ref} className="menu" role="menu" id={level.id} aria-label={labelledBy ? undefined : level.label} aria-labelledby={labelledBy} aria-orientation="vertical"
    tabIndex={-1} data-level={depth} style={placement ? { left: placement.x, top: placement.y, maxHeight: placement.maxHeight } : { left: 0, top: 0, visibility: 'hidden' }}
    onPointerLeave={() => controller.pointerLeaveLevel(depth)} onScroll={report}>
    {level.items.map((item, index) => <MenuItemView key={item.key} item={item} level={level} depth={depth} index={index} controller={controller}
      expanded={child && level.active === index ? child.id : undefined} />)}
  </div>
}

class MenuErrorBoundary extends Component<{ open: boolean; onError(error: unknown): void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(error: Error, _info: ErrorInfo) { this.props.onError(error) }
  // The menus closed after the failure, so the next menu renders afresh.
  componentDidUpdate() { if (this.state.failed && !this.props.open) this.setState({ failed: false }) }
  render() { return this.state.failed ? null : this.props.children }
}

/**
 * The custom menus: one layer at the end of `body`, above the docking guides, the quick input, and dialogs. It renders
 * the controller's state and reports pointer events and measured rects back; the controller decides everything else.
 */
export default function MenuLayer() {
  const { menus, commands } = useWorkbench()
  const view = useServiceSnapshot(menus.controller)
  const controller = menus.controller
  const failed = (error: unknown) => {
    onUnexpectedError(error)
    menus.close('dispose')
    commands.reportError('Could not show the menu.')
  }
  return createPortal(<MenuErrorBoundary open={view.levels.length > 0} onError={failed}>
    <div className="menu-layer" data-mnemonics={view.mnemonics ? 'visible' : 'hidden'} onPointerMove={event => controller.pointerMove(point(event))}
      onContextMenu={event => event.preventDefault()} onAuxClick={event => event.preventDefault()}>
      {view.levels.map((level, depth) => <MenuLevelView key={level.id} view={view} depth={depth} controller={controller} />)}
    </div>
  </MenuErrorBoundary>, document.body)
}
