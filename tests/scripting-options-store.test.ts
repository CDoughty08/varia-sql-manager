import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { ScriptingOptionsStore } from '../src/main/scripting-options-store'
import { scriptLimits } from '../src/shared/scripting/catalog'
import { defaultScriptingOptions, type ScriptingOptions } from '../src/shared/scripting/options'

let directory: string
beforeEach(async () => {
  await mkdir('artifacts', { recursive: true })
  directory = await mkdtemp(join(resolve('artifacts'), 'scripting-options-test-'))
})
afterEach(async () => {
  expect(directory.startsWith(resolve('artifacts') + sep)).toBe(true)
  await rm(directory, { recursive: true, force: true })
})

const path = () => join(directory, 'scripting-options.json')
const changed: ScriptingOptions = { ...defaultScriptingOptions, scriptUseDatabase: false, matchSourceSettings: false, targetServerVersion: '130' }
const stored = (options: Record<string, unknown>) => JSON.stringify({ version: 1, options })

describe('scripting options file', () => {
  it('uses the defaults for a missing file without writing one', async () => {
    expect(await new ScriptingOptionsStore(path()).load()).toEqual({ options: defaultScriptingOptions })
    expect(await readdir(directory)).toEqual([])
  })
  it('reads a valid file, dropping options a newer version added and filling ones an older version lacked', async () => {
    const { scriptUseDatabase: _, ...older } = changed
    await writeFile(path(), stored({ ...older, scriptFutureOption: 'kept out' }))
    expect(await new ScriptingOptionsStore(path()).load()).toEqual({ options: { ...changed, scriptUseDatabase: true } })
    expect(await readdir(directory)).toEqual(['scripting-options.json'])
  })
  it('quarantines invalid files, keeps their bytes, and says why once', async () => {
    const cases: [string | Buffer, string][] = [
      ['{"version":1,', 'not valid JSON'], [Buffer.from([0xff, 0xfe, 0x7b]), 'not UTF-8'], [' '.repeat(scriptLimits.prefsBytes + 1), 'larger than 16 KiB'],
      [stored({ scriptUseDatabase: 'no' }), 'unsupported values'], [stored({ targetServerVersion: '120' }), 'unsupported values'],
      [JSON.stringify({ version: 2, options: {} }), 'unsupported values'], [JSON.stringify({ version: 1, options: {}, extra: true }), 'unsupported values'],
      [JSON.stringify({ version: 1, options: [] }), 'unsupported values'], ['null', 'unsupported values']
    ]
    for (const [content, reason] of cases) {
      await rm(directory, { recursive: true, force: true }); await mkdir(directory)
      await writeFile(path(), content)
      const store = new ScriptingOptionsStore(path())
      expect(await store.load()).toEqual({ options: defaultScriptingOptions, warning: `Scripting options were invalid (${reason}) and were reset; the original file was kept.` })
      const [kept, ...rest] = await readdir(directory)
      expect(rest).toEqual([])
      expect(kept).toMatch(/^scripting-options\.json\.invalid-[0-9a-f-]{36}\.json$/)
      expect(await readFile(join(directory, kept))).toEqual(Buffer.from(content))
      // A reloaded window asks again: the file is not read again, and the warning is not repeated.
      expect(await store.load()).toEqual({ options: defaultScriptingOptions })
      expect(await readdir(directory)).toEqual([kept])
    }
  })
  it('gives callers that ask at the same time one read and one quarantine', async () => {
    await writeFile(path(), '{')
    const store = new ScriptingOptionsStore(path())
    const [first, second] = await Promise.all([store.load(), store.load()])
    expect([first.warning, second.warning].filter(Boolean)).toHaveLength(2)
    expect(await readdir(directory)).toHaveLength(1)
  })
  it('does not cache a read that failed, and overwrites nothing it could not read', async () => {
    await mkdir(path())
    const store = new ScriptingOptionsStore(path())
    await expect(store.load()).rejects.toThrow('Expected a regular file')
    await rm(path(), { recursive: true })
    await writeFile(path(), stored(changed))
    expect(await store.load()).toEqual({ options: changed })
  })
  it('writes atomically, one write after another, and rejects incomplete or unknown options', async () => {
    const store = new ScriptingOptionsStore(path())
    const versions = ['130', '140', '150', '170'] as const
    const results = await Promise.all(versions.map(targetServerVersion => store.save({ ...changed, targetServerVersion })))
    expect(results.map(options => options.targetServerVersion)).toEqual(versions)
    expect(JSON.parse(await readFile(path(), 'utf8'))).toEqual({ version: 1, options: { ...changed, targetServerVersion: '170' } })
    expect(await readdir(directory)).toEqual(['scripting-options.json'])
    expect(await store.load()).toEqual({ options: { ...changed, targetServerVersion: '170' } })
    const { scriptOwner: _, ...missing } = changed
    for (const invalid of [missing, { ...changed, extra: true }, { ...changed, scriptOwner: 'yes' }, { ...changed, targetEngineType: 'azure' }, null, [] as unknown]) {
      expect(() => store.save(invalid)).toThrow()
    }
    expect(await store.load()).toEqual({ options: { ...changed, targetServerVersion: '170' } })
    // A new store reads what the last write left.
    expect(await new ScriptingOptionsStore(path()).load()).toEqual({ options: { ...changed, targetServerVersion: '170' } })
  })
  it('keeps the options it last stored when a later write fails', async () => {
    const store = new ScriptingOptionsStore(path())
    await store.save(changed)
    // A folder in the file's place makes the rename that replaces it fail.
    await rm(path()); await mkdir(path()); await writeFile(join(path(), 'keep'), '')
    await expect(store.save(defaultScriptingOptions)).rejects.toThrow()
    expect(await store.load()).toEqual({ options: changed })
    expect((await readdir(directory)).sort()).toEqual(['scripting-options.json'])
  })
})
