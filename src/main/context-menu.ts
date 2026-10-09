import type { MenuItemConstructorOptions } from 'electron'
import type { CommandId } from '../shared/commands/catalog'
import { primaryRule, toAccelerator, toPlatform } from '../shared/commands/keybindings'
import { buildMenuModel, contextMenuRequestSchema, pruneMenu, type ContextMenuRequest, type MenuEntry, type MenuId } from '../shared/commands/menus'
import type { MenuStyle } from '../shared/menu-style'

/**
 * A native context menu for a request the renderer resolved: the catalogue's menu with only the `visible` commands,
 * without submenus left empty or stray separators. Labels and keys are the catalogue's (the placement's title, else
 * the platform's, else the command's), never the renderer's. Role-backed commands are Electron's roles, which act on
 * the focused element; every other item sends its command id back through `send`.
 */
export function contextMenuTemplate(request: ContextMenuRequest, platform: NodeJS.Platform, send: (id: CommandId) => void,
  model: (menu: MenuId) => readonly MenuEntry[] = menu => buildMenuModel(menu, toPlatform(platform))): MenuItemConstructorOptions[] {
  const visible = new Set<CommandId>(request.visible), disabled = new Set<CommandId>(request.disabled), checked = new Set<CommandId>(request.checked)
  // Windows and Linux read `&` as an access key; macOS shows labels as they are.
  const label = (title: string) => platform === 'darwin' ? title : title.replaceAll('&', '&&')
  const keep = (entry: MenuEntry) => entry.kind === 'command' ? visible.has(entry.id) : entry.kind === 'submenu' && !entry.dynamic
  const items = (entries: readonly MenuEntry[], depth: number): MenuItemConstructorOptions[] => pruneMenu(entries, keep, id => model(id), depth).map((entry): MenuItemConstructorOptions => {
    if (entry.kind === 'separator' || entry.kind === 'role') return { type: 'separator' }
    if (entry.kind === 'submenu') return { id: entry.nativeId, label: label(entry.title), submenu: items(model(entry.id), depth + 1) }
    const { id } = entry, rule = primaryRule(id, toPlatform(platform)), accelerator = rule && toAccelerator(rule.chords, toPlatform(platform))
    // An open popup handles its own keys, so every key can show; nothing registers outside the menu.
    const keys = accelerator ? { accelerator, registerAccelerator: false } : {}
    if (entry.role) return { id: entry.nativeId, label: label(entry.title), role: entry.role, enabled: !disabled.has(id), accelerator: accelerator ?? '', registerAccelerator: false }
    return {
      id: entry.nativeId, label: label(entry.title), ...keys, enabled: !disabled.has(id), type: entry.toggle ? 'checkbox' : 'normal', ...(entry.toggle ? { checked: checked.has(id) } : {}),
      click: () => send(id)
    }
  })
  return items(model(request.menu), 0)
}

/** The parts of a `BrowserWindow` a popup uses, so tests can pass a fake. */
export interface PopupWindow {
  isDestroyed(): boolean
  getContentBounds(): { readonly width: number; readonly height: number }
  readonly webContents: { getZoomFactor(): number; send(channel: string, ...args: unknown[]): void }
}
export interface PopupMenu<W> {
  popup(options: { window: W; x: number; y: number; callback: () => void }): void
  closePopup(window: W): void
}

/**
 * Native context menus for the renderer (`varia:context-menu`), one at a time. Only ids, an integer token, and integer
 * coordinates come from the renderer, validated against the catalogue; a chosen item goes back as
 * `varia:context-menu-command` with the request's token. Showing resolves when the menu closes.
 */
export class ContextMenuPopups<W extends PopupWindow> {
  private open: { readonly menu: PopupMenu<W>; readonly window: W } | null = null
  constructor(private readonly options: { readonly style: MenuStyle; readonly platform: NodeJS.Platform; build(template: MenuItemConstructorOptions[]): PopupMenu<W> }) {}

  async show(value: unknown, window: W): Promise<void> {
    if (this.options.style !== 'native') throw new Error('Native context menus are not in use.')
    const request = contextMenuRequestSchema.parse(value)
    this.close()
    const menu = this.options.build(contextMenuTemplate(request, this.options.platform, id => {
      if (!window.isDestroyed()) window.webContents.send('varia:context-menu-command', { token: request.token, id })
    }))
    // Requests are in CSS pixels; the popup takes window pixels, inside the window.
    const bounds = window.getContentBounds(), zoom = window.webContents.getZoomFactor()
    const at = (value: number, size: number) => Math.max(0, Math.min(size - 1, Math.round(value * zoom)))
    await new Promise<void>(resolve => {
      const popup = { menu, window }
      this.open = popup
      try {
        menu.popup({ window, x: at(request.x, bounds.width), y: at(request.y, bounds.height), callback: () => { if (this.open === popup) this.open = null; resolve() } })
      } catch (error) {
        if (this.open === popup) this.open = null
        throw error
      }
    })
  }
  /** Closes the open popup, if any: a new request replaces it, and a reloaded renderer can no longer use it. */
  close(): void {
    const popup = this.open
    this.open = null
    if (popup && !popup.window.isDestroyed()) popup.menu.closePopup(popup.window)
  }
}
