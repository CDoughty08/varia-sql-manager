import { z } from 'zod'
import { commandDescriptor, commandIds, type CommandId } from './catalog'
import { primaryRule, toAccelerator, type Platform } from './keybindings'

/** The menubar, in title-bar order. Alt plus the mnemonic opens a menu on Windows and Linux. */
export const applicationMenus = [
  { id: 'file', label: 'File', mnemonic: 'f' }, { id: 'edit', label: 'Edit', mnemonic: 'e' }, { id: 'view', label: 'View', mnemonic: 'v' },
  { id: 'query', label: 'Query', mnemonic: 'q' }, { id: 'window', label: 'Window', mnemonic: 'w' }
] as const
export type MenubarId = typeof applicationMenus[number]['id']
/** Menubar menus, the View › Theme submenu, and the context menus that PR3 renders. */
export type MenuId = MenubarId | 'theme' | 'editor.context' | 'explorer.context' | 'documentTab.context' | 'output.context'
/** Every menu in native-id order: the theme submenu sits inside View, and context menus come last. */
export const menuIds: readonly MenuId[] = ['file', 'edit', 'view', 'theme', 'query', 'window', 'editor.context', 'explorer.context', 'documentTab.context', 'output.context']
export const menubarIds: readonly MenubarId[] = applicationMenus.map(menu => menu.id)

/** Electron roles the menus use. They stay native items: their keys and behaviour belong to Electron. */
export type MenuRole = 'quit' | 'cut' | 'copy' | 'paste' | 'selectAll' | 'reload' | 'toggleDevTools' | 'resetZoom' | 'zoomIn' | 'zoomOut' | 'togglefullscreen' | 'minimize' | 'zoom'
export type MenuEntry =
  | { readonly kind: 'command'; readonly id: CommandId; readonly nativeId: string; readonly title: string; readonly toggle: boolean; readonly accelerator?: string }
  | { readonly kind: 'role'; readonly role: MenuRole }
  | { readonly kind: 'submenu'; readonly id: 'view.theme'; readonly title: 'Theme'; readonly menu: 'theme' }
  | { readonly kind: 'separator' }
interface Slot { readonly group: string; readonly order: number; readonly platforms?: readonly Platform[] }
export type ExtraEntry = Slot & (
  | { readonly kind: 'role'; readonly role: MenuRole }
  | { readonly kind: 'submenu'; readonly id: 'view.theme'; readonly title: 'Theme'; readonly menu: 'theme' })

const windowsAndLinux: readonly Platform[] = ['win32', 'linux']
const roles = (group: string, list: readonly MenuRole[], platforms?: readonly Platform[]): ExtraEntry[] =>
  list.map((role, index) => ({ kind: 'role', role, group, order: index + 1, ...(platforms ? { platforms } : {}) }))
/** Menu content that is not a command: Electron roles and the theme submenu, placed by group like commands. */
export const menuExtras: Readonly<Record<MenuId, readonly ExtraEntry[]>> = {
  file: roles('z_quit', ['quit'], windowsAndLinux),
  edit: roles('2_clipboard', ['cut', 'copy', 'paste', 'selectAll']),
  view: [{ kind: 'submenu', id: 'view.theme', title: 'Theme', menu: 'theme', group: '3_theme', order: 1 }, ...roles('4_display', ['reload', 'toggleDevTools', 'resetZoom', 'zoomIn', 'zoomOut', 'togglefullscreen'])],
  query: [],
  window: roles('4_window', ['minimize', 'zoom'], ['darwin']),
  theme: [], 'editor.context': [], 'explorer.context': [], 'documentTab.context': [], 'output.context': []
}

const nativeIds = new Map<string, string>()
for (const id of commandIds) {
  const menus = (commandDescriptor(id).menus ?? []).map(placement => placement.menu).sort((a, b) => menuIds.indexOf(a) - menuIds.indexOf(b))
  menus.forEach((menu, index) => nativeIds.set(`${id}\n${menu}`, index ? `${id}@${menu}` : id))
}
/**
 * The native menu item id of a command in `menu`: its first placement (in `menuIds` order, on any platform) keeps the
 * bare command id, so `getMenuItemById('layout.save')` finds the View item, and later ones become `layout.save@window`.
 */
export function nativeItemId(id: CommandId, menu: MenuId): string {
  const nativeId = nativeIds.get(`${id}\n${menu}`)
  if (!nativeId) throw new Error(`${id} has no placement in the ${menu} menu`)
  return nativeId
}

const applies = (platforms: readonly Platform[] | undefined, platform: Platform) => !platforms || platforms.includes(platform)
/**
 * The entries of `menu` on `platform`: catalogue placements and `menuExtras`, sorted by group, order, and title, with
 * exactly one separator between non-empty groups.
 */
export function buildMenuModel(menu: MenuId, platform: Platform): MenuEntry[] {
  const items: { group: string; order: number; title: string; entry: MenuEntry }[] = []
  for (const id of commandIds) {
    const command = commandDescriptor(id)
    for (const placement of command.menus ?? []) {
      if (placement.menu !== menu || !applies(placement.platforms, platform)) continue
      const title = placement.title ?? command.title, rule = primaryRule(id, platform)
      const accelerator = rule && toAccelerator(rule.chords, platform)
      items.push({ group: placement.group, order: placement.order, title, entry: { kind: 'command', id, nativeId: nativeItemId(id, menu), title, toggle: command.toggled !== undefined, ...(accelerator ? { accelerator } : {}) } })
    }
  }
  for (const extra of menuExtras[menu]) {
    if (!applies(extra.platforms, platform)) continue
    const entry: MenuEntry = extra.kind === 'role' ? { kind: 'role', role: extra.role } : { kind: 'submenu', id: extra.id, title: extra.title, menu: extra.menu }
    items.push({ group: extra.group, order: extra.order, title: extra.kind === 'role' ? extra.role : extra.title, entry })
  }
  items.sort((a, b) => (a.group < b.group ? -1 : a.group > b.group ? 1 : 0) || a.order - b.order || a.title.localeCompare(b.title))
  const entries: MenuEntry[] = []
  items.forEach((item, index) => {
    if (index && item.group !== items[index - 1].group) entries.push({ kind: 'separator' })
    entries.push(item.entry)
  })
  return entries
}

export const menuForMnemonic = (key: string): MenubarId | undefined => applicationMenus.find(menu => menu.mnemonic === key.toLowerCase())?.id

const nativeMenus: readonly MenuId[] = [...menubarIds, 'theme']
/** Commands that appear in a native menu, so their enablement is sent to main. */
export const menuCommandIds: readonly CommandId[] = commandIds.filter(id => commandDescriptor(id).menus?.some(placement => nativeMenus.includes(placement.menu)))
/** Commands with checkbox state. */
export const toggleCommandIds: readonly CommandId[] = commandIds.filter(id => commandDescriptor(id).toggled !== undefined)

const unique = (values: readonly string[]) => new Set(values).size === values.length
/** The renderer's only input to native menus: which command items are disabled and which are checked. */
export const menuStateSchema = z.object({
  disabled: z.array(z.enum(menuCommandIds)).max(menuCommandIds.length).refine(unique, 'Duplicate command id.'),
  checked: z.array(z.enum(toggleCommandIds)).max(toggleCommandIds.length).refine(unique, 'Duplicate command id.')
}).strict()
export interface MenuState { disabled: CommandId[]; checked: CommandId[] }
