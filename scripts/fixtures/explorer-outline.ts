// Finding a row of Object Explorer's windowed tree by its path, as plain data: explorer-tree.mjs reads the rendered rows
// from the page and matches here, and tests/explorer-outline.test.ts checks the matching. The tree renders only a window of
// rows around its viewport (plus the selected row, wherever it is), so a row's ancestors can be out of the rendered rows:
// a path is matched only through rows known to be adjacent, and rows from several windows are joined by their offsets.

/** A rendered row: its element id, its offset from the top of the tree's content (not the viewport) and its height in px, its
 * aria-level, and its label without its sublabel. */
export interface OutlineRow {
  readonly id: string
  readonly top: number
  readonly height: number
  readonly level: number
  readonly label: string
}

/** Whether `next` sits right below `previous`, with no row between them: closer than half the shortest row. */
function adjacent(previous: OutlineRow, next: OutlineRow, unit: number): boolean {
  return Math.abs(next.top - (previous.top + previous.height)) < unit / 2
}

const unitOf = (rows: readonly OutlineRow[]) => Math.max(1, Math.min(...rows.map(row => row.height)))

/** A window's rows as runs of adjacent rows, from the top: the selected row rendered far from the window is a run of its own. */
export function explorerRuns(rows: readonly OutlineRow[]): OutlineRow[][] {
  const sorted = [...rows].sort((a, b) => a.top - b.top), unit = unitOf(sorted), runs: OutlineRow[][] = []
  for (const row of sorted) {
    const run = runs.at(-1), last = run?.at(-1)
    if (run && last && adjacent(last, row, unit)) run.push(row)
    else runs.push([row])
  }
  return runs
}

/** Whether a run of adjacent rows spans the viewport from `top` to `bottom`: the window for that scroll position is rendered. */
export function explorerCovers(rows: readonly OutlineRow[], top: number, bottom: number): boolean {
  return explorerRuns(rows).some(run => run[0].top <= top && run[run.length - 1].top + run[run.length - 1].height >= bottom)
}

/**
 * The rows of several windows (in the order they were read) as one outline from the top. Each run of adjacent rows is the
 * tree as it was for the offsets it spans, so it replaces whatever an earlier window held there: a folder that expanded
 * between two reads leaves no stale rows below it within the later run.
 */
export function explorerOutline(windows: readonly (readonly OutlineRow[])[]): OutlineRow[] {
  let outline: OutlineRow[] = []
  for (const rows of windows) {
    for (const run of explorerRuns(rows)) {
      const start = run[0].top, end = run[run.length - 1].top + run[run.length - 1].height
      outline = outline.filter(row => row.top + row.height <= start || row.top >= end).concat(run)
    }
  }
  return outline.sort((a, b) => a.top - b.top)
}

/**
 * The row at a path of labels from a server down, in an outline (or one window's rows), or undefined. Each row's ancestors
 * are the rows above it at each lower level, read only through adjacent rows: after a gap (rows not rendered, or the
 * selected row rendered apart from the window) the ancestors are unknown until a server row, so a row is never matched
 * through another subtree's ancestors.
 */
export function findExplorerPath(outline: readonly OutlineRow[], path: readonly string[]): OutlineRow | undefined {
  const sorted = [...outline].sort((a, b) => a.top - b.top), unit = unitOf(sorted)
  let stack: (string | undefined)[] = [], previous: OutlineRow | undefined
  for (const row of sorted) {
    if (!previous || !adjacent(previous, row, unit)) stack = []
    stack.length = Math.max(0, row.level - 1)
    stack[row.level - 1] = row.label
    if (row.level === path.length && path.every((label, index) => stack[index] === label)) return row
    previous = row
  }
  return undefined
}
