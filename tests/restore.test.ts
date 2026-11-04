import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { validateRequest } from '../src/main/validation'
import { deadlineFor, restoreDescribeDeadlineMs } from '../src/shared/ipc/methods'
import { actionLimits } from '../src/shared/actions/catalog'
import type { ActionDescribeRequest } from '../src/shared/actions/schema'
import {
  backupSetTypeSpecs, fileNamePart, fileStamp, pathFileName, restoreAsPath, restoreLimits, restoreMessages, restoreTargetProblem, standbyFile, tailLogFile, type BackupSetRow, type RestoreOptions
} from '../src/shared/actions/restore'
import { dependants, lastBackupTaken, logCoverage, orderSelection, planRestore, pointAllowed, reachesPoint, selectionProblem } from '../src/shared/actions/restore-plan'
import { restoreOptionsProblems, restoreRequestSchema, restoreSourceSchema } from '../src/shared/actions/restore-schema'
import { serverPathProblem } from '../src/shared/actions/files'

const ids = { connectionId: '00000000-0000-4000-8000-000000000001', requestId: '00000000-0000-4000-8000-000000000002' }
const row = (id: string, name: string, type: BackupSetRow['type'], position: number, first: string, last: string, checkpoint: string, base: string, finish: string, devices: string[], extra: Partial<BackupSetRow> = {}): BackupSetRow => ({
  id, name, type, server: 'SQLHOST', database: 'Sales', position, firstLsn: first, lastLsn: last, checkpointLsn: checkpoint, databaseBackupLsn: base,
  start: `2026-10-29T${finish}`, finish: `2026-10-29T${finish}`, sizeBytes: 1024, userName: 'CONTOSO\\dba', copyOnly: false, damaged: false, devices, ...extra
})
// The D1 probe's history (SQL Server 2025): a full, two logs in one file, a differential, and a third log in that file.
const full = row('1:1', 'full', 'full', 1, '43200001', '45600001', '43200001', '0', '21:05:40', ['C:\\B\\full.bak'])
const log1 = row('2:1', 'log1', 'log', 1, '43200001', '51200001', '51200001', '43200001', '21:05:41', ['C:\\B\\log.trn'])
const log2 = row('2:2', 'log2', 'log', 2, '51200001', '56800001', '56800001', '43200001', '21:05:44', ['C:\\B\\log.trn'])
const diff = row('3:1', 'diff', 'differential', 1, '56800001', '68000001', '68000001', '43200001', '21:05:45', ['C:\\B\\diff.bak'])
const log3 = row('2:3', 'log3', 'log', 3, '56800001', '68800001', '68800001', '43200001', '21:05:46', ['C:\\B\\log.trn'])
const probe = [log3, diff, log2, log1, full]

describe('the restore planner', () => {
  it('chooses the sets SMO chooses on the probed history', () => {
    expect(planRestore(probe)).toEqual({ ids: ['1:1', '3:1', '2:3'] })
    expect(planRestore(probe, { stopAt: '2026-10-29T21:05:43' })).toEqual({ ids: ['1:1', '2:1', '2:2'], stopAt: '2026-10-29T21:05:43' })
    // A point at the differential's own finish needs no log, and so no STOPAT; one after it takes the log that reaches it.
    expect(planRestore(probe, { stopAt: '2026-10-29T21:05:45' })).toEqual({ ids: ['1:1', '3:1'] })
    expect(planRestore(probe, { stopAt: '2026-10-29T21:05:46' })).toEqual({ ids: ['1:1', '3:1', '2:3'], stopAt: '2026-10-29T21:05:46' })
  })
  it('has no plan for a point past the last log (the tail-log restore is D1f\'s), nor without a full backup before the point', () => {
    expect(planRestore(probe, { stopAt: '2026-10-29T21:06:00' })).toEqual({ ids: [], problem: restoreMessages.afterLastBackup })
    expect(planRestore(probe, { stopAt: '2026-10-29T21:05:39' })).toMatchObject({ ids: [], problem: restoreMessages.noFullBackup })
    expect(planRestore([])).toMatchObject({ ids: [], problem: restoreMessages.noSets })
  })
  // A restore to a point inside log2 (LSN 4000) forked the log; log3 starts on the old fork and forks at 4000, so it continues
  // log1 (ending at 3000) but not log2 (ending at 5000, past the fork): F, l1, l2, l3 cannot restore (3013), F, l1, l3 can.
  const fork = (id: string, name: string, type: BackupSetRow['type'], first: string, last: string, checkpoint: string, base: string, finish: string, forks: [string, string, string?]) =>
    row(id, name, type, 1, first, last, checkpoint, base, finish, [`C:\\B\\${name}.bak`], { firstForkGuid: forks[0], forkGuid: forks[1], ...forks[2] ? { forkPointLsn: forks[2] } : {}, familyGuid: 'f0000000-0000-4000-8000-000000000001' })
  const [forkA, forkB] = ['a0000000-0000-4000-8000-00000000000a', 'b0000000-0000-4000-8000-00000000000b']
  const forked = [
    fork('f', 'full', 'full', '1000', '2000', '1000', '0', '22:00:00', [forkA, forkA]),
    fork('l1', 'l1', 'log', '1000', '3000', '1000', '1000', '22:01:00', [forkA, forkA]),
    fork('l2', 'l2', 'log', '3000', '5000', '1000', '1000', '22:02:00', [forkA, forkA]),
    fork('l3', 'l3', 'log', '3000', '6000', '1000', '1000', '22:05:00', [forkA, forkB, '4000'])
  ]
  it('follows the recovery fork a restore to a point in time made, never the abandoned branch', () => {
    expect(planRestore(forked)).toEqual({ ids: ['f', 'l1', 'l3'] })
    expect(lastBackupTaken(forked, planRestore(forked).ids)).toBe('2026-10-29T22:05:00')
    expect(planRestore(forked, { stopAt: '2026-10-29T22:04:00' })).toEqual({ ids: ['f', 'l1', 'l3'], stopAt: '2026-10-29T22:04:00' })
    // A point before the abandoned branch's end, which only log2 finished after, restores it.
    expect(planRestore(forked, { stopAt: '2026-10-29T22:01:30' })).toEqual({ ids: ['f', 'l1', 'l2'], stopAt: '2026-10-29T22:01:30' })
    expect(selectionProblem(forked, ['f', 'l1', 'l2', 'l3'])).toBe(restoreMessages.invalidPlan)
    expect(selectionProblem(forked, ['f', 'l1', 'l3'])).toBeUndefined()
    expect(orderSelection(forked, ['l3', 'f', 'l1'])).toEqual(['f', 'l1', 'l3'])
    expect(logCoverage(forked)).toEqual([{ from: '2026-10-29T22:00:00', to: '2026-10-29T22:05:00' }])
    // Without fork facts (an older fixture), LSNs alone chain them.
    const bare = forked.map(({ firstForkGuid: _first, forkGuid: _fork, forkPointLsn: _point, ...set }) => set)
    expect(planRestore(bare).ids).toEqual(['f', 'l1', 'l2', 'l3'])
  })
  it('never chains sets of two databases whose LSNs overlap (family_guid)', () => {
    const family = (guid: string, database: string) => ({ familyGuid: guid, database })
    const sales = family('50000000-0000-4000-8000-000000000005', 'Sales'), hr = family('60000000-0000-4000-8000-000000000006', 'HR')
    const media = [
      row('1:1', 'Sales full', 'full', 1, '1000', '2000', '1000', '0', '20:00:00', ['C:\\B\\mixed.bak'], sales),
      row('1:2', 'HR full', 'full', 2, '1500', '2500', '1500', '0', '20:05:00', ['C:\\B\\mixed.bak'], hr),
      row('1:3', 'Sales log', 'log', 3, '1000', '3000', '1000', '1000', '20:10:00', ['C:\\B\\mixed.bak'], sales)
    ]
    expect(planRestore(media)).toEqual({ ids: ['1:1', '1:3'] })
    expect(selectionProblem(media, ['1:2', '1:3'])).toBe(restoreMessages.invalidPlan)
    expect(planRestore(media.slice(0, 2))).toEqual({ ids: ['1:2'] })
  })
  it('says whether a selection stops at a point', () => {
    expect(reachesPoint(probe, ['1:1', '2:1', '2:2'], '2026-10-29T21:05:43')).toBe(true)
    expect(reachesPoint(probe, ['1:1', '2:1', '2:2'], '2026-10-29T21:05:41')).toBe(true)
    expect(reachesPoint(probe, ['1:1', '2:1', '2:2'], '2026-10-29T21:05:40')).toBe(false)
    expect(reachesPoint(probe, ['1:1', '2:1', '2:2'], '2026-10-29T21:05:45')).toBe(false)
    expect(reachesPoint(probe, ['1:1', '2:1'], '2026-10-29T21:05:43')).toBe(false)
    expect(reachesPoint(probe, ['1:1'], '2026-10-29T21:05:40')).toBe(false)
  })
  it('passes over sets it cannot restore: copy-only logs, damaged sets, missing stripes, other kinds', () => {
    const copy = row('4:1', 'copy', 'log', 1, '68800001', '69600001', '69600001', '43200001', '21:05:47', ['C:\\B\\copy.trn'], { copyOnly: true })
    expect(planRestore([...probe, copy]).ids).toEqual(['1:1', '3:1', '2:3'])
    expect(planRestore([{ ...diff, damaged: true }, ...probe.filter(set => set !== diff)]).ids).toEqual(['1:1', '2:1', '2:2', '2:3'])
    expect(planRestore([{ ...full, problem: 'This backup set is striped across 2 files; add the missing ones.' }, log1]).problem).toBe(restoreMessages.noFullBackup)
    const file = row('5:1', 'file', 'file', 1, '43200001', '45600001', '43200001', '0', '21:05:48', ['C:\\B\\f.bak'])
    expect(planRestore([file, ...probe]).ids).toEqual(['1:1', '3:1', '2:3'])
    // A differential of another full is not based on this one.
    expect(planRestore([{ ...diff, databaseBackupLsn: '99' }, ...probe.filter(set => set !== diff)]).ids).toEqual(['1:1', '2:1', '2:2', '2:3'])
  })
  it('orders and checks a Manual Selection', () => {
    expect(orderSelection(probe, ['2:3', '3:1', '1:1'])).toEqual(['1:1', '3:1', '2:3'])
    expect(orderSelection(probe, ['2:2', '2:1', '1:1'])).toEqual(['1:1', '2:1', '2:2'])
    expect(selectionProblem(probe, ['1:1', '3:1', '2:3'])).toBeUndefined()
    expect(selectionProblem(probe, ['1:1', '2:1', '2:2', '2:3'])).toBeUndefined()
    for (const selection of [['1:1', '2:2'], ['2:1', '2:2'], ['1:1', '2:1', '3:1'], [], ['1:1', 'tail', '2:1'], ['1:1', 'missing']])
      expect(selectionProblem(probe, selection), selection.join()).toBe(restoreMessages.invalidPlan)
    expect(selectionProblem([{ ...full, problem: restoreMessages.notDisk }], ['1:1'])).toBe(restoreMessages.notDisk)
    expect(dependants(['1:1', '3:1', '2:3'], '3:1')).toEqual(['2:3'])
    expect(dependants(['1:1', '3:1', '2:3'], 'x')).toEqual([])
  })
  it('gives the Timeline its log coverage and allowed points', () => {
    expect(logCoverage(probe)).toEqual([{ from: '2026-10-29T21:05:40', to: '2026-10-29T21:05:46' }])
    expect(pointAllowed(probe, '2026-10-29T21:05:42')).toBe(true)
    expect(pointAllowed(probe, '2026-10-29T21:05:39')).toBe(false)
    expect(pointAllowed(probe, '2026-10-29T21:05:47')).toBe(false)
    expect(pointAllowed([full], '2026-10-29T21:05:40')).toBe(true)
    expect(lastBackupTaken(probe, ['1:1', '3:1', '2:3'])).toBe('2026-10-29T21:05:46')
    expect(lastBackupTaken(probe, [])).toBeUndefined()
  })
})

interface SmoFixture { readonly history: BackupSetRow[]; readonly media: BackupSetRow[]; readonly plans: { goal: string; stopAt: string | null; names: string[]; varia: string[] }[] }
const fixturePath = 'tests/fixtures/restore/smo-plans.json'
const forkPath = 'tests/fixtures/restore/smo-fork.json'

describe('the restore planner against SMO', () => {
  // RestoreLiveChecks holds the fixture's `names` to SMO's choices on the server and restores each `varia` plan, proving it reaches its point.
  it(`chooses what SMO's DatabaseRestorePlanner chose on a live history (${fixturePath}), but a differential taken after the point`, () => {
    expect(existsSync(fixturePath)).toBe(true)
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as SmoFixture
    expect(fixture.plans.map(plan => plan.goal)).toEqual(['last backup', 'between log1 and log2', 'between log2 and the differential', 'between the differential and log3'])
    for (const sets of [fixture.history, fixture.media]) {
      const byName = (name: string) => sets.find(set => set.name === name)?.id
      for (const plan of fixture.plans) {
        const goal = plan.stopAt === null ? {} : { stopAt: plan.stopAt }
        expect(planRestore(sets, goal).ids, plan.goal).toEqual(plan.varia.map(byName))
        expect(selectionProblem(sets, plan.varia.map(name => byName(name)!)), plan.goal).toBeUndefined()
      }
      // The striped full lists both of its files, in family order, from msdb and from the media alike.
      expect(sets.find(set => set.name === 'full')?.devices).toEqual(['C:\\Backup\\Sales_full1.bak', 'C:\\Backup\\Sales_full2.bak'])
    }
    expect(fixture.media.map(set => set.id)).toEqual(['1:1', '1:2', '2:1', '3:1', '4:1'])
    // Only there does the planner part from SMO, whose differential ends after the point.
    expect(fixture.plans.filter(plan => plan.varia.join() !== plan.names.join()).map(plan => [plan.goal, plan.names.join()])).toEqual([['between log2 and the differential', 'full,diff,log3']])
  })
  // RestoreLiveChecks forks a live history (full, log1, log2, a restore to a point inside log2, log3), records it, and restores
  // `varia` (ONLINE with every row) and the abandoned branch's plan (which fails).
  it(`follows the fork a live restore to a point in time made (${forkPath})`, () => {
    expect(existsSync(forkPath)).toBe(true)
    const fixture = JSON.parse(readFileSync(forkPath, 'utf8')) as SmoFixture
    const l3 = fixture.history.find(set => set.name === 'log3')!
    expect(l3.firstForkGuid).not.toBe(l3.forkGuid)
    expect(l3.forkPointLsn).toEqual(expect.any(String))
    expect(fixture.plans.map(plan => plan.goal)).toEqual(['last backup', 'after the restore'])
    for (const sets of [fixture.history, fixture.media]) {
      const byName = (name: string) => sets.find(set => set.name === name)?.id
      for (const plan of fixture.plans) {
        expect(plan.varia).toEqual(['full', 'log1', 'log3'])
        expect(planRestore(sets, plan.stopAt === null ? {} : { stopAt: plan.stopAt }).ids, plan.goal).toEqual(plan.varia.map(byName))
      }
      expect(selectionProblem(sets, ['full', 'log1', 'log2', 'log3'].map(name => byName(name)!))).toBe(restoreMessages.invalidPlan)
    }
  })
})

describe('restore requests', () => {
  const set = { id: '1:1', devices: ['C:\\Backup\\Sales.bak'], file: 1, type: 'full' as const }
  const options: RestoreOptions = { sets: [set, { ...set, id: '1:2', file: 2, type: 'log' }], relocate: [], replace: false, keepReplication: false, restrictedUser: false, recovery: 'recovery', closeConnections: false }
  const request = { action: 'restore', ...ids, target: { kind: 'database', name: 'Sales' }, restore: options }
  it('passes main and the backend the same shapes', () => {
    expect(validateRequest('actions.script', request)).toEqual(request)
    const hostile = { ...request, target: { kind: 'database', name: "a]b'c; DROP DATABASE x --" }, identity: { id: 5, created: '2026-10-29T21:05:43.123' },
      restore: { ...options, stopAt: '2026-10-29T21:05:43', relocate: [{ logical: "l'o]g", physical: '/var/opt/mssql/data/x\'y.ldf' }], recovery: 'standby', standbyFile: '\\\\files\\share\\u.bak',
        tailLog: { file: 'C:\\Backup\\t.bak', noRecovery: true }, closeConnections: true, replace: true, restrictedUser: true } }
    expect(validateRequest('actions.script', hostile)).toEqual(hostile)
    // actions.execute takes the same restore (D1f), and refuses what actions.script refuses.
    expect(validateRequest('actions.execute', hostile)).toEqual(hostile)
    expect(() => validateRequest('actions.execute', { ...request, restore: { ...options, sets: [] } })).toThrow('Invalid request')
    // In any case: a case-insensitive server, the default, takes MSDB for msdb.
    for (const name of ['master', 'model', 'msdb', 'tempdb', 'MSDB', 'Master', 'Model', 'TempDB']) {
      expect(() => validateRequest('actions.script', { ...request, target: { kind: 'database', name } }), name).toThrow('Invalid request')
      expect(restoreRequestSchema.safeParse({ ...request, target: { kind: 'database', name } }).error?.issues[0].message).toBe(restoreMessages.systemDatabase)
    }
    expect(restoreTargetProblem('Sales')).toBeUndefined()
    for (const value of [
      { ...request, restore: { ...options, sets: [] } }, { ...request, restore: { ...options, sets: [options.sets[1]] } }, { ...request, restore: { ...options, sets: [set, set] } },
      { ...request, restore: { ...options, stopAt: '2026-10-29 21:05:43' } }, { ...request, restore: { ...options, sets: [set], stopAt: '2026-10-29T21:05:43' } },
      { ...request, restore: { ...options, recovery: 'standby' } }, { ...request, restore: { ...options, standbyFile: 'C:\\u.bak' } }, { ...request, restore: { ...options, recovery: 'norecovery', keepReplication: true } },
      { ...request, restore: { ...options, relocate: [{ logical: 'a', physical: 'C:\\a.mdf' }, { logical: 'b', physical: 'c:\\A.MDF' }] } },
      { ...request, restore: { ...options, relocate: [{ logical: 'a', physical: 'a.mdf' }] } }, { ...request, restore: { ...options, tailLog: { file: 'C:\\t.bak' } } },
      { ...request, restore: { ...options, sets: [{ ...set, devices: Array(65).fill('C:\\a.bak') }] } }, { ...request, restore: { ...options, sets: [{ ...set, id: 'x' }] } },
      { ...request, restore: { ...options, sets: [{ ...set, type: 'file' }] } }, { ...request, restore: { ...options, extra: 1 } }, { ...request, newName: 'x' },
      { ...request, target: { kind: 'database', database: 'x', name: 'Sales' } }, { ...request, identity: { id: 0, created: '2026-10-29T21:05:43.000' } },
      { ...request, restore: { ...options, relocate: Array.from({ length: restoreLimits.restoreMoves + 1 }, (_, index) => ({ logical: `f${index}`, physical: `C:\\f${index}.mdf` })) } }
    ]) expect(() => validateRequest('actions.script', value), JSON.stringify(value).slice(0, 160)).toThrow('Invalid request')
    expect(restoreOptionsProblems({ ...options, recovery: 'norecovery', keepReplication: true }).map(problem => problem.path)).toEqual(['keepReplication'])
  })
  it('reads the backups through actions.describe under a 130 s deadline around the backend\'s 120 s budget (critic A2)', () => {
    const describe = { ...ids, dialog: 'restoreDatabase', target: { kind: 'server' } }
    for (const restore of [{ kind: 'history' }, { kind: 'history', database: "a]b'c" }, { kind: 'devices', devices: ['C:\\Backup\\a.bak', '/var/opt/mssql/b.bak'] },
      { kind: 'historyFiles', setId: 'abcdef00-0000-4000-8000-000000000000' }, { kind: 'mediaFiles', devices: ['C:\\a.bak'], file: 32_767 }]) {
      expect(validateRequest('actions.describe', { ...describe, restore })).toEqual({ ...describe, restore })
      expect(restoreSourceSchema.safeParse(restore).success).toBe(true)
    }
    for (const value of [
      describe, { ...describe, restore: { kind: 'tape' } }, { ...describe, restore: { kind: 'devices', devices: [] } }, { ...describe, restore: { kind: 'devices', devices: ['x.bak'] } },
      { ...describe, restore: { kind: 'devices', devices: Array(65).fill('C:\\a.bak') } }, { ...describe, restore: { kind: 'historyFiles', setId: 'ABCDEF00-0000-4000-8000-000000000000' } },
      { ...describe, restore: { kind: 'mediaFiles', devices: ['C:\\a.bak'], file: 0 } }, { ...describe, restore: { kind: 'history', file: 1 } },
      { ...describe, target: { kind: 'database', name: 'Sales' }, restore: { kind: 'history' } }, { ...ids, dialog: 'deleteObject', target: { kind: 'server' }, restore: { kind: 'history' } }
    ]) expect(() => validateRequest('actions.describe', value), JSON.stringify(value).slice(0, 160)).toThrow('Invalid request')
    expect(deadlineFor('actions.describe', { ...describe, restore: { kind: 'history' } } as ActionDescribeRequest).deadlineMs).toBe(restoreDescribeDeadlineMs)
    expect([restoreDescribeDeadlineMs, restoreLimits.describeDeadlineMs]).toEqual([130_000, 130_000])
    expect(restoreLimits.mediaReadMs + 5_000).toBeLessThanOrEqual(restoreDescribeDeadlineMs)
    expect(restoreLimits.backupDevices + 2 * restoreLimits.restoreMoves + 6).toBeLessThanOrEqual(2_100)
    expect(restoreLimits.restoreMoves).toBeLessThanOrEqual(actionLimits.files)
  })
})

describe('restore defaults', () => {
  const at = new Date(2026, 9, 29, 21, 5, 45)
  it('names files as SSMS does (recalled)', () => {
    expect(fileStamp(at)).toBe('2026-10-29_21-05-45')
    expect(tailLogFile('C:\\Backup\\', '\\', 'Sales', at)).toBe('C:\\Backup\\Sales_LogBackup_2026-10-29_21-05-45.bak')
    expect(tailLogFile('/var/opt/mssql/data', '/', 'a/b:c', at)).toBe('/var/opt/mssql/data/a_b:c_LogBackup_2026-10-29_21-05-45.bak')
    // On Linux too, what serverPathSchema refuses everywhere becomes _, so the defaults pass it.
    for (const [name, part] of [['Sales*2', 'Sales_2'], ['what?', 'what_'], ['a\r\nb', 'a__b'], ['x"<y>|', 'x__y__']]) {
      const tail = tailLogFile('/var/opt/mssql/data/', '/', name, at), undo = standbyFile('/var/opt/mssql/data/', '/', name, at)
      expect(tail).toBe(`/var/opt/mssql/data/${part}_LogBackup_2026-10-29_21-05-45.bak`)
      expect([serverPathProblem(tail), serverPathProblem(undo)]).toEqual([undefined, undefined])
      const moved = restoreAsPath({ logical: 'L', physical: '/var/opt/mssql/data/Sales.mdf', type: 'data', sizeBytes: 1, fileId: 1 }, 'Sales', name, '/var/opt/mssql/data/', '/')
      expect([moved, serverPathProblem(moved)]).toEqual([`/var/opt/mssql/data/${part}.mdf`, undefined])
    }
    expect(standbyFile('C:\\Backup', '\\', 'a:b*c', at)).toBe('C:\\Backup\\a_b_c_RollbackUndo_2026-10-29_21-05-45.bak')
    expect(tailLogFile(undefined, '\\', 'Sales', at)).toBe('')
    expect(fileNamePart("O'Brien ]", '\\')).toBe("O'Brien ]")
    expect(pathFileName('C:\\DATA\\Sales.mdf')).toBe('Sales.mdf')
    expect(pathFileName('/var/opt/mssql/data/Sales.mdf')).toBe('Sales.mdf')
    const data = { logical: 'AppData', physical: 'C:\\DATA\\AppData.mdf', type: 'data' as const, sizeBytes: 1, fileId: 1 }
    const log = { ...data, logical: 'AppData_log', physical: 'C:\\DATA\\AppData_log.ldf', type: 'log' as const, fileId: 2 }
    expect(restoreAsPath(data, 'AppData', 'AppData', 'D:\\DATA\\', '\\')).toBe('C:\\DATA\\AppData.mdf')
    expect(restoreAsPath(data, 'AppData', 'Sales', 'D:\\DATA\\', '\\')).toBe('D:\\DATA\\Sales.mdf')
    expect(restoreAsPath(log, 'AppData', 'Sales', '/var/opt/mssql/data/', '/')).toBe('/var/opt/mssql/data/Sales_log.ldf')
    expect(restoreAsPath({ ...data, physical: 'C:\\DATA\\other.ndf' }, 'AppData', 'Sales', 'D:\\DATA', '\\')).toBe('D:\\DATA\\Sales_other.ndf')
    expect(backupSetTypeSpecs.log).toEqual({ component: 'Database', type: 'Transaction Log' })
  })
})
