import { z } from 'zod'
import { scriptAsTitleKeys, scriptAsTitles, scriptCommandIds, scriptSubmenuEntries, scriptSubmenuIds, type ScriptAsTitleKey } from '../scripting/catalog.ts'
import { commandDescriptor, commandIds, type CommandId, type RoleName } from './catalog'
import { primaryRule, splitChord, toAccelerator, type Platform } from './keybindings'
import { compileWhen, type WhenAst } from './when'

/** The menubar, in title-bar order. Alt plus the mnemonic opens a menu on Windows and Linux. */
export const applicationMenus = [
  { id: 'file', label: 'File', mnemonic: 'f' }, { id: 'edit', label: 'Edit', mnemonic: 'e' }, { id: 'view', label: 'View', mnemonic: 'v' },
  { id: 'query', label: 'Query', mnemonic: 'q' }, { id: 'tools', label: 'Tools', mnemonic: 't' }, { id: 'window', label: 'Window', mnemonic: 'w' }
] as const
export type MenubarId = typeof applicationMenus[number]['id']
/** Context menus, one per kind of target: the editor, an Object Explorer node, a query tab, Query Output, a panel tab, a text field. */
export const contextMenuIds = ['editor.context', 'explorer.context', 'documentTab.context', 'output.context', 'dockTab.context', 'input.context'] as const
export type ContextMenuId = typeof contextMenuIds[number]
export const submenuIds = ['theme', 'query.connection', ...scriptSubmenuIds] as const
export type SubmenuId = typeof submenuIds[number]
export type MenuId = MenubarId | SubmenuId | ContextMenuId
/** Every menu in native-id order: a submenu follows the menu it first appears in, and context menus come last. */
export const menuIds: readonly MenuId[] = ['file', 'edit', 'view', 'theme', 'query', 'query.connection', 'tools', 'window', 'editor.context', 'explorer.context',
  ...scriptSubmenuIds, 'documentTab.context', 'output.context', 'dockTab.context', 'input.context']
export const menubarIds: readonly MenubarId[] = applicationMenus.map(menu => menu.id)
export const isContextMenuId = (menu: MenuId): menu is ContextMenuId => (contextMenuIds as readonly MenuId[]).includes(menu)

/** Where a submenu appears; the same fields as a command's placement, without a title of its own. */
export interface SubmenuPlacement {
  readonly menu: MenuId
  readonly group: string
  readonly order: number
  readonly mnemonic?: string
  readonly when?: string
  readonly platforms?: readonly Platform[]
}
export interface SubmenuDescriptor {
  readonly title: string
  /** The native menu item id of its first placement (in `menuIds` order); later placements are `<nativeId>@<menu>`. */
  readonly nativeId: string
  /** Items built from the theme state follow the catalogue's: main and the renderer each add them. */
  readonly dynamic?: 'theme'
  /** The title names the selected object ("Script Table as"): `scriptAsTitles[explorerScriptTitle]`, else `title`. */
  readonly dynamicTitle?: 'scriptAs'
  readonly placements: readonly SubmenuPlacement[]
}
/** Submenus, placed like commands. One with nothing visible in it is left out (`pruneMenu`). */
export const submenus: Readonly<Record<SubmenuId, SubmenuDescriptor>> = {
  theme: { title: 'Theme', nativeId: 'view.theme', dynamic: 'theme', placements: [{ menu: 'view', group: '3_theme', order: 1, mnemonic: 'h' }] },
  'query.connection': {
    title: 'Connection', nativeId: 'query.connection',
    placements: [{ menu: 'query', group: '0_connection', order: 1, mnemonic: 'o' }, { menu: 'editor.context', group: '1_connection', order: 1, mnemonic: 'o' }]
  },
  // Script as › <verb> To, from src/shared/scripting/catalog.ts.
  ...scriptSubmenuEntries()
}
/** The deepest a submenu may nest below a menu, so at most four menu levels are ever open. */
export const maxSubmenuDepth = 3

/** Electron roles the native menus show: their keys and behaviour belong to Electron. */
export type MenuRole = RoleName | 'minimize' | 'zoom'
export type MenuEntry =
  | {
    readonly kind: 'command'; readonly id: CommandId; readonly nativeId: string; readonly title: string; readonly mnemonic?: string; readonly toggle: boolean
    readonly role?: RoleName; readonly accelerator?: string; readonly when?: WhenAst
  }
  | {
    readonly kind: 'submenu'; readonly id: SubmenuId; readonly nativeId: string; readonly title: string; readonly mnemonic?: string; readonly when?: WhenAst; readonly dynamic?: 'theme'
    readonly dynamicTitle?: 'scriptAs'
  }
  | { readonly kind: 'role'; readonly role: MenuRole }
  | { readonly kind: 'separator' }
interface Slot { readonly group: string; readonly order: number; readonly platforms?: readonly Platform[] }
export type ExtraEntry = Slot & { readonly kind: 'role'; readonly role: MenuRole }

const roles = (group: string, list: readonly MenuRole[], platforms?: readonly Platform[]): ExtraEntry[] =>
  list.map((role, index) => ({ kind: 'role', role, group, order: index + 1, ...(platforms ? { platforms } : {}) }))
/**
 * Menu content that is not a command: Electron roles, placed by group like commands. Every other role is a command
 * (`role` in the catalogue), so it also reaches custom menus and the palette.
 */
export const menuExtras: Readonly<Partial<Record<MenuId, readonly ExtraEntry[]>>> = {
  window: roles('4_window', ['minimize', 'zoom'], ['darwin'])
}

const byMenuOrder = (a: MenuId, b: MenuId) => menuIds.indexOf(a) - menuIds.indexOf(b)
const nativeIds = new Map<string, string>()
const assignNativeIds = (key: string, nativeId: string, menus: readonly MenuId[]) =>
  [...menus].sort(byMenuOrder).forEach((menu, index) => nativeIds.set(`${key}\n${menu}`, index ? `${nativeId}@${menu}` : nativeId))
for (const id of commandIds) assignNativeIds(id, id, (commandDescriptor(id).menus ?? []).map(placement => placement.menu))
for (const id of submenuIds) assignNativeIds(`submenu:${id}`, submenus[id].nativeId, submenus[id].placements.map(placement => placement.menu))
/**
 * The native menu item id of a command in `menu`: its first placement (in `menuIds` order, on any platform) keeps the
 * bare command id, so `getMenuItemById('layout.save')` finds the View item, and later ones become `layout.save@window`.
 */
export function nativeItemId(id: CommandId, menu: MenuId): string {
  const nativeId = nativeIds.get(`${id}\n${menu}`)
  if (!nativeId) throw new Error(`${id} has no placement in the ${menu} menu`)
  return nativeId
}
const nativeSubmenuId = (id: SubmenuId, menu: MenuId): string => nativeIds.get(`submenu:${id}\n${menu}`)!

const applies = (platforms: readonly Platform[] | undefined, platform: Platform) => !platforms || platforms.includes(platform)
/**
 * Whether a menu item may carry `chords` as its accelerator. On macOS every accelerator is also a key equivalent, and
 * AppKit offers keys without ⌘ to the menu before the page (Chromium sends only ⌘ keys to the page first): F5 would run
 * Execute from Object Explorer, and the workbench would never see the key. Those keys stay the dispatcher's alone.
 */
export const menuMayShowChords = (chords: readonly string[], platform: Platform): boolean =>
  platform !== 'darwin' || (chords.length === 1 && splitChord(chords[0]).modifiers.has('meta'))
/** The accelerator a command's menu items show: its primary key, where Electron can name it and the platform allows it. */
export function menuAccelerator(id: CommandId, platform: Platform): string | undefined {
  const rule = primaryRule(id, platform)
  return rule && menuMayShowChords(rule.chords, platform) ? toAccelerator(rule.chords, platform) : undefined
}
/** A command's title in menus on `platform`: the placement's own title, else the platform's, else the palette title. */
export const menuTitle = (id: CommandId, platform: Platform, placementTitle?: string): string =>
  placementTitle ?? commandDescriptor(id).platformTitles?.[platform] ?? commandDescriptor(id).title

/**
 * The entries of `menu` on `platform`: catalogue placements, submenus, and `menuExtras`, sorted by group, order, and
 * title, with exactly one separator between non-empty groups. Placement `when` clauses are compiled, not applied:
 * `pruneMenu` drops what a context hides, and with it any separator or submenu left empty.
 */
export function buildMenuModel(menu: MenuId, platform: Platform): MenuEntry[] {
  const items: { group: string; order: number; title: string; entry: MenuEntry }[] = []
  const optional = (placement: { readonly mnemonic?: string; readonly when?: string }) =>
    ({ ...(placement.mnemonic ? { mnemonic: placement.mnemonic } : {}), ...(placement.when !== undefined ? { when: compileWhen(placement.when) } : {}) })
  for (const id of commandIds) {
    const command = commandDescriptor(id)
    for (const placement of command.menus ?? []) {
      if (placement.menu !== menu || !applies(placement.platforms, platform)) continue
      const title = menuTitle(id, platform, placement.title), accelerator = menuAccelerator(id, platform)
      items.push({ group: placement.group, order: placement.order, title, entry: {
        kind: 'command', id, nativeId: nativeItemId(id, menu), title, toggle: command.toggled !== undefined, ...optional(placement),
        ...(command.role ? { role: command.role } : {}), ...(accelerator ? { accelerator } : {})
      } })
    }
  }
  for (const id of submenuIds) {
    const submenu = submenus[id]
    for (const placement of submenu.placements) {
      if (placement.menu !== menu || !applies(placement.platforms, platform)) continue
      items.push({ group: placement.group, order: placement.order, title: submenu.title, entry: {
        kind: 'submenu', id, nativeId: nativeSubmenuId(id, menu), title: submenu.title, ...optional(placement), ...(submenu.dynamic ? { dynamic: submenu.dynamic } : {}),
        ...(submenu.dynamicTitle ? { dynamicTitle: submenu.dynamicTitle } : {})
      } })
    }
  }
  for (const extra of menuExtras[menu] ?? []) {
    if (applies(extra.platforms, platform)) items.push({ group: extra.group, order: extra.order, title: extra.role, entry: { kind: 'role', role: extra.role } })
  }
  items.sort((a, b) => (a.group < b.group ? -1 : a.group > b.group ? 1 : 0) || a.order - b.order || a.title.localeCompare(b.title))
  const entries: MenuEntry[] = []
  items.forEach((item, index) => {
    if (index && item.group !== items[index - 1].group) entries.push({ kind: 'separator' })
    entries.push(item.entry)
  })
  return entries
}

const isScriptAsTitleKey = (value: unknown): value is ScriptAsTitleKey => typeof value === 'string' && (scriptAsTitleKeys as readonly string[]).includes(value)
/** A submenu's title as it shows: a dynamic one from its key (catalogue strings only), else the descriptor's. */
export function submenuTitle(entry: { readonly title: string; readonly dynamicTitle?: 'scriptAs' }, keys: { readonly explorerScriptTitle?: string }): string {
  return entry.dynamicTitle === 'scriptAs' && isScriptAsTitleKey(keys.explorerScriptTitle) ? scriptAsTitles[keys.explorerScriptTitle] : entry.title
}

/** Drops leading, trailing, and repeated separators. */
export function trimSeparators<T extends { readonly kind: string }>(entries: readonly T[]): T[] {
  const result: T[] = []
  for (const entry of entries) if (entry.kind !== 'separator' || (result.length && result.at(-1)!.kind !== 'separator')) result.push(entry)
  if (result.at(-1)?.kind === 'separator') result.pop()
  return result
}
/**
 * The entries a context shows: those `keep` accepts, without submenus that have nothing to show (looked up through
 * `children`, at most `maxSubmenuDepth` deep) and without stray separators. A dynamic submenu always has its own items.
 */
export function pruneMenu(entries: readonly MenuEntry[], keep: (entry: MenuEntry) => boolean, children: (id: SubmenuId) => readonly MenuEntry[], depth = 0): MenuEntry[] {
  return trimSeparators(entries.filter(entry => {
    if (entry.kind === 'separator') return true
    if (!keep(entry)) return false
    if (entry.kind !== 'submenu') return true
    return depth < maxSubmenuDepth && (entry.dynamic !== undefined || pruneMenu(children(entry.id), keep, children, depth + 1).length > 0)
  }))
}

export interface MnemonicItem {
  readonly title: string
  /** A letter or digit to underline; undefined picks a free one; null (theme names) has none. */
  readonly mnemonic?: string | null
}
const isMnemonicCharacter = (character: string) => /^[\p{L}\p{N}]$/u.test(character)
const startsWord = (title: string, index: number) => index === 0 || !isMnemonicCharacter(title[index - 1])
/** Where `mnemonic` is underlined in `title`: its first occurrence that starts a word, else its first occurrence, else -1. */
export function mnemonicIndex(title: string, mnemonic: string): number {
  const wanted = mnemonic.toLowerCase()
  let first = -1
  for (let index = 0; index < title.length; index++) {
    if (title[index].toLowerCase() !== wanted) continue
    if (startsWord(title, index)) return index
    if (first < 0) first = index
  }
  return first
}
/**
 * The mnemonic of each item of one menu level, as an index into its title or -1 (separators are null). Explicit
 * mnemonics come first; every other item takes the first unused letter or digit that starts a word in its title, else
 * any unused one. Explicit duplicates are kept: pressing the key then cycles between them.
 */
export function assignMnemonics(items: readonly (MnemonicItem | null)[]): number[] {
  const used = new Set<string>()
  const result = items.map(item => {
    if (!item?.mnemonic) return -1
    const index = mnemonicIndex(item.title, item.mnemonic)
    if (index >= 0) used.add(item.title[index].toLowerCase())
    return index
  })
  items.forEach((item, position) => {
    if (!item || item.mnemonic !== undefined) return
    const { title } = item, indexes = Array.from({ length: title.length }, (_, index) => index)
    // Indexes are UTF-16 units, so the halves of a surrogate pair never pass as letters.
    const free = (index: number) => isMnemonicCharacter(title[index]) && !used.has(title[index].toLowerCase())
    const index = indexes.find(index => startsWord(title, index) && free(index)) ?? indexes.find(free) ?? -1
    if (index >= 0) used.add(title[index].toLowerCase())
    result[position] = index
  })
  return result
}

const submenusIn = (menu: MenuId): SubmenuId[] => submenuIds.filter(id => submenus[id].placements.some(placement => placement.menu === menu))
const commandsIn = (menu: MenuId): CommandId[] => commandIds.filter(id => commandDescriptor(id).menus?.some(placement => placement.menu === menu))
/** Menus reachable from `roots` through submenu placements, on any platform, in `menuIds` order. */
function reachable(roots: readonly MenuId[]): MenuId[] {
  const found = new Set<MenuId>(roots)
  for (const menu of found) for (const id of submenusIn(menu)) found.add(id)
  return menuIds.filter(menu => found.has(menu))
}
/** The menubar and context menus whose trees contain `menu`. */
export function menuRoots(menu: MenuId): (MenubarId | ContextMenuId)[] {
  return [...menubarIds, ...contextMenuIds].filter(root => reachable([root]).includes(menu))
}
const contextTrees = new Map(contextMenuIds.map(menu => {
  const tree = reachable([menu])
  return [menu, commandIds.filter(id => tree.some(inner => commandsIn(inner).includes(id)))] as const
}))
/** Every command a context menu can show, through its submenus, on any platform and for any target. */
export const contextCommandIds = (menu: ContextMenuId): readonly CommandId[] => contextTrees.get(menu)!

export const menuForMnemonic = (key: string): MenubarId | undefined => applicationMenus.find(menu => menu.mnemonic === key.toLowerCase())?.id

/** The menubar menus and the submenus reachable from them: the menus main builds natively. */
export const nativeMenuIds: readonly MenuId[] = reachable(menubarIds)
/**
 * Commands that appear in a native menu, so their enablement is sent to main. Role-backed commands are left out: their
 * native items are Electron roles, which have no command state.
 */
export const menuCommandIds: readonly CommandId[] = commandIds.filter(id => !commandDescriptor(id).role && nativeMenuIds.some(menu => commandsIn(menu).includes(id)))
/** Commands with checkbox state. */
export const toggleCommandIds: readonly CommandId[] = commandIds.filter(id => commandDescriptor(id).toggled !== undefined)

const unique = (values: readonly string[]) => new Set(values).size === values.length
/** The renderer's only input to native menus: which command items are disabled and which are checked. */
export const menuStateSchema = z.object({
  disabled: z.array(z.enum(menuCommandIds)).max(menuCommandIds.length).refine(unique, 'Duplicate command id.'),
  checked: z.array(z.enum(toggleCommandIds)).max(toggleCommandIds.length).refine(unique, 'Duplicate command id.')
}).strict()
export interface MenuState { disabled: CommandId[]; checked: CommandId[] }

const maxContextItems = 64
const scriptCommands: ReadonlySet<CommandId> = new Set(scriptCommandIds)
/**
 * The schema of a native context-menu request for menus whose commands `commandsOf` lists. Only ids, an integer
 * token, integer coordinates, and a title key cross IPC: the visible commands (an allowlist, so a resolution bug hides
 * items rather than showing them), the disabled ones, the checked toggles, each a subset of the menu's commands, and
 * the Script submenu's title key, present exactly when a script command shows.
 */
export function createContextMenuRequestSchema(commandsOf: (menu: ContextMenuId) => readonly CommandId[]) {
  const allowed = commandIds.filter(id => contextMenuIds.some(menu => commandsOf(menu).includes(id)))
  const list = z.array(z.enum(allowed)).max(maxContextItems)
  const pixel = z.number().int().min(0).max(32767)
  return z.object({
    token: z.number().int().min(1).max(2 ** 31 - 1), menu: z.enum(contextMenuIds), x: pixel, y: pixel, visible: list.min(1), disabled: list, checked: list,
    scriptAsTitle: z.enum(scriptAsTitleKeys).optional()
  }).strict()
    .superRefine((request, context) => {
      const inMenu = commandsOf(request.menu)
      const issue = (path: string, message: string) => context.addIssue({ code: 'custom', path: [path], message })
      for (const key of ['visible', 'disabled', 'checked'] as const) {
        if (!unique(request[key])) issue(key, 'Duplicate command id.')
        for (const id of request[key]) if (!inMenu.includes(id)) issue(key, `${id} is not in the ${request.menu} menu.`)
      }
      for (const key of ['disabled', 'checked'] as const) for (const id of request[key]) if (!request.visible.includes(id)) issue(key, `${id} is not visible.`)
      for (const id of request.checked) if (!toggleCommandIds.includes(id)) issue('checked', `${id} has no checkbox.`)
      const scripts = request.visible.some(id => scriptCommands.has(id))
      if (scripts !== (request.scriptAsTitle !== undefined)) issue('scriptAsTitle', scripts ? 'A Script submenu needs its title key.' : 'Only a menu with script commands has a Script title.')
    })
}
export const contextMenuRequestSchema = createContextMenuRequestSchema(contextCommandIds)
export type ContextMenuRequest = z.infer<typeof contextMenuRequestSchema>
/** A native context menu's chosen item, sent back to the renderer with the token of the request that showed it. */
export interface ContextMenuCommand { readonly token: number; readonly id: CommandId }
