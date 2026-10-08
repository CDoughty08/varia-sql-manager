import type { CommandContext, CommandId, Disposable } from './types'

interface Command { run(context?: CommandContext): void | Promise<void>; when?(context?: CommandContext): boolean }
export class CommandService implements Disposable {
  private commands = new Map<CommandId, Command>()
  register(id: CommandId, command: Command): Disposable {
    if (this.commands.has(id)) throw new Error(`Command already registered: ${id}`)
    this.commands.set(id, command)
    return { dispose: () => { if (this.commands.get(id) === command) this.commands.delete(id) } }
  }
  canRun(id: CommandId, context?: CommandContext): boolean {
    const command = this.commands.get(id)
    return !!command && (command.when?.(context) ?? true)
  }
  async run(id: CommandId, context?: CommandContext): Promise<void> {
    const command = this.commands.get(id)
    if (!command) throw new Error(`Unknown command: ${id}`)
    if (command.when && !command.when(context)) return
    await command.run(context)
  }
  dispose(): void { this.commands.clear() }
}
