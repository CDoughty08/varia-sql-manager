// The object actions' native confirmations (`varia:confirm-action`, src/shared/actions/prompts.ts) and the long-run line
// of the reload prompt (`varia:long-runs`, src/shared/long-runs.ts). The page sends a prompt id and bounded facts, or its
// runs; main validates them and writes the message box itself.
import type { MessageBoxOptions } from 'electron'
import { actionPromptAnswer, actionPromptBox, actionPromptRequestSchema, type ActionPromptBox } from '../shared/actions/prompts.ts'
import { longRunMessages, longRunStateSchema, type LongRunState } from '../shared/long-runs.ts'

/** The prompt's box for a request, or a thrown validation error (the handler answers `{ ok: false }`). */
export const confirmActionBox = (value: unknown): ActionPromptBox => actionPromptBox(actionPromptRequestSchema.parse(value))
export const actionMessageBox = (box: ActionPromptBox, signal?: AbortSignal): MessageBoxOptions => ({
  type: 'warning', title: box.title, message: box.message, detail: box.detail, buttons: [...box.buttons], defaultId: box.defaultId, cancelId: box.cancelId, noLink: true,
  ...signal ? { signal } : {}
})
export { actionPromptAnswer }

/** The page's long runs, as it last reported them; a reloaded or crashed page has none. */
export const noLongRuns: LongRunState = Object.freeze({ runs: [], total: 0 })
export const parseLongRuns = (value: unknown): LongRunState => longRunStateSchema.parse(value)
/** The reload prompt's detail: the running work it would stop, first, then what AutoRecover keeps. */
export const reloadDetail = (runs: LongRunState, loss: string): string => [longRunMessages.reload(runs), loss].filter(Boolean).join('\n\n')
/** The Restart SQL Backend prompt's detail: the running work it would stop, first, then the connections it closes. */
export const restartDetail = (runs: LongRunState, connections: number, bigQuery = false): string => [
  longRunMessages.restart(runs),
  connections === 1 ? 'The connection closes and uncommitted transactions are rolled back.' : connections > 1 ? `All ${connections} connections close and uncommitted transactions are rolled back.` : undefined,
  // A restart never cancels a BigQuery job (docs/bigquery.md, Re-attaching to jobs).
  bigQuery ? 'Running BigQuery jobs carry on in BigQuery and are re-attached once their tabs reconnect; a BigQuery session running a job keeps its transaction open until the session ends.' : undefined
].filter(Boolean).join('\n\n')
