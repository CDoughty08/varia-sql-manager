import { isCommandId, type CommandId } from '../../../shared/commands/catalog'
import type { ContextMenuId, ContextMenuRequest } from '../../../shared/commands/menus'
import type { ApiResult, VariaApi } from '../../../shared/contracts'
import type { CommandService } from '../core/commands'
import { onUnexpectedError } from '../core/errors'
import { browserTimers, type Timers } from '../core/timers'
import type { CommandArgs, Disposable } from '../core/types'
import type { Point } from './geometry'
import type { ResolvedMenuItem } from './resolve'

/** How long after a native menu closed its chosen item may still arrive: macOS reports the close before the click. */
export const nativeChoiceWindow = 2000
const maxToken = 2 ** 31 - 1
const maxCoordinate = 32767

/**
 * What main needs to show a resolved context menu natively: its command ids, flattened through submenus (the visible
 * ones are an allowlist, so a mistake hides items rather than showing them), which are disabled and checked, and where,
 * in whole CSS pixels. Titles, targets, and arguments stay here.
 */
export function nativeMenuRequest(token: number, menu: ContextMenuId, items: readonly ResolvedMenuItem[], at: Point): ContextMenuRequest {
  const visible: CommandId[] = [], disabled: CommandId[] = [], checked: CommandId[] = []
  const visit = (level: readonly ResolvedMenuItem[]) => {
    for (const item of level) {
      if (item.kind === 'submenu') visit(item.items)
      if (item.kind !== 'command' || visible.includes(item.id)) continue
      visible.push(item.id)
      if (!item.enabled) disabled.push(item.id)
      if (item.checked && !item.radio) checked.push(item.id)
    }
  }
  visit(items)
  const pixel = (value: number) => Number.isFinite(value) ? Math.min(maxCoordinate, Math.max(0, Math.round(value))) : 0
  return { token, menu, x: pixel(at.x), y: pixel(at.y), visible, disabled, checked }
}

export interface NativeMenuHandlers {
  /** The menu closed, chosen or not. */
  closed(): void
  /** Main could not show it; the caller shows the same items itself. */
  failed(): void
}
interface Pending { readonly token: number; readonly args: ReadonlyMap<CommandId, CommandArgs | undefined>; expiry?: unknown }

/**
 * Shows context menus as native menus (macOS): main builds them from the catalogue and reports a choice as a token and
 * a command id. Only the latest menu's token counts, only for a command it showed, and only until shortly after it
 * closed; the command then runs here with the menu's arguments, which re-checks that it can. Focus never left the page.
 */
export class NativeMenuPresenter implements Disposable {
  private seq = 0
  private pending?: Pending
  private readonly timers: Timers
  private readonly unsubscribe: () => void

  constructor(private readonly options: {
    readonly api: Pick<VariaApi, 'showContextMenu' | 'onContextMenuCommand'>
    readonly commands: Pick<CommandService, 'execute'>
    readonly timers?: Timers
  }) {
    this.timers = options.timers ?? browserTimers
    this.unsubscribe = options.api.onContextMenuCommand(command => { try { this.choose(command) } catch (error) { onUnexpectedError(error) } })
  }

  /** Replaces any menu still waiting for a choice. */
  show(menu: ContextMenuId, items: readonly ResolvedMenuItem[], at: Point, handlers: NativeMenuHandlers): void {
    this.drop()
    const args = new Map<CommandId, CommandArgs | undefined>()
    const collect = (level: readonly ResolvedMenuItem[]) => level.forEach(item => {
      if (item.kind === 'submenu') collect(item.items)
      else if (item.kind === 'command' && !args.has(item.id)) args.set(item.id, item.args)
    })
    collect(items)
    this.seq = this.seq >= maxToken ? 1 : this.seq + 1
    const pending: Pending = { token: this.seq, args }
    this.pending = pending
    const settle = (action: () => void) => { try { action() } catch (error) { onUnexpectedError(error) } }
    let shown: Promise<ApiResult<void>>
    try { shown = this.options.api.showContextMenu(nativeMenuRequest(pending.token, menu, items, at)) } catch (error) { shown = Promise.reject(error) }
    void shown.then(result => { if (!result.ok) throw new Error(result.error) }).then(() => {
      if (this.pending === pending) pending.expiry = this.timers.setTimeout(() => { if (this.pending === pending) this.pending = undefined }, nativeChoiceWindow)
      settle(handlers.closed)
    }, error => {
      // A newer menu has replaced this one, so there is nothing to show instead.
      if (this.pending !== pending) { settle(handlers.closed); return }
      this.pending = undefined
      onUnexpectedError(error)
      settle(handlers.failed)
    })
  }

  dispose(): void {
    this.drop()
    this.unsubscribe()
  }

  private choose(command: unknown): void {
    const pending = this.pending, { token, id } = (typeof command === 'object' && command !== null ? command : {}) as { token?: unknown; id?: unknown }
    if (!pending || token !== pending.token || !isCommandId(id) || !pending.args.has(id)) return
    // One choice per menu.
    this.drop()
    void this.options.commands.execute(id, pending.args.get(id), 'menu')
  }
  private drop(): void {
    if (this.pending?.expiry !== undefined) this.timers.clearTimeout(this.pending.expiry)
    this.pending = undefined
  }
}
