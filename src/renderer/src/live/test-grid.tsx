// Test mode only (scripts/live-grid-smoke.mjs): a LiveGridPane over a synthetic live view, mounted in its own box above
// the workbench, as the Activity Monitor and SSIS documents will mount it.
import { createRoot } from 'react-dom/client'
import type { LiveProbeId } from '../../../shared/live/catalog'
import type { Workbench } from '../core/workbench'
import { WorkbenchProvider } from '../core/WorkbenchContext'
import type { LiveGrid, LiveGridState } from './LiveGrid'
import { LiveGridPane } from './LiveGridPane'
import type { LiveHandle } from './LiveService'

export interface TestGrid { grid(): LiveGrid | undefined; dispose(): void }

export function mountTestGrid(workbench: Workbench, handle: LiveHandle, probe: LiveProbeId, table: number, state?: LiveGridState): TestGrid {
  const host = document.createElement('div')
  host.className = 'live-grid-test'
  host.style.cssText = 'position: fixed; left: 48px; top: 96px; width: 720px; height: 360px; z-index: 20; display: flex;'
  document.body.append(host)
  let grid: LiveGrid | undefined
  const root = createRoot(host)
  root.render(<WorkbenchProvider workbench={workbench}>
    <LiveGridPane live={handle} probe={probe} table={table} {...state ? { state } : {}} label="Live grid" toneLabel={tone => tone === 'muted' ? 'ended' : tone} onGrid={value => { grid = value }} />
  </WorkbenchProvider>)
  return { grid: () => grid, dispose: () => { root.unmount(); host.remove() } }
}
