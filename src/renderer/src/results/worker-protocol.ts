// Messages between the UI thread (ResultClient) and the results worker. The worker also owns the results port to main
// (src/shared/ipc/port-messages.ts).
import type { BackendStatus, IdentityBy, QueryEvent, ResultsDiffResult, ResultsFindRowsResult, ResultsIdentifyResult, ResultsProfileResult, ResultsRowIdsResult, ResultsSearchResult, ResolvedViewFilter, ViewFilter, ViewSortKey, WireKind } from '../../../shared/contracts'
import type { MemoryFeature, MemoryReport } from '../../../shared/ipc/port-messages'
import type { ErrorCode } from '../../../shared/ipc/wire/protocol'
import type { LiveEnd, LiveEvent, LiveSubscribeParams, LiveUpdateParams, LiveUpdateResult } from '../../../shared/live/schema'

/** A result is named by its backend generation and its id within that generation; `view` names one of its sorted views
 *  (results.view), whose rows are read by view position. */
export interface ResultKey { readonly generation: number; readonly resultId: number; readonly view?: number }

/** One row-identity request: tell the rows apart, read a range's identities, or find the rows with some identities. */
export type IdentityRequest =
  | { readonly method: 'identify'; readonly by: IdentityBy; readonly column?: number }
  | { readonly method: 'rowIds'; readonly firstRow: number; readonly count: number }
  | { readonly method: 'findRows'; readonly ids: readonly number[] }
  /** results.diff: this result (the earlier) against `right` (the later), of the same generation. */
  | { readonly method: 'diff'; readonly right: number; readonly exact: boolean; readonly context: number }

/** Cell flags in a window: NULL, truncated where the backend stored it (a prefix), read error, over the window's text
 *  budget, and cut at the window's maxCellChars. */
export const FLAG_NULL = 1
export const FLAG_TRUNCATED = 2
export const FLAG_ERROR = 4
export const FLAG_OVER_BUDGET = 8
export const FLAG_CAPPED = 16

/** How the worker formats a value opened in a document tab (plans are XML). */
export type ValueFormat = 'xml' | 'json'

export interface WindowRequest {
  readonly type: 'window'
  readonly id: number
  readonly key: ResultKey
  readonly wires: readonly WireKind[]
  readonly first: number
  readonly count: number
  readonly colStart: number
  readonly colEnd: number
  readonly maxCellChars: number
  readonly textBudget: number
  /** Grid text: line breaks and tabs become spaces, other control characters U+FFFD (cells.ts displayText). */
  readonly display?: boolean
}
/** The widest display text of each column [colStart, colEnd) over rows [first, first + count), in monospace columns. */
export interface MeasureRequest {
  readonly type: 'measure'
  readonly id: number
  readonly key: ResultKey
  readonly wires: readonly WireKind[]
  readonly first: number
  readonly count: number
  readonly colStart: number
  readonly colEnd: number
}

/** UI → worker. `attach` transfers the port main sent to the page. */
export type WorkerRequest =
  | { readonly type: 'attach'; readonly port: MessagePort }
  | WindowRequest
  | MeasureRequest
  /** One cell's whole stored value; with `format`, pretty-printed as XML or JSON when it is well formed and complete. */
  | { readonly type: 'cell'; readonly id: number; readonly key: ResultKey; readonly wires: readonly WireKind[]; readonly row: number; readonly col: number; readonly format?: ValueFormat }
  | { readonly type: 'prefetch'; readonly key: ResultKey; readonly wires: readonly WireKind[]; readonly first: number; readonly count: number }
  | { readonly type: 'cancel'; readonly id: number }
  | { readonly type: 'close'; readonly id: number; readonly generation: number; readonly resultIds: readonly number[] }
  /** Row sizes (results.rowBytes), relayed to main as they are. */
  | { readonly type: 'rowBytes'; readonly id: number; readonly key: ResultKey; readonly firstRow: number; readonly count: number }
  | { readonly type: 'stats'; readonly id: number }
  /** A sorted view of `key`'s result (results.view); `cancel` with the same id stops the sort. `replaces` names a view it
   *  supersedes, whose pages go once it is built. */
  | { readonly type: 'view'; readonly id: number; readonly key: ResultKey; readonly sort: readonly ViewSortKey[]; readonly filters?: readonly ViewFilter[]; readonly replaces?: number }
  | { readonly type: 'viewClose'; readonly id: number; readonly key: ResultKey; readonly viewIds: readonly number[] }
  /** Row identities (results.identify, rowIds, findRows), relayed to main as they are; `key.view` reads through a view.
   *  `cancel` with the same id stops an identify. */
  | { readonly type: 'identity'; readonly id: number; readonly key: ResultKey; readonly request: IdentityRequest }
  /** The cells of `key` (its view's positions when it names one) containing `text` (results.search); `cancel` with the same
   *  id stops it. */
  | { readonly type: 'search'; readonly id: number; readonly key: ResultKey; readonly text: string; readonly fromRow: number; readonly maxMatches: number; readonly backward: boolean }
  /** A column profile (results.profile) of `key`'s rows, through its view when it names one; `cancel` with the same id stops it. */
  | { readonly type: 'profile'; readonly id: number; readonly key: ResultKey; readonly columns: readonly number[] }
  /** A live subscription (docs/ipc.md, Live subscriptions); `cancel` with the same id ends it. */
  | { readonly type: 'live'; readonly id: number; readonly params: LiveSubscribeParams }
  /** A change to the running subscription whose request id is `live`. */
  | { readonly type: 'liveUpdate'; readonly id: number; readonly live: number; readonly params: LiveUpdateParams }
  /** The page applied a live event of the subscription `id`: the worker grants those bytes back to main. */
  | { readonly type: 'liveAck'; readonly id: number; readonly bytes: number }
  /** Results the backend already released (retired by a tick, or ended with their subscription): their pages go, and no
   *  results.close is sent. */
  | { readonly type: 'forget'; readonly generation: number; readonly resultIds: readonly number[] }

/** Worker → UI. A window's `flags` buffer and a measure's `widths` buffer are transferred. */
export type WorkerResponse =
  | { readonly type: 'window'; readonly id: number; readonly first: number; readonly count: number; readonly colStart: number; readonly colEnd: number; readonly text: string[]; readonly flags: Uint8Array }
  | { readonly type: 'measure'; readonly id: number; readonly rows: number; readonly widths: Uint16Array }
  | { readonly type: 'cell'; readonly id: number; readonly text: string; readonly isNull: boolean; readonly truncated: boolean; readonly error: boolean; readonly formatted: boolean }
  | { readonly type: 'closed'; readonly id: number; readonly closed: number; readonly usedBytes: number }
  | { readonly type: 'rowBytes'; readonly id: number; readonly firstRow: number; readonly bytes: readonly number[]; readonly rowsAvailable: number; readonly estimated: readonly number[] }
  | { readonly type: 'stats'; readonly id: number; readonly bytes: number; readonly pages: number; readonly wireBytes: number; readonly columns: number }
  | { readonly type: 'view'; readonly id: number; readonly viewId: number; readonly rows: number; readonly complete: boolean; readonly approximate: boolean; readonly filters?: readonly ResolvedViewFilter[] }
  | { readonly type: 'viewClosed'; readonly id: number; readonly closed: number }
  | { readonly type: 'identity'; readonly id: number; readonly result: ResultsIdentifyResult | ResultsRowIdsResult | ResultsFindRowsResult | ResultsDiffResult }
  | { readonly type: 'search'; readonly id: number; readonly result: ResultsSearchResult }
  | { readonly type: 'profile'; readonly id: number; readonly result: ResultsProfileResult }
  | { readonly type: 'error'; readonly id: number; readonly code: ErrorCode; readonly message: string }
  | { readonly type: 'query'; readonly queryId: string; readonly event: QueryEvent }
  | ({ readonly type: 'memory'; readonly feature: MemoryFeature } & MemoryReport)
  | { readonly type: 'backend'; readonly generation: number; readonly status: BackendStatus }
  /** A live event as main validated it, with its EVENT body's length, which the page acknowledges with `liveAck`. */
  | { readonly type: 'live'; readonly id: number; readonly bytes: number; readonly event: LiveEvent }
  | { readonly type: 'liveEnd'; readonly id: number; readonly result: LiveEnd }
  | { readonly type: 'liveUpdated'; readonly id: number; readonly result: LiveUpdateResult }
