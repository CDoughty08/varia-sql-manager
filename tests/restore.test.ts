import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { validateRequest } from '../src/main/validation'
import { deadlineFor, restoreDescribeDeadlineMs } from '../src/shared/ipc/methods'
import { actionLimits } from '../src/shared/actions/catalog'
import type { ActionDescribeRequest } from '../src/shared/actions/schema'
import {
  backupSetTypeSpecs, fileNamePart, fileStamp, pathFileName, restoreAsPath, restoreLimits, restoreMessages, restoreTargetProblem, standbyFile, tailLogFile, type BackupSetRow, type RestoreOptions
} from '../src/shared/actions/restore'
import { dependants, lastBackupTaken, logCoverage, orderSelection, planRestore, pointAllowed, selectionProblem, tailSetId } from '../src/shared/actions/restore-plan'
import { restoreOptionsProblems, restoreRequestSchema, restoreSourceSchema } from '../src/shared/actions/restore-schema'

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
    expect(planRestore(probe)).toEqual({ ids: ['1:1', '3:1', '2:3'], needsTail: false })
    expect(planRestore(probe, { stopAt: '2026-10-29T21:05:43' })).toEqual({ ids: ['1:1', '2:1', '2:2'], stopAt: '2026-10-29T21:05:43', needsTail: false })
    // A point at the differential's own finish needs no log, and so no STOPAT; one after it takes the log that reaches it.
    expect(planRestore(probe, { stopAt: '2026-10-29T21:05:45' })).toEqual({ ids: ['1:1', '3:1'], needsTail: false })
    expect(planRestore(probe, { stopAt: '2026-10-29T21:05:46' })).toEqual({ ids: ['1:1', '3:1', '2:3'], stopAt: '2026-10-29T21:05:46', needsTail: false })
    // With the last backup taken and a tail-log backup asked for, SMO restores up to the last log and leaves the tail out (probed).
    expect(planRestore(probe, { tailLog: true })).toEqual({ ids: ['1:1', '3:1', '2:3'], needsTail: false })
  })
  it('needs a tail-log backup for a point past the last log, and a full backup before the point', () => {
    expect(planRestore(probe, { stopAt: '2026-10-29T21:06:00' })).toEqual({ ids: ['1:1', '3:1', '2:3'], needsTail: true, problem: restoreMessages.afterLastBackup })
    expect(planRestore(probe, { stopAt: '2026-10-29T21:06:00', tailLog: true })).toEqual({ ids: ['1:1', '3:1', '2:3', tailSetId], stopAt: '2026-10-29T21:06:00', needsTail: true })
    expect(planRestore(probe, { stopAt: '2026-10-29T21:05:39' })).toMatchObject({ ids: [], problem: restoreMessages.noFullBackup })
    expect(planRestore([])).toMatchObject({ ids: [], problem: restoreMessages.noSets })
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
    expect(orderSelection(probe, [tailSetId, '2:3', '3:1', '1:1'])).toEqual(['1:1', '3:1', '2:3', tailSetId])
    expect(orderSelection(probe, ['2:2', '2:1', '1:1'])).toEqual(['1:1', '2:1', '2:2'])
    expect(selectionProblem(probe, ['1:1', '3:1', '2:3'])).toBeUndefined()
    expect(selectionProblem(probe, ['1:1', '2:1', '2:2', '2:3'])).toBeUndefined()
    for (const selection of [['1:1', '2:2'], ['2:1', '2:2'], ['1:1', '2:1', '3:1'], [], ['1:1', tailSetId, '2:1'], ['1:1', 'missing']])
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
    expect(lastBackupTaken(probe, ['1:1', '3:1', '2:3', tailSetId])).toBe('2026-10-29T21:05:46')
    expect(lastBackupTaken(probe, [])).toBeUndefined()
  })
})

interface SmoFixture { readonly history: BackupSetRow[]; readonly media: BackupSetRow[]; readonly plans: { goal: string; stopAt: string | null; names: string[]; varia: string[] }[] }
const fixturePath = 'tests/fixtures/restore/smo-plans.json'

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
    // actions.execute takes no restore until D1f runs one (critic A17).
    expect(() => validateRequest('actions.execute', request)).toThrow('Invalid request')
    for (const name of ['master', 'model', 'msdb', 'tempdb']) {
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
