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
 * The chain for the first of `ends` that has one: a full, a differential with the latest of `fulls` it is based on, or a log
 * back through the sets it continues to the latest base (a differential with its full, or a full). With `limit`, every set
 * before the end finished by it. Bases are tried before logs, as SMO prefers a differential to the logs it covers; a dead end
 * tries the next set. A set that reaches no full is remembered across ends, so each set is searched at most once.
 */
function firstChain(ends: readonly BackupSetRow[], candidates: readonly BackupSetRow[], fulls: readonly BackupSetRow[], limit?: string): BackupSetRow[] | undefined {
  // A log can continue only a predecessor ending in [firstLSN, lastLSN). Searching just that range also leaves
  // equally ranked candidates in input order, as the stable latest-first sort does.
  const byLast = candidates.filter(set => limit === undefined || set.finish <= limit)
    .map(set => ({ set, last: lsn(set.lastLsn) })).sort((a, b) => a.last < b.last ? -1 : a.last > b.last ? 1 : 0)
  const dead = new Set<BackupSetRow>()
  const reversed: BackupSetRow[] = []
  function reach(set: BackupSetRow): boolean {
    if (dead.has(set)) return false
    reversed.push(set)
    if (set.type === 'full') return true
    if (set.type === 'differential') {
      const full = fulls.find(item => basedOn(set, item))
      if (full) { reversed.push(full); return true }
    } else {
      const first = lsn(set.firstLsn), last = lsn(set.lastLsn)
      let low = 0, high = byLast.length
      while (low < high) {
        const mid = (low + high) >> 1
        if (byLast[mid].last < first) low = mid + 1
        else high = mid
      }
      const before: BackupSetRow[] = []
      for (let i = low; i < byLast.length && byLast[i].last < last; i++) {
        const from = byLast[i].set
        if (!dead.has(from) && continues(set, from)) before.push(from)
      }
      // Prefer the latest reachable base, then the latest reachable log. Every step decreases the last LSN.
      before.sort((a, b) => Number(a.type === 'log') - Number(b.type === 'log') || latest(a, b))
      for (const predecessor of before) if (reach(predecessor)) return true
    }
    reversed.pop()
    dead.add(set)
    return false
  }
  return ends.some(reach) ? reversed.reverse() : undefined
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
  const fulls = candidates.filter(set => set.type === 'full' && (point === undefined || set.finish <= point)).sort(latest)
  if (!fulls.length) return none(restoreMessages.noFullBackup)
  if (point === undefined) {
    const chain = firstChain([...candidates].sort(latest), candidates, fulls)
    return chain ? { ids: ids(chain) } : none(restoreMessages.noFullBackup)
  }
  const full = fulls[0]
  const differential = candidates.filter(set => set.type === 'differential' && set.finish <= point && basedOn(set, full)).sort(latest)[0]
  // A point at a base backup's own finish needs no log, and so no STOPAT.
  if ((differential ?? full).finish >= point) return { ids: ids([full, ...differential ? [differential] : []]) }
  const ends = candidates.filter(set => set.type === 'log' && set.finish >= point).sort((a, b) => a.finish < b.finish ? -1 : a.finish > b.finish ? 1 : byLsn(a, b))
  const chain = firstChain(ends, candidates, fulls, point)
  if (chain) return { ids: ids(chain), stopAt: point }
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

/**
 * How a Manual Selection, in restore order, restores to a point: at its last set's finish when that is a full or differential
 * (no STOPAT), or with STOPAT on its last log (reachesPoint); undefined when it cannot.
 */
export function selectionReaches(sets: readonly BackupSetRow[], ids: readonly string[], point: string): 'base' | 'log' | undefined {
  const last = sets.find(set => set.id === ids.at(-1))
  if (last && last.type !== 'log' && last.finish === point) return 'base'
  return reachesPoint(sets, ids, point) ? 'log' : undefined
}
/** The stretch a Manual Selection's last log stops in (reachesPoint's points): from the set before it to the log's finish. */
export function selectionCoverage(sets: readonly BackupSetRow[], ids: readonly string[]): Coverage[] {
  const byId = new Map(sets.map(set => [set.id, set]))
  const last = byId.get(ids.at(-1) ?? ''), before = byId.get(ids.at(-2) ?? '')
  return last?.type === 'log' && before && before.finish <= last.finish ? [{ from: before.finish, to: last.finish }] : []
}

/** The sets that depend on one in a plan: every set after it, which SSMS unchecks with it. */
export function dependants(ids: readonly string[], id: string): string[] {
  const at = ids.indexOf(id)
  return at < 0 ? [] : ids.slice(at + 1)
}

/** One stretch of the timeline a point may be in: from the earliest point a log's chain allows to the log's finish. */
export interface Coverage { readonly from: string; readonly to: string }
/**
 * The Backup Timeline's covered areas: the points planRestore reaches through a log. It restores to a point with the first log
 * finishing at or after it whose chain back to a full has every earlier set finished by the point, so a log covers from the
 * earliest point any of its full-rooted chains allows (the latest finish among that chain's earlier sets) to its own finish; a
 * log that no full reaches (a log missing before it, or the full lost) covers nothing. Touching stretches are merged. Each
 * set's earliest chain is found once, in LSN order, and a log looks only at the sets ending inside its LSN range.
 */
export function logCoverage(sets: readonly BackupSetRow[]): Coverage[] {
  const candidates = sets.filter(usableSet)
  const last = new Map(candidates.map(set => [set, lsn(set.lastLsn)]))
  const byLast = [...candidates].sort((a, b) => { const d = last.get(a)! - last.get(b)!; return d === 0n ? 0 : d < 0n ? -1 : 1 })
  const max = (a: string, b: string) => a > b ? a : b
  // The earliest point a chain ending with each set (itself included) allows: the latest finish in its best chain.
  const reach = new Map<BackupSetRow, string>()
  const fulls = candidates.filter(set => set.type === 'full')
  for (const full of fulls) reach.set(full, full.finish)
  for (const differential of candidates.filter(set => set.type === 'differential')) {
    const base = fulls.filter(full => basedOn(differential, full)).map(full => full.finish).sort()[0]
    if (base !== undefined) reach.set(differential, max(base, differential.finish))
  }
  const stretches: Coverage[] = []
  for (const log of byLast) {
    if (log.type !== 'log') continue
    // The sets a log may continue end in [its first LSN, its last LSN), and come before it in byLast.
    const first = lsn(log.firstLsn), end = last.get(log)!
    let low = 0, high = byLast.length
    while (low < high) { const mid = (low + high) >> 1; if (last.get(byLast[mid])! < first) low = mid + 1; else high = mid }
    let from: string | undefined
    for (let index = low; index < byLast.length && last.get(byLast[index])! < end; index++) {
      const set = byLast[index], allows = reach.get(set)
      if (allows !== undefined && set !== log && continues(log, set) && (from === undefined || allows < from)) from = allows
    }
    if (from === undefined) continue
    reach.set(log, max(from, log.finish))
    if (from <= log.finish) stretches.push({ from, to: log.finish })
  }
  stretches.sort((a, b) => a.from < b.from ? -1 : a.from > b.from ? 1 : 0)
  const merged: Coverage[] = []
  for (const stretch of stretches) {
    const previous = merged[merged.length - 1]
    if (previous && stretch.from <= previous.to) merged[merged.length - 1] = { from: previous.from, to: max(stretch.to, previous.to) }
    else merged.push(stretch)
  }
  return merged
}

/**
 * Whether the Timeline may put its point here: exactly where planRestore has a plan for it. Inside log coverage, or at the
 * finish of the base planRestore takes for the point (the latest full finished by it, or the latest differential of that full).
 * Pass `coverage` (logCoverage of the same sets) to reuse it while the point moves.
 */
export function pointAllowed(sets: readonly BackupSetRow[], point: string, coverage: readonly Coverage[] = logCoverage(sets)): boolean {
  if (coverage.some(stretch => stretch.from <= point && point <= stretch.to)) return true
  const candidates = sets.filter(usableSet)
  const full = candidates.filter(set => set.type === 'full' && set.finish <= point).sort(latest)[0]
  if (!full) return false
  const differential = candidates.filter(set => set.type === 'differential' && set.finish <= point && basedOn(set, full)).sort(latest)[0]
  return (differential ?? full).finish === point
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
  const byFirst: { readonly set: BackupSetRow; readonly first: bigint; readonly last: bigint; readonly forks: boolean; readonly forkPoint?: bigint; readonly order: number; used: boolean }[] = []
  for (let i = 0; i < sets.length; i++) {
    const set = sets[i]
    if (set.type !== 'log' || !usableSet(set)) continue
    const first = lsn(set.firstLsn), last = lsn(set.lastLsn)
    const forks = !!set.firstForkGuid && !!set.forkGuid && set.firstForkGuid !== set.forkGuid
    byFirst.push({ set, first, last, forks, forkPoint: forks && set.forkPointLsn ? lsn(set.forkPointLsn) : undefined, order: i, used: false })
  }
  byFirst.sort((a, b) => a.first < b.first ? -1 : a.first > b.first ? 1 : a.order - b.order)
  const chain: BackupSetRow[] = []
  const active: typeof byFirst = []
  let previous = base, prevLast = lsn(base.lastLsn), cursor = 0
  for (;;) {
    while (cursor < byFirst.length && byFirst[cursor].first <= prevLast) {
      if (byFirst[cursor].last > prevLast) active.push(byFirst[cursor])
      cursor++
    }
    let best: (typeof byFirst)[number] | undefined
    let keep = 0
    for (let i = 0; i < active.length; i++) {
      const entry = active[i]
      if (entry.used || entry.last <= prevLast) continue
      active[keep++] = entry
      const log = entry.set
      if (!sameFamily(log, previous)) continue
      if (log.firstForkGuid && previous.forkGuid && log.firstForkGuid !== previous.forkGuid) continue
      if (entry.forkPoint !== undefined && entry.forkPoint < prevLast) continue
      if (!best || log.finish > best.set.finish || (log.finish === best.set.finish && (entry.last > best.last || (entry.last === best.last && entry.order < best.order)))) best = entry
    }
    active.length = keep
    if (!best) return chain
    best.used = true
    chain.push(best.set)
    previous = best.set
    prevLast = best.last
  }
}
