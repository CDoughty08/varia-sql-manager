import { commandDescriptor, type Codicon, type CommandId } from '../../../shared/commands/catalog'
import { contextRecord, type ContextKeys, type TargetKeys } from '../../../shared/commands/context-keys'
import type { KeybindingLabel, Platform } from '../../../shared/commands/keybindings'
import { assignMnemonics, buildMenuModel, pruneMenu, submenuTitle, trimSeparators, type MenuEntry, type MenuId, type SubmenuId } from '../../../shared/commands/menus'
import type { ScriptAsTitleKey } from '../../../shared/scripting/catalog.ts'
import { evaluateWhen } from '../../../shared/commands/when'
import { commandTitle, type SettingsValues } from '../../../shared/settings/catalog'
import type { CommandService } from '../core/commands'
import { onUnexpectedError } from '../core/errors'
import type { CommandArgs } from '../core/types'

/**
 * One item of an open menu, frozen while the menu is open. `key` is stable across resolutions (the native item id, a
 * dynamic item's id, or `sep:<n>`); `mnemonic` indexes the underlined character of `title`, or is -1. A submenu is
 * enabled while something in it is; a disabled one shows greyed and does not open, as SSMS greys a verb an object does
 * not support. The Script submenu carries its title key for native menus, which show catalogue titles only.
 */
export type ResolvedMenuItem =
  | {
    readonly kind: 'command'; readonly key: string; readonly id: CommandId; readonly args?: CommandArgs; readonly title: string; readonly mnemonic: number
    readonly icon?: Codicon; readonly keybinding?: KeybindingLabel; readonly enabled: boolean; readonly checked?: boolean; readonly radio?: true
  }
  | {
    readonly kind: 'submenu'; readonly key: string; readonly title: string; readonly mnemonic: number; readonly items: readonly ResolvedMenuItem[]; readonly enabled: boolean
    readonly scriptAsTitle?: ScriptAsTitleKey
  }
  | { readonly kind: 'separator'; readonly key: string }
export type ResolvedCommandItem = Extract<ResolvedMenuItem, { kind: 'command' }>

/**
 * Items a dynamic submenu adds after its catalogue items, before enablement, keybindings, and mnemonics are worked
 * out. `mnemonic: null` gives an item none (theme names); `enabled: false` disables it whatever its command says.
 */
export type DynamicMenuItem =
  | {
    readonly kind: 'command'; readonly key: string; readonly id: CommandId; readonly args?: CommandArgs; readonly title: string; readonly mnemonic?: string | null
    readonly enabled?: boolean; readonly checked?: boolean; readonly radio?: true
  }
  | { readonly kind: 'submenu'; readonly key: string; readonly title: string; readonly mnemonic?: string | null; readonly items: readonly DynamicMenuItem[] }
  | { readonly kind: 'separator' }

export interface ResolveOptions {
  readonly platform: Platform
  /** A packaged build's menus leave out development commands. */
  readonly packaged?: boolean
  /** The workbench's static and state keys (`ContextKeyService.getState()`); focus keys are not read. */
  readonly state: Partial<ContextKeys>
  /** What a context menu was opened for. */
  readonly target?: Partial<TargetKeys>
  /** Passed to every command item: enablement, and the handler when the item runs. */
  readonly args?: CommandArgs
  readonly commands: Pick<CommandService, 'isEnabled' | 'isToggled'>
  readonly keybindings: { lookup(id: CommandId): KeybindingLabel | undefined }
  readonly dynamic?: { readonly theme?: () => readonly DynamicMenuItem[] }
  /** Settings that titles follow ("Select Top 50 Rows"); the defaults without them. Applied here, not in the cached model. */
  readonly settings?: SettingsValues
  /** Each menu's entries; defaults to the catalogue's model (tests pass their own). */
  readonly model?: (menu: MenuId) => readonly MenuEntry[]
}

const models = new Map<string, readonly MenuEntry[]>()
/** The catalogue never changes while the app runs, so each menu's model is built once per platform and build. */
function catalogueModel(menu: MenuId, platform: Platform, packaged: boolean): readonly MenuEntry[] {
  const key = `${menu}\n${platform}\n${packaged}`
  let entries = models.get(key)
  if (!entries) models.set(key, entries = Object.freeze(buildMenuModel(menu, platform, packaged)))
  return entries
}
function guarded<T>(read: () => T, fallback: T): T {
  try { return read() } catch (error) { onUnexpectedError(error); return fallback }
}

type Draft =
  | (Omit<ResolvedCommandItem, 'mnemonic'> & { readonly mnemonic?: string | null })
  | (Omit<Extract<ResolvedMenuItem, { kind: 'submenu' }>, 'mnemonic' | 'enabled'> & { readonly mnemonic?: string | null })
  | { readonly kind: 'separator' }
const isEnabled = (item: ResolvedMenuItem) => item.kind !== 'separator' && item.enabled

/**
 * A menu as it shows now: catalogue placements whose `when` holds over the state and target keys, submenus with
 * something visible in them, enablement and checks from the command service, keybinding labels, and mnemonics
 * assigned per level. Electron roles are left out: custom menus show only commands. Reads no DOM.
 */
export function resolveMenu(menu: MenuId, options: ResolveOptions): readonly ResolvedMenuItem[] {
  const { platform, commands, keybindings, args } = options
  const model = options.model ?? ((id: MenuId) => catalogueModel(id, platform, options.packaged ?? false))
  const keys = contextRecord(platform, { ...options.state, ...options.target })
  const keep = (entry: MenuEntry) => entry.kind !== 'role' && (entry.kind === 'separator' || !entry.when || evaluateWhen(entry.when, keys))
  const children = (id: SubmenuId) => model(id)
  let separators = 0

  const command = (id: CommandId, title: string, extra: { mnemonic?: string | null; key: string; toggle?: boolean; args?: CommandArgs; enabled?: boolean; checked?: boolean; radio?: true }): Draft => {
    const itemArgs = extra.args ?? args, icon = extra.toggle || extra.radio ? undefined : commandDescriptor(id).icon
    const keybinding = guarded(() => keybindings.lookup(id), undefined)
    const checked = extra.toggle ? guarded(() => commands.isToggled(id), false) : extra.checked
    return {
      kind: 'command', key: extra.key, id, title, ...(itemArgs ? { args: itemArgs } : {}), ...(extra.mnemonic !== undefined ? { mnemonic: extra.mnemonic } : {}),
      ...(icon ? { icon } : {}), ...(keybinding ? { keybinding } : {}), enabled: extra.enabled !== false && guarded(() => commands.isEnabled(id, itemArgs), false),
      ...(checked !== undefined ? { checked } : {}), ...(extra.radio ? { radio: true as const } : {})
    }
  }
  const finish = (drafts: readonly Draft[]): readonly ResolvedMenuItem[] => {
    const shown = trimSeparators(drafts.filter(draft => draft.kind !== 'submenu' || draft.items.length > 0))
    const mnemonics = assignMnemonics(shown.map(draft => draft.kind === 'separator' ? null : draft))
    return Object.freeze(shown.map((draft, index): ResolvedMenuItem => draft.kind === 'separator'
      ? Object.freeze({ kind: 'separator', key: `sep:${separators++}` })
      : draft.kind === 'submenu' ? Object.freeze({ ...draft, mnemonic: mnemonics[index], enabled: draft.items.some(isEnabled) })
        : Object.freeze({ ...draft, mnemonic: mnemonics[index] })))
  }
  const dynamic = (items: readonly DynamicMenuItem[]): Draft[] => items.map((item): Draft => {
    if (item.kind === 'separator') return item
    if (item.kind === 'submenu') return { kind: 'submenu', key: item.key, title: item.title, mnemonic: item.mnemonic, items: finish(dynamic(item.items)) }
    return command(item.id, item.title, item)
  })
  const level = (entries: readonly MenuEntry[], depth: number): Draft[] => pruneMenu(entries, keep, children, depth).map((entry): Draft => {
    // `keep` has already dropped roles.
    if (entry.kind === 'separator' || entry.kind === 'role') return { kind: 'separator' }
    if (entry.kind === 'command') return command(entry.id, commandTitle(entry.id, options.settings, entry.title), { key: entry.nativeId, mnemonic: entry.mnemonic, toggle: entry.toggle })
    const provider = entry.dynamic && options.dynamic?.[entry.dynamic]
    const provided = provider ? guarded(provider, []) : []
    // Dynamic items share the level with the catalogue's, so `finish` assigns their mnemonics together.
    const items = finish([...level(children(entry.id), depth + 1), { kind: 'separator' }, ...dynamic(provided)])
    const scriptAsTitle = entry.dynamicTitle === 'scriptAs' && keys.explorerScriptTitle ? { scriptAsTitle: keys.explorerScriptTitle } : {}
    return { kind: 'submenu', key: entry.nativeId, title: submenuTitle(entry, keys), mnemonic: entry.mnemonic, items, ...scriptAsTitle }
  })
  return finish(level(model(menu), 0))
}
