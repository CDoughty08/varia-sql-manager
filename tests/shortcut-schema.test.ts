import { describe, expect, it } from 'vitest'
import { emptyShortcutFile, parseShortcutText, readShortcutFile, shortcutFileSchema, shortcutLimits, type ShortcutReadResult } from '../src/shared/commands/shortcut-schema'

const read = (raw: unknown, options?: Parameters<typeof readShortcutFile>[1]) => {
  const result = readShortcutFile(raw, options)
  if (!result.ok) throw new Error(`not read: ${result.error}`)
  return result
}
const v1 = (rest: Record<string, unknown>) => ({ version: 1, scheme: 'default', bindings: [], gestures: {}, unknown: [], ...rest })

describe('shortcuts.json', () => {
  it('reads a valid file unchanged, and what it reads passes the strict schema', () => {
    const raw = v1({
      bindings: [
        { command: 'query.execute', key: 'ctrl+e', scope: 'global' },
        { command: 'query.execute', key: 'f5', remove: true },
        { command: 'view.zoomIn', key: 'ctrl+alt+f12', platform: 'linux' },
        { command: 'edit.toggleBookmark', key: 'mod+k mod+b', scope: 'queryEditor' }
      ],
      gestures: { 'explorer.peekHover': 'alt', 'grid.addToSelection': 'ctrl' },
      unknown: [{ command: 'future.command', key: 'f9' }]
    })
    const { file, problems } = read(raw)
    expect(problems).toEqual([])
    expect(file).toEqual(raw)
    expect(shortcutFileSchema.parse(file)).toEqual(raw)
    expect(shortcutFileSchema.parse(emptyShortcutFile)).toEqual(emptyShortcutFile)
    expect(shortcutLimits).toMatchObject({ fileBytes: 131072, bindings: 1024, key: 64, command: 128, unknown: 256, unknownBytes: 1024 })
  })
  it('keeps records this build does not understand verbatim, in unknown', () => {
    const foreign = [
      { command: 'future.command', key: 'f9' },
      { command: 'file.new', key: 'f9', scope: 'futureScope' },
      { command: 'file.new', key: 'numpad1' },
      { command: 'file.new', key: 'f9', when: 'editorFocus' },
      { command: 'file.new', key: 'f9', platform: 'freebsd' },
      { command: 'file.new', key: 'f9', remove: true, scope: 'global' },
      { command: 'file.new', key: 'f9', remove: false }
    ]
    const { file, problems } = read(v1({ bindings: [{ command: 'file.new', key: 'f9' }, ...foreign], future: { a: 1 } }))
    expect(problems).toEqual([])
    expect(file.bindings).toEqual([{ command: 'file.new', key: 'f9' }])
    expect(file.unknown).toEqual([...foreign, { future: { a: 1 } }])
    // Unknown records from the file itself stay first, ahead of those found on this read.
    expect(read(v1({ unknown: ['kept'], bindings: [foreign[0]] })).file.unknown).toEqual(['kept', foreign[0]])
  })
  it('moves gestures the catalogue does not know to unknown when given the catalogue', () => {
    const gestures = new Map([['grid.addToSelection', ['ctrl', 'alt']]])
    const { file } = read(v1({ gestures: { 'grid.addToSelection': 'alt', 'dock.future': 'ctrl', 'grid.addToSelection2': 'shift' } }), { gestures })
    expect(file.gestures).toEqual({ 'grid.addToSelection': 'alt' })
    expect(file.unknown).toEqual([{ gesture: 'dock.future', choice: 'ctrl' }, { gesture: 'grid.addToSelection2', choice: 'shift' }])
    expect(read(v1({ gestures: { 'grid.addToSelection': 'meta' } }), { gestures }).file.unknown).toEqual([{ gesture: 'grid.addToSelection', choice: 'meta' }])
  })
  it('drops malformed entries with fixed wording that never quotes the file', () => {
    const secret = 'hunter2-secret'
    const { file, problems } = read(v1({
      bindings: [secret, { command: 'file.new' }, { command: 'file.new', key: 'x'.repeat(65) }, { command: 'x'.repeat(129), key: 'f9' }, { command: 'file.new', key: 7 }],
      gestures: { [secret]: 'ctrl', 'grid.ok': secret.toUpperCase(), 'grid.n': 3 },
      scheme: `${secret} !`,
      unknown: [{ big: 'x'.repeat(shortcutLimits.unknownBytes) }]
    }))
    expect(file).toEqual(emptyShortcutFile)
    expect(problems).toEqual([
      'Unknown record 1 was dropped: an unknown record is limited to 1024 bytes.',
      'The scheme was reset to the default: it was not a scheme name.',
      ...[1, 2, 3, 4, 5].map(index => `Shortcut ${index} was dropped: it is not a shortcut.`),
      ...[1, 2, 3].map(index => `Gesture ${index} was dropped: it is not a gesture setting.`)
    ])
    expect(problems.join('\n')).not.toContain('hunter2')
    expect(read(v1({ bindings: {}, gestures: [], unknown: 'x' })).problems).toEqual([
      'The unknown records were dropped: they were not a list.', 'The shortcuts were dropped: they were not a list.', 'The gesture settings were dropped: they were not an object.'
    ])
  })
  it('enforces the counts', () => {
    const bindings = Array.from({ length: shortcutLimits.bindings + 2 }, () => ({ command: 'file.new', key: 'f9' }))
    const many = read(v1({ bindings }))
    expect(many.file.bindings).toHaveLength(shortcutLimits.bindings)
    expect(many.problems).toEqual(['Shortcut 1025 was dropped: the file keeps at most 1024 shortcuts.', 'Shortcut 1026 was dropped: the file keeps at most 1024 shortcuts.'])
    const unknown = read(v1({ unknown: Array.from({ length: shortcutLimits.unknown + 1 }, (_, index) => index) }))
    expect(unknown.file.unknown).toHaveLength(shortcutLimits.unknown)
    expect(unknown.problems).toEqual(['Unknown record 257 was dropped: the file keeps at most 256 unknown records.'])
    const gestures = read(v1({ gestures: Object.fromEntries(Array.from({ length: shortcutLimits.gestures + 1 }, (_, index) => [`grid.g${index}`, 'ctrl'])) }))
    expect(Object.keys(gestures.file.gestures)).toHaveLength(shortcutLimits.gestures)
    expect(gestures.problems).toEqual(['Gesture 65 was dropped: the file keeps at most 64 gestures.'])
    expect(shortcutFileSchema.safeParse(v1({ bindings })).success).toBe(false)
  })
  it('keeps a scheme it does not know by name, and the platform of an entry', () => {
    const { file } = read(v1({ scheme: 'vsCode', bindings: [{ command: 'file.new', key: 'mod+f9', platform: 'darwin' }] }))
    expect(file.scheme).toBe('vsCode')
    expect(file.bindings).toEqual([{ command: 'file.new', key: 'mod+f9', platform: 'darwin' }])
    expect(read({ version: 1 }).file).toEqual(emptyShortcutFile)
  })
  it('refuses a file that is not one, is newer, or is too large, without throwing', () => {
    const fails = (result: ShortcutReadResult) => result.ok ? 'ok' : result.error
    for (const raw of [null, [], 'text', 3, {}, { version: '1' }, { version: 0 }]) expect(fails(readShortcutFile(raw)), JSON.stringify(raw)).toBe('invalid')
    expect(fails(readShortcutFile({ version: 2, bindings: 'anything' }))).toBe('newer')
    expect(fails(parseShortcutText('{'))).toBe('invalid')
    expect(fails(parseShortcutText(JSON.stringify(v1({}))))).toBe('ok')
    expect(fails(parseShortcutText(JSON.stringify(v1({ unknown: ['x'.repeat(shortcutLimits.fileBytes)] }))))).toBe('size')
    // The limit counts UTF-8 bytes, not characters.
    const wide = JSON.stringify(v1({ scheme: 'default', pad: 'é'.repeat(shortcutLimits.fileBytes / 2) }))
    expect(wide.length).toBeLessThan(shortcutLimits.fileBytes)
    expect(fails(parseShortcutText(wide))).toBe('size')
  })
})
