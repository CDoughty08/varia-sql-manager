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
export function useServiceSnapshot<T>(store: ExternalStore<T>): T { return useSyncExternalStore(store.subscribe, store.getSnapshot) }
