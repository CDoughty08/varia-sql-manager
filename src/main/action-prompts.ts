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
