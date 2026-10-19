import { chordFromEvent, parseKeySpec, type KeyEventLike, type Platform } from '../../../shared/commands/keybindings'
import { gridLimits as g } from './constants'

// The grid's own keys, handled in the grid's React onKeyDown. They are not catalogue keybindings: the catalogue's
// commands (Copy with Headers, Save Results As, F6, Ctrl+R, Shift+F10) reach the grid through KeybindingService, and
// Tab, Alt combinations and Previous/Next Query are left to the browser and the workbench.

/** Where a move goes: one cell, a page, or an edge of the result (the last row is the last available one). */
export type GridMove = 'up' | 'down' | 'left' | 'right' | 'pageUp' | 'pageDown' | 'firstRow' | 'lastRow' | 'firstColumn' | 'lastColumn' | 'firstCell' | 'lastCell'
export type GridAction =
  /** Moves the active cell (collapsing the selection to it), or with `extend` moves the last block's far corner. */
  | { readonly type: 'move'; readonly move: GridMove; readonly extend: boolean }
  /** Shift+Space and Ctrl+Space: whole rows or whole columns over the last block. */
  | { readonly type: 'selectRows' | 'selectColumns' | 'selectAll' }
  /** Enter opens a link cell; Escape cancels a drag, a resize, or the tab's copy or save; copy is mod+C. */
  | { readonly type: 'open' | 'escape' | 'copy' }

const moves: readonly (readonly [key: string, plain: GridMove, mod: GridMove])[] = [
  ['up', 'up', 'firstRow'], ['down', 'down', 'lastRow'], ['left', 'left', 'firstColumn'], ['right', 'right', 'lastColumn'],
  ['home', 'firstColumn', 'firstCell'], ['end', 'lastColumn', 'lastCell'], ['pageup', 'pageUp', 'pageUp'], ['pagedown', 'pageDown', 'pageDown']
]
function build(platform: Platform): ReadonlyMap<string, GridAction> {
  const map = new Map<string, GridAction>()
  const add = (spec: string, action: GridAction) => { for (const chord of parseKeySpec(spec, platform)) map.set(chord, action) }
  for (const [key, plain, mod] of moves) {
    add(key, { type: 'move', move: plain, extend: false })
    add('shift+' + key, { type: 'move', move: plain, extend: true })
    // Ctrl+PageUp and Ctrl+PageDown are Previous and Next Query.
    if (key === 'pageup' || key === 'pagedown') continue
    add('mod+' + key, { type: 'move', move: mod, extend: false })
    add('mod+shift+' + key, { type: 'move', move: mod, extend: true })
  }
  add('shift+space', { type: 'selectRows' })
  // ⌃Space on macOS, where macOS may claim it for input sources; column headers still select columns.
  add('ctrl+space', { type: 'selectColumns' })
  add('enter', { type: 'open' })
  add('escape', { type: 'escape' })
  add('mod+a', { type: 'selectAll' })
  add('mod+c', { type: 'copy' })
  return map
}
const tables = new Map<Platform, ReadonlyMap<string, GridAction>>()

/** What a key press does in the grid, or undefined when the grid leaves it alone (and does not prevent its default). */
export function gridKeyAction(event: KeyEventLike, platform: Platform): GridAction | undefined {
  const chord = chordFromEvent(event, platform)
  if (!chord) return undefined
  let table = tables.get(platform)
  if (!table) tables.set(platform, table = build(platform))
  return table.get(chord)
}

/** PageUp and PageDown move by the rows the body shows less one, so one row of context stays in view. */
export const pageStep = (bodyHeight: number): number => Math.max(1, Math.floor(bodyHeight / g.rowHeight) - 1)
