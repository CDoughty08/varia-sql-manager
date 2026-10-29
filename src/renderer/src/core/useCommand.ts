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
  const snapshot = () => commands.isEnabled(id, args)
  // These hooks give the same snapshot to server rendering, so the markup tests can draw what uses them.
  return useSyncExternalStore(useEnablementChanges(), snapshot, snapshot)
}

/** `useCommandEnabled` for several commands at once, such as a toolbar's buttons, in their order. */
export function useCommandsEnabled(items: readonly { readonly id: CommandId; readonly args?: CommandArgs }[]): readonly boolean[] {
  const { commands } = useWorkbench()
  // A string is a snapshot React can compare; a new array each time would never settle.
  const snapshot = () => items.map(item => commands.isEnabled(item.id, item.args) ? '1' : '0').join('')
  const mask = useSyncExternalStore(useEnablementChanges(), snapshot, snapshot)
  return useMemo(() => Array.from(mask, flag => flag === '1'), [mask])
}

/** Whether each command's `toggled` condition holds, for buttons that show it (`aria-pressed`), in their order. */
export function useCommandsToggled(ids: readonly CommandId[]): readonly boolean[] {
  const { commands } = useWorkbench()
  const snapshot = () => ids.map(id => commands.isToggled(id) ? '1' : '0').join('')
  const mask = useSyncExternalStore(useEnablementChanges(), snapshot, snapshot)
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
