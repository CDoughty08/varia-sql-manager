import { useCallback, useMemo, useSyncExternalStore } from 'react'
import type { KeybindingLabel } from '../../../shared/commands/keybindings'
import type { CommandArgs, CommandId } from './types'
import { useWorkbench } from './WorkbenchContext'

/**
 * Whether the command can run now (with `args`, when a button acts on something); buttons use it so the toolbar, menus,
 * and keys agree. It is read again whenever the component renders, so arguments from its own state stay current.
 */
export function useCommandEnabled(id: CommandId, args?: CommandArgs): boolean {
  const { commands } = useWorkbench()
  return useSyncExternalStore(useEnablementChanges(), () => commands.isEnabled(id, args))
}

/** `useCommandEnabled` for several commands at once, such as a toolbar's buttons, in their order. */
export function useCommandsEnabled(items: readonly { readonly id: CommandId; readonly args?: CommandArgs }[]): readonly boolean[] {
  const { commands } = useWorkbench()
  // A string is a snapshot React can compare; a new array each time would never settle.
  const mask = useSyncExternalStore(useEnablementChanges(), () => items.map(item => commands.isEnabled(item.id, item.args) ? '1' : '0').join(''))
  return useMemo(() => Array.from(mask, flag => flag === '1'), [mask])
}

function useEnablementChanges(): (listener: () => void) => () => void {
  const { commands, context } = useWorkbench()
  return useCallback((listener: () => void) => {
    const unsubscribe = context.subscribe(listener), handlers = commands.onDidChangeHandlers(listener)
    return () => { unsubscribe(); handlers.dispose() }
  }, [commands, context])
}

/** The command's primary keybinding as shown on this platform, for tooltips and hints. */
export function useKeybindingLabel(id: CommandId): KeybindingLabel | undefined {
  return useWorkbench().keybindings.lookup(id)
}
