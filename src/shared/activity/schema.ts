// The strict zod schema of the Activity Monitor's filter: Processes' view chip and toggles, the filter box and the column
// value filters. The live layer carries it as `args.activity` (L2b); the backend re-checks every bound and column id against
// the catalogue (Activity/ActivityFilter.cs) and filters the snapshot in memory, so the SQL never changes.
import { z } from 'zod'
import { activityLimits, activityTables, tableSpecs, viewChips, type ActivityTable, type ViewChip } from './catalog.ts'

export interface ActivityColumnFilter {
  readonly column: string
  /** Rows whose cell text equals one of these (exactly, as the facets list them). */
  readonly values?: readonly string[]
  /** Rows whose cell is empty or NULL. */
  readonly blanks?: boolean
  /** Rows whose cell is not empty. */
  readonly nonBlanks?: boolean
}
export interface ActivityFilter {
  readonly table: ActivityTable
  /** Processes only. */
  readonly view?: ViewChip
  /** Processes only: SQL Server's own sessions, and Varia's pool sessions (query tabs always show). */
  readonly showSystem?: boolean
  readonly showVaria?: boolean
  /** Matched case-insensitively against the table's text columns. */
  readonly text?: string
  /** One per column; within one, any choice matches, and every column must match. */
  readonly columnFilters?: readonly ActivityColumnFilter[]
}

const processesOnly = ['view', 'showSystem', 'showVaria'] as const

export const activityColumnFilterSchema = z.object({
  column: z.string().min(1).max(64),
  values: z.array(z.string().max(activityLimits.columnFilterChars)).max(activityLimits.columnFilterValues).optional(),
  blanks: z.boolean().optional(),
  nonBlanks: z.boolean().optional()
}).strict()

export const activityFilterSchema = z.object({
  table: z.enum(activityTables),
  view: z.enum(viewChips).optional(),
  showSystem: z.boolean().optional(),
  showVaria: z.boolean().optional(),
  text: z.string().max(activityLimits.filterText).optional(),
  columnFilters: z.array(activityColumnFilterSchema).max(activityLimits.columnFilters).optional()
}).strict().superRefine((filter, context) => {
  const spec = tableSpecs[filter.table]
  if (filter.table !== 'sessions') {
    for (const key of processesOnly) if (filter[key] !== undefined) context.addIssue({ code: 'custom', path: [key], message: `Only Processes takes ${key}.` })
  }
  const seen = new Set<string>()
  filter.columnFilters?.forEach((columnFilter, index) => {
    if (!spec.facetColumns?.includes(columnFilter.column)) context.addIssue({ code: 'custom', path: ['columnFilters', index, 'column'], message: `${spec.title} has no value filter on ${columnFilter.column}.` })
    if (seen.has(columnFilter.column)) context.addIssue({ code: 'custom', path: ['columnFilters', index, 'column'], message: 'One filter per column.' })
    seen.add(columnFilter.column)
    if (!columnFilter.values?.length && !columnFilter.blanks && !columnFilter.nonBlanks) context.addIssue({ code: 'custom', path: ['columnFilters', index], message: 'A column filter needs a value, (Blanks) or (Non-blanks).' })
  })
}) satisfies z.ZodType<ActivityFilter>
