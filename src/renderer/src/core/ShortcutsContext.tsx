import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react'
import type { ShortcutsService, ShortcutsSnapshot } from './ShortcutsService'

const Context = createContext<ShortcutsService | null>(null)
/** Gives `useShortcuts` its service: the workbench's in the app, `createFakeShortcutsService()` in tests. */
export function ShortcutsProvider({ shortcuts, children }: { shortcuts: ShortcutsService; children: ReactNode }) {
  return <Context.Provider value={shortcuts}>{children}</Context.Provider>
}
/** The user's shortcuts (`ShortcutsService`): the Shortcuts page reads and saves them through this. */
export function useShortcuts(): ShortcutsService {
  const shortcuts = useContext(Context)
  if (!shortcuts) throw new Error('ShortcutsProvider is missing.')
  return shortcuts
}
/** The current snapshot; the component re-renders when main's file or the effective rules change. */
export function useShortcutsSnapshot(): ShortcutsSnapshot {
  const shortcuts = useShortcuts()
  return useSyncExternalStore(shortcuts.subscribe, shortcuts.getSnapshot, shortcuts.getSnapshot)
}
