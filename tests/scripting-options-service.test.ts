import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiResult, VariaApi } from '../src/shared/contracts'
import { ScriptingOptionsService } from '../src/renderer/src/scripting/ScriptingOptionsService'
import { defaultScriptingOptions, type ScriptingOptions } from '../src/shared/scripting/options'
import { deferred } from './fixtures/documents'
import { workbenchFixture } from './fixtures/workbench'

const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()) })

type Loaded = Awaited<ReturnType<VariaApi['getScriptingOptions']>>
const stored: ScriptingOptions = { ...defaultScriptingOptions, scriptUseDatabase: false, scriptOwner: true }
function setup(get: () => Promise<Loaded> = async () => ({ ok: true, value: { options: stored } })) {
  const reports: string[] = []
  const api = {
    getScriptingOptions: vi.fn<VariaApi['getScriptingOptions']>(get),
    setScriptingOptions: vi.fn<VariaApi['setScriptingOptions']>(async options => ({ ok: true, value: options }))
  }
  const service = new ScriptingOptionsService(api, message => reports.push(message))
  cleanups.push(() => service.dispose())
  return { api, service, reports }
}

describe('scripting options service', () => {
  it('holds the defaults until main\'s options arrive, and reads them once', async () => {
    const { api, service, reports } = setup()
    expect(service.getSnapshot()).toEqual({ options: defaultScriptingOptions, loaded: false })
    const published: unknown[] = []
    service.subscribe(() => published.push(service.getSnapshot()))
    await Promise.all([service.load(), service.load()])
    await service.load()
    expect(api.getScriptingOptions).toHaveBeenCalledTimes(1)
    expect(service.getSnapshot()).toEqual({ options: stored, loaded: true })
    expect(published).toHaveLength(1)
    expect(reports).toEqual([])
  })
  it('shows main\'s warning about a reset file once, in the command banner', async () => {
    const warning = 'Scripting options were invalid (not valid JSON) and were reset; the original file was kept.'
    const { service, reports } = setup(async () => ({ ok: true, value: { options: defaultScriptingOptions, warning } }))
    await service.load(); await service.load()
    expect(service.getSnapshot()).toEqual({ options: defaultScriptingOptions, loaded: true, warning })
    expect(reports).toEqual([warning])
  })
  it('keeps the defaults and says so when the options cannot be read or are not valid', async () => {
    const cases: [() => Promise<Loaded>, string][] = [
      [async () => ({ ok: false, error: 'Expected a regular file.' }), 'Expected a regular file.'],
      [async () => { throw new Error('IPC failed.') }, 'IPC failed.'],
      [async () => ({ ok: true, value: { options: { ...defaultScriptingOptions, targetServerVersion: '90' } as unknown as ScriptingOptions } }), 'Main sent options this version does not support.']
    ]
    for (const [get, reason] of cases) {
      const { service, reports } = setup(get)
      await service.load()
      expect(service.getSnapshot()).toEqual({ options: defaultScriptingOptions, loaded: true })
      expect(reports).toEqual([`Scripting options could not be loaded, so the defaults are used: ${reason}`])
    }
  })
  it('publishes saved options only once main has stored them, and keeps the old ones when it cannot', async () => {
    const { api, service } = setup()
    await service.load()
    const next = { ...stored, scriptPermissions: true }
    const pending = deferred<ApiResult<ScriptingOptions>>()
    api.setScriptingOptions.mockReturnValueOnce(pending.promise)
    const saving = service.save(next)
    expect(service.getSnapshot().options).toEqual(stored)
    pending.resolve({ ok: true, value: next })
    expect(await saving).toEqual(next)
    expect(service.getSnapshot()).toEqual({ options: next, loaded: true })
    expect(api.setScriptingOptions).toHaveBeenLastCalledWith(next)
    api.setScriptingOptions.mockResolvedValueOnce({ ok: false, error: 'Scripting options exceed their size limit.' })
    await expect(service.save(defaultScriptingOptions)).rejects.toThrow('Scripting options exceed their size limit.')
    expect(service.getSnapshot().options).toEqual(next)
    // An incomplete set never reaches main.
    const { scriptOwner: _, ...missing } = next
    await expect(service.save(missing as ScriptingOptions)).rejects.toThrow('The scripting options are not valid.')
    expect(api.setScriptingOptions).toHaveBeenCalledTimes(2)
  })
  it('keeps options saved while the first read was in flight', async () => {
    const read = deferred<Loaded>()
    const { service } = setup(() => read.promise)
    const loading = service.load()
    const saved = { ...defaultScriptingOptions, includeCollation: true }
    await service.save(saved)
    read.resolve({ ok: true, value: { options: stored } })
    await loading
    expect(service.getSnapshot()).toEqual({ options: saved, loaded: true })
  })
  it('opens and closes the dialog, and ignores a read that ends after disposal', async () => {
    const read = deferred<Loaded>()
    const { service, reports } = setup(() => read.promise)
    const changes: boolean[] = []
    service.dialog.subscribe(() => changes.push(service.dialog.getSnapshot()))
    service.openDialog(); service.openDialog(); service.closeDialog()
    expect(changes).toEqual([true, false])
    const loading = service.load()
    service.dispose()
    read.resolve({ ok: true, value: { options: stored, warning: 'late' } })
    await loading
    expect(service.getSnapshot().loaded).toBe(false)
    expect(reports).toEqual([])
  })
})

describe('Tools › Options… command', () => {
  it('opens the dialog only after the stored options are in, and the warning reaches the command banner', async () => {
    const fixture = workbenchFixture()
    cleanups.push(fixture.dispose)
    const read = deferred<Loaded>()
    fixture.api.getScriptingOptions.mockReturnValueOnce(read.promise)
    expect(fixture.commands.isEnabled('preferences.options')).toBe(true)
    const running = fixture.commands.execute('preferences.options', undefined, 'palette')
    await Promise.resolve()
    expect(fixture.scriptingOptions.dialog.getSnapshot()).toBe(false)
    read.resolve({ ok: true, value: { options: stored, warning: 'Scripting options were invalid (not UTF-8) and were reset; the original file was kept.' } })
    expect(await running).toBe(true)
    expect(fixture.scriptingOptions.dialog.getSnapshot()).toBe(true)
    expect(fixture.scriptingOptions.getSnapshot().options).toEqual(stored)
    expect(fixture.commands.getSnapshot().error).toBe('Scripting options were invalid (not UTF-8) and were reset; the original file was kept.')
    // Behind an open dialog the command does nothing.
    fixture.scriptingOptions.closeDialog()
    const modal = workbenchFixture({ modal: () => true })
    cleanups.push(modal.dispose)
    expect(await modal.commands.execute('preferences.options', undefined, 'keybinding')).toBe(false)
    expect(modal.scriptingOptions.dialog.getSnapshot()).toBe(false)
  })
})
