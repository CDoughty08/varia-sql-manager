import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react'
import type { ExternalStore } from './types'
import type { Workbench } from './workbench'

const Context = createContext<Workbench | null>(null)
export function WorkbenchProvider({ workbench, children }: { workbench: Workbench; children: ReactNode }) {
  return <Context.Provider value={workbench}>{children}</Context.Provider>
}
export function useWorkbench(): Workbench {
  const workbench = useContext(Context)
  if (!workbench) throw new Error('WorkbenchProvider is missing.')
  return workbench
}
// The same snapshot serves server rendering, so the markup tests can draw a component that reads the workbench.
export function useServiceSnapshot<T>(store: ExternalStore<T>): T { return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot) }
/** One part of a store's snapshot; the component re-renders only when that part changes (`select` must return stable values). */
export function useServiceSelector<T, R>(store: ExternalStore<T>, select: (snapshot: T) => R): R {
  const read = () => select(store.getSnapshot())
  return useSyncExternalStore(store.subscribe, read, read)
}
/** A stored connection color as CSS for the active theme; the component re-renders when the theme changes. */
export function useConnectionAccent(color: string | undefined): string | undefined {
  const { theme } = useWorkbench()
  useServiceSnapshot(theme)
  return theme.accent(color)
}
