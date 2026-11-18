// Test mode only (scripts/results-smoke.mjs, local grids): a LocalGrid over the table given, mounted in its own box above the
// workbench, as a Peek card or a Properties page will mount it. One at a time: mounting again replaces it.
import { createRoot, type Root } from 'react-dom/client'
import type { LocalTableData } from '../../../shared/results/local-table'
import type { Workbench } from '../core/workbench'
import { WorkbenchProvider } from '../core/WorkbenchContext'
import { LocalGrid, type LocalGridPreset } from './LocalGrid'

export interface TestLocalGridOptions { readonly label: string; readonly preset: LocalGridPreset; readonly empty?: string; readonly suggestedName?: string; readonly sortable?: boolean }

let mounted: { root: Root; host: HTMLElement } | undefined
export function mountTestLocalGrid(workbench: Workbench, table: LocalTableData, o: TestLocalGridOptions): void {
  unmountTestLocalGrid()
  const host = document.createElement('div')
  host.className = 'local-grid-test'
  host.style.cssText = `position: fixed; left: 48px; top: 96px; width: 640px; ${o.preset === 'page' ? 'height: 320px;' : ''} z-index: 20; display: flex; flex-direction: column;`
  document.body.append(host)
  const root = createRoot(host)
  root.render(<WorkbenchProvider workbench={workbench}><LocalGrid table={table} {...o} /></WorkbenchProvider>)
  mounted = { root, host }
}
export function unmountTestLocalGrid(): void {
  mounted?.root.unmount()
  mounted?.host.remove()
  mounted = undefined
}
