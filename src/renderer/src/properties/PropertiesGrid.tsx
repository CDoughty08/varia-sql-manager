import type { LocalTableData } from '../../../shared/results/local-table'
import { gridLimits as g } from '../grid/constants'
import { LocalGrid } from '../grid/LocalGrid'
import { scrollbarSize } from '../grid/scrollbar'

/** The most rows a Properties list shows before it scrolls: the page's sections scroll too, so a long list stays a window. */
export const propertiesGridRows = 12
/** An empty list's room under its header for the words that say so. */
const emptyRoom = 48

/** A list's height in pixels: its header and rows up to `propertiesGridRows`, room for a horizontal scroll bar, and its border. */
export const propertiesGridHeight = (rows: number, scrollbar: number) =>
  g.headerHeight + (rows === 0 ? emptyRoom : Math.min(rows, propertiesGridRows) * g.rowHeight + scrollbar) + 2

/**
 * A Properties list as a page grid (LocalGrid's `page` preset, so Save Results As applies) in a box as tall as its rows:
 * the sections column scrolls as one, so a grid that filled it would leave no room for the rest of the section.
 */
export default function PropertiesGrid({ table, label, empty, suggestedName }: { table: LocalTableData; label: string; empty: string; suggestedName: string }) {
  return <div className="properties-grid" style={{ height: propertiesGridHeight(table.rows.length, typeof document === 'undefined' ? 0 : scrollbarSize()) }}>
    <LocalGrid table={table} label={label} preset="page" empty={empty} suggestedName={suggestedName} />
  </div>
}
