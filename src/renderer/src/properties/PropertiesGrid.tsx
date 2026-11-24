import type { LocalTableData } from '../../../shared/results/local-table'
import { propertiesGridRows } from '../../../shared/actions/catalog'
import { LocalGrid } from '../grid/LocalGrid'

/**
 * A Properties list as a page grid (LocalGrid's `page` preset, so Save Results As applies), fitted to its rows: the
 * sections column scrolls as one, so a grid that filled it would have no height. The fitted grid makes room for its strip
 * (a save's notice, a failed copy) and for a scroll bar only under columns wider than it. Pass `maxRows={Infinity}` inside
 * an `ObjectInspectorFrame` flow pane so tables render at natural height with zero nested vertical scrolling.
 */
export default function PropertiesGrid({ table, label, empty, suggestedName, maxRows = propertiesGridRows }: { table: LocalTableData; label: string; empty: string; suggestedName: string; maxRows?: number }) {
  return <div className="properties-grid">
    <LocalGrid table={table} label={label} preset="page" fit maxRows={maxRows} empty={empty} suggestedName={suggestedName} />
  </div>
}
