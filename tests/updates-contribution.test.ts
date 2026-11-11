import { describe, expect, it } from 'vitest'
import { workbenchFixture } from './fixtures/workbench'
import { updateErrors, type UpdateState } from '../src/shared/updates'

const base = { currentVersion: '1.0.0', kind: 'nsis', enabled: true } as const
const flush = () => new Promise(resolve => setTimeout(resolve, 0))
const error = (change: Partial<Extract<UpdateState, { status: 'error' }>>): UpdateState => ({ ...base, status: 'error', code: 'proxy', during: 'check', manual: false, ...updateErrors.proxy, detail: 'net::ERR_TUNNEL_CONNECTION_FAILED', ...change })

describe('updates in the workbench', () => {
  it('opens installed notes from Help, captures a toast version, and keeps download remedies external', async () => {
    const fixture = workbenchFixture()
    await flush()
    const { api, commands, releaseNotes, notifications } = fixture
    api.pushUpdate({ ...base, status: 'ready', version: '1.1.0' })
    const advertised = notifications.getSnapshot().visible[0]!.actions!.find(action => action.label === 'Release notes')!
    api.pushUpdate({ ...base, status: 'available', version: '1.2.0', size: 123 })
    advertised.run()
    await flush()
    expect(releaseNotes.getSnapshot().version).toBe('1.1.0')
    await commands.execute('help.releaseNotes', undefined, 'menu')
    expect(releaseNotes.getSnapshot().version).toBe('1.0.0')
    expect(api.openReleasesPage).not.toHaveBeenCalled()
    await commands.execute('help.openDownloads', undefined, 'palette')
    expect(api.openReleasesPage).toHaveBeenCalledTimes(1)
    api.pushUpdate(error({ manual: true }))
    notifications.getSnapshot().visible[0]!.actions!.find(action => action.label === 'Open releases page')!.run()
    await flush()
    expect(api.openReleasesPage).toHaveBeenCalledTimes(2)
    fixture.dispose()
  })
  it('follows main\'s state in the update context keys, so the commands enable as the state allows', async () => {
    const fixture = workbenchFixture()
    await flush()
    const { api, commands } = fixture
    expect(commands.isEnabled('help.checkForUpdates')).toBe(true)
    expect(commands.isEnabled('help.restartToUpdate')).toBe(false)
    expect(commands.isEnabled('help.downloadUpdate')).toBe(false)
    api.pushUpdate({ ...base, status: 'downloading', version: '1.1.0', received: 10, total: 100 })
    expect(commands.isEnabled('help.checkForUpdates')).toBe(false)
    api.pushUpdate({ ...base, status: 'available', version: '1.1.0', size: 100 })
    expect(commands.isEnabled('help.downloadUpdate')).toBe(true)
    // A release this copy cannot install has nothing to download.
    api.pushUpdate({ ...base, kind: 'unsupported', status: 'available', version: '1.1.0' })
    expect(commands.isEnabled('help.downloadUpdate')).toBe(false)
    api.pushUpdate({ ...base, status: 'ready', version: '1.1.0' })
    expect(commands.isEnabled('help.restartToUpdate')).toBe(true)
    expect(await commands.execute('help.restartToUpdate', undefined, 'menu')).toBe(true)
    expect(api.restartToUpdate).toHaveBeenCalledTimes(1)
    fixture.dispose()
  })
  it('announces a ready update once a version, with Restart to update', async () => {
    const fixture = workbenchFixture()
    await flush()
    const { api, notifications } = fixture
    api.pushUpdate({ ...base, status: 'downloading', version: '1.1.0', received: 0, total: 100 })
    expect(notifications.getSnapshot().visible).toEqual([])
    api.pushUpdate({ ...base, status: 'ready', version: '1.1.0' })
    const [toast] = notifications.getSnapshot().visible
    expect(toast).toMatchObject({ severity: 'info', message: 'Varia SQL Manager 1.1.0 is ready to install. It installs when Varia restarts.' })
    expect(toast!.actions!.map(action => action.label)).toEqual(['Restart to update', 'Release notes'])
    toast!.actions![0]!.run()
    await flush()
    expect(api.restartToUpdate).toHaveBeenCalledTimes(1)
    notifications.clear()
    // A later automatic check that finds the same release says nothing new.
    api.pushUpdate({ ...base, status: 'checking', manual: false })
    api.pushUpdate({ ...base, status: 'ready', version: '1.1.0' })
    expect(notifications.getSnapshot().visible).toEqual([])
    fixture.dispose()
  })
  it('keeps an automatic check\'s failure to the status bar, and toasts a manual check\'s or a download\'s, with Copy details', async () => {
    const fixture = workbenchFixture()
    await flush()
    const { api, notifications } = fixture
    api.pushUpdate(error({}))
    expect(notifications.getSnapshot().visible).toEqual([])
    api.pushUpdate({ ...base, status: 'checking', manual: true })
    api.pushUpdate(error({ manual: true }))
    const [toast] = notifications.getSnapshot().visible
    expect(toast).toMatchObject({ severity: 'error', message: `${updateErrors.proxy.message} ${updateErrors.proxy.hint}`, report: { code: 'UPDATE_PROXY', context: 'Checking for updates', extra: 'Detail: net::ERR_TUNNEL_CONNECTION_FAILED' } })
    expect(toast!.message).toContain('github.com')
    expect(toast!.actions!.map(action => action.label)).toEqual(['Try again', 'Open releases page'])
    toast!.actions![1]!.run()
    await flush()
    expect(api.openReleasesPage).toHaveBeenCalledTimes(1)
    notifications.clear()
    api.pushUpdate({ ...base, status: 'downloading', version: '1.1.0', received: 0, total: 100 })
    api.pushUpdate(error({ code: 'integrity', during: 'download', version: '1.1.0', ...updateErrors.integrity, detail: 'SHA-512 mismatch' }))
    expect(notifications.getSnapshot().visible[0]).toMatchObject({ severity: 'error', report: { code: 'UPDATE_INTEGRITY', context: 'Downloading Varia SQL Manager 1.1.0' } })
    fixture.dispose()
  })
  it('answers Check for Updates with the latest version, and again with a release it announced before', async () => {
    const fixture = workbenchFixture()
    await flush()
    const { api, notifications, commands } = fixture
    api.checkForUpdates.mockImplementationOnce(async () => { api.pushUpdate({ ...base, status: 'upToDate', checkedAt: 1 }); return { ok: true, value: { ...base, status: 'upToDate', checkedAt: 1 } } })
    await commands.execute('help.checkForUpdates', undefined, 'menu')
    expect(notifications.getSnapshot().visible.map(toast => toast.message)).toEqual(['Varia SQL Manager 1.0.0 is the latest version.'])
    notifications.clear()
    const available: UpdateState = { ...base, status: 'available', version: '1.1.0', size: 2_097_152 }
    api.pushUpdate(available)
    expect(notifications.getSnapshot().visible).toHaveLength(1)
    notifications.clear()
    api.checkForUpdates.mockImplementationOnce(async () => ({ ok: true, value: available }))
    await commands.execute('help.checkForUpdates', undefined, 'palette')
    const [toast] = notifications.getSnapshot().visible
    expect(toast!.message).toMatch(/^Varia SQL Manager 1\.1\.0 is available \(2(\.0)? MB\)\.$/)
    expect(toast!.actions!.map(action => action.label)).toEqual(['Download', 'Release notes'])
    fixture.dispose()
  })
  it('points a copy that cannot update itself to the releases page, and says a development build does not check', async () => {
    const fixture = workbenchFixture()
    await flush()
    const { api, notifications, commands } = fixture
    api.pushUpdate({ ...base, kind: 'unsupported', status: 'available', version: '1.1.0' })
    expect(notifications.getSnapshot().visible[0]!.actions!.map(action => action.label)).toEqual(['Open releases page', 'Release notes'])
    api.checkForUpdates.mockImplementationOnce(async () => ({ ok: true, value: { ...base, enabled: false, status: 'idle' } }))
    await commands.execute('help.checkForUpdates', undefined, 'menu')
    expect(commands.getSnapshot()).toMatchObject({ kind: 'warning', error: 'This copy of Varia SQL Manager is a development build, which does not check for updates.' })
    fixture.dispose()
  })
})
