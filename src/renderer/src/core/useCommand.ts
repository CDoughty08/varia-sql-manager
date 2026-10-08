import { useCallback, useSyncExternalStore } from 'react'
import type { KeybindingLabel } from '../../../shared/commands/keybindings'
import type { CommandId } from './types'
import { useWorkbench } from './WorkbenchContext'

/** Whether the command can run now; buttons use it so the toolbar, menus, and keys agree. */
export function useCommandEnabled(id: CommandId): boolean {
  const { commands, context } = useWorkbench()
  const subscribe = useCallback((listener: () => void) => {
    const unsubscribe = context.subscribe(listener), handlers = commands.onDidChangeHandlers(listener)
    return () => { unsubscribe(); handlers.dispose() }
  }, [commands, context])
  return useSyncExternalStore(subscribe, () => commands.isEnabled(id))
}

/** The command's primary keybinding as shown on this platform, for tooltips and hints. */
export function useKeybindingLabel(id: CommandId): KeybindingLabel | undefined {
  return useWorkbench().keybindings.lookup(id)
}
