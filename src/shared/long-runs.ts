// Long runs: actions that change a server for seconds or hours (Create Catalog, a restore, New Database) and that a window
// close, a reload, a Disconnect or Restart SQL Backend would stop part way. While one runs, the renderer's LongRunService
// refuses the close, Disconnect of its server and Restart with a message naming it, and main's reload prompt names it.
// Long runs never hold the document task (`documentBusy`): a window close would then wait for them silently. Main's drain
// of a stopping backend stays the last resort. Erasable TypeScript, so Node's type stripping can load it too.
import { z } from 'zod'
import { displayText } from './explorer/refs.ts'

// One kind per line, so later runs append cleanly.
export const longRunKinds = [
  'createCatalog',
  'newDatabase',
  'attach',
  'restore',
  'verify',
  'newLogin',
  'backup',
  'shrink'
] as const
export type LongRunKind = typeof longRunKinds[number]
/** How a message names the run, at the start of a sentence. */
export const longRunSubjects: { readonly [K in LongRunKind]: string } = {
  createCatalog: 'Create Catalog', newDatabase: 'New Database', attach: 'An attach', restore: 'A restore', verify: 'A backup verification', newLogin: 'New Login',
  backup: 'A backup', shrink: 'A shrink'
}
/** The renderer tells main about at most this many runs (more are counted, not named), with server names this long. */
export const longRunLimits = { runs: 16, server: 256 } as const
/** A run: its kind and the server it changes, as the connection names it. */
export interface LongRun { readonly kind: LongRunKind; readonly server: string }
/** What the renderer sends main (`varia:long-runs`) whenever its runs change: all of them, `total` counting any past the limit. */
export interface LongRunState { readonly runs: readonly LongRun[]; readonly total: number }
export const longRunStateSchema = z.object({
  runs: z.array(z.object({ kind: z.enum(longRunKinds), server: z.string().min(1).max(longRunLimits.server) }).strict()).max(longRunLimits.runs),
  total: z.number().int().min(0).max(1_000_000)
}).strict().refine(state => state.total >= state.runs.length, 'total counts every run')

const subject = (run: LongRun) => `${longRunSubjects[run.kind]} is running on ${displayText(run.server)}`
const stops = (state: LongRunState, doing: string) => {
  const first = state.runs[0]
  if (!first) return undefined
  return state.total === 1 ? `${subject(first)}: ${doing} stops it part way.` : `${subject(first)}, with ${state.total - 1} more ${state.total === 2 ? 'run' : 'runs'}: ${doing} stops them part way.`
}
/** The refusals and the reload and restart prompts' line. Server names are shown through displayText. */
export const longRunMessages = {
  /** Closing the window. */
  close: (run: LongRun) => `${subject(run)}, and closing the window would stop it part way. Stop it, or wait for it to finish, then close the window.`,
  /** Disconnect of its server, and Restart SQL Backend. */
  stop: (run: LongRun) => `${subject(run)}. Stop it first.`,
  /** The first line of main's reload prompt's detail. */
  reload: (state: LongRunState) => stops(state, 'reloading'),
  /** The first line of main's Restart SQL Backend prompt's detail (the page lets Restart through while the backend does not answer). */
  restart: (state: LongRunState) => stops(state, 'restarting the backend')
} as const
