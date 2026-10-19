import type { CommandId } from '../../../shared/commands/catalog'
import type { SettingsValues } from '../../../shared/settings/catalog'
import type { ContextKeys } from '../../../shared/commands/context-keys'
import type { KeybindingLabel, Platform } from '../../../shared/commands/keybindings'
import { menubarIds, menuForMnemonic, type ContextMenuId, type MenubarId, type MenuId } from '../../../shared/commands/menus'
import type { VariaApi } from '../../../shared/contracts'
import type { MenuStyle } from '../../../shared/menu-style'
import { themeMenuModel, type ThemeMenuItem } from '../../../shared/theme/menu'
import type { ThemeState } from '../../../shared/theme/types'
import type { CommandService } from '../core/commands'
import { onUnexpectedError } from '../core/errors'
import type { FocusAdapter } from '../core/focus'
import type { KeyDownEvent } from '../core/keybindings'
import type { Timers } from '../core/timers'
import type { Disposable } from '../core/types'
import type { Anchor, Rect } from './geometry'
import { MenuController, type CloseReason, type MenuKey } from './MenuController'
import { MenubarAccess } from './menubar'
import { NativeMenuPresenter } from './native'
import { resolveMenu, type DynamicMenuItem, type ResolvedCommandItem, type ResolvedMenuItem } from './resolve'
import { argsFor, contextMenuLabels, menuForTarget, targetKeys, type MenuTarget, type MenuTargetService, type TargetHit } from './targets'

/**
 * View › Theme's theme items as menu items: the mode and theme choices run `preferences.setTheme` with the choice as
 * arguments, and the theme-file actions run their commands. Theme names get no access key.
 */
export function themeMenuItems(theme: Pick<ThemeState, 'preference' | 'themes'>): DynamicMenuItem[] {
  const map = (items: readonly ThemeMenuItem[]): DynamicMenuItem[] => items.map((item): DynamicMenuItem => {
    if (item.kind === 'separator') return item
    if (item.kind === 'submenu') return { kind: 'submenu', key: item.id, title: item.label, mnemonic: item.mnemonic, items: map(item.items) }
    if (item.kind === 'action') return { kind: 'command', key: item.id, id: item.command, title: item.label, mnemonic: item.mnemonic }
    return {
      kind: 'command', key: item.id, id: 'preferences.setTheme', title: item.label, mnemonic: item.mnemonic ?? null, checked: item.checked, radio: true,
      enabled: item.enabled && !!item.patch, ...(item.patch ? { args: { theme: item.patch } } : {})
    }
  })
  return map(themeMenuModel(theme))
}

export interface MenuServiceOptions {
  readonly platform: Platform
  /** A packaged build: its menus have no development commands. */
  readonly packaged?: boolean
  readonly commands: Pick<CommandService, 'isEnabled' | 'isToggled' | 'execute' | 'onWillExecute'>
  /** Static and state keys, for menu conditions and enablement. */
  readonly context: { getState(): ContextKeys }
  readonly keybindings: { lookup(id: CommandId): KeybindingLabel | undefined }
  readonly theme: { readonly state: Pick<ThemeState, 'preference' | 'themes'> }
  /** The settings titles follow (Select Top <n> Rows). */
  readonly settings?: () => SettingsValues
  readonly focus: FocusAdapter
  readonly modalOpen: () => boolean
  /** Whether focus is in the query editor's find widget, where Alt+W toggles Whole Word instead of opening Window. */
  readonly findWidgetFocused?: () => boolean
  /** Where a menubar button is: its dropdown opens below it. */
  readonly menubarRect?: (id: MenubarId) => Rect | undefined
  /** What context menus are for; without it, no context menu opens. */
  readonly targets?: MenuTargetService
  /** The query editor's caret line, scrolled into view: a keyboard-opened editor menu opens below it. */
  readonly editorCaret?: () => Rect | undefined
  /** Whether `element` is inside the topmost open dialog, where text fields keep their menu. */
  readonly modalContains?: (element: Element) => boolean
  /** 'native' shows context menus through main (macOS), and the workbench's own only when main cannot. */
  readonly style?: MenuStyle
  readonly api?: Pick<VariaApi, 'showContextMenu' | 'onContextMenuCommand'>
  readonly timers?: Timers
}

const guard = (action: () => void) => { try { action() } catch (error) { onUnexpectedError(error) } }
const hasItems = (items: readonly ResolvedMenuItem[]) => items.some(item => item.kind !== 'separator')
const inside = (target: EventTarget | null, selector: string) => typeof (target as Partial<Element> | null)?.closest === 'function' && !!(target as Element).closest(selector)
/** The item a focused composite widget names as active (`aria-activedescendant`), when it is inside the widget. */
function activeDescendant(element: Element | null): Element | undefined {
  if (typeof element?.getAttribute !== 'function') return undefined
  const id = element.getAttribute('aria-activedescendant'), found = id ? element.ownerDocument?.getElementById(id) : null
  return found && element.contains(found) ? found : undefined
}
/** The menubar menu whose button `target` is in, if any. */
function menubarButton(target: EventTarget | null): MenubarId | undefined {
  if (typeof (target as Partial<Element> | null)?.closest !== 'function') return undefined
  const id = (target as Element).closest('.title-bar-menus [data-menu]')?.getAttribute('data-menu')
  return menubarIds.find(menu => menu === id)
}
function menuKey(event: KeyDownEvent, platform: Platform): MenuKey {
  // AltGr types characters (Ctrl+Alt on Windows), so it is neither a shortcut nor an access key here.
  const altGraph = platform !== 'darwin' && event.getModifierState?.('AltGraph') === true
  return { key: event.key, code: event.code, alt: event.altKey && !altGraph, ctrl: event.ctrlKey && !altGraph, meta: event.metaKey, shift: event.shiftKey, repeat: event.repeat }
}

/**
 * The title-bar menus (Windows and Linux) and context menus: resolves menus from the catalogue, owns the keyboard while
 * a menu is open or the menubar has focus (`KeybindingService` routes keys here first), and returns focus to where it
 * was before the menus took it. A chosen command runs only after the menus have closed and that focus is back, so Cut,
 * Undo, and Find act on the editor or field the menu was opened from.
 */
export class MenuService implements Disposable {
  readonly controller: MenuController
  readonly access: MenubarAccess
  private owned = false
  private replacing = false
  /** The menubar took the keyboard because Tab or Shift+Tab reached one of its buttons, so Tab also leaves it onward. */
  private tabbedIn = false
  /** Where focus goes back to: captured when the menus take the keyboard. */
  private restoreTarget: unknown
  /** The latest focus outside the menus, the menubar, and the quick input. */
  private lastFocus: unknown
  /** The element an open context menu is for, outlined while the menu shows. */
  private marked?: Element
  /** The same for an open native menu. */
  private nativeMarked?: Element
  /** A widget scrolled to show its active item for a keyboard menu: that scroll does not close the menu. */
  private revealed?: { readonly widget: Element; readonly top: number }
  private readonly native?: NativeMenuPresenter
  private readonly subscriptions: Disposable[]
  private detach?: () => void

  constructor(private readonly options: MenuServiceOptions) {
    this.controller = new MenuController({
      ...(options.timers ? { timers: options.timers } : {}),
      menubar: id => this.resolve(id),
      menubarRect: id => options.menubarRect?.(id),
      activate: item => this.activate(item),
      closed: reason => this.closed(reason)
    })
    this.access = new MenubarAccess(options.platform)
    if (options.style === 'native' && options.api) this.native = new NativeMenuPresenter({ api: options.api, commands: options.commands, ...(options.timers ? { timers: options.timers } : {}) })
    const unsubscribe = this.controller.subscribe(() => this.ownershipChanged())
    this.subscriptions = [
      { dispose: unsubscribe },
      // Another way of running a command (a key, the palette, a toolbar button) closes the menus first.
      options.commands.onWillExecute(event => { if (event.source !== 'menu' && this.ownsKeyboard()) this.close('command') })
    ]
  }

  /** A menu as it shows now; a context menu's items for `target`, whose commands run with it as their arguments. */
  resolve(menu: MenuId, target?: MenuTarget): readonly ResolvedMenuItem[] {
    const { platform, packaged, commands, keybindings, theme } = this.options
    return resolveMenu(menu, {
      platform, packaged, state: this.options.context.getState(), commands, keybindings, dynamic: { theme: () => themeMenuItems(theme.state) }, settings: this.options.settings?.(),
      ...(target ? { target: targetKeys(target), args: argsFor(target) } : {})
    })
  }
  ownsKeyboard(): boolean { return this.controller.ownsKeyboard() }
  close(reason: CloseReason): void { this.controller.close(reason) }

  /** Arms a bare-Alt tap, or cancels it; called for every key press, before the menus or the workbench handle it. */
  noteKeyDown(event: KeyDownEvent): void { this.access.noteKeyDown(event) }
  /** A key press while the menus own the keyboard; 'passthrough' lets the workbench dispatch it after they closed. */
  handleKeyDown(event: KeyDownEvent): 'consumed' | 'passthrough' {
    if (!this.ownsKeyboard()) return 'passthrough'
    // The browser moves focus on from the button in the page's order, as from any control, instead of back to where it
    // came from: otherwise Tab would bounce between the menubar and the control before it.
    if (this.tabbedIn && event.key === 'Tab' && !event.ctrlKey && !event.altKey && !event.metaKey && !this.controller.view.levels.length) {
      this.close('focus')
      return 'passthrough'
    }
    // Holding F10 must not toggle the menubar on every repeat.
    const result = event.repeat && event.key === 'F10' ? 'consumed' : this.controller.key(menuKey(event, this.options.platform))
    if (result === 'consumed') { event.preventDefault(); event.stopPropagation() }
    return result
  }
  /** Releases go to the menus while they own the keyboard (the keyup of a key that opened or closed one included). */
  handleKeyUp(event: KeyDownEvent): void {
    const owned = this.ownsKeyboard()
    if (this.access.noteKeyUp(event)) {
      if (owned) this.close('escape')
      else if (this.accessAllowed()) this.controller.focusMenubar('file')
    }
    if (owned) { event.preventDefault(); event.stopPropagation() }
  }
  /**
   * F10 and Alt+F/E/V/Q/T/W on Windows and Linux: F10 focuses the menubar, and Alt plus a menu's letter opens that menu
   * with its first item active. Not while a dialog is open, nor Alt+W in the editor's find widget (Whole Word).
   */
  handleAccessKey(chord: string, event: KeyDownEvent): boolean {
    if (this.options.platform === 'darwin') return false
    const menu = chord.startsWith('alt+') ? menuForMnemonic(chord.slice('alt+'.length)) : undefined
    if (chord !== 'f10' && !menu) return false
    if (menu === 'window' && this.options.findWidgetFocused?.()) return false
    // Chromium hands keys the page leaves alone to Windows, where F10 and Alt+letter would enter the system menu.
    event.preventDefault()
    if (this.options.modalOpen()) return true
    event.stopPropagation()
    if (event.repeat) return true
    if (menu) this.controller.openMenubar(menu, { keyboard: true, focus: 'first' })
    else this.controller.focusMenubar('file')
    return true
  }
  /**
   * The window's `contextmenu` event (right-click, Ctrl+click on macOS, or the context-menu key): the app owns every
   * context menu, so the browser's never shows. The menu opens at the pointer for whatever was clicked, if it has one.
   */
  openFromEvent(event: Pick<MouseEvent, 'target' | 'clientX' | 'clientY' | 'preventDefault'>): void {
    event.preventDefault()
    // Windows sends the context-menu key's event on its release, to the menu its press has already opened.
    if (inside(event.target, '.menu-layer')) return
    this.openFor(event.target as Element | null, { kind: 'point', x: event.clientX, y: event.clientY }, false)
  }
  /**
   * Shift+F10 and the context-menu key: the focused element's menu, below it, with its first item active. A widget that
   * keeps focus on itself and names its active item with `aria-activedescendant` (Object Explorer's tree) gets that
   * item's menu.
   */
  openForElement(element: Element | null, _how: { keyboard: true }): boolean {
    const item = activeDescendant(element)
    if (item && element) this.reveal(element, item)
    return this.openFor(item ?? element, undefined, true, item ? element ?? undefined : undefined)
  }

  /** A menubar button activated without a pointer press (assistive technology): toggles its menu. */
  toggleMenubarMenu(id: MenubarId): void {
    const { source, menubar } = this.controller.view
    if (source === 'menubar' && menubar.open === id) this.controller.focusMenubar(id)
    else this.controller.openMenubar(id, { keyboard: true, focus: 'first' })
  }

  /**
   * Window listeners: a press outside the menus closes them, as do scrolling outside a menu, resizing, the window losing
   * focus, and the page being hidden. Focus is tracked so the menus know where to return it.
   */
  attach(target: Window): Disposable {
    this.detach?.()
    const options = { capture: true }
    const pointerDown = (event: Event) => guard(() => {
      this.access.disarm()
      // The menus and the menubar buttons handle their own presses.
      if (this.ownsKeyboard() && !inside(event.target, '.menu-layer, .title-bar-menus')) this.close('outside')
    })
    const pointerUp = (event: Event) => guard(() => {
      const pointer = event as PointerEvent
      // Items report their own release: a menubar press dragged onto an item activates it there.
      if (!inside(pointer.target, '.menu-layer .menu-item')) this.controller.pointerUp(-1, -1, { x: pointer.clientX, y: pointer.clientY }, pointer.button)
    })
    const scroll = (event: Event) => guard(() => {
      const revealed = this.revealed
      if (revealed && event.target === revealed.widget) {
        this.revealed = undefined
        if (revealed.widget.scrollTop === revealed.top) return
      }
      if (this.controller.view.levels.length && !inside(event.target, '.menu')) this.close('scroll')
    })
    // Alt with the wheel scrolls faster in the editor; it is not an Alt tap.
    const wheel = (event: Event) => { guard(() => this.access.disarm()); scroll(event) }
    const resize = () => guard(() => this.close('resize'))
    const blur = () => guard(() => { this.access.disarm(); this.close('blur') })
    const visibility = () => guard(() => { if (target.document.visibilityState === 'hidden') this.close('blur') })
    const focusIn = (event: Event) => guard(() => {
      // Focus moving while Alt is down was something else (a window manager's Alt+drag moves it out and back).
      this.access.disarm()
      // Tab and Shift+Tab reach the menubar's buttons too: the menubar then takes the arrow and access keys, as after F10.
      const menubar = menubarButton(event.target)
      if (menubar) {
        if (!this.ownsKeyboard() && this.accessAllowed()) { this.controller.focusMenubar(menubar); this.tabbedIn = true }
        return
      }
      // Focus left the focused menubar without a key or a press (assistive technology, a script): keys follow focus.
      const { levels, menubar: bar } = this.controller.view
      if (bar.focused && !levels.length && !inside(event.target, '.menu-layer')) this.close('focus')
      const focused = this.options.focus.capture()
      if (focused !== undefined) this.lastFocus = focused
    })
    // Bubble phase: Monaco has already focused the editor and moved the caret to the click.
    const contextMenu = (event: Event) => guard(() => this.openFromEvent(event as MouseEvent))
    target.addEventListener('pointerdown', pointerDown, options)
    target.addEventListener('pointerup', pointerUp, options)
    target.addEventListener('wheel', wheel, options)
    target.addEventListener('scroll', scroll, options)
    target.addEventListener('focusin', focusIn, options)
    target.addEventListener('contextmenu', contextMenu)
    target.addEventListener('resize', resize)
    target.addEventListener('blur', blur)
    target.document.addEventListener('visibilitychange', visibility)
    const detach = () => {
      target.removeEventListener('pointerdown', pointerDown, options)
      target.removeEventListener('pointerup', pointerUp, options)
      target.removeEventListener('wheel', wheel, options)
      target.removeEventListener('scroll', scroll, options)
      target.removeEventListener('focusin', focusIn, options)
      target.removeEventListener('contextmenu', contextMenu)
      target.removeEventListener('resize', resize)
      target.removeEventListener('blur', blur)
      target.document.removeEventListener('visibilitychange', visibility)
      if (this.detach === detach) this.detach = undefined
    }
    this.detach = detach
    return { dispose: detach }
  }

  /** Behind a dialog the menubar stays shut. Over the quick input it opens (as F10 did before), and the quick input closes. */
  private accessAllowed(): boolean { return !this.options.modalOpen() }
  /**
   * Opens the context menu for `element`: at `anchor` for the pointer, else below the element (the caret in the query
   * editor) with its first item active. While a dialog is open only text fields in it have menus. Focus moves to what
   * the menu is for first, so the menu returns it there and its commands act on it.
   */
  private openFor(element: Element | null, anchor: Anchor | undefined, keyboard: boolean, widget?: Element): boolean {
    const { targets } = this.options
    if (!targets || !element) return false
    const hit = targets.targetFor(element)
    if (!hit) return false
    if (this.options.modalOpen() && (hit.target.kind !== 'input' || !this.options.modalContains?.(hit.element))) return false
    // A native menu does not replace the workbench's own, so those close first and return focus before the target takes it.
    if (this.native && this.ownsKeyboard()) this.close('command')
    // Also undoes Monaco moving focus from its find widget's input to the editor on right-click.
    hit.focus?.focus({ preventScroll: true })
    const target = targets.refresh(hit.target), menu = menuForTarget[target.kind]
    const items = this.resolve(menu, target)
    if (!hasItems(items)) return false
    const at = anchor ?? this.keyboardAnchor(hit, widget), open = () => this.openContext(menu, items, at, keyboard, hit.mark)
    if (!this.native) return open()
    this.showNative(this.native, menu, items, at, hit.mark, open)
    return true
  }
  private openContext(menu: ContextMenuId, items: readonly ResolvedMenuItem[], anchor: Anchor, keyboard: boolean, mark: Element | undefined): boolean {
    this.controller.openContext(items, anchor, { keyboard, label: contextMenuLabels[menu] })
    if (this.controller.view.source !== 'context') return false
    if (mark) { mark.setAttribute('data-menu-target', ''); this.marked = mark }
    return true
  }
  /** Main shows the menu at the pointer, or below what a keyboard-opened menu is for; if it cannot, `fallback` does. */
  private showNative(native: NativeMenuPresenter, menu: ContextMenuId, items: readonly ResolvedMenuItem[], anchor: Anchor, mark: Element | undefined, fallback: () => void): void {
    this.unmarkNative()
    mark?.setAttribute('data-menu-target', '')
    this.nativeMarked = mark
    const at = anchor.kind === 'point' ? anchor : anchor.kind === 'below' ? { x: anchor.rect.left, y: anchor.rect.bottom } : { x: anchor.rect.right, y: anchor.rect.top }
    const unmark = () => { if (mark && this.nativeMarked === mark) this.unmarkNative() }
    native.show(menu, items, at, { closed: unmark, failed: () => { unmark(); fallback() } })
  }
  private unmarkNative(): void {
    this.nativeMarked?.removeAttribute('data-menu-target')
    this.nativeMarked = undefined
  }
  /** Below the item (the editor's caret), kept within the widget that names it as its active item. */
  private keyboardAnchor(hit: TargetHit, widget?: Element): Anchor {
    const caret = hit.target.kind === 'editor' ? this.options.editorCaret?.() : undefined
    if (caret) return { kind: 'below', rect: caret }
    let { left, top, right, bottom } = (hit.anchor ?? hit.element).getBoundingClientRect()
    if (widget) {
      const box = widget.getBoundingClientRect()
      top = Math.min(Math.max(top, box.top), box.bottom)
      bottom = Math.min(Math.max(bottom, top), box.bottom)
    }
    return { kind: 'below', rect: { left: left + 8, top, right, bottom } }
  }
  /** Scrolls a widget (Object Explorer's tree) just enough to show its active item, as a keyboard menu opens for it. */
  private reveal(widget: Element, item: Element): void {
    const box = widget.getBoundingClientRect(), rect = item.getBoundingClientRect()
    const top = box.top + widget.clientTop, bottom = top + widget.clientHeight
    const delta = rect.top < top ? rect.top - top : rect.bottom > bottom ? Math.min(rect.bottom - bottom, rect.top - top) : 0
    if (!delta) return
    const before = widget.scrollTop
    widget.scrollTop = before + delta
    if (widget.scrollTop !== before) this.revealed = { widget, top: widget.scrollTop }
  }
  /** The menus took the keyboard: remember where focus was, unless a menu replaced another one. */
  private ownershipChanged(): void {
    const owns = this.controller.ownsKeyboard()
    if (owns && !this.owned) {
      if (!this.replacing) {
        const focused = this.options.focus.capture()
        if (focused !== undefined) this.lastFocus = focused
        this.restoreTarget = this.lastFocus
      }
      this.replacing = false
    }
    this.owned = owns
  }
  /** Order matters: the menus have closed, focus goes back synchronously, and only then does the command run. */
  private activate(item: ResolvedCommandItem): void {
    this.options.focus.restore(this.restoreTarget)
    void this.options.commands.execute(item.id, item.args, 'menu')
  }
  private closed(reason: CloseReason): void {
    this.tabbedIn = false
    this.marked?.removeAttribute('data-menu-target')
    this.marked = undefined
    // Activation restores focus itself, just before its command; a menu replacing this one keeps the original target.
    if (reason === 'replace') { this.replacing = true; return }
    if (reason !== 'activate' && reason !== 'focus') this.options.focus.restore(this.restoreTarget)
  }
  dispose(): void {
    this.detach?.()
    this.native?.dispose()
    this.unmarkNative()
    this.controller.dispose()
    this.subscriptions.forEach(subscription => subscription.dispose())
    this.access.dispose()
  }
}
