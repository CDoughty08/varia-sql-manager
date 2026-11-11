import { describe, expect, it, vi } from 'vitest'
import { aboutUpdate, platformName, versionDetails } from '../src/renderer/src/about/about'
import { helpContribution } from '../src/renderer/src/contributions/help'
import { CommandService } from '../src/renderer/src/core/commands'
import { EventBus } from '../src/renderer/src/core/events'
import type { UpdateState } from '../src/shared/updates'
import { updateErrors } from '../src/shared/updates'
import { productLinkUrl } from '../src/shared/product'

const base = { currentVersion: '0.8.0', kind: 'nsis', enabled: true } as const

describe('About update presentation', () => {
  it('does not mistake missing application information for a development build or a successful check', () => {
    expect(aboutUpdate({ ...base, status: 'idle', currentVersion: '', enabled: false }, 'win32')).toMatchObject({ title: 'Version information unavailable' })
    expect(aboutUpdate({ ...base, status: 'idle', enabled: false }, 'win32')).toEqual({ title: 'Development build', detail: 'This copy does not check for updates.' })
    expect(aboutUpdate({ ...base, status: 'idle' }, 'win32')).toMatchObject({ title: 'Check for a newer version', action: { command: 'help.checkForUpdates' } })
    expect(aboutUpdate({ ...base, status: 'upToDate', checkedAt: 1 }, 'win32').title).toBe('No newer version was found at the last check')
  })
  it('offers download, manual download and restart only for the states that support them', () => {
    const available: UpdateState = { ...base, status: 'available', version: '0.9.0', size: 1024 }
    expect(aboutUpdate(available, 'win32')).toMatchObject({ action: { command: 'help.downloadUpdate', label: 'Download Update' } })
    const manual: UpdateState = { ...base, kind: 'unsupported', status: 'available', version: '0.9.0' }
    expect(aboutUpdate(manual, 'darwin')).toMatchObject({ detail: expect.stringContaining('manual downloads'), action: { command: 'help.openDownloads' } })
    expect(aboutUpdate(manual, 'linux')).toMatchObject({ detail: expect.stringContaining('installed manually') })
    expect(aboutUpdate({ ...base, status: 'ready', version: '0.9.0' }, 'win32')).toMatchObject({ action: { command: 'help.restartToUpdate' }, detail: expect.stringContaining('save any unsaved work') })
  })
  it('keeps checking, downloading and preparing busy without offering an install action', () => {
    for (const state of [
      { ...base, status: 'checking', manual: true },
      { ...base, status: 'downloading', version: '0.9.0', received: 42, total: 100 },
      { ...base, status: 'preparing', version: '0.9.0' }
    ] satisfies UpdateState[]) {
      expect(aboutUpdate(state, 'win32')).toMatchObject({ busy: true })
      expect(aboutUpdate(state, 'win32').action).toBeUndefined()
    }
    expect(aboutUpdate({ ...base, status: 'downloading', version: '0.9.0', received: 200, total: 100 }, 'win32').percent).toBe(100)
    expect(aboutUpdate({ ...base, status: 'downloading', version: '0.9.0', received: 0, total: 0 }, 'win32').percent).toBeUndefined()
  })
  it('keeps the failure and remedy visible and offers a fresh check', () => {
    for (const during of ['check', 'download', 'install'] as const) {
      const state: UpdateState = { ...base, status: 'error', code: 'offline', manual: true, during, ...updateErrors.offline }
      expect(aboutUpdate(state, 'win32')).toMatchObject({ detail: `${state.message} ${state.hint}`, action: { command: 'help.checkForUpdates', label: 'Try Again' } })
    }
  })
})

describe('About support details and links', () => {
  it('copies only allowlisted application facts even when the input carries other properties', () => {
    const state = { ...base, status: 'idle' as const, server: 'private-server', password: 'private-password', path: 'private-path', sql: 'private-query' }
    expect(versionDetails(state, 'win32')).toBe('Varia SQL Manager 0.8.0\nPlatform: Windows\nBuild: Windows installer\nUpdate status: idle')
    expect(versionDetails({ ...base, status: 'idle', kind: 'unsupported', enabled: false }, 'darwin')).toContain('Development build')
    expect(versionDetails({ ...base, status: 'idle', currentVersion: '' }, 'linux')).toContain('Update status: unavailable')
    expect(['win32', 'darwin', 'linux'].map(platform => platformName(platform as 'win32' | 'darwin' | 'linux'))).toEqual(['Windows', 'macOS', 'Linux'])
  })
  it('accepts only named product destinations, never a renderer-supplied URL or object key', () => {
    expect(productLinkUrl('project')).toBe('https://github.com/CDoughty08/varia-sql-manager')
    expect(productLinkUrl('issues')).toBe('https://github.com/CDoughty08/varia-sql-manager/issues/new')
    for (const value of ['https://example.com', 'file:///private', 'javascript:alert(1)', '../issues', 'constructor', '__proto__', null, {}, ['project'], 1]) expect(() => productLinkUrl(value), JSON.stringify(value)).toThrow()
  })
  it('routes Help/palette actions through the existing command contribution and disposes them', async () => {
    const commands = new CommandService(), events = new EventBus(), requested = vi.fn()
    const api = { clearEntraTokenCache: vi.fn(), openProductLink: vi.fn(async () => ({ ok: true as const, value: undefined })) }
    events.subscribe(requested)
    const contribution = helpContribution({ commands, events }, api)
    expect(await commands.execute('help.about', undefined, 'palette')).toBe(true)
    expect(requested).toHaveBeenCalledWith({ type: 'help.aboutRequested' })
    await commands.execute('help.openProject', undefined, 'menu')
    await commands.execute('help.reportIssue', undefined, 'palette')
    expect(api.openProductLink.mock.calls).toEqual([['project'], ['issues']])
    contribution.dispose()
    for (const id of ['help.about', 'help.openProject', 'help.reportIssue', 'help.clearEntraTokenCache'] as const) expect(commands.has(id)).toBe(false)
    commands.dispose(); events.dispose()
  })
})
