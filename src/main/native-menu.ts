import { isCommandId, type CommandId } from '../shared/commands/catalog'
import { menuStateSchema, toggleCommandIds, type MenuState } from '../shared/commands/menus'

/** The parts of Electron's `Menu` and `MenuItem` the bridge reads and writes, so tests can use plain objects. */
export interface MenuItemLike { readonly id: string; enabled: boolean; checked: boolean; readonly submenu?: MenuLike }
export interface MenuLike { readonly items: readonly MenuItemLike[] }

/** Command items by command id, including `<id>@<menu>` duplicates and items in submenus. */
export function indexCommandItems(menu: MenuLike): Map<CommandId, MenuItemLike[]> {
  const index = new Map<CommandId, MenuItemLike[]>()
  const visit = (items: readonly MenuItemLike[]) => {
    for (const item of items) {
      const id = item.id?.split('@')[0]
      if (isCommandId(id)) index.set(id, [...index.get(id) ?? [], item])
      if (item.submenu) visit(item.submenu.items)
    }
  }
  visit(menu.items)
  return index
}

/** Sets enablement and checkboxes in place; `null` (no state from the renderer yet) enables everything and clears checks. */
export function applyMenuState(index: ReadonlyMap<CommandId, readonly MenuItemLike[]>, state: MenuState | null): void {
  for (const [id, items] of index) {
    const enabled = !state?.disabled.includes(id), toggle = toggleCommandIds.includes(id), checked = !!state?.checked.includes(id)
    for (const item of items) {
      item.enabled = enabled
      if (toggle) item.checked = checked
    }
  }
}

/**
 * Keeps the native menu in step with the renderer, which owns command enablement and toggle state. The renderer sends
 * only id sets, validated here; state changes never rebuild the menu, because Electron reads `enabled` and `checked`
 * live. A rebuild (a theme change) re-applies the last state.
 */
export class NativeMenuBridge<M extends MenuLike> {
  private index = new Map<CommandId, MenuItemLike[]>()
  private state: MenuState | null = null
  constructor(private readonly options: { build(): M; install(menu: M): void }) {}
  rebuild(): void {
    const menu = this.options.build()
    this.index = indexCommandItems(menu)
    applyMenuState(this.index, this.state)
    this.options.install(menu)
  }
  /** Applies a renderer message; an invalid one is dropped and the previous state stays. */
  applyState(raw: unknown): boolean {
    const parsed = menuStateSchema.safeParse(raw)
    if (!parsed.success) return false
    this.state = parsed.data
    applyMenuState(this.index, this.state)
    return true
  }
  /** A reloaded or crashed renderer has no state yet: every item is enabled until it reports again. */
  reset(): void {
    this.state = null
    applyMenuState(this.index, null)
  }
  isChecked(id: CommandId): boolean { return !!this.state?.checked.includes(id) }
}
