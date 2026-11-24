// One of Peek's lists (`peekLists`: Columns, Parameters, Index columns, Events, Files, Server roles, User mapping) as a local
// grid: Peek's tabs show it, and any surface holding the same list from explorer.peek (Search Objects details' Columns) can
// show it the same way.
import { useMemo } from 'react'
import { peekLists, type PeekList, type PeekListId } from '../../../shared/explorer/peek.ts'
import { LocalGrid, type LocalGridPreset } from '../grid/LocalGrid'
import type { GridViewState } from '../results/ResultsService'
import { peekListTable } from './peek-format'

export interface PeekListGridProps {
  readonly id: PeekListId
  /** The list as explorer.peek returned it; none shows the list's empty words. */
  readonly list: PeekList | undefined
  /** `card` in the hover card and a details pane, `page` in a promoted Peek tab (with Save Results As). */
  readonly preset: LocalGridPreset
  /** Fills its flex container instead of shrinking to row height (used by Peek Card's dedicated list tabs). */
  readonly fill?: boolean
  /** The object's display name, which Save Results As suggests the file after. */
  readonly objectName?: string
  readonly state?: GridViewState
}

/** The list's rows in the results grid: its columns as the list names them, its values as Peek formats them. */
export function PeekListGrid({ id, list, preset, fill, objectName, state }: PeekListGridProps) {
  const spec = peekLists[id]
  const table = useMemo(() => peekListTable(spec, list?.rows ?? []), [spec, list])
  return <LocalGrid table={table} label={spec.title} preset={preset} fill={fill} empty={spec.empty} suggestedName={objectName ? `${objectName} ${spec.title}` : spec.title} {...state ? { state } : {}} />
}
