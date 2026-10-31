// Restore Database's planner (D1e): which backup sets restore a database to its last backup or to a point in time, as
// SMO's DatabaseRestorePlanner chooses them (tests/fixtures/restore/ holds plans SMO made from a live history), whether a
// Manual Selection forms a plan, which sets depend on one, and where the Backup Timeline may put its point. Pure and
// synchronous, so the document answers a Timeline drag or a checkbox at once; the backend never trusts it (D1f's
// RestoreChain re-reads the chosen sets' headers before any statement). Erasable TypeScript.
import { restoreMessages, type BackupSetRow, type PlannedSetType } from './restore.ts'

/** The set id of the tail-log backup the plan restores last when the point is after the last log backup. */
export const tailSetId = 'tail'

/** What to restore to: the last backup taken, or `stopAt` (the server's local time, yyyy-MM-ddTHH:mm:ss); `tailLog` when a tail-log backup is taken first. */
export interface RestoreGoal { readonly stopAt?: string; readonly tailLog?: boolean }
export interface RestorePlan {
  /** The sets to restore, in order; `tail` last when the tail-log backup is restored too. */
  readonly ids: readonly string[]
  /** STOPAT for the last set, when a point was asked and a log reaches it. */
  readonly stopAt?: string
  /** The point is after the last log backup, so only a tail-log backup reaches it. */
  readonly needsTail: boolean
  readonly problem?: string
}

const lsn = (text: string): bigint => { try { return BigInt(text || '0') } catch { return 0n } }
const planned = (set: BackupSetRow): set is BackupSetRow & { readonly type: PlannedSetType } => set.type === 'full' || set.type === 'differential' || set.type === 'log'
/** A set the planner may choose: full, differential or log, readable from disk, not damaged. A copy-only log is never in a
 *  chain: the next log backup starts where it started, so choosing it would break the chain after it. */
const usable = (set: BackupSetRow): boolean => planned(set) && !set.problem && !set.damaged && !(set.type === 'log' && set.copyOnly)
const latest = (a: BackupSetRow, b: BackupSetRow) => a.finish < b.finish ? 1 : a.finish > b.finish ? -1 : lsn(b.lastLsn) > lsn(a.lastLsn) ? 1 : lsn(b.lastLsn) < lsn(a.lastLsn) ? -1 : 0
const byLsn = (a: BackupSetRow, b: BackupSetRow) => { const first = lsn(a.firstLsn) - lsn(b.firstLsn), last = lsn(a.lastLsn) - lsn(b.lastLsn); return first !== 0n ? (first < 0n ? -1 : 1) : last === 0n ? 0 : last < 0n ? -1 : 1 }
/** Whether a log continues from a set: it starts at or before the set's last LSN and ends after it. */
const continues = (log: BackupSetRow, from: BackupSetRow) => lsn(log.firstLsn) <= lsn(from.lastLsn) && lsn(from.lastLsn) < lsn(log.lastLsn)
/** Whether a differential is based on a full: its database_backup_lsn is the full's checkpoint, and it ends after it. */
const basedOn = (differential: BackupSetRow, full: BackupSetRow) => differential.databaseBackupLsn === full.checkpointLsn && lsn(differential.lastLsn) > lsn(full.lastLsn)
/** The next log from a set: one that continues it, preferring one on the same recovery fork. */
function nextLog(logs: readonly BackupSetRow[], from: BackupSetRow): BackupSetRow | undefined {
  const candidates = logs.filter(log => continues(log, from))
  return candidates.find(log => !from.forkGuid || !log.firstForkGuid || log.firstForkGuid === from.forkGuid) ?? candidates[0]
}

/**
 * SMO's plan: the latest full backup that finished by the point, the latest differential based on it that also did,
 * then the logs from the first that continues that base, each continuing the one before, up to the first log that
 * finished at or after the point (which takes STOPAT) or, for the last backup taken, to the end of the chain. A
 * differential that finished after the point is passed over, and the logs it covers restore instead. SMO does that only
 * when a log before the differential reaches the point: for a point between the last log before it and the differential,
 * it restores the differential, which no STOPAT can undo (RestoreLiveChecks restores both). A point past the last log
 * needs the tail-log backup, which then restores last.
 */
export function planRestore(sets: readonly BackupSetRow[], goal: RestoreGoal = {}): RestorePlan {
  const point = goal.stopAt
  const candidates = sets.filter(usable)
  const ends = (set: BackupSetRow) => point === undefined || set.finish <= point
  const full = candidates.filter(set => set.type === 'full' && ends(set)).sort(latest)[0]
  if (!full) return { ids: [], needsTail: false, problem: sets.length === 0 ? restoreMessages.noSets : restoreMessages.noFullBackup }
  const differential = candidates.filter(set => set.type === 'differential' && ends(set) && basedOn(set, full)).sort(latest)[0]
  const logs = candidates.filter(set => set.type === 'log').sort(byLsn)
  const chosen: BackupSetRow[] = [full, ...differential ? [differential] : []]
  let reached = point === undefined || chosen[chosen.length - 1].finish >= point
  while (!reached || point === undefined) {
    const log = nextLog(logs, chosen[chosen.length - 1])
    if (!log || chosen.includes(log)) break
    chosen.push(log)
    if (point !== undefined && log.finish >= point) reached = true
  }
  const ids = chosen.map(set => set.id)
  if (reached) {
    // A point at a base backup's own finish needs no log, and so no STOPAT.
    const stopAt = point !== undefined && chosen[chosen.length - 1].type === 'log' ? point : undefined
    return { ids, ...stopAt ? { stopAt } : {}, needsTail: false }
  }
  if (goal.tailLog) return { ids: [...ids, tailSetId], stopAt: point, needsTail: true }
  return { ids, needsTail: true, problem: restoreMessages.afterLastBackup }
}

/** Manual Selection's sets in the order they restore: the full, a differential, then the logs by LSN; the tail-log backup last. */
export function orderSelection(sets: readonly BackupSetRow[], ids: readonly string[]): string[] {
  const rank = (set: BackupSetRow) => set.type === 'full' ? 0 : set.type === 'differential' ? 1 : 2
  const chosen = sets.filter(set => ids.includes(set.id)).sort((a, b) => rank(a) - rank(b) || byLsn(a, b))
  return [...chosen.map(set => set.id), ...ids.includes(tailSetId) ? [tailSetId] : []]
}

/** Why the sets checked under Manual Selection, in restore order, do not form a plan, or undefined. */
export function selectionProblem(sets: readonly BackupSetRow[], ids: readonly string[]): string | undefined {
  const byId = new Map(sets.map(set => [set.id, set]))
  const chosen = ids.filter(id => id !== tailSetId).map(id => byId.get(id))
  if (chosen.length === 0 || chosen.some(set => !set || !usable(set))) return chosen.find(set => set?.problem)?.problem ?? restoreMessages.invalidPlan
  const [full, ...rest] = chosen as BackupSetRow[]
  if (full.type !== 'full') return restoreMessages.invalidPlan
  let previous = full
  for (const [index, set] of rest.entries()) {
    const fits = set.type === 'differential' ? index === 0 && basedOn(set, full) : set.type === 'log' && continues(set, previous)
    if (!fits) return restoreMessages.invalidPlan
    previous = set
  }
  if (ids.includes(tailSetId) && ids[ids.length - 1] !== tailSetId) return restoreMessages.invalidPlan
  return undefined
}

/** The sets that depend on one in a plan: every set after it, which SSMS unchecks with it. */
export function dependants(ids: readonly string[], id: string): string[] {
  const at = ids.indexOf(id)
  return at < 0 ? [] : ids.slice(at + 1)
}

/** One stretch of the timeline a point may be in: from the finish of a backup to the finish of the last log continuing it. */
export interface Coverage { readonly from: string; readonly to: string }
/**
 * The Backup Timeline's green areas: where log backups cover, each log from the earliest finish of the sets it continues
 * (a full, differential or log: a log after a differential also continues the log before it) to its own finish, touching stretches merged. A point is allowed inside them, and at a full or
 * differential backup's finish.
 */
export function logCoverage(sets: readonly BackupSetRow[]): Coverage[] {
  const candidates = sets.filter(usable)
  const stretches = candidates.filter(set => set.type === 'log').flatMap(log => {
    const from = candidates.filter(set => set !== log && continues(log, set) && set.finish <= log.finish).sort(latest).at(-1)
    return from ? [{ from: from.finish, to: log.finish }] : []
  }).sort((a, b) => a.from < b.from ? -1 : a.from > b.from ? 1 : 0)
  const merged: Coverage[] = []
  for (const stretch of stretches) {
    const last = merged[merged.length - 1]
    if (last && stretch.from <= last.to) merged[merged.length - 1] = { from: last.from, to: stretch.to > last.to ? stretch.to : last.to }
    else merged.push(stretch)
  }
  return merged
}

/** Whether the Timeline may put its point here: inside log coverage, or at a full or differential backup's finish. */
export function pointAllowed(sets: readonly BackupSetRow[], point: string): boolean {
  return logCoverage(sets).some(stretch => stretch.from <= point && point <= stretch.to)
    || sets.some(set => usable(set) && set.type !== 'log' && set.finish === point)
}

/** The last backup taken: the finish of the plan's last set. */
export function lastBackupTaken(sets: readonly BackupSetRow[], ids: readonly string[]): string | undefined {
  const last = sets.find(set => set.id === ids.filter(id => id !== tailSetId).at(-1))
  return last?.finish
}
