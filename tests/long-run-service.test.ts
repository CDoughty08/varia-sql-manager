import { describe, expect, it, vi } from 'vitest'
import type { VariaApi } from '../src/shared/contracts'
import { longRunLimits, longRunMessages } from '../src/shared/long-runs'
import { LongRunService } from '../src/renderer/src/services/long-runs'

const service = () => {
  const api = { setLongRuns: vi.fn<VariaApi['setLongRuns']>(async () => ({ ok: true, value: undefined })) }
  return { api, runs: new LongRunService({ api }) }
}

describe('LongRunService', () => {
  it('refuses a close, a Disconnect of the run\'s server and Restart while a run is registered, naming the first run', () => {
    const { runs } = service()
    expect([runs.closeRefusal(), runs.disconnectRefusal('a'), runs.restartRefusal()]).toEqual([undefined, undefined, undefined])
    const restore = runs.begin({ kind: 'restore', connectionId: 'a', server: 'sql-a' })
    runs.begin({ kind: 'backup', connectionId: 'b', server: 'sql-b' })
    expect(runs.closeRefusal()).toBe(longRunMessages.close({ kind: 'restore', server: 'sql-a' }))
    expect(runs.disconnectRefusal('a')).toBe('A restore is running on sql-a. Stop it first.')
    expect(runs.disconnectRefusal('b')).toBe('A backup is running on sql-b. Stop it first.')
    expect(runs.disconnectRefusal('c')).toBeUndefined()
    expect(runs.restartRefusal()).toBe('A restore is running on sql-a. Stop it first.')
    restore.dispose()
    expect(runs.disconnectRefusal('a')).toBeUndefined()
    expect(runs.restartRefusal()).toBe('A backup is running on sql-b. Stop it first.')
  })
  it('tells a refused run\'s owner, which shows it where the user is looking, but not for a question a picker asks', () => {
    const { runs } = service()
    const refused = vi.fn<(message: string) => void>()
    const run = runs.begin({ kind: 'restore', connectionId: 'a', server: 'sql-a', refused })
    expect(runs.disconnectRefusal('a')).toBeDefined()
    expect(refused).not.toHaveBeenCalled()
    expect(runs.closeRefusal()).toBe(longRunMessages.close({ kind: 'restore', server: 'sql-a' }))
    expect(runs.restartRefusal()).toBe('A restore is running on sql-a. Stop it first.')
    expect(refused.mock.calls).toEqual([[longRunMessages.close({ kind: 'restore', server: 'sql-a' })], ['A restore is running on sql-a. Stop it first.']])
    // An owner that throws does not stop the refusal; an ended run's owner hears nothing more.
    refused.mockImplementation(() => { throw new Error('gone') })
    const reported = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(runs.closeRefusal()).toBeDefined()
    expect(reported).toHaveBeenCalledOnce()
    reported.mockRestore()
    run.dispose()
    refused.mockClear()
    runs.begin({ kind: 'verify', connectionId: 'b', server: 'sql-b' })
    expect(runs.closeRefusal()).toBe(longRunMessages.close({ kind: 'verify', server: 'sql-b' }))
    expect(refused).not.toHaveBeenCalled()
  })
  it('ends a run once, however often it is disposed, and keeps two runs of one kind apart', () => {
    const { runs } = service()
    const first = runs.begin({ kind: 'restore', connectionId: 'a', server: 'sql-a' })
    runs.begin({ kind: 'restore', connectionId: 'a', server: 'sql-a' })
    first.dispose()
    first.dispose()
    expect(runs.getSnapshot().runs).toHaveLength(1)
    expect(runs.disconnectRefusal('a')).toBeDefined()
  })
  it('tells main its runs on every change, bounded as main\'s schema allows, with the total counting the rest', () => {
    const { api, runs } = service()
    const handles = Array.from({ length: longRunLimits.runs + 2 }, (_, index) => runs.begin({ kind: 'verify', connectionId: String(index), server: index ? `sql-${index}` : 'x'.repeat(longRunLimits.server + 10) }))
    const last = api.setLongRuns.mock.lastCall![0]
    expect(last.total).toBe(longRunLimits.runs + 2)
    expect(last.runs).toHaveLength(longRunLimits.runs)
    expect(last.runs[0].server).toHaveLength(longRunLimits.server)
    handles.forEach(handle => handle.dispose())
    expect(api.setLongRuns).toHaveBeenLastCalledWith({ runs: [], total: 0 })
    expect(api.setLongRuns).toHaveBeenCalledTimes(2 * handles.length)
  })
  it('stays usable when main cannot be told, and stops telling it once disposed', async () => {
    const { api, runs } = service()
    api.setLongRuns.mockRejectedValueOnce(new Error('IPC lost'))
    const run = runs.begin({ kind: 'shrink', connectionId: 'a', server: 'sql-a' })
    await Promise.resolve()
    expect(runs.restartRefusal()).toBe('A shrink is running on sql-a. Stop it first.')
    runs.dispose()
    run.dispose()
    expect(api.setLongRuns).toHaveBeenCalledOnce()
  })
})
