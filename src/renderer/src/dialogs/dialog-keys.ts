// What Enter does in an object dialog, without the DOM, so Node tests pin it.
import { propertyGridAttribute } from '../settings/grid-rows'

/** Where Enter edits in place, as in SSMS's grids, lists and property grid, rather than pressing OK. */
const editsInPlace = `[role="grid"], [role="listbox"], table, [${propertyGridAttribute}]`

/** The part of an element Enter's routing reads. */
export interface EnterTarget { readonly tagName?: string; closest?(selector: string): unknown; hasAttribute?(name: string): boolean }

/**
 * Enter in an object dialog, as in SSMS: a button, a list box, a disclosure's summary or a link keeps its own Enter ('native':
 * Enter opens a closed Sessions list rather than running the action); in a grid, list box, table or property grid it edits there ('edit': committing a cell never presses OK, and an input there must not submit
 * the form either); anywhere else it presses OK ('ok').
 */
export function dialogEnter(target: EnterTarget | null): 'native' | 'edit' | 'ok' {
  if (target?.tagName === 'BUTTON' || target?.tagName === 'SELECT' || target?.tagName === 'SUMMARY' || (target?.tagName === 'A' && target.hasAttribute?.('href'))) return 'native'
  return target?.closest?.(editsInPlace) ? 'edit' : 'ok'
}
