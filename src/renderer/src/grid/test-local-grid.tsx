// Test mode only (scripts/results-smoke.mjs, local grids): a LocalGrid over the table given, mounted in its own box above the
// workbench, as a Peek card or a Properties page will mount it. One at a time: mounting again replaces it.
import { createRoot, type Root } from 'react-dom/client'
import type { LocalTableData } from '../../../shared/results/local-table'
import type { Workbench } from '../core/workbench'
import { WorkbenchProvider } from '../core/WorkbenchContext'
import type { GridViewState } from '../results/ResultsService'
import { LocalGrid, type LocalGridPreset } from './LocalGrid'

export interface TestLocalGridOptions {
  readonly label: string; readonly preset: LocalGridPreset; readonly empty?: string; readonly suggestedName?: string; readonly sortable?: boolean
  readonly fit?: boolean; readonly maxRows?: number
  /** The name of a view state kept across mounts, as an owner that remounts its grid (a tab switch) keeps one per tab. */
  readonly keepState?: string
}
const keptStates = new Map<string, GridViewState>()
const keptState = (name: string): GridViewState => { let state = keptStates.get(name); if (!state) keptStates.set(name, state = { topRow: 0, virtualTop: 0, scrollLeft: 0, sized: false }); return state }

const props = ({ keepState, ...o }: TestLocalGridOptions) => keepState ? { ...o, state: keptState(keepState) } : o
let mounted: { root: Root; host: HTMLElement; workbench: Workbench; o: TestLocalGridOptions; table: LocalTableData } | undefined
export function mountTestLocalGrid(workbench: Workbench, table: LocalTableData, o: TestLocalGridOptions): void {
  unmountTestLocalGrid()
  const host = document.createElement('div')
  host.className = 'local-grid-test'
  host.style.cssText = `position: fixed; left: 48px; top: 96px; width: 640px; ${o.preset === 'page' && !o.fit ? 'height: 320px;' : ''} z-index: 20; display: flex; flex-direction: column;`
  document.body.append(host)
  const root = createRoot(host)
  root.render(<WorkbenchProvider workbench={workbench}><LocalGrid table={table} {...props(o)} /></WorkbenchProvider>)
  mounted = { root, host, workbench, o, table }
}
/** The mounted grid given a new table (null keeps the same table object) and options, as an owner renders one: the same
 *  component, not a new mount. */
export function rerenderTestLocalGrid(table: LocalTableData | null, patch: Partial<TestLocalGridOptions> = {}): void {
  if (!mounted) return
  mounted.o = { ...mounted.o, ...patch }
  if (table) mounted.table = table
  mounted.root.render(<WorkbenchProvider workbench={mounted.workbench}><LocalGrid table={mounted.table} {...props(mounted.o)} /></WorkbenchProvider>)
}
export function unmountTestLocalGrid(): void {
  mounted?.root.unmount()
  mounted?.host.remove()
  mounted = undefined
}
