import { useCallback, useSyncExternalStore } from 'react'
import type { KeybindingLabel } from '../../../shared/commands/keybindings'
import type { CommandArgs, CommandId } from './types'
import { useWorkbench } from './WorkbenchContext'

/**
 * Whether the command can run now (with `args`, when a button acts on something); buttons use it so the toolbar, menus,
 * and keys agree. It is read again whenever the component renders, so arguments from its own state stay current.
 */
export function useCommandEnabled(id: CommandId, args?: CommandArgs): boolean {
  const { commands, context } = useWorkbench()
  const subscribe = useCallback((listener: () => void) => {
    const unsubscribe = context.subscribe(listener), handlers = commands.onDidChangeHandlers(listener)
    return () => { unsubscribe(); handlers.dispose() }
  }, [commands, context])
  return useSyncExternalStore(subscribe, () => commands.isEnabled(id, args))
}

/** The command's primary keybinding as shown on this platform, for tooltips and hints. */
export function useKeybindingLabel(id: CommandId): KeybindingLabel | undefined {
  return useWorkbench().keybindings.lookup(id)
}
