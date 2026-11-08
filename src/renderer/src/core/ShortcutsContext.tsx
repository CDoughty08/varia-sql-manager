import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react'
import type { ShortcutsService, ShortcutsSnapshot } from './ShortcutsService'
import { useOptionalWorkbench } from './WorkbenchContext'

const Context = createContext<ShortcutsService | null>(null)
/** Gives `useShortcuts` a service other than the workbench's: `createFakeShortcutsService()` in tests. */
export function ShortcutsProvider({ shortcuts, children }: { shortcuts: ShortcutsService; children: ReactNode }) {
  return <Context.Provider value={shortcuts}>{children}</Context.Provider>
}
/**
 * The user's shortcuts (`ShortcutsService`): the Shortcuts page reads and saves them through this. A `ShortcutsProvider`
 * wins; otherwise it is the workbench's own service.
 */
export function useShortcuts(): ShortcutsService {
  const provided = useContext(Context), workbench = useOptionalWorkbench()
  const shortcuts = provided ?? workbench?.shortcuts
  if (!shortcuts) throw new Error('ShortcutsProvider or WorkbenchProvider is missing.')
  return shortcuts
}
/** The current snapshot; the component re-renders when main's file or the effective rules change. */
export function useShortcutsSnapshot(): ShortcutsSnapshot {
  const shortcuts = useShortcuts()
  return useSyncExternalStore(shortcuts.subscribe, shortcuts.getSnapshot, shortcuts.getSnapshot)
}
