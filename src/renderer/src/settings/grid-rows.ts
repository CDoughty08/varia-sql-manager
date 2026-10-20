// Which rows a property grid shows, without React, so Node tests pin it for Tools › Options, Database Properties and the
// table designer that build on PropertyGrid.
import type { GridGroup, GridRow } from './PropertyGrid'

const byLabel = (a: GridRow, b: GridRow) => a.label.localeCompare(b.label, 'en', { sensitivity: 'base' })

/** Top-level rows by label, each followed by its child rows in their own order, as SSMS's Alphabetical view nests them. */
function alphabetical(rows: readonly GridRow[]): GridRow[] {
  const withChildren = (row: GridRow): GridRow[] => [row, ...rows.filter(child => child.parent === row.key).flatMap(withChildren)]
  return rows.filter(row => row.parent === undefined).sort(byLabel).flatMap(withChildren)
}

/** The groups as they show: SSMS's Categorized view keeps them, its Alphabetical view is one unlabelled list sorted by
 *  label; a child row shows only while its parent is expanded. */
export function visibleGridRows(groups: readonly GridGroup[], order: 'categorized' | 'alphabetical' = 'categorized'): readonly GridGroup[] {
  const shown: readonly GridGroup[] = order === 'alphabetical' ? [{ rows: alphabetical(groups.flatMap(group => group.rows)) }] : groups
  const expanded = new Set(shown.flatMap(group => group.rows).filter(row => row.expanded).map(row => row.key))
  return shown.map(group => ({ ...group, rows: group.rows.filter(row => row.parent === undefined || expanded.has(row.parent)) }))
}

/** Marks a property grid's container, so a dialog's Enter edits the grid rather than pressing OK. */
export const propertyGridAttribute = 'data-property-grid'
