import { describe, expect, it, vi } from 'vitest'
import { gestureChoiceFromText, gestureChoiceText, gestureChoiceTexts, gestureOverrides } from '../src/shared/commands/gesture-choices'
import { gestureDescriptor, gestureIds } from '../src/shared/commands/gestures'
import { defaultRules } from '../src/shared/commands/keybindings'
import { emptyShortcutFile, readShortcutFile, type ShortcutFile } from '../src/shared/commands/shortcut-schema'
import { GestureService } from '../src/renderer/src/core/gestures'
import { KeybindingService } from '../src/renderer/src/core/keybindings'
import { ShortcutsService, type ShortcutsApi } from '../src/renderer/src/core/ShortcutsService'
import { createFakeShortcutsService } from '../src/renderer/src/core/ShortcutsService.fake'

const remap: ShortcutFile = { ...emptyShortcutFile, bindings: [{ command: 'file.new', key: 'mod+n', remove: true }, { command: 'file.new', key: 'mod+shift+f9' }], gestures: { 'explorer.peekHover': 'shift' } }
function targets() {
  const setRules = vi.fn(), setModifiers = vi.fn()
  return { keybindings: { setRules }, gestures: { setModifiers }, setRules, setModifiers }
}
function api(overrides: Partial<ShortcutsApi> = {}) {
  let push: (snapshot: unknown) => void = () => {}
  const value: ShortcutsApi = {
    get: vi.fn(async () => ({ ok: true as const, value: { file: remap, revision: 3, salvaged: true, notice: 'Some shortcuts were set aside.' } })),
    save: vi.fn(async (_file, base) => ({ ok: true as const, value: { revision: base + 1 } })),
    importFile: vi.fn(async () => ({ ok: true as const, value: { cancelled: true as const } })),
    exportFile: vi.fn(async () => ({ ok: true as const, value: { cancelled: false } })),
    onChanged: vi.fn(callback => { push = callback as typeof push; return () => { push = () => {} } }),
    ...overrides
  }
  return { api: value, push: (snapshot: unknown) => push(snapshot) }
}

describe('shortcuts service', () => {
  it("loads main's file, then applies its effective rules to the keys and its gestures to the gesture service", async () => {
    const { api: main } = api(), { setRules, setModifiers, ...bound } = targets()
    const service = new ShortcutsService({ api: main, platform: 'win32' })
    expect(service.snapshot()).toMatchObject({ revision: 0, loaded: false, file: emptyShortcutFile })
    service.bind(bound)
    expect(setRules).toHaveBeenLastCalledWith(defaultRules('win32'))
    const changes = vi.fn()
    service.subscribe(changes)
    expect(await service.load()).toBe(true)
    const snapshot = service.snapshot()
    expect(snapshot).toMatchObject({ revision: 3, loaded: true, salvaged: true, notice: 'Some shortcuts were set aside.', file: remap })
    expect(snapshot.effective.userRules.map(rule => rule.chords[0])).toEqual(['ctrl+shift+f9'])
    expect(setRules).toHaveBeenLastCalledWith(snapshot.effective.rules)
    expect(setModifiers).toHaveBeenLastCalledWith(new Map([['explorer.peekHover', ['shift']]]))
    expect(changes).toHaveBeenCalledOnce()
    // A second load shares the first read.
    await service.load()
    expect(main.get).toHaveBeenCalledOnce()
  })
  it('takes pushes only when they are valid and newer than what it holds', async () => {
    const { api: main, push } = api(), { setRules, ...bound } = targets()
    const service = new ShortcutsService({ api: main, platform: 'linux', ...bound })
    await service.load()
    setRules.mockClear()
    push({ file: emptyShortcutFile, revision: 3 })
    push({ file: emptyShortcutFile, revision: 2 })
    push({ file: { ...emptyShortcutFile, scheme: 42 }, revision: 9 })
    push({ file: emptyShortcutFile, revision: -1 })
    push(undefined)
    expect(service.snapshot()).toMatchObject({ revision: 3, file: remap })
    expect(setRules).not.toHaveBeenCalled()
    push({ file: emptyShortcutFile, revision: 4 })
    expect(service.snapshot()).toMatchObject({ revision: 4, file: emptyShortcutFile })
    expect(setRules).toHaveBeenLastCalledWith(defaultRules('linux'))
  })
  it('saves from the revision it holds, applies the answer at once, and ignores the echo', async () => {
    const { api: main, push } = api(), { setRules, ...bound } = targets()
    const service = new ShortcutsService({ api: main, platform: 'darwin', ...bound })
    await service.load()
    const changes = vi.fn()
    service.subscribe(changes)
    expect(await service.save(emptyShortcutFile)).toEqual({ ok: true, value: { revision: 4 } })
    expect(main.save).toHaveBeenCalledWith(emptyShortcutFile, 3)
    expect(service.snapshot()).toMatchObject({ revision: 4, file: emptyShortcutFile })
    expect(setRules).toHaveBeenLastCalledWith(defaultRules('darwin'))
    push({ file: emptyShortcutFile, revision: 4 })
    expect(changes).toHaveBeenCalledOnce()
  })
  it('answers failures as values and keeps the snapshot', async () => {
    const { api: main } = api({ save: vi.fn(async () => ({ ok: false as const, error: 'The shortcuts changed in another window.' })) })
    const service = new ShortcutsService({ api: main, platform: 'win32' })
    await service.load()
    expect(await service.save(emptyShortcutFile)).toEqual({ ok: false, error: 'The shortcuts changed in another window.' })
    expect(await service.save({ ...emptyShortcutFile, bindings: [{ command: 'file.new', key: 'x'.repeat(65) }] })).toMatchObject({ ok: false })
    expect(main.save).toHaveBeenCalledOnce()
    expect(service.snapshot().revision).toBe(3)
    const throwing = new ShortcutsService({ api: api({ save: vi.fn(async () => { throw new Error('gone') }), importFile: vi.fn(async () => { throw new Error('no dialog') }) }).api, platform: 'win32' })
    expect(await throwing.save(emptyShortcutFile)).toEqual({ ok: false, error: 'gone' })
    expect(await throwing.importFile()).toEqual({ ok: false, error: 'no dialog' })
  })
  it("keeps the catalogue's keys when main cannot be read, and reads again next time", async () => {
    let fail = true
    const get = vi.fn(async () => fail ? { ok: false as const, error: 'no main' } : { ok: true as const, value: { file: remap, revision: 1, salvaged: false } })
    const { setRules, ...bound } = targets()
    const service = new ShortcutsService({ api: api({ get }).api, platform: 'win32', ...bound })
    expect(await service.load()).toBe(false)
    expect(service.snapshot()).toMatchObject({ loaded: true, revision: 0 })
    expect(setRules).not.toHaveBeenCalled()
    fail = false
    expect(await service.load()).toBe(true)
    expect(service.snapshot()).toMatchObject({ revision: 1, file: remap })
  })
  it('takes revision 0 from the first load, and stops after dispose', async () => {
    const { api: main, push } = api({ get: vi.fn(async () => ({ ok: true as const, value: { file: remap, revision: 0, salvaged: false } })) })
    const { setRules, ...bound } = targets()
    const service = new ShortcutsService({ api: main, platform: 'win32', ...bound })
    await service.load()
    expect(service.snapshot().file).toEqual(remap)
    service.dispose()
    push({ file: emptyShortcutFile, revision: 5 })
    expect(service.snapshot().revision).toBe(0)
    expect(setRules).toHaveBeenCalledOnce()
  })
})

describe('fake shortcuts service', () => {
  it('saves like main, refuses a stale base revision, and follows changes from other windows', async () => {
    const { setRules, ...bound } = targets()
    const fake = createFakeShortcutsService({ file: remap, revision: 2, ...bound })
    expect(fake.snapshot()).toMatchObject({ loaded: true, revision: 2, file: remap })
    expect(setRules).toHaveBeenLastCalledWith(fake.snapshot().effective.rules)
    expect(await fake.save(emptyShortcutFile)).toEqual({ ok: true, value: { revision: 3 } })
    expect(fake.saves).toEqual([{ file: emptyShortcutFile, baseRevision: 2 }])
    fake.changeElsewhere(remap)
    expect(fake.snapshot()).toMatchObject({ revision: 4, file: remap })
    fake.failNextSave('Disk full.')
    expect(await fake.save(emptyShortcutFile)).toEqual({ ok: false, error: 'Disk full.' })
    expect(fake.stored().revision).toBe(4)
    fake.answerImport({ file: remap, problems: ['One binding was left out.'] })
    expect(await fake.importFile()).toEqual({ ok: true, value: { file: remap, problems: ['One binding was left out.'] } })
    fake.answerExport('cancel')
    expect(await fake.exportFile(remap)).toEqual({ ok: true, value: { cancelled: true } })
    expect(await fake.exportFile(remap)).toEqual({ ok: true, value: { cancelled: false } })
    expect(fake.exports).toEqual([remap, remap])
  })
})

describe('gesture choice text', () => {
  it('writes every catalogue choice as text the file schema accepts, and reads it back', () => {
    for (const id of gestureIds) {
      const gesture = gestureDescriptor(id)
      for (const choice of gesture.choices ?? []) {
        const text = gestureChoiceText(choice)
        expect(gestureChoiceFromText(text), `${id} ${text}`).toEqual(choice)
        expect(readShortcutFile({ version: 1, scheme: 'default', bindings: [], gestures: { [id]: text } }, { gestures: gestureChoiceTexts })).toMatchObject({ ok: true, problems: [], file: { gestures: { [id]: text } } })
      }
    }
    expect([gestureChoiceText(null), gestureChoiceText([]), gestureChoiceText(['shift', 'mod'])]).toEqual(['off', 'none', 'modShift'])
    expect([gestureChoiceFromText('off'), gestureChoiceFromText('shiftMod'), gestureChoiceFromText('modMod'), gestureChoiceFromText('hyper')]).toEqual([null, undefined, undefined, undefined])
    expect(gestureChoiceTexts.get('explorer.peekHover')).toEqual(['mod', 'shift', 'off'])
    expect(gestureChoiceTexts.has('grid.extendSelection')).toBe(false)
  })
  it('turns a file into GestureService choices, leaving out what the catalogue does not offer', () => {
    const overrides = gestureOverrides({ 'explorer.peekHover': 'off', 'grid.addToSelection': 'alt', 'grid.extendSelection': 'alt', 'dock.toggleFloat': 'off', 'future.gesture': 'mod', 'grid.fitColumn': 'mod' })
    expect(overrides).toEqual(new Map([['explorer.peekHover', null], ['grid.addToSelection', ['alt']]]))
    const gestures = new GestureService('win32')
    gestures.setModifiers(overrides)
    expect([gestures.matches('grid.addToSelection', { altKey: true }), gestures.matches('grid.addToSelection', { ctrlKey: true }), gestures.label('explorer.peekHover')]).toEqual([true, false, 'Off'])
  })
})

describe('shortcuts service reporting and pushes', () => {
  it("reports a failed load and main's notice, including ones from before the reporter", async () => {
    const failing = new ShortcutsService({ api: api({ get: vi.fn(async () => ({ ok: false as const, error: 'Access denied.' })) }).api, platform: 'win32' })
    await failing.load()
    const reported: [string, string][] = []
    failing.setReporter((message, kind) => { reported.push([message, kind]) })
    expect(reported).toEqual([['Your shortcuts could not be loaded, so the default keys are used: Access denied.', 'error']])
    const invalid = new ShortcutsService({ api: api({ get: vi.fn(async () => ({ ok: true as const, value: { file: { version: 2 } as never, revision: 1, salvaged: false } })) }).api, platform: 'win32' })
    invalid.setReporter((message, kind) => { reported.push([message, kind]) })
    await invalid.load()
    const salvaged = new ShortcutsService({ api: api().api, platform: 'win32' })
    salvaged.setReporter((message, kind) => { reported.push([message, kind]) })
    await salvaged.load()
    expect(reported.slice(1)).toEqual([
      ['Your shortcuts could not be loaded, so the default keys are used: Main sent shortcuts this version does not support.', 'error'],
      ['Some shortcuts were set aside.', 'warning']
    ])
  })
  it("clears the load's salvage notice once a newer file arrives", async () => {
    const service = new ShortcutsService({ api: api().api, platform: 'win32' })
    await service.load()
    expect(service.snapshot()).toMatchObject({ salvaged: true, notice: 'Some shortcuts were set aside.' })
    await service.save(emptyShortcutFile)
    expect(service.snapshot().salvaged).toBe(false)
    expect(service.snapshot().notice).toBeUndefined()
  })
  it('keeps the file object and rules for a push of the same content', async () => {
    const { api: main, push } = api(), { setRules, ...bound } = targets()
    const service = new ShortcutsService({ api: main, platform: 'win32', ...bound })
    await service.load()
    const { file, effective } = service.snapshot()
    setRules.mockClear()
    push({ file: structuredClone(remap), revision: 4 })
    expect(service.snapshot().revision).toBe(4)
    expect(service.snapshot().file).toBe(file)
    expect(service.snapshot().effective).toBe(effective)
    expect(setRules).not.toHaveBeenCalled()
  })
})

describe('shortcuts service bound as the workbench binds it', () => {
  it('drives a real KeybindingService and GestureService, and stops after the binding is disposed', async () => {
    const keybindings = new KeybindingService({ platform: 'win32', commands: { execute: async () => true }, context: { get: () => ({}) as never }, modalOpen: () => false, editorHasTextFocus: () => false })
    const gestures = new GestureService('win32')
    const fake = createFakeShortcutsService()
    const binding = fake.bind({ keybindings, gestures })
    expect(keybindings.lookup('file.new')?.text).toBe('Ctrl+N')
    await fake.save(remap)
    expect([keybindings.lookup('file.new')?.text, gestures.label('explorer.peekHover')]).toEqual(['Ctrl+Shift+F9', 'Shift+Hover'])
    binding.dispose()
    fake.changeElsewhere(emptyShortcutFile)
    expect(keybindings.lookup('file.new')?.text).toBe('Ctrl+Shift+F9')
  })
})

describe('shortcuts service reload', () => {
  it('reads main again on reload, where load shares its first successful read', async () => {
    let revision = 1
    const get = vi.fn(async () => ({ ok: true as const, value: { file: revision > 1 ? remap : emptyShortcutFile, revision, salvaged: false } }))
    const service = new ShortcutsService({ api: api({ get }).api, platform: 'win32' })
    await service.load()
    revision = 2
    await service.load()
    expect([get.mock.calls.length, service.snapshot().revision]).toEqual([1, 1])
    expect(await service.reload()).toBe(true)
    expect(get).toHaveBeenCalledTimes(2)
    expect(service.snapshot()).toMatchObject({ revision: 2, file: remap })
  })
})

describe('shortcuts service reload reports', () => {
  it("shows main's notice once across reloads, and says the loaded shortcuts stay when a reload fails", async () => {
    let fail = false
    const get = vi.fn(async () => fail ? { ok: false as const, error: 'Busy.' } : { ok: true as const, value: { file: remap, revision: 1, salvaged: true, notice: 'Some shortcuts were set aside.' } })
    const service = new ShortcutsService({ api: api({ get }).api, platform: 'win32' })
    const reported: string[] = []
    service.setReporter(message => { reported.push(message) })
    await service.load()
    await service.reload()
    fail = true
    await service.reload()
    expect(reported).toEqual(['Some shortcuts were set aside.', 'Your shortcuts could not be read again, so the ones already loaded stay: Busy.'])
    expect(service.snapshot()).toMatchObject({ revision: 1, file: remap })
  })
})
