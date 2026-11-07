import { parseKeySpec, type Platform } from './keybindings'
import type { ScopeId } from './scopes'

/**
 * Built-in widget keys: what the results grid, Object Explorer's tree and the table designer do with keys of their own
 * (moving, selecting, editing). They are not catalogue commands and cannot be changed; the Shortcuts page lists them as
 * Built in, and a shortcut on one in an overlapping scope gets a warning. `tests/shortcut-validate.test.ts` ties these
 * lists to `grid/keyboard.ts`, `explorer/tree-model.ts` and `designer/DesignerGrid.tsx`.
 */
export type IntrinsicKey =
  | { readonly scope: ScopeId; readonly title: string; readonly key: string; readonly label?: undefined }
  /** A key the key grammar cannot name (numeric keypad keys, any character), shown by its label only. */
  | { readonly scope: ScopeId; readonly title: string; readonly label: string; readonly key?: undefined }

const each = (scope: ScopeId, title: string, ...keys: string[]): IntrinsicKey[] => keys.map(key => ({ scope, title, key }))
const gridEdges = ['up', 'down', 'left', 'right', 'home', 'end']
const moves = ['up', 'down', 'left', 'right', 'home', 'end', 'pageup', 'pagedown']
const treeKeys = [...moves, 'enter']

export const intrinsicKeys: readonly IntrinsicKey[] = [
  ...each('resultsGrid', 'Move the active cell', ...moves),
  ...each('resultsGrid', 'Extend the selection', ...moves.map(key => `shift+${key}`)),
  ...each('resultsGrid', 'Move to the edge of the results', ...gridEdges.map(key => `mod+${key}`)),
  ...each('resultsGrid', 'Extend the selection to the edge', ...gridEdges.map(key => `mod+shift+${key}`)),
  ...each('resultsGrid', 'Select whole rows', 'shift+space'),
  ...each('resultsGrid', 'Select whole columns', 'ctrl+space'),
  ...each('resultsGrid', 'Open a link cell', 'enter'),
  ...each('resultsGrid', 'Cancel a drag, a resize, a copy or a save', 'escape'),

  ...each('objectExplorer', 'Move, expand, collapse or open the selected node', ...treeKeys, ...treeKeys.map(key => `shift+${key}`)),
  { scope: 'objectExplorer', title: 'Expand the selected node', label: 'Numpad +' },
  { scope: 'objectExplorer', title: 'Collapse the selected node', label: 'Numpad −' },
  { scope: 'objectExplorer', title: 'Expand the node and its siblings', label: '*' },

  ...each('tableDesigner', 'Move the active cell', 'up', 'down', 'left', 'right', 'home', 'end', 'pageup', 'pagedown', 'tab', 'shift+tab'),
  ...each('tableDesigner', 'Move to the first or last row', 'mod+home', 'mod+end'),
  ...each('tableDesigner', 'Open the data type list', 'alt+down'),
  ...each('tableDesigner', 'Edit the cell', 'f2', 'enter'),
  ...each('tableDesigner', 'Toggle Allow Nulls', 'space'),
  { scope: 'tableDesigner', title: 'Start editing the cell with the character typed', label: 'Any character' }
]

const tables = new Map<Platform, ReadonlyMap<ScopeId, ReadonlyMap<string, string>>>()
/** The built-in keys of `scope` on `platform`, as canonical chords with what each does. */
export function intrinsicChords(scope: ScopeId, platform: Platform): ReadonlyMap<string, string> {
  let table = tables.get(platform)
  if (!table) {
    const built = new Map<ScopeId, Map<string, string>>()
    for (const entry of intrinsicKeys) {
      if (entry.key === undefined) continue
      let chords = built.get(entry.scope)
      if (!chords) built.set(entry.scope, chords = new Map())
      for (const chord of parseKeySpec(entry.key, platform)) if (!chords.has(chord)) chords.set(chord, entry.title)
    }
    tables.set(platform, table = built)
  }
  return table.get(scope) ?? new Map()
}
