import { describe, expect, it, vi } from 'vitest'
import { gestureChoiceTexts } from '../src/shared/commands/gesture-choices'
import { emptyShortcutFile, parseShortcutText, readShortcutFile, shortcutFileSchema, shortcutFileText, shortcutLimits, type ShortcutBinding, type ShortcutFile, type ShortcutReadResult } from '../src/shared/commands/shortcut-schema'

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
  it("refuses gesture ids that are Object.prototype's names", () => {
    const names = ['constructor', 'hasOwnProperty', 'toString', 'valueOf', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString']
    for (const name of names) {
      expect(shortcutFileSchema.safeParse(v1({ gestures: { [name]: 'alt' } })).success, name).toBe(false)
      expect(read(v1({ gestures: { [name]: 'alt' } })).problems, name).toEqual(['Gesture 1 was dropped: it is not a gesture setting.'])
    }
    // Names that only contain one are still ids.
    expect(shortcutFileSchema.safeParse(v1({ gestures: { 'grid.toString': 'alt', constructors: 'alt' } })).success).toBe(true)
  })
  it('measures the limit on the form main writes, indented when that fits and compact when only that does', () => {
    // Records of many small values: indenting puts each value on its own line, about five times the compact size.
    const fileWith = (count: number, values: number): ShortcutFile => ({ ...emptyShortcutFile, unknown: Array.from({ length: count }, () => Array.from({ length: values }, (_, index) => index % 10)) })
    const small = fileWith(1, 10)
    expect(shortcutFileText(small)).toBe(JSON.stringify(small, null, 2) + '\n')
    // About 120 KB compact, well over the limit indented: written compact, and its compact text reads back cleanly.
    const near = fileWith(shortcutLimits.unknown, 230)
    const compact = JSON.stringify(near)
    expect(Buffer.byteLength(compact)).toBeGreaterThan(shortcutLimits.fileBytes * 0.9)
    expect(Buffer.byteLength(compact)).toBeLessThanOrEqual(shortcutLimits.fileBytes)
    expect(Buffer.byteLength(JSON.stringify(near, null, 2))).toBeGreaterThan(shortcutLimits.fileBytes)
    expect(shortcutFileText(near)).toBe(compact)
    const parsed = parseShortcutText(compact)
    expect(parsed.ok && parsed.problems).toEqual([])
    expect(shortcutFileText(fileWith(shortcutLimits.unknown, 260))).toBeUndefined()
  })
  it('salvages a file under the limit that would be over it once its records move to unknown (#237)', () => {
    // Each member this build does not know is kept wrapped as { name: value }, two bytes more than it took.
    const count = 250, length = Math.floor(shortcutLimits.fileBytes / count) - 20
    const members: Record<string, string> = Object.fromEntries(Array.from({ length: count }, (_, index) => [`m${index}`, 'x'.repeat(length)]))
    const base = Buffer.byteLength(JSON.stringify(v1(members)))
    // Spread the rest over the members, so each stays an unknown record under its own limit.
    const spare = shortcutLimits.fileBytes - 50 - base
    for (let index = 0; index < count; index++) members[`m${index}`] += 'x'.repeat(Math.floor(spare / count) + (index < spare % count ? 1 : 0))
    const text = JSON.stringify(v1(members))
    expect(Buffer.byteLength(text)).toBe(shortcutLimits.fileBytes - 50)
    const result = parseShortcutText(text)
    if (!result.ok) throw new Error(result.error)
    // The records this read moved go, last first, until the file fits; it loads (salvaged) instead of being reset.
    expect(result.file.unknown.length).toBeLessThan(count)
    expect(result.file.unknown.length).toBeGreaterThan(count - 10)
    expect(result.file.unknown[0]).toEqual({ m0: members.m0 })
    expect(result.problems.at(-1)).toMatch(/^A member this build does not know was dropped: keeping it would make the file larger than 128 KiB\.$/)
    expect(Buffer.byteLength(shortcutFileText(result.file) ?? '')).toBeGreaterThan(0)
    expect(Buffer.byteLength(shortcutFileText(result.file)!)).toBeLessThanOrEqual(shortcutLimits.fileBytes)
  })
})

describe('shortcuts file records kept for later', () => {
  const options = { gestures: gestureChoiceTexts }
  const v1 = (extra: Record<string, unknown>) => ({ version: 1, scheme: 'default', bindings: [], gestures: {}, unknown: [], ...extra })
  it('moves a gesture choice and a binding back from unknown once this build understands them (#239)', () => {
    const kept = { command: 'future.command', key: 'ctrl+alt+q' }
    const result = readShortcutFile(v1({
      bindings: [{ command: 'query.execute', key: 'ctrl+e' }],
      unknown: [{ gesture: 'grid.addToSelection', choice: 'alt' }, kept, { command: 'file.new', key: 'mod+shift+f9' }, { gesture: 'grid.addToSelection', choice: 'shift' }]
    }), options)
    if (!result.ok) throw new Error(result.error)
    expect(result.problems).toEqual([])
    expect(result.file.gestures).toEqual({ 'grid.addToSelection': 'alt' })
    // Restored bindings follow the file's own, in their order; what is still not understood stays verbatim, in order.
    expect(result.file.bindings).toEqual([{ command: 'query.execute', key: 'ctrl+e' }, { command: 'file.new', key: 'mod+shift+f9' }])
    expect(result.file.unknown).toEqual([kept, { gesture: 'grid.addToSelection', choice: 'shift' }])
  })
  it("keeps the file's own gesture setting over one kept in unknown", () => {
    const result = readShortcutFile(v1({ gestures: { 'grid.addToSelection': 'mod' }, unknown: [{ gesture: 'grid.addToSelection', choice: 'alt' }] }), options)
    if (!result.ok) throw new Error(result.error)
    expect(result.file.gestures).toEqual({ 'grid.addToSelection': 'mod' })
    expect(result.file.unknown).toEqual([])
  })
  it('keeps an unoffered gesture choice in gestures when unknown is full, rather than dropping it (#239)', () => {
    const full = Array.from({ length: shortcutLimits.unknown }, (_, index) => ({ kept: index }))
    const result = readShortcutFile(v1({ gestures: { 'grid.addToSelection': 'shift' }, unknown: full }), options)
    if (!result.ok) throw new Error(result.error)
    expect(result.problems).toEqual([])
    expect(result.file.gestures).toEqual({ 'grid.addToSelection': 'shift' })
    expect(result.file.unknown).toHaveLength(shortcutLimits.unknown)
  })
  it('keeps a binding in unknown, verbatim and in place, when the bindings cap leaves no room for its restore (#314)', () => {
    const full = Array.from({ length: shortcutLimits.bindings }, () => ({ command: 'query.execute', key: 'ctrl+e' }))
    const kept = { command: 'future.command', key: 'f9' }
    const raw = v1({ bindings: full, unknown: [{ command: 'query.execute', key: 'f6' }, kept, { command: 'file.new', key: 'f7', platform: 'linux' }] })
    const result = readShortcutFile(raw, options)
    if (!result.ok) throw new Error(result.error)
    expect(result.problems).toEqual([])
    expect(result.file.bindings).toEqual(full)
    expect(result.file.unknown).toEqual(raw.unknown)
    // One place free: the first restores, the next stays.
    const room = readShortcutFile({ ...raw, bindings: full.slice(1) }, options)
    if (!room.ok) throw new Error(room.error)
    expect(room.problems).toEqual([])
    expect(room.file.bindings).toEqual([...full.slice(1), { command: 'query.execute', key: 'f6' }])
    expect(room.file.unknown).toEqual([kept, { command: 'file.new', key: 'f7', platform: 'linux' }])
  })
  it('keeps a gesture choice in unknown, verbatim and in place, when the gestures cap leaves no room for its restore (#314)', () => {
    const ids = Array.from({ length: shortcutLimits.gestures + 2 }, (_, index) => `test.gesture${index}`)
    const many = { gestures: new Map(ids.map(id => [id, ['alt', 'ctrl']] as const)) }
    const own = Object.fromEntries(ids.slice(0, shortcutLimits.gestures).map(id => [id, 'alt']))
    const restorable = [{ gesture: ids[shortcutLimits.gestures], choice: 'ctrl' }, { gesture: ids[shortcutLimits.gestures + 1], choice: 'alt' }]
    // The file's own setting for an id still wins over the record kept for it, which is dropped as before.
    const shadowed = { gesture: ids[0], choice: 'ctrl' }
    const raw = v1({ gestures: own, unknown: [restorable[0], shadowed, { kept: 1 }, restorable[1]] })
    const result = readShortcutFile(raw, many)
    if (!result.ok) throw new Error(result.error)
    expect(result.problems).toEqual([])
    expect(result.file.gestures).toEqual(own)
    expect(result.file.unknown).toEqual([restorable[0], { kept: 1 }, restorable[1]])
    // One place free: the first restores, the next stays.
    const { [ids[0]]: _, ...fewer } = own
    const room = readShortcutFile({ ...raw, gestures: fewer, unknown: [restorable[0], { kept: 1 }, restorable[1]] }, many)
    if (!room.ok) throw new Error(room.error)
    expect(room.problems).toEqual([])
    expect(room.file.gestures).toEqual({ ...fewer, [restorable[0].gesture]: 'ctrl' })
    expect(room.file.unknown).toEqual([{ kept: 1 }, restorable[1]])
  })
  it('settles a restored gesture and an unoffered own choice together, so reading what it wrote changes nothing (#314)', () => {
    const ids = Array.from({ length: shortcutLimits.gestures + 6 }, (_, index) => `test.gesture${index}`)
    const many = { gestures: new Map(ids.map(id => [id, ['alt', 'ctrl']] as const)) }
    // One place short of the cap, plus an own choice this build does not offer, which goes live only when `unknown` is full.
    const own: Record<string, string> = Object.fromEntries(ids.slice(0, shortcutLimits.gestures - 1).map(id => [id, 'alt']))
    const unoffered = ids[shortcutLimits.gestures - 1]
    own[unoffered] = 'zzz'
    const restorable = { gesture: ids[shortcutLimits.gestures + 1], choice: 'ctrl' }
    const others = Array.from({ length: shortcutLimits.unknown - 1 }, (_, index) => ({ kept: index }))
    const foreign = { command: 'future.x', key: 'f9' }
    const raw = v1({ bindings: [foreign], gestures: own, unknown: [others[0], restorable, ...others.slice(1)] })
    const result = readShortcutFile(raw, many)
    if (!result.ok) throw new Error(result.error)
    // The restored gesture takes the last place and the unoffered choice the last record; the foreign binding, moved after
    // both, is what the cap drops. Before, the binding took the record first, the unoffered choice stayed live, and reading
    // the written file again swapped them, so a save on the salvaged revision was STALE.
    const { [unoffered]: _, ...live } = own
    expect(result.file.gestures).toEqual({ ...live, [restorable.gesture]: 'ctrl' })
    expect(result.file.unknown).toEqual([...others, { gesture: unoffered, choice: 'zzz' }])
    expect(result.problems).toEqual([`Shortcut 1 was dropped: the file keeps at most ${shortcutLimits.unknown} unknown records.`])
    const again = readShortcutFile(JSON.parse(JSON.stringify(result.file)), many)
    expect(again).toEqual({ ok: true, file: result.file, problems: [] })
  })
  it('reads its own output back unchanged around the unknown and gesture caps (#314)', () => {
    const ids = Array.from({ length: shortcutLimits.gestures + 6 }, (_, index) => `test.gesture${index}`)
    const many = { gestures: new Map(ids.map(id => [id, ['alt', 'ctrl']] as const)) }
    // Vary how full each cap is, how many own choices are unoffered and how many gestures wait in `unknown`.
    for (const ownCount of [shortcutLimits.gestures - 3, shortcutLimits.gestures - 1, shortcutLimits.gestures])
      for (const unofferedCount of [0, 1, 2, 3])
        for (const restorableCount of [1, 2, 3])
          for (const otherCount of [shortcutLimits.unknown - 4, shortcutLimits.unknown - 2, shortcutLimits.unknown - 1, shortcutLimits.unknown])
            for (const foreignCount of [0, 1, 2]) {
              const own: Record<string, string> = Object.fromEntries(ids.slice(0, ownCount - unofferedCount).map(id => [id, 'alt']))
              ids.slice(ownCount - unofferedCount, ownCount).forEach(id => { own[id] = 'zzz' })
              const restorable = ids.slice(shortcutLimits.gestures + 1, shortcutLimits.gestures + 1 + restorableCount).map(gesture => ({ gesture, choice: 'ctrl' }))
              const others = Array.from({ length: otherCount }, (_, index) => ({ kept: index }))
              const bindings = Array.from({ length: foreignCount }, (_, index) => ({ command: `future.x${index}`, key: 'f9' }))
              const first = readShortcutFile(v1({ bindings, gestures: own, unknown: [...restorable, ...others] }), many)
              if (!first.ok) throw new Error(first.error)
              const again = readShortcutFile(JSON.parse(JSON.stringify(first.file)), many)
              expect(again, `${ownCount}/${unofferedCount}/${restorableCount}/${otherCount}/${foreignCount}`).toEqual({ ok: true, file: first.file, problems: [] })
            }
  })
  it('reports a restorable gesture record it cannot keep when an unoffered own choice shadows it (#383)', () => {
    const ids = Array.from({ length: 20 }, (_, index) => `test.g${index}`)
    const many = { gestures: new Map(ids.map(id => [id, ['alt', 'ctrl']] as const)) }
    const record = { gesture: 'test.g0', choice: 'ctrl' }
    const others = Array.from({ length: shortcutLimits.unknown }, (_, index) => ({ kept: index }))
    // The issue's file: `unknown` is over its cap, so the own choice this build does not offer stays live and shadows the
    // record. Before, the record vanished with no problem reported, so main never salvaged the file.
    const full = readShortcutFile(v1({ gestures: { 'test.g0': 'zzz' }, unknown: [record, ...others] }), many)
    if (!full.ok) throw new Error(full.error)
    expect(full.file.gestures).toEqual({ 'test.g0': 'zzz' })
    expect(full.file.unknown).toEqual(others)
    expect(full.problems).toEqual([`Unknown record 1 was dropped: the file keeps at most ${shortcutLimits.unknown} unknown records.`])
    // Around the cap nothing is lost unreported: the record is live, kept in `unknown`, or named in a problem, and reading
    // the result again changes nothing.
    for (const otherCount of [shortcutLimits.unknown - 2, shortcutLimits.unknown - 1, shortcutLimits.unknown, shortcutLimits.unknown + 1])
      for (const unofferedCount of [1, 2, 3]) {
        const own = Object.fromEntries(ids.slice(0, unofferedCount).reverse().map(id => [id, 'zzz']))
        const result = readShortcutFile(v1({ gestures: own, unknown: [record, ...others.slice(0, otherCount), ...otherCount > others.length ? [{ kept: 'more' }] : []] }), many)
        if (!result.ok) throw new Error(result.error)
        const name = `${otherCount}/${unofferedCount}`
        const kept = result.file.gestures['test.g0'] === 'ctrl' || result.file.unknown.some(value => JSON.stringify(value) === JSON.stringify(record))
        expect(kept || result.problems.length > 0, name).toBe(true)
        expect(shortcutFileSchema.safeParse(result.file).success, name).toBe(true)
        expect(readShortcutFile(JSON.parse(JSON.stringify(result.file)), many), name).toEqual({ ok: true, file: result.file, problems: [] })
      }
  })
  it("keeps the bindings of a file a few bytes under the limit whose gesture moves to unknown (#237)", () => {
    // The issue's file: ten bindings, unknown records filling it to just under the limit, and a choice this build lacks.
    const bindings = Array.from({ length: 10 }, (_, index) => ({ command: 'query.execute', key: `ctrl+shift+f${index + 1}` }))
    const filler = (index: number, length: number) => ({ filler: index, text: 'x'.repeat(length) })
    const base = v1({ bindings, gestures: { 'explorer.peekHover': 'hyper' }, unknown: Array.from({ length: 131 }, (_, index) => filler(index, 900)) })
    // Spread the rest over the records, so the text ends 10 bytes under the limit and each record stays under 1 KiB.
    const records = base.unknown as { text: string }[], spare = shortcutLimits.fileBytes - 10 - Buffer.byteLength(JSON.stringify(base))
    records.forEach((record, index) => { record.text += 'x'.repeat(Math.floor(spare / records.length) + (index < spare % records.length ? 1 : 0)) })
    const text = JSON.stringify(base)
    expect(Buffer.byteLength(text)).toBe(shortcutLimits.fileBytes - 10)
    const result = parseShortcutText(text, options)
    if (!result.ok) throw new Error(result.error)
    expect(result.file.bindings).toEqual(bindings)
    expect(shortcutFileText(result.file)).toBeDefined()
  })
})

describe('shortcuts file size', () => {
  it('counts the indented size exactly as JSON.stringify writes it', () => {
    const samples: ShortcutFile[] = [
      emptyShortcutFile,
      { ...emptyShortcutFile, bindings: [{ command: 'query.execute', key: 'ctrl+e', scope: 'global' }], gestures: { 'grid.addToSelection': 'alt' } },
      { ...emptyShortcutFile, unknown: [[], {}, [[[1, 'é', null, true]]], { a: { b: [] }, 'ü"\\': 'q' }, 'text'] }
    ]
    for (const file of samples) {
      const text = shortcutFileText(file)
      expect(text).toBe(JSON.stringify(file, null, 2) + '\n')
    }
  })
  it('writes the indented form exactly up to the limit and the compact form one byte past it', () => {
    // Many non-empty containers, so a miscount of even one byte per container shows as kilobytes.
    const bindings: ShortcutBinding[] = Array.from({ length: 300 }, (_, index) => ({ command: 'query.execute', key: `ctrl+shift+f${index % 12 + 1}`, platform: 'darwin' }))
    const nested = [[[{ a: [1, { b: 'é' }] }]], { c: {} }]
    const padded = (length: number): ShortcutFile => ({ ...emptyShortcutFile, bindings, unknown: [nested, 'x'.repeat(length)] })
    const prettyBytes = (file: ShortcutFile) => Buffer.byteLength(JSON.stringify(file, null, 2) + '\n')
    const exact = shortcutLimits.fileBytes - prettyBytes(padded(0))
    expect(prettyBytes(padded(exact))).toBe(shortcutLimits.fileBytes)
    expect(shortcutFileText(padded(exact))).toBe(JSON.stringify(padded(exact), null, 2) + '\n')
    expect(shortcutFileText(padded(exact + 1))).toBe(JSON.stringify(padded(exact + 1)))
    // What main writes reads back.
    expect(parseShortcutText(shortcutFileText(padded(exact))!).ok).toBe(true)
    expect(parseShortcutText(shortcutFileText(padded(exact + 1))!).ok).toBe(true)
  })
  it('never builds the indented text of a deeply nested file that cannot fit indented (#240)', () => {
    // 127 records nested about 500 arrays deep: each is under 1 KiB compact but indents to half a megabyte.
    const nested = (depth: number): unknown => depth ? [nested(depth - 1)] : 0
    const file: ShortcutFile = { ...emptyShortcutFile, unknown: Array.from({ length: 127 }, () => nested(500)) }
    expect(Buffer.byteLength(JSON.stringify(file))).toBeLessThan(shortcutLimits.fileBytes)
    const stringify = vi.spyOn(JSON, 'stringify')
    try {
      const text = shortcutFileText(file)
      expect(text).toBe(JSON.stringify(file))
      expect(stringify.mock.calls.filter(call => call[2] !== undefined)).toEqual([])
    } finally { stringify.mockRestore() }
  })
})
