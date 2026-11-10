import { kindSpecs, type ExplorerIcon, type KindSpec } from '../../../shared/explorer/catalog.ts'
import { insertTextFor } from '../../../shared/explorer/refs.ts'
import type { ObjectSearchHit } from '../../../shared/explorer/search.ts'
import type { Platform } from '../../../shared/commands/keybindings'
import { onUnexpectedError } from '../core/errors'
import type { Workbench } from '../core/workbench'
import { selectionContextOf } from '../explorer/ExplorerService'
import type { SearchHitTarget } from '../menus/targets'

/** A hit's kind as this build's catalogue has it; a kind it does not know (a newer backend's) shows as a plain object. */
export function hitKindSpec(kind: string): Pick<KindSpec, 'title' | 'icon' | 'subtypeIcons'> {
  return Object.hasOwn(kindSpecs, kind) ? kindSpecs[kind as keyof typeof kindSpecs] : unknownKindSpec
}
const unknownKindSpec: Pick<KindSpec, 'title' | 'icon'> = { title: 'Object', icon: 'file' }
/** The icon Object Explorer draws the hit's node with. */
export function hitIcon(hit: Pick<ObjectSearchHit, 'object' | 'subtype'>): ExplorerIcon {
  const spec = hitKindSpec(hit.object.kind)
  return (hit.subtype && spec.subtypeIcons?.[hit.subtype]) || spec.icon
}

/**
 * A hit's context menu target: the object as a menu node on the search's server, and its selection keys, which its menu's Object
 * Explorer commands (Select Top N Rows, Modify, Script as) read instead of the tree's selection.
 */
export function searchHitTarget(explorer: Pick<Workbench['explorer'], 'objectNode'>, connectionId: string, searchId: string, index: number, hit: ObjectSearchHit, pane: boolean): SearchHitTarget {
  const node = explorer.objectNode(connectionId, hit.object, hit.label, hit.subtype)
  return { kind: 'searchHit', searchId, index, hit, pane, node, state: selectionContextOf(node, { insertable: insertTextFor(node.ref) !== undefined }) }
}

/**
 * Reveal in Object Explorer for a Search Objects hit: Object Explorer shows at once and follows the seek as it expands and pages
 * its way to the object. From the tab (`pane` false) Object Explorer is shown without taking focus, so the arrows go on walking
 * the hits; its own search already shows the tree.
 */
export function revealHit({ commands, objectSearch, explorer }: Pick<Workbench, 'commands' | 'objectSearch' | 'explorer'>, connectionId: string, hit: ObjectSearchHit, pane: boolean): void {
  if (!pane) void commands.execute('window.explorer', { keepFocus: true }, 'toolbar')
  void objectSearch.reveal(explorer, connectionId, hit).then(outcome => { if (!outcome.ok && !outcome.cancelled) commands.reportError(outcome.message) }, onUnexpectedError)
}

/** The clipboard's Copy key on `platform`: ⌘C on macOS, where Ctrl+C is not Copy, and Ctrl+C elsewhere. */
export function isCopyKey(event: { readonly key: string; readonly ctrlKey: boolean; readonly metaKey: boolean; readonly altKey: boolean; readonly shiftKey: boolean }, platform: Platform): boolean {
  const mac = platform === 'darwin'
  return event.key.toLowerCase() === 'c' && !event.altKey && !event.shiftKey && (mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)
}
