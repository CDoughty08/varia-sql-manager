import { applicationMenus, menubarIds, menuForMnemonic, type MenubarId } from '../../../shared/commands/menus'
import { onUnexpectedError } from '../core/errors'
import { SnapshotStore } from '../core/store'
import { browserTimers, type Timers } from '../core/timers'
import { inSafeTriangle, type Anchor, type Point, type Rect } from './geometry'
import type { ResolvedCommandItem, ResolvedMenuItem } from './resolve'

/** Why the menus closed; 'focus' means focus has already moved elsewhere by itself, so it is not returned. */
export type CloseReason = 'escape' | 'activate' | 'outside' | 'blur' | 'resize' | 'scroll' | 'tab' | 'replace' | 'command' | 'dispose' | 'focus'
/** One open menu. `active` is -1 (pointer-opened, or the pointer left) or the index of a non-separator item. */
export interface MenuLevel { readonly id: string; readonly label: string; readonly items: readonly ResolvedMenuItem[]; readonly active: number; readonly anchor: Anchor }
export interface MenuView {
  /** The open menus, outermost first; each after the first is the submenu of the item active in the one before it. */
  readonly levels: readonly MenuLevel[]
  readonly source: 'menubar' | 'context' | null
  /** Whether mnemonics are underlined: the keyboard opened or reached the menus. */
  readonly mnemonics: boolean
  readonly menubar: { readonly focused: MenubarId | null; readonly open: MenubarId | null }
}
/** The parts of a key press the controller reads. */
export interface MenuKey { readonly key: string; readonly code: string; readonly alt: boolean; readonly ctrl: boolean; readonly meta: boolean; readonly shift: boolean; readonly repeat: boolean }
export interface MenuControllerOptions {
  readonly timers?: Timers
  /** The resolved items of a menubar menu, read each time it opens. */
  menubar(id: MenubarId): readonly ResolvedMenuItem[]
  menubarRect(id: MenubarId): Rect | undefined
  /** Runs a chosen command; the menus have already closed with reason 'activate'. */
  activate(item: ResolvedCommandItem): void
  /**
   * The menus no longer own the keyboard: every menu closed and the menubar lost focus. A dropdown that closes back to
   * its focused menubar button does not count.
   */
  closed(reason: CloseReason): void
}

/** Hovering a submenu parent opens it, and hovering away from an open submenu closes it, after this long. */
export const hoverDelay = 250
/** How long the pointer may head for an open submenu across its siblings before the sibling it is over wins. */
export const safeTriangleTimeout = 400
/** Characters typed within this long of each other search item titles together. */
export const typeAheadTimeout = 500
/** A press on the menubar activates the item it is released over once it has lasted this long or moved this far. */
export const dragActivation = { ms: 250, px: 6 } as const
export const maxLevels = 4
const typeAheadLength = 32

const idle: MenuView = Object.freeze({ levels: [], source: null, mnemonics: false, menubar: Object.freeze({ focused: null, open: null }) })
const modifierKeys = new Set(['Control', 'Shift', 'Alt', 'AltGraph', 'Meta', 'OS', 'Super', 'Hyper', 'Fn', 'CapsLock', 'NumLock', 'ScrollLock'])
const isItem = (item: ResolvedMenuItem | undefined) => !!item && item.kind !== 'separator'
const itemIndexes = (items: readonly ResolvedMenuItem[]) => items.flatMap((item, index) => isItem(item) ? [index] : [])
const zeroRect: Rect = { left: 0, top: 0, right: 0, bottom: 0 }
/** The letter or digit a key types for mnemonics: the layout's key, or the physical key when the layout types a non-Latin letter. */
function mnemonicKey(key: MenuKey): string | undefined {
  if (/^[a-z0-9]$/i.test(key.key)) return key.key.toLowerCase()
  const physical = /^(?:Key([A-Z])|Digit([0-9]))$/.exec(key.code)
  if (physical) return (physical[1] ?? physical[2]).toLowerCase()
  return [...key.key].length === 1 ? key.key.toLowerCase() : undefined
}

interface Timer { readonly handle: unknown }
interface Sibling { readonly level: number; index: number; mode: 'triangle' | 'hover'; timer: Timer }
interface Press { readonly at: Point; armed: boolean; moved: boolean; timer: Timer }

/**
 * The state machine behind the title-bar and context menus, without the DOM: the layer renders `MenuView` and reports
 * keys, pointer events, and measured rects; the controller decides what opens, what is active, and when a command runs.
 * Timers are injected so tests drive hover delays, the safe triangle, and type-ahead by hand.
 */
export class MenuController extends SnapshotStore<MenuView> {
  private readonly timers: Timers
  private seq = 0
  private rects: ({ readonly rect: Rect; readonly items: readonly Rect[] } | undefined)[] = []
  private hover?: { readonly level: number; readonly timer: Timer }
  private sibling?: Sibling
  private press?: Press
  private typeAhead?: { buffer: string; timer: Timer }
  private point?: Point
  private exit?: Point

  constructor(private readonly options: MenuControllerOptions) {
    super(idle)
    this.timers = options.timers ?? browserTimers
  }

  get view(): MenuView { return this.getSnapshot() }
  /** A menu is open or the menubar has focus, so keys go to the menus first. */
  ownsKeyboard(): boolean { return this.view.levels.length > 0 || this.view.menubar.focused !== null }

  openContext(items: readonly ResolvedMenuItem[], anchor: Anchor, options: { keyboard: boolean; label: string }): void {
    if (!items.some(isItem)) return
    if (this.ownsKeyboard()) this.close('replace')
    this.publish({ levels: [this.level(items, anchor, options.label, options.keyboard ? itemIndexes(items)[0] : -1)], source: 'context', mnemonics: options.keyboard, menubar: idle.menubar })
  }

  openMenubar(id: MenubarId, options: { keyboard: boolean; focus: 'first' | 'last' | 'none'; pressed?: Point }): void {
    let items: readonly ResolvedMenuItem[]
    try { items = this.options.menubar(id) } catch (error) { onUnexpectedError(error); return }
    if (this.view.source === 'context') this.close('replace')
    this.cancelPointerTimers()
    this.cancelTypeAhead()
    this.rects = []
    const indexes = itemIndexes(items), active = options.focus === 'first' ? indexes[0] ?? -1 : options.focus === 'last' ? indexes.at(-1) ?? -1 : -1
    const label = applicationMenus.find(menu => menu.id === id)!.label
    this.publish({ levels: [this.level(items, { kind: 'below', rect: this.options.menubarRect(id) ?? zeroRect }, label, active)], source: 'menubar', mnemonics: options.keyboard, menubar: { focused: id, open: id } })
    if (options.pressed) this.startPress(options.pressed)
  }

  /** Moves keyboard focus to a menubar button (F10, a bare Alt tap, or Escape from a dropdown), closing any dropdown. */
  focusMenubar(id: MenubarId = this.view.menubar.focused ?? 'file'): void {
    if (this.view.source === 'context') this.close('replace')
    this.cancelPointerTimers()
    this.cancelTypeAhead()
    this.rects = []
    this.publish({ levels: [], source: null, mnemonics: true, menubar: { focused: id, open: null } })
  }
  leaveMenubar(reason: CloseReason = 'escape'): void { this.close(reason) }

  /** Every key while the menus own the keyboard: 'passthrough' lets the workbench dispatch it after the menus closed. */
  key(key: MenuKey): 'consumed' | 'passthrough' {
    if (!this.ownsKeyboard()) return 'passthrough'
    if (modifierKeys.has(key.key)) return 'consumed'
    // Shortcuts still work: the menus close and the key goes on, so Ctrl+S saves and Alt+F4 still closes the window.
    if (key.ctrl || key.meta || (key.alt && key.key === 'F4')) { this.close('escape'); return 'passthrough' }
    if (key.key === 'Tab') this.close('tab')
    else if (key.key === 'F10' && !key.shift && !key.alt) this.close('escape')
    else if (!this.view.levels.length) this.menubarKey(key)
    else this.menuKey(key)
    return 'consumed'
  }

  pointerEnterItem(level: number, index: number, p: Point): void {
    const { levels } = this.view, entered = levels[level]?.items[index]
    if (!entered || entered.kind === 'separator') { this.point = p; return }
    if (this.sibling && level > this.sibling.level) this.cancelSibling()
    if (levels[level + 1] && index !== levels[level].active) {
      // A submenu is open from this level, and the pointer is over one of its parent's siblings.
      this.deferSibling(level, index, p)
    } else if (!levels[level + 1]) {
      if (this.sibling?.level === level) this.cancelSibling()
      this.setActive(level, index)
      this.cancelHover()
      if (entered.kind === 'submenu') this.hover = { level, timer: this.after(hoverDelay, () => { this.hover = undefined; this.openSubmenu(level, false) }) }
    } else if (this.sibling?.level === level) this.cancelSibling()
    this.point = p
  }
  pointerMove(p: Point): void {
    this.point = p
    const { press, sibling } = this
    if (press && !press.moved && Math.hypot(p.x - press.at.x, p.y - press.at.y) >= dragActivation.px) press.moved = true
    if (sibling?.mode === 'triangle' && !this.inTriangle(sibling.level, p)) this.restartSibling(sibling, 'hover')
  }
  pointerLeaveLevel(level: number): void {
    const { levels } = this.view
    if (!levels[level]) return
    if (this.sibling?.level === level) this.cancelSibling()
    if (this.hover?.level === level) this.cancelHover()
    if (!levels[level + 1]) this.setActive(level, -1)
  }
  /** A primary click, including one from assistive technology with no pointer events before it. */
  click(level: number, index: number): void {
    const item = this.view.levels[level]?.items[index]
    if (!item || item.kind === 'separator') return
    if (item.kind === 'submenu') {
      this.cancelHover()
      this.cancelSibling()
      this.setActive(level, index)
      this.openSubmenu(level, false)
    } else if (item.enabled) this.activateItem(item)
  }
  /** A button release; `level` -1 is anywhere outside an item. Only a primary release after a menubar press can activate. */
  pointerUp(level: number, index: number, p: Point, button: number): void {
    const press = this.press
    this.endPress()
    if (button !== 0 || !press || level < 0) return
    if (!press.armed && !press.moved && Math.hypot(p.x - press.at.x, p.y - press.at.y) < dragActivation.px) return
    const item = this.view.levels[level]?.items[index]
    if (item?.kind === 'command' && item.enabled) this.activateItem(item)
  }
  menubarPointerDown(id: MenubarId, p: Point): void {
    if (this.view.source === 'menubar' && this.view.menubar.open === id) this.close('outside')
    else this.openMenubar(id, { keyboard: false, focus: 'none', pressed: p })
  }
  /** While a dropdown is open, hovering another menubar button opens that menu instead. */
  menubarPointerEnter(id: MenubarId): void {
    const { source, menubar, mnemonics } = this.view
    if (source === 'menubar' && menubar.open !== id) this.openMenubar(id, { keyboard: mnemonics, focus: 'none' })
  }
  /** The measured menu and item rects of a level, for submenu anchors and the safe triangle. */
  setLevelRect(level: number, rect: Rect, itemRects: readonly Rect[]): void {
    if (level < this.view.levels.length) this.rects[level] = { rect, items: itemRects }
  }

  close(reason: CloseReason): void {
    const owned = this.ownsKeyboard()
    this.cancelPointerTimers()
    this.cancelTypeAhead()
    this.endPress()
    this.rects = []
    this.exit = undefined
    if (this.view !== idle) this.publish(idle)
    if (!owned) return
    try { this.options.closed(reason) } catch (error) { onUnexpectedError(error) }
  }
  dispose(): void {
    this.close('dispose')
    this.clearListeners()
  }

  private level(items: readonly ResolvedMenuItem[], anchor: Anchor, label: string, active: number): MenuLevel {
    return Object.freeze({ id: `menu-${++this.seq}`, label, items, active, anchor })
  }
  private update(levels: readonly MenuLevel[]): void {
    this.rects.length = Math.min(this.rects.length, levels.length)
    this.publish({ ...this.view, levels })
  }
  /** Makes `index` active in `level`, closing the submenus below it unless the item stays the same. */
  private setActive(level: number, index: number): void {
    const { levels } = this.view
    if (!levels[level] || (levels[level].active === index)) return
    this.update([...levels.slice(0, level), { ...levels[level], active: index }])
  }
  private openSubmenu(level: number, keyboard: boolean): void {
    const { levels } = this.view, parent = levels[level], item = parent?.items[parent.active]
    // A disabled submenu can be active, as a disabled command can, but never opens: not on hover, →, Enter, or a click.
    if (item?.kind !== 'submenu' || !item.enabled || level + 1 >= maxLevels) return
    const indexes = itemIndexes(item.items)
    if (levels[level + 1]) {
      if (keyboard && levels[level + 1].active < 0) this.update([...levels.slice(0, level + 1), { ...levels[level + 1], active: indexes[0] ?? -1 }])
      return
    }
    const rects = this.rects[level], itemRect = rects?.items[parent.active]
    const rect = rects && itemRect ? { left: rects.rect.left, right: rects.rect.right, top: itemRect.top, bottom: itemRect.bottom } : zeroRect
    this.update([...levels.slice(0, level + 1), this.level(item.items, { kind: 'right', rect }, item.title, keyboard ? indexes[0] ?? -1 : -1)])
  }
  private activateItem(item: ResolvedCommandItem): void {
    this.close('activate')
    try { this.options.activate(item) } catch (error) { onUnexpectedError(error) }
  }
  private choose(level: number, index: number, keyboard: boolean): void {
    const item = this.view.levels[level]?.items[index]
    if (!item || item.kind === 'separator') return
    if (item.kind === 'submenu') { this.setActive(level, index); this.openSubmenu(level, keyboard) }
    else if (item.enabled) this.activateItem(item)
  }

  private menubarKey(key: MenuKey): void {
    const focused = this.view.menubar.focused!, index = menubarIds.indexOf(focused), count = menubarIds.length
    const focus = (next: number) => this.focusMenubar(menubarIds[(next + count) % count])
    switch (key.key) {
      case 'ArrowLeft': focus(index - 1); break
      case 'ArrowRight': focus(index + 1); break
      case 'Home': focus(0); break
      case 'End': focus(count - 1); break
      case 'ArrowDown': case 'Enter': case ' ': this.openMenubar(focused, { keyboard: true, focus: 'first' }); break
      case 'ArrowUp': this.openMenubar(focused, { keyboard: true, focus: 'last' }); break
      case 'Escape': this.close('escape'); break
      default: {
        const letter = mnemonicKey(key), menu = letter ? menuForMnemonic(letter) : undefined
        if (menu) this.openMenubar(menu, { keyboard: true, focus: 'first' })
      }
    }
  }
  private menuKey(key: MenuKey): void {
    const { levels, source } = this.view, depth = levels.length - 1, level = levels[depth], item = level.items[level.active]
    const indexes = itemIndexes(level.items), mnemonics = () => { if (!this.view.mnemonics) this.publish({ ...this.view, mnemonics: true }) }
    switch (key.key) {
      case 'ArrowDown': case 'ArrowUp': {
        const position = indexes.indexOf(level.active), down = key.key === 'ArrowDown'
        const next = position < 0 ? (down ? indexes[0] : indexes.at(-1)) : indexes[(position + (down ? 1 : indexes.length - 1)) % indexes.length]
        this.setActive(depth, next ?? -1)
        mnemonics()
        return
      }
      case 'Home': case 'PageUp': this.setActive(depth, indexes[0] ?? -1); mnemonics(); return
      case 'End': case 'PageDown': this.setActive(depth, indexes.at(-1) ?? -1); mnemonics(); return
      case 'ArrowRight':
        if (item?.kind === 'submenu') this.openSubmenu(depth, true)
        else if (source === 'menubar') this.openAdjacent(1)
        return
      case 'ArrowLeft':
        if (depth > 0) this.update(levels.slice(0, depth))
        else if (source === 'menubar') this.openAdjacent(-1)
        return
      case 'Enter': this.choose(depth, level.active, true); return
      case 'Escape':
        if (depth > 0) this.update(levels.slice(0, depth))
        else if (source === 'menubar') this.focusMenubar(this.view.menubar.open ?? undefined)
        else this.close('escape')
        return
    }
    if (key.key === ' ' && !this.typeAhead) { this.choose(depth, level.active, true); return }
    const letter = mnemonicKey(key)
    if (key.alt) {
      const menu = source === 'menubar' && letter ? menuForMnemonic(letter) : undefined
      if (menu) this.openMenubar(menu, { keyboard: true, focus: 'first' })
      else if (letter) this.mnemonic(depth, letter)
      return
    }
    // Shift+F10, the context-menu key, function keys, and other named keys are consumed and do nothing.
    if ([...key.key].length !== 1) return
    if (this.typeAhead) this.search(depth, key.key, true)
    else if (!letter || !this.mnemonic(depth, letter)) this.search(depth, key.key, false)
  }
  private openAdjacent(delta: number): void {
    const current = this.view.menubar.open ?? this.view.menubar.focused ?? 'file', count = menubarIds.length
    this.openMenubar(menubarIds[(menubarIds.indexOf(current) + delta + count) % count], { keyboard: true, focus: 'first' })
  }
  /** Mnemonic matching in the innermost menu; false when no item has that mnemonic. */
  private mnemonic(depth: number, letter: string): boolean {
    const level = this.view.levels[depth]
    const matches = level.items.flatMap((item, index) => item.kind !== 'separator' && item.mnemonic >= 0 && item.title[item.mnemonic].toLowerCase() === letter ? [index] : [])
    if (!matches.length) return false
    if (!this.view.mnemonics) this.publish({ ...this.view, mnemonics: true })
    if (matches.length > 1) { this.setActive(depth, matches.find(index => index > level.active) ?? matches[0]); return true }
    const item = level.items[matches[0]]
    this.setActive(depth, matches[0])
    if (item.kind === 'submenu' || (item.kind === 'command' && item.enabled)) this.choose(depth, matches[0], true)
    return true
  }
  /** Type-ahead: the next item whose title starts with the typed characters, from the active one when adding to them. */
  private search(depth: number, character: string, append: boolean): void {
    const buffer = ((append ? this.typeAhead?.buffer ?? '' : '') + character).slice(0, typeAheadLength)
    this.cancelTypeAhead()
    this.typeAhead = { buffer, timer: this.after(typeAheadTimeout, () => { this.typeAhead = undefined }) }
    const { items, active } = this.view.levels[depth], wanted = buffer.toLocaleLowerCase(), count = items.length
    const start = buffer.length > 1 && active >= 0 ? active : active + 1
    for (let offset = 0; offset < count; offset++) {
      const index = (start + offset + count) % count, item = items[index]
      if (item.kind !== 'separator' && item.title.toLocaleLowerCase().startsWith(wanted)) { this.setActive(depth, index); return }
    }
  }

  private inTriangle(level: number, p: Point): boolean {
    const parent = this.rects[level]?.rect, submenu = this.rects[level + 1]?.rect
    return !!parent && !!submenu && !!this.exit && inSafeTriangle(p, this.exit, submenu, submenu.left >= parent.left ? 'right' : 'left')
  }
  private deferSibling(level: number, index: number, p: Point): void {
    if (this.sibling?.level === level) { this.sibling.index = index; return }
    this.cancelSibling()
    // Where the pointer was before it entered this sibling: the triangle's apex.
    this.exit = this.point ?? p
    const mode = this.inTriangle(level, p) ? 'triangle' : 'hover'
    const sibling: Sibling = { level, index, mode, timer: { handle: undefined } }
    this.sibling = sibling
    this.restartSibling(sibling, mode)
  }
  private restartSibling(sibling: Sibling, mode: Sibling['mode']): void {
    this.timers.clearTimeout(sibling.timer.handle)
    sibling.mode = mode
    sibling.timer = this.after(mode === 'triangle' ? safeTriangleTimeout : hoverDelay, () => {
      if (this.sibling !== sibling) return
      this.sibling = undefined
      this.setActive(sibling.level, sibling.index)
      this.openSubmenu(sibling.level, false)
    })
  }
  private startPress(at: Point): void {
    this.endPress()
    const press: Press = { at, armed: false, moved: false, timer: { handle: undefined } }
    press.timer = this.after(dragActivation.ms, () => { press.armed = true })
    this.press = press
  }
  private endPress(): void {
    if (this.press) this.timers.clearTimeout(this.press.timer.handle)
    this.press = undefined
  }
  private after(ms: number, callback: () => void): Timer {
    return { handle: this.timers.setTimeout(() => { try { callback() } catch (error) { onUnexpectedError(error) } }, ms) }
  }
  private cancelHover(): void {
    if (this.hover) this.timers.clearTimeout(this.hover.timer.handle)
    this.hover = undefined
  }
  private cancelSibling(): void {
    if (this.sibling) this.timers.clearTimeout(this.sibling.timer.handle)
    this.sibling = undefined
    this.exit = undefined
  }
  private cancelTypeAhead(): void {
    if (this.typeAhead) this.timers.clearTimeout(this.typeAhead.timer.handle)
    this.typeAhead = undefined
  }
  private cancelPointerTimers(): void { this.cancelHover(); this.cancelSibling() }
}
