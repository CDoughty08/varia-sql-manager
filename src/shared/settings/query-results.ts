import type { SettingDef } from './types'

/** Query Results pages. */
export const queryResultsSettings = [
  {
    key: 'queryResults.grid.layout', page: 'queryResults.sqlServer.grid', group: 'Grid display', label: 'Show results', type: 'enum', varia: true,
    values: [{ value: 'stacked', label: 'Stacked' }, { value: 'tabs', label: 'As tabs' }], default: 'tabs',
    keywords: ['layout', 'tabs', 'stacked', 'stack', 'groups', 'results', 'pivot', 'comparison', 'view'],
    description: 'Stacked shows every result of a run one under another, each Pivot under its result, comparisons last. As tabs, the default, shows one at a time: a row of tabs for the results and comparisons, the selected result\'s Table and Pivot as view tabs beneath, and one grid; when the tabs do not fit, a button at the end of the row opens a list of every result, view and comparison (Go to Result…). Switching keeps each grid\'s scroll, column widths, selection, sort and filters. The results toolbar changes this too.'
  },
  {
    key: 'queryResults.grid.sortText', page: 'queryResults.sqlServer.grid', group: 'Grid display', label: 'Sort text columns by', type: 'enum', varia: true,
    values: [{ value: 'value', label: 'Value' }, { value: 'chars', label: 'Length in characters' }, { value: 'bytes', label: 'Length in bytes' }], default: 'value',
    keywords: ['sort', 'order', 'length', 'len', 'datalength', 'characters', 'bytes', 'text'],
    description: 'How a sorted results grid orders its text and binary columns. Value sorts as ORDER BY would, by the column\'s collation, with NULL first ascending. Length in characters counts every character, spaces included; length in bytes sorts by DATALENGTH. Other columns always sort by value. The results toolbar changes this too, and sorted grids sort again.'
  },
  {
    key: 'queryResults.grid.whitespace', page: 'queryResults.sqlServer.grid', group: 'Grid display', label: 'Show white space in results', type: 'enum', varia: true,
    values: [{ value: 'none', label: 'Off' }, { value: 'spaces', label: 'Spaces and tabs' }, { value: 'all', label: 'All white space' }], default: 'none',
    keywords: ['whitespace', 'white space', 'spaces', 'tabs', 'line breaks', 'crlf', 'nbsp', 'invisible'],
    description: 'Spaces show as a raised dot (·) and tabs as an arrow (→) in the results grid. All white space also names line breaks (CR, LF, CRLF) and the invisible characters that make values look alike: no-break and zero-width spaces, BOM and the other Unicode spaces. The marks are only drawn: Copy and Save Results As write the values as they are. The results toolbar changes this too.'
  },
  {
    key: 'queryResults.grid.showColumnTypes', page: 'queryResults.sqlServer.grid', group: 'Grid display', label: 'Show column data types in the column headers', type: 'boolean', default: true,
    varia: true, keywords: ['type', 'data type', 'header', 'int', 'nvarchar'],
    description: 'Each column header shows the column\'s SQL type after its name, in smaller text: int, nvarchar(50), decimal(18,2). The header\'s tooltip names the type either way. Column widths already set are kept when this changes.'
  },
  {
    key: 'queryResults.grid.rowSize', page: 'queryResults.sqlServer.grid', group: 'Grid display', label: 'Show row size behind row numbers', type: 'boolean', default: true, varia: true,
    keywords: ['row size', 'bytes', 'datalength', 'bar', 'gutter', 'row number'],
    description: 'A bar behind each row number shows the row\'s size, the sum of DATALENGTH over its columns, scaled to the largest row of the result (or of its filtered rows); rows over half the largest stand out. Hover a row number for the exact bytes. The results toolbar changes this too.'
  },
  {
    key: 'queryResults.grid.columnProfile', page: 'queryResults.sqlServer.grid', group: 'Grid display', label: 'Show the column profile panel', type: 'boolean', default: false, varia: true,
    keywords: ['profile', 'stats', 'statistics', 'distinct', 'nulls', 'min', 'max', 'histogram', 'length'],
    description: 'A panel beside the results describes each column of the result set that last had focus: its NULLs, distinct values (by the column\'s collation), lowest and highest values, lengths in characters and bytes, and a histogram. It describes the rows as the grid shows them, sorted or filtered, and is computed in the SQL backend. The results toolbar changes this too.'
  },
  {
    key: 'queryResults.grid.columnProfileSelectedOnly', page: 'queryResults.sqlServer.grid', group: 'Grid display', label: 'Show only the selected columns in the column profile', type: 'boolean', default: false, varia: true,
    keywords: ['profile', 'selected', 'selection', 'columns', 'filter', 'peek'],
    description: 'The column profile panel lists only the columns the grid\'s selection covers, following it as it changes, instead of every column. Either way the cards of the selected columns are highlighted, and holding Ctrl (⌘ on macOS) with the pointer over the panel shows the other list for as long as it is held. The panel\'s Selected Columns Only button changes this too.'
  },
  {
    key: 'queryResults.grid.filterPopupWidth', page: 'queryResults.sqlServer.grid', group: 'Grid display', label: 'Column filter width', title: 'Column filter popup width', type: 'integer', min: 340, max: 900, default: 440, unit: 'px', varia: true,
    keywords: ['filter', 'funnel', 'popup', 'popover', 'size', 'resize', 'width'],
    description: 'The width of the column filter that a header\'s funnel or Filter Column Values opens. Dragging the filter\'s corner grip sets it. The filter shrinks to fit a small window.'
  },
  {
    key: 'queryResults.grid.filterPopupHeight', page: 'queryResults.sqlServer.grid', group: 'Grid display', label: 'Column filter height', title: 'Column filter popup height', type: 'integer', min: 0, max: 1200, default: 0, unit: 'px', hint: '0 = fit to contents', varia: true,
    keywords: ['filter', 'funnel', 'popup', 'popover', 'size', 'resize', 'height'],
    description: 'The height of the column filter that a header\'s funnel or Filter Column Values opens; a taller filter shows more values. 0 fits it to its contents. Dragging the filter\'s corner grip sets it, at least 240 px. The filter shrinks to fit a small window.'
  },
  {
    key: 'queryResults.grid.copyColumnHeaders', page: 'queryResults.sqlServer.grid', group: 'Copy and save', label: 'Include column headers when copying the results', type: 'boolean', default: false,
    keywords: ['headers', 'copy', 'clipboard', 'column names'],
    description: 'Copy starts with a row of column names, in the results grid and in every other grid that copies its rows. Copy with Headers always includes them.'
  },
  {
    key: 'queryResults.grid.saveColumnHeaders', page: 'queryResults.sqlServer.grid', group: 'Copy and save', label: 'Include column headers when saving the results', type: 'boolean', default: true,
    keywords: ['headers', 'csv', 'export', 'save', 'column names'],
    description: 'Save Results As (CSV and tab-delimited text) starts with a row of column names, from the results grid and from every other grid that saves its rows. JSON always names its keys.'
  },
  {
    key: 'queryResults.grid.discardResults', page: 'queryResults.sqlServer.grid', group: 'Limits and memory', label: 'Discard results after execution', type: 'boolean', default: false,
    applies: 'nextExecution', keywords: ['discard', 'no results', 'rows', 'timing', 'profile', 'memory', 'large', 'million'],
    description: 'Every query, in every query tab, runs and has its rows read from the server, but none is kept or shown: the Messages tab says how many result sets and rows were read. Execution plans and client statistics are still collected. For timing a large query without spending memory on its rows; turn it off again to see results.'
  },
  {
    key: 'queryResults.grid.maxResultSets', page: 'queryResults.sqlServer.grid', group: 'Limits and memory', label: 'Result sets kept per execution', title: 'Maximum result sets kept per execution', type: 'integer', min: 1, max: 1000, default: 1000,
    varia: true, applies: 'nextExecution', keywords: ['result sets', 'limit', 'max result sets', 'result set limit'],
    description: 'Result sets after this many still run and are counted, but their rows are not kept; the Messages tab says so.'
  },
  {
    key: 'queryResults.grid.maxRows', page: 'queryResults.sqlServer.grid', group: 'Limits and memory', label: 'Rows kept per execution', title: 'Maximum rows kept per execution', type: 'integer', min: 0, max: 2_147_483_647, default: 0, hint: '0 = no limit',
    varia: true, applies: 'nextExecution', keywords: ['rows', 'limit', 'truncated', 'large', 'million', 'top', 'max rows', 'row limit', 'rows kept'],
    description: 'Rows after this many, counted over every result set of one execution, are still read and counted, but not kept; the grid says how many of how many it shows. The query itself is not changed, so the server still returns every row.'
  },
  {
    key: 'queryResults.grid.memoryLimitGiB', page: 'queryResults.sqlServer.grid', group: 'Limits and memory', label: 'Result memory limit', type: 'integer', min: 0, max: 1024, default: 0, unit: 'GiB', hint: '0 = automatic',
    varia: true, applies: 'immediately', keywords: ['memory', 'budget', 'limit', 'rows', 'truncated', 'large', 'million'],
    description: 'How much memory all query results may hold together; one query may use half of it. Automatic is a quarter of the computer\'s memory, at least 256 MiB and at most 16 GiB. A limit set here is used as it is, up to three quarters of the computer\'s memory. Rows past the limit are still read and counted, but not kept. A change applies at once: lowering the limit below what results hold keeps them, and stores nothing more until enough are closed. Sorting, filtering, pivoting or profiling a result takes its working memory from the same limit, so a result that fills its share leaves no room for them. Closing results may keep the memory they used for new results instead of giving it back to the computer: Varia gives memory back after a close, once more than 64 MiB has been closed, or the last results are, and what remains is no more than has been closed since it last gave memory back, and no more than 8 GiB unless memory runs short, because giving memory back pauses Varia while it moves what stays, about a second for every 8 GiB that stays; with a limit over 8 GiB, results that stay stored past 8 GiB can keep the memory of closed results until enough of them are closed.'
  },
  { key: 'queryResults.plan.outline', page: 'queryResults.sqlServer.grid', group: 'Execution plan', label: 'Show outline', title: 'Show execution plan outline', type: 'boolean', default: true, varia: true, description: 'Show the searchable, keyboard accessible operator outline.' },
  { key: 'queryResults.plan.properties', page: 'queryResults.sqlServer.grid', group: 'Execution plan', label: 'Show properties', title: 'Show execution plan properties', type: 'boolean', default: true, varia: true, description: 'Show properties for the selected statement or operator.' },
  { key: 'queryResults.plan.minimap', page: 'queryResults.sqlServer.grid', group: 'Execution plan', label: 'Show minimap', title: 'Show execution plan minimap', type: 'boolean', default: true, varia: true, description: 'Show a bounded overview of the plan and its viewport.' },
  { key: 'queryResults.plan.rowFlow', page: 'queryResults.sqlServer.grid', group: 'Execution plan', label: 'Show row flow', title: 'Show execution plan row flow', type: 'boolean', default: true, varia: true, description: 'Label edges with actual, estimated, unavailable or partial live rows.' },
  { key: 'queryResults.plan.outlineWidth', page: 'queryResults.sqlServer.grid', group: 'Execution plan', label: 'Outline width', title: 'Execution plan outline width', type: 'integer', min: 120, max: 600, default: 220, unit: 'px', varia: true, description: 'Preferred outline width in pixels. The pane shrinks to fit a small window.' },
  { key: 'queryResults.plan.propertiesWidth', page: 'queryResults.sqlServer.grid', group: 'Execution plan', label: 'Properties width', title: 'Execution plan properties width', type: 'integer', min: 140, max: 600, default: 260, unit: 'px', varia: true, description: 'Preferred properties width in pixels. The pane shrinks to fit a small window.' },
  {
    key: 'queryResults.compare.layout', page: 'queryResults.sqlServer.grid', group: 'Comparisons', label: 'Show a comparison as', title: 'Comparison layout', type: 'enum', varia: true,
    values: [{ value: 'entry', label: 'One row per entry' }, { value: 'unified', label: 'Two rows (−/+)' }], default: 'entry',
    keywords: ['compare', 'comparison', 'diff', 'differences', 'layout', 'one row', 'two rows', 'unified', 'old', 'new'],
    description: 'How a new comparison draws its rows. One row per entry, the default, shows a changed row once, each changed value as old → new. Two rows shows a changed row as its old row (−) and its new row (+), with the changed values coloured. A comparison too wide for one row per entry (more than 2,046 compared columns) shows two rows. The Layout button in a comparison toolbar changes that comparison only.'
  },
  {
    key: 'queryResults.compare.rows', page: 'queryResults.sqlServer.grid', group: 'Comparisons', label: 'Rows of a comparison', title: 'Comparison rows', type: 'enum', varia: true,
    values: [{ value: 'all', label: 'All rows' }, { value: 'changes', label: 'Changes only' }], default: 'all',
    keywords: ['compare', 'comparison', 'diff', 'differences', 'rows', 'changes', 'unchanged', 'context', 'hide'],
    description: 'Which rows a new comparison keeps. All rows, the default, keeps unchanged rows too, uncoloured. Changes only keeps the changed, added and removed rows, with a dashed rule where unchanged rows were left out. The Rows button in a comparison toolbar changes that comparison only.'
  }
] as const satisfies readonly SettingDef[]
