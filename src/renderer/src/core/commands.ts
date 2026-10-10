import { commandDescriptor, isCommandId, paletteLabel, type CommandId } from '../../../shared/commands/catalog'
import { contextRecord, type ContextKeys } from '../../../shared/commands/context-keys'
import { compileWhen, evaluateWhen } from '../../../shared/commands/when'
import { onUnexpectedError } from './errors'
import { Emitter } from './events'
import { SnapshotStore } from './store'
import type { CommandArgs, Disposable } from './types'

export type CommandSource = 'keybinding' | 'menu' | 'palette' | 'toolbar' | 'api'
export interface CommandHandler { run(args?: CommandArgs): void | Promise<void>; when?(args?: CommandArgs): boolean }
export interface CommandEvent { readonly id: CommandId; readonly source: CommandSource }
/** The command banner's message; a warning (`kind`) is shown as a notice, not as a failure. */
export interface CommandSnapshot { readonly error: string; readonly kind?: 'warning' }

const maxErrorLength = 300
// Before the workbench supplies its context, every key is false and no platform is assumed.
const unknownState = contextRecord('linux', { isLinux: false })
const truncate = (text: string) => { const characters = [...text]; return characters.length > maxErrorLength ? characters.slice(0, maxErrorLength - 1).join('') + '…' : text }

/**
 * Command handlers by catalogue id. `run` is the programmatic path (it honours only the handler's own `when`);
 * `execute` is every user path: keys, menus, the toolbar, and the palette. It applies the modal rule and the catalogue
 * precondition, reports failures in the error snapshot, and never rejects.
 */
export class CommandService extends SnapshotStore<CommandSnapshot> implements Disposable {
  private handlers = new Map<CommandId, CommandHandler>()
  private warned = new Set<string>()
  private willExecute = new Emitter<CommandEvent>()
  private didExecute = new Emitter<CommandEvent>()
  private handlersChanged = new Emitter<void>()
  private readonly state: () => ContextKeys
  private readonly modalOpen: () => boolean
  constructor(options: { state?: () => ContextKeys; modalOpen?: () => boolean } = {}) {
    super({ error: '' })
    this.state = options.state ?? (() => unknownState)
    this.modalOpen = options.modalOpen ?? (() => false)
  }
  register(id: CommandId, handler: CommandHandler): Disposable {
    if (this.handlers.has(id)) throw new Error(`Command already registered: ${id}`)
    this.handlers.set(id, handler)
    this.handlersChanged.emit()
    return { dispose: () => {
      if (this.handlers.get(id) !== handler) return
      this.handlers.delete(id)
      this.handlersChanged.emit()
    } }
  }
  has(id: CommandId): boolean { return this.handlers.has(id) }
  canRun(id: CommandId, args?: CommandArgs): boolean {
    const handler = this.handlers.get(id)
    return !!handler && (handler.when?.(args) ?? true)
  }
  /** Whether a user can run the command now: it has a handler, its precondition holds, and the handler's `when` agrees. */
  isEnabled(id: CommandId, args?: CommandArgs): boolean {
    const handler = this.handlers.get(id)
    if (!handler) return false
    try {
      const { precondition } = commandDescriptor(id)
      if (precondition !== undefined && !evaluateWhen(compileWhen(precondition), this.state())) return false
      return handler.when?.(args) ?? true
    } catch (error) { onUnexpectedError(error); return false }
  }
  isToggled(id: CommandId): boolean {
    const { toggled } = commandDescriptor(id)
    if (toggled === undefined) return false
    try { return evaluateWhen(compileWhen(toggled), this.state()) } catch (error) { onUnexpectedError(error); return false }
  }
  async run(id: CommandId, args?: CommandArgs): Promise<void> {
    const handler = this.handlers.get(id)
    if (!handler) throw new Error(`Unknown command: ${id}`)
    if (handler.when && !handler.when(args)) return
    await handler.run(args)
  }
  /** Runs a command for a user; resolves to whether it ran. */
  async execute(id: CommandId, args: CommandArgs | undefined, source: CommandSource): Promise<boolean> {
    try {
      // A menu click can arrive before the renderer has registered every handler.
      if (!isCommandId(id) || !this.handlers.has(id)) { this.warnOnce(id); return false }
      if (source !== 'api' && !commandDescriptor(id).allowInModal && this.modalOpen()) return false
      // Native menu state can be 50 ms stale, so enablement is checked again here.
      if (!this.isEnabled(id, args)) return false
      this.willExecute.emit({ id, source })
      const handler = this.handlers.get(id)
      if (!handler) return false
      try { await handler.run(args) }
      catch (error) {
        this.publish({ error: truncate(`Could not run “${paletteLabel(id)}”: ${error instanceof Error ? error.message : 'The command failed.'}`) })
        onUnexpectedError(error)
        return false
      }
      this.didExecute.emit({ id, source })
      return true
    } catch (error) { onUnexpectedError(error); return false }
  }
  onWillExecute(listener: (event: CommandEvent) => void): Disposable { return this.willExecute.subscribe(listener) }
  onDidExecute(listener: (event: CommandEvent) => void): Disposable { return this.didExecute.subscribe(listener) }
  onDidChangeHandlers(listener: () => void): Disposable { return this.handlersChanged.subscribe(listener) }
  clearError(): void { if (this.getSnapshot().error) this.publish({ error: '' }) }
  /** Shows a failure outside a command (a menu that could not render) in the command banner. */
  reportError(message: string): void { this.publish({ error: truncate(message) }) }
  /** Shows a warning in the command banner: something worked, but the user should know more (a script's warnings). */
  reportWarning(message: string): void { this.publish({ error: truncate(message), kind: 'warning' }) }
  private warnOnce(id: string): void {
    if (this.warned.has(id)) return
    this.warned.add(id)
    console.warn(`Command ${JSON.stringify(id).slice(0, 80)} has no handler.`)
  }
  dispose(): void {
    this.handlers.clear()
    this.willExecute.dispose(); this.didExecute.dispose(); this.handlersChanged.dispose()
    this.clearListeners()
  }
}
