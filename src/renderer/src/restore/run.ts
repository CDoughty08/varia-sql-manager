// Restore Database's run (D1f), pure: the steps the backend will take for a request, the confirm bar's facts, the Run
// panel's steps and overall percent, the outcome in words, and the sections' one-line summaries while it runs. The
// service keeps the state; vitest holds each rule.
import { pathFileName, restoreRecoveryLabels, restoreStepTitles, type RestorePlanSet } from '../../../shared/actions/restore.ts'
import type { RestoreRequest } from '../../../shared/actions/restore-schema.ts'
import type { ActionError, ActionStep, RestoredDatabase } from '../../../shared/actions/schema.ts'
import { displayText } from '../../../shared/explorer/refs.ts'
import type { StepProgress } from '../actions/ActionProgressService'
import type { StepItem } from '../kit/StepList'
import { closesConnections, destinationOf, draftPlan, fileRows, sameDatabase, sourceDatabase, sourceSets, tailLogPossible, type RestoreDraft, type RestoreFacts } from './model'

/** A step the run will take, as the backend titles it; `set` marks a RESTORE, which the overall percent counts. */
export interface PlannedStep { readonly title: string; readonly detail?: string; readonly set: boolean }

/** A set as the backend's RestoreChain.Where names it: its first file's name, and how many more files it is striped over. */
export function setWhere(set: Pick<RestorePlanSet, 'devices'>): string {
  const first = set.devices[0] ?? ''
  return pathFileName(first) + (set.devices.length > 1 ? ` (+${set.devices.length - 1} files)` : '')
}

/**
 * The main steps RestoreRun.cs's RestoreSteps takes for `request`, in its order, with its titles and details: Close existing
 * connections (only over an existing database), the tail-log backup, one RESTORE per set ("Restore log backup 2 of 3"), and
 * multi-user access back after a RECOVERY restore that closed connections. Compensations and the cleanup are listed only when
 * they run, so they come from the reply alone.
 */
export function plannedSteps(request: RestoreRequest): PlannedStep[] {
  const options = request.restore, exists = !!request.identity, steps: PlannedStep[] = []
  const close = options.closeConnections && exists
  if (close) steps.push({ title: restoreStepTitles.close, set: false })
  if (options.tailLog) steps.push({ title: restoreStepTitles.tailLog, detail: pathFileName(options.tailLog.file), set: false })
  const logs = options.sets.filter(set => set.type === 'log').length
  let log = 0
  for (const set of options.sets) {
    const title = set.type === 'log' ? restoreStepTitles.log + (logs > 1 ? ` ${++log} of ${logs}` : '') : restoreStepTitles[set.type]
    steps.push({ title, detail: `${setWhere(set)}, position ${set.file}`, set: true })
  }
  if (close && options.recovery === 'recovery' && !options.restrictedUser) steps.push({ title: restoreStepTitles.multiUser, set: false })
  return steps
}

/** What closing connections would roll back, for the confirm bar (critic A7): the server's counts and this window's queries. */
export interface CloseFacts { readonly tabs: readonly string[] }
/** At most this many of Varia's own query windows are named; the rest are counted. */
export const confirmTabNames = 8
const plural = (value: number, one: string, many: string) => `${value.toLocaleString('en-US')} ${value === 1 ? one : many}`
const show = (text: string) => displayText(text)

/**
 * The confirm bar's lines before a restore runs, each only when its fact applies (owner decision 4); none means it runs at
 * once. SSMS asks none of these: they are Varia's, for data loss.
 * - Overwriting an existing database (WITH REPLACE): it is left restoring if the run stops or fails part way, and when it
 *   is not the database the backups are of, its own contents are lost outright (critic A11b).
 * - A tail-log backup that could be taken is off: changes since the last log backup are lost.
 * - Closing connections: how many sessions it ends, how many have open transactions (rolled back), and this window's own
 *   queries in the database that are running or may hold one (critic A7).
 */
export function confirmLines(draft: RestoreDraft, facts: RestoreFacts, close: CloseFacts): string[] {
  const destination = destinationOf(facts, draft.destination)
  if (!destination) return []
  const name = show(destination.name), lines: string[] = []
  if (draft.replace) {
    lines.push(`Restoring over ${name} replaces it. If the restore stops or fails part way, ${name} is left restoring and cannot be used until a restore finishes.`)
    if (!sameDatabase(draft, facts))
      lines.push(`${name} is not the database these backups are of (${show(sourceDatabase(draft, facts))}${destination.name.toLowerCase() === sourceDatabase(draft, facts).toLowerCase() ? ', from another server or an earlier database of that name' : ''}): everything in it now is lost, and no tail-log backup can keep its recent changes.`)
  }
  if (tailLogPossible(draft, facts) && !draft.tailLog) lines.push(`No tail-log backup is taken: changes to ${name} since its last log backup will be lost.`)
  if (closesConnections(draft, facts)) {
    const counted = destination.sessions === undefined ? `Closing existing connections ends every session in ${name}, and rolls back any open transaction.`
      : destination.sessions === 0 ? undefined
        : `Closing existing connections ends ${plural(destination.sessions, 'session', 'sessions')} in ${name}` + (destination.withTransaction === undefined ? ', and rolls back any open transaction.'
          : destination.withTransaction ? `; ${plural(destination.withTransaction, 'of them has an open transaction, which is', 'of them have open transactions, which are')} rolled back.` : '.')
    if (counted) lines.push(counted)
    if (close.tabs.length) {
      const named = close.tabs.slice(0, confirmTabNames).map(show), more = close.tabs.length - named.length
      lines.push(`Varia's query windows in ${name} that are running or may have an open transaction: ${named.join(', ')}${more > 0 ? `, and ${more.toLocaleString('en-US')} more` : ''}.`)
    }
  }
  return lines
}

/** The Stop question over a database that existed: stopping leaves it restoring (critic A11c). Keep restoring is the default. */
export function stopQuestion(database: string, replace: boolean): string {
  return `Stop the restore? Stopping leaves ${show(database)} restoring and unusable until a restore finishes.` + (replace ? ' Its previous contents are replaced as the restore runs (WITH REPLACE).' : '')
}

/** The Run panel's note: what a Stop or a failure leaves, which depends on whether the database existed (owner decision 5). */
export function runNote(database: string, existed: boolean): string {
  const name = show(database)
  return existed
    ? `${name} existed before this restore, so Varia never drops it. If the restore stops or fails, the steps completed are listed and Restore again keeps these choices.`
    : `${name} did not exist before this restore: if it stops or fails, Varia removes the partly restored database ("${restoreStepTitles.remove}").`
}

/** The steps the Run panel lists: while the run is on, the planned steps with the one in progress; then the reply's, as they ran. */
export function runSteps(planned: readonly PlannedStep[], reply: readonly ActionStep[] | undefined, progress: StepProgress | undefined, running: boolean): StepItem[] {
  // A step that stopped or failed part way keeps the percent it reached.
  if (reply) return reply.map(step => ({ state: step.status, text: step.detail ? `${step.title} (${step.detail})` : step.title, ...step.progress !== undefined && step.status !== 'done' ? { meta: `${step.progress} %` } : {} }))
  const current = running ? Math.min(progress?.step ?? 0, Math.max(0, planned.length - 1)) : -1
  return planned.map((step, index) => {
    const text = step.detail ? `${step.title} (${step.detail})` : step.title
    if (index < current) return { state: 'done', text }
    if (index > current) return { state: 'pending', text }
    const percent = progress && progress.step === index ? progress.percent : undefined
    return { state: 'running', text, ...percent !== undefined ? { meta: `${percent} %`, progress: percent, progressText: `${percent} percent processed` } : {} }
  })
}

/** About how far the restore is: the sets done and the running set's percent, each set counting alike (an approximation). */
export function overallPercent(planned: readonly PlannedStep[], progress: StepProgress | undefined): number {
  const sets = planned.filter(step => step.set).length
  if (!sets || !progress) return 0
  const done = planned.slice(0, Math.min(progress.step, planned.length)).filter(step => step.set).length
  const current = planned[progress.step]?.set ? progress.percent / 100 : 0
  return Math.max(0, Math.min(100, Math.round(((done + current) / sets) * 100)))
}

/**
 * How the run left the database, in words (critic A12), only from what the backend read after it: sys.databases' state and
 * user_access, or that no database has the name, "removed" only when the reply lists the cleanup done. When the backend could not read it, after steps ran, the page says so rather than guess; a refusal before any
 * statement, or a lost backend (whose message says to check), has no line.
 */
export function restoredText(database: string, restored: RestoredDatabase | undefined, steps: readonly ActionStep[] | undefined): string | undefined {
  const name = show(database)
  if (!restored) return steps?.length ? `How the restore left ${name} could not be read: check its state in Object Explorer.` : undefined
  if (restored.absent) {
    // Files SQL Server left (filesLeft) are named once, by the backend's error message (RestoreRun.LeftoversNote), not again here.
    const removed = steps?.some(step => step.title === restoreStepTitles.remove && step.status === 'done')
    return `${name} is not on the server${removed ? ': the partly restored database was removed' : ''}.`
  }
  const access = restored.userAccess === 1 ? 'in single-user mode' : restored.userAccess === 2 ? 'with access restricted (RESTRICTED_USER)' : undefined
  if (restored.state === 1) return `${name} is restoring${access ? `, ${access},` : ''} and cannot be used until a restore finishes.`
  const state = ['online', 'restoring', 'recovering', 'recovery pending', 'suspect', 'in emergency mode', 'offline'][restored.state] ?? 'in another state'
  return `${name} is ${state}${access ? `, ${access}` : ''}.`
}

export type RunOutcome = 'done' | 'failed' | 'stopped' | 'unknown'
/** The outcome's headline. */
export function outcomeTitle(outcome: RunOutcome, database: string): string {
  const name = show(database)
  return outcome === 'done' ? `Restored ${name}` : outcome === 'stopped' ? `Stopped restoring ${name}` : outcome === 'failed' ? `Restoring ${name} failed` : `Whether ${name} was restored is not known`
}
/** The outcome from the reply: done, a Stop the backend confirmed (CANCELLED), a failure, or a lost backend or server. */
export function outcomeOf(error: ActionError | undefined, lost: boolean): RunOutcome {
  return lost ? 'unknown' : !error ? 'done' : error.code === 'CANCELLED' ? 'stopped' : 'failed'
}

/** The sections' one-line summaries while a run is on, so the Run panel and the steps stay in view. */
export function sectionSummaries(draft: RestoreDraft, facts: RestoreFacts): { readonly general: string; readonly files: string; readonly options: string } {
  const plan = draftPlan(draft, facts), byId = new Map(sourceSets(draft, facts).map(set => [set.id, set]))
  const sets = plan.ids.flatMap(id => byId.get(id) ?? [])
  const first = sets[0], from = first ? setWhere(first) + (sets.length > 1 ? ` + ${sets.length - 1} more` : '') : sourceDatabase(draft, facts)
  const exists = !!destinationOf(facts, draft.destination)
  const general = `From ${show(from)} · to ${show(draft.destination)}${exists ? '' : ' (new)'} · ${draft.stopAt ? draft.stopAt.replace('T', ' ') : 'the last backup taken'}`
  const rows = fileRows(draft, facts), moved = rows.filter(row => row.typed || draft.relocate).length
  const files = `${draft.relocate ? `Relocated to ${show(draft.dataFolder)}` : moved ? `${moved} moved` : 'Default locations'} · ${plural(rows.length, 'file', 'files')}`
  const tail = tailLogPossible(draft, facts) ? draft.tailLog ? 'tail-log backup on' : 'no tail-log backup' : exists ? 'no tail-log backup possible' : 'no tail-log backup (new database)'
  const options = [...draft.replace ? ['WITH REPLACE'] : [], restoreRecoveryLabels[draft.recovery], tail, ...closesConnections(draft, facts) ? ['closes connections'] : []].join(' · ')
  return { general, files, options }
}
