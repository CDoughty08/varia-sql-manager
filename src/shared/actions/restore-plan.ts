// Restore Database's planner (D1e): which backup sets restore a database to its last backup or to a point in time, as
// SMO's DatabaseRestorePlanner chooses them (tests/fixtures/restore/ holds plans SMO made from a live history), whether a
// Manual Selection forms a plan, which sets depend on one, and where the Backup Timeline may put its point. Pure and
// synchronous, so the document answers a Timeline drag or a checkbox at once; the backend never trusts it (D1f's
// RestoreChain re-reads the chosen sets' headers before any statement). Erasable TypeScript.
import { restoreMessages, type BackupSetRow, type PlannedSetType } from './restore.ts'

/** What to restore to: the last backup taken, or `stopAt` (the server's local time, yyyy-MM-ddTHH:mm:ss). */
export interface RestoreGoal { readonly stopAt?: string }
export interface RestorePlan {
  /** The sets to restore, in order. */
  readonly ids: readonly string[]
  /** STOPAT for the last set, when a point was asked and a log reaches it. */
  readonly stopAt?: string
  readonly problem?: string
}

const lsn = (text: string | undefined): bigint => { try { return BigInt(text || '0') } catch { return 0n } }
const planned = (set: BackupSetRow): set is BackupSetRow & { readonly type: PlannedSetType } => set.type === 'full' || set.type === 'differential' || set.type === 'log'
/** A set the planner may choose: full, differential or log, readable from disk, not damaged. A copy-only log is never in a
 *  chain: the next log backup starts where it started, so choosing it would break the chain after it. */
export const usableSet = (set: BackupSetRow): boolean => planned(set) && !set.problem && !set.damaged && !(set.type === 'log' && set.copyOnly)
/** Newest first: by finish, then by last LSN. */
const latest = (a: BackupSetRow, b: BackupSetRow) => a.finish < b.finish ? 1 : a.finish > b.finish ? -1 : lsn(b.lastLsn) > lsn(a.lastLsn) ? 1 : lsn(b.lastLsn) < lsn(a.lastLsn) ? -1 : 0
const byLsn = (a: BackupSetRow, b: BackupSetRow) => { const first = lsn(a.firstLsn) - lsn(b.firstLsn), last = lsn(a.lastLsn) - lsn(b.lastLsn); return first !== 0n ? (first < 0n ? -1 : 1) : last === 0n ? 0 : last < 0n ? -1 : 1 }
/** Two sets of one database: LSNs of different databases overlap, so a chain never crosses families (when both are known). */
const sameFamily = (a: BackupSetRow, b: BackupSetRow) => !a.familyGuid || !b.familyGuid || a.familyGuid === b.familyGuid
/**
 * Whether a log continues from a set: it starts at or before the set's last LSN and ends after it, in the same family, and on
 * the set's recovery fork. A restore to a point in time forks the log: the next log starts on the old fork and forks inside
 * itself (first fork ≠ last fork) at the fork point, so it continues only a set that ends at or before that point; a set that
 * ends after it holds log the fork abandoned, and restoring both fails (as SMO's planner checks; RestoreLiveChecks restores both).
 */
export function continues(log: BackupSetRow, from: BackupSetRow): boolean {
  if (!(lsn(log.firstLsn) <= lsn(from.lastLsn) && lsn(from.lastLsn) < lsn(log.lastLsn)) || !sameFamily(log, from)) return false
  if (log.firstForkGuid && from.forkGuid && log.firstForkGuid !== from.forkGuid) return false
  const forks = !!log.firstForkGuid && !!log.forkGuid && log.firstForkGuid !== log.forkGuid
  return !(forks && log.forkPointLsn && lsn(log.forkPointLsn) < lsn(from.lastLsn))
}
/** Whether a differential is based on a full: its database_backup_lsn is the full's checkpoint, and it ends after it. */
const basedOn = (differential: BackupSetRow, full: BackupSetRow) => differential.databaseBackupLsn === full.checkpointLsn && lsn(differential.lastLsn) > lsn(full.lastLsn) && sameFamily(differential, full)

/**
 * The chain that ends with a set: a full, a differential with the latest full it is based on, or a log back through the sets
 * it continues to the latest base (a differential with its full, or a full). With `limit`, every set before the end finished
 * by it. Bases are tried before logs, as SMO prefers a differential to the logs it covers; a dead end tries the next set.
 */
function chainTo(end: BackupSetRow, candidates: readonly BackupSetRow[], limit?: string): BackupSetRow[] | undefined {
  const fits = (set: BackupSetRow) => limit === undefined || set.finish <= limit
  const fulls = candidates.filter(set => set.type === 'full').sort(latest)
  const base = (set: BackupSetRow): BackupSetRow[] | undefined => {
    if (set.type === 'full') return [set]
    const full = fulls.find(item => basedOn(set, item) && fits(item))
    return full ? [full, set] : undefined
  }
  if (end.type !== 'log') return base(end)
  const dead = new Set<BackupSetRow>()
  const walk = (current: BackupSetRow, depth: number): BackupSetRow[] | undefined => {
    if (dead.has(current) || depth > candidates.length) return undefined
    const before = candidates.filter(set => set !== current && fits(set) && continues(current, set)).sort(latest)
    for (const set of [...before.filter(item => item.type !== 'log'), ...before.filter(item => item.type === 'log')]) {
      const chain = set.type === 'log' ? walk(set, depth + 1) : base(set)
      if (chain) return [...chain, current]
    }
    dead.add(current)
    return undefined
  }
  return walk(end, 0)
}

/**
 * SMO's plan, built backwards from its end as SMO builds it, so a fork's abandoned branch is never in it. For the last backup
 * taken, the newest set back to the latest base it continues. For a point, the latest full that finished by it and the latest
 * differential based on that full that did, when one ends at the point (no log, no STOPAT); otherwise the first log that
 * finishes at or after the point (which takes STOPAT), back through sets that finished by the point to the latest base. A
 * differential that finished after the point is passed over, and the logs it covers restore instead. SMO does that only when
 * a log before the differential reaches the point: for a point between the last log before it and the differential, it
 * restores the differential, which no STOPAT can undo (RestoreLiveChecks restores both). A point past the last log has no plan
 * here: restoring a tail-log backup taken first is D1f's.
 */
export function planRestore(sets: readonly BackupSetRow[], goal: RestoreGoal = {}): RestorePlan {
  const point = goal.stopAt
  const candidates = sets.filter(usableSet)
  const none = (problem: string): RestorePlan => ({ ids: [], problem: sets.length === 0 ? restoreMessages.noSets : problem })
  const ids = (chain: readonly BackupSetRow[]) => chain.map(set => set.id)
  if (point === undefined) {
    for (const end of [...candidates].sort(latest)) { const chain = chainTo(end, candidates); if (chain) return { ids: ids(chain) } }
    return none(restoreMessages.noFullBackup)
  }
  const full = candidates.filter(set => set.type === 'full' && set.finish <= point).sort(latest)[0]
  if (!full) return none(restoreMessages.noFullBackup)
  const differential = candidates.filter(set => set.type === 'differential' && set.finish <= point && basedOn(set, full)).sort(latest)[0]
  // A point at a base backup's own finish needs no log, and so no STOPAT.
  if ((differential ?? full).finish >= point) return { ids: ids([full, ...differential ? [differential] : []]) }
  const ends = candidates.filter(set => set.type === 'log' && set.finish >= point).sort((a, b) => a.finish < b.finish ? -1 : a.finish > b.finish ? 1 : byLsn(a, b))
  for (const end of ends) { const chain = chainTo(end, candidates, point); if (chain) return { ids: ids(chain), stopAt: point } }
  return none(candidates.every(set => set.finish < point) ? restoreMessages.afterLastBackup : restoreMessages.noFullBackup)
}

/** Manual Selection's sets in the order they restore: the full, a differential, then the logs by LSN. */
export function orderSelection(sets: readonly BackupSetRow[], ids: readonly string[]): string[] {
  const rank = (set: BackupSetRow) => set.type === 'full' ? 0 : set.type === 'differential' ? 1 : 2
  return sets.filter(set => ids.includes(set.id)).sort((a, b) => rank(a) - rank(b) || byLsn(a, b)).map(set => set.id)
}

/** Why the sets checked under Manual Selection, in restore order, do not form a plan, or undefined. */
export function selectionProblem(sets: readonly BackupSetRow[], ids: readonly string[]): string | undefined {
  const byId = new Map(sets.map(set => [set.id, set]))
  const chosen = ids.map(id => byId.get(id))
  if (chosen.length === 0 || chosen.some(set => !set || !usableSet(set))) return chosen.find(set => set?.problem)?.problem ?? restoreMessages.invalidPlan
  const [full, ...rest] = chosen as BackupSetRow[]
  if (full.type !== 'full') return restoreMessages.invalidPlan
  let previous = full
  for (const [index, set] of rest.entries()) {
    const fits = set.type === 'differential' ? index === 0 && basedOn(set, full) : set.type === 'log' && continues(set, previous)
    if (!fits) return restoreMessages.invalidPlan
    previous = set
  }
  return undefined
}

/** Whether a plan, in restore order, stops at a point: its last set is a log that finishes at or after it, and the set before finished by it. */
export function reachesPoint(sets: readonly BackupSetRow[], ids: readonly string[], point: string): boolean {
  const byId = new Map(sets.map(set => [set.id, set]))
  const last = byId.get(ids.at(-1) ?? ''), before = byId.get(ids.at(-2) ?? '')
  return last?.type === 'log' && last.finish >= point && !!before && before.finish <= point
}

/** The sets that depend on one in a plan: every set after it, which SSMS unchecks with it. */
export function dependants(ids: readonly string[], id: string): string[] {
  const at = ids.indexOf(id)
  return at < 0 ? [] : ids.slice(at + 1)
}

/** One stretch of the timeline a point may be in: from the finish of a backup to the finish of the last log continuing it. */
export interface Coverage { readonly from: string; readonly to: string }
/**
 * The Backup Timeline's covered areas: where log backups cover, each log from the earliest finish of the sets it continues
 * (a full, differential or log: a log after a differential also continues the log before it) to its own finish, touching
 * stretches merged. A point is allowed inside them, and at a full or differential backup's finish.
 */
export function logCoverage(sets: readonly BackupSetRow[]): Coverage[] {
  const candidates = sets.filter(usableSet)
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
    || sets.some(set => usableSet(set) && set.type !== 'log' && set.finish === point)
}

/** The last backup taken: the finish of the plan's last set. */
export function lastBackupTaken(sets: readonly BackupSetRow[], ids: readonly string[]): string | undefined {
  return sets.find(set => set.id === ids.at(-1))?.finish
}

// --- Restore Files and Filegroups (D1g) ---------------------------------------------------------------------------------

/** A set files restore from: a full or file backup on disk, not damaged. */
export const fileBaseSet = (set: BackupSetRow): boolean => (set.type === 'full' || set.type === 'file') && !set.problem && !set.damaged
/** The sets files can restore from, newest first, at most `limit`: the document reads each one's files. */
export function fileBaseSets(sets: readonly BackupSetRow[], limit: number): BackupSetRow[] {
  return sets.filter(fileBaseSet).sort(latest).slice(0, limit)
}
/**
 * The log backups that restore after a file restore from `base`, in order: from the base, each next log that continues the set
 * before it (the newest when a fork offers two), until none does. A file restore rolls its files forward through every log there
 * is, so the person does not choose them (SSMS's grid checks them); copy-only and damaged logs never chain.
 */
export function fileRestoreLogs(sets: readonly BackupSetRow[], base: BackupSetRow): BackupSetRow[] {
  const logs = sets.filter(set => set.type === 'log' && usableSet(set))
  const chain: BackupSetRow[] = []
  let previous = base
  for (;;) {
    const next = logs.filter(log => !chain.includes(log) && continues(log, previous)).sort(latest)[0]
    if (!next) return chain
    chain.push(next)
    previous = next
  }
}
