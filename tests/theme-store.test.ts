import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { AppearanceStore } from '../src/main/appearance-store'
import { AppearanceService, type NativeThemeLike } from '../src/main/appearance'
import { readRegularFile } from '../src/main/json-file'
import { scanThemes, schemaFileName, writeSchemaFile } from '../src/main/theme-files'
import { buildThemeJsonSchema } from '../src/shared/theme/schema'
import { parseThemeFile, themeLimits } from '../src/shared/theme/format'
import { resolveBuiltin } from '../src/shared/theme/resolve'
import type { ThemeMode, ThemePreference, ThemeState } from '../src/shared/theme/types'

let directory: string, themes: string
beforeEach(async () => {
  await mkdir('artifacts', { recursive: true })
  directory = await mkdtemp(join(resolve('artifacts'), 'theme-store-test-'))
  themes = join(directory, 'themes')
})
afterEach(async () => {
  vi.restoreAllMocks()
  expect(directory.startsWith(resolve('artifacts') + sep)).toBe(true)
  await rm(directory, { recursive: true, force: true })
})

const posix = process.platform !== 'win32'
const root = process.getuid?.() === 0
const theme = (fields: Record<string, unknown> = {}) => JSON.stringify({ kind: 'varia-color-theme', version: 1, name: 'Test', type: 'dark', ...fields })
async function themeFiles(files: Record<string, string | Uint8Array>) {
  await mkdir(themes, { recursive: true })
  for (const [name, content] of Object.entries(files)) await writeFile(join(themes, name), content)
}
const preference = (fields: Partial<ThemePreference>) => writeFile(join(directory, 'appearance.json'), JSON.stringify({ version: 1, mode: 'dark', darkTheme: 'varia-dark', lightTheme: 'varia-light', ...fields }))
const userThemes = (state: ThemeState) => state.themes.filter(item => item.source === 'user').map(item => item.id)

/** Records every `themeSource` assignment; System follows `systemDark`. */
class FakeNativeTheme implements NativeThemeLike {
  assignments: ThemeMode[] = []
  private source: ThemeMode = 'system'
  constructor(public systemDark = false) {}
  get themeSource() { return this.source }
  set themeSource(value: ThemeMode) { this.assignments.push(value); this.source = value }
  get shouldUseDarkColors() { return this.source === 'system' ? this.systemDark : this.source === 'dark' }
}
async function service(systemDark = false) {
  const nativeTheme = new FakeNativeTheme(systemDark)
  const appearance = new AppearanceService({ userData: directory, nativeTheme })
  const published: ThemeState[] = []
  appearance.onDidChange(state => published.push(state))
  await appearance.initialize()
  return { appearance, nativeTheme, published }
}

describe('appearance preferences file', () => {
  const path = () => join(directory, 'appearance.json')
  it('uses defaults for a missing file without writing one', async () => {
    expect(await new AppearanceStore(path()).load()).toEqual({ preference: { version: 1, mode: 'dark', darkTheme: 'varia-dark', lightTheme: 'varia-light' } })
    expect(await readdir(directory)).toEqual([])
  })
  it('quarantines invalid files, keeps their bytes, and says why', async () => {
    const cases: [string | Buffer, string][] = [
      ['{"version":1,', 'not valid JSON'], ['{"version":1,"mode":"blue","darkTheme":"varia-dark","lightTheme":"varia-light"}', 'unsupported values'],
      [Buffer.from([0xff, 0xfe, 0x7b]), 'not UTF-8'], [' '.repeat(themeLimits.appearanceBytes + 1), 'larger than 4 KiB'],
      ['{"version":1,"mode":"dark","darkTheme":"../x","lightTheme":"varia-light"}', 'unsupported values'],
      ['{"version":1,"mode":"dark","darkTheme":"varia-dark","lightTheme":"varia-light","extra":true}', 'unsupported values']
    ]
    for (const [content, reason] of cases) {
      await rm(directory, { recursive: true, force: true }); await mkdir(directory)
      await writeFile(path(), content)
      const result = await new AppearanceStore(path()).load()
      expect(result.preference.mode).toBe('dark')
      expect(result.warning).toBe(`Theme preferences were invalid (${reason}) and were reset; the original file was kept.`)
      const [kept, ...rest] = await readdir(directory)
      expect(rest).toEqual([])
      expect(kept).toMatch(/^appearance\.json\.invalid-[0-9a-f-]{36}\.json$/)
      expect(await readFile(join(directory, kept))).toEqual(Buffer.from(content))
    }
  })
  it('writes atomically, one write after another, and rejects invalid preferences', async () => {
    const store = new AppearanceStore(path())
    const modes: ThemeMode[] = ['light', 'system', 'dark', 'light']
    await Promise.all(modes.map(mode => store.save({ version: 1, mode, darkTheme: 'varia-dark', lightTheme: 'harbor' })))
    expect(JSON.parse(await readFile(path(), 'utf8'))).toEqual({ version: 1, mode: 'light', darkTheme: 'varia-dark', lightTheme: 'harbor' })
    expect(await readdir(directory)).toEqual(['appearance.json'])
    expect(() => store.save({ version: 1, mode: 'dark', darkTheme: '../x', lightTheme: 'varia-light' })).toThrow()
    expect((await store.load()).preference.lightTheme).toBe('harbor')
  })
})

describe('theme folder scan', () => {
  it('treats a missing folder as empty and a file in its place as unreadable', async () => {
    expect(await scanThemes(themes)).toEqual({ themes: [], problems: [], files: 0 })
    await writeFile(themes, 'not a folder')
    const scan = await scanThemes(themes)
    expect(scan.themes).toEqual([])
    expect(scan.problems).toMatchObject([{ severity: 'error', code: 'E_READ', file: 'themes', path: '' }])
    const { appearance } = await service()
    expect(await appearance.reload()).toMatchObject({ notice: 'Reloaded 0 themes; the themes folder could not be read.', problems: [{ code: 'E_READ', file: 'themes' }] })
  })
  it('reads regular .json files with valid, unreserved names, and reports a folder named like a theme', async () => {
    await themeFiles({
      'good.json': theme({ name: 'Good' }), 'Mixed_Case-1.json': theme(), 'notes.txt': 'x', '.varia-1.tmp': 'x', [schemaFileName]: '{}',
      'bad name.json': theme(), '.hidden.json': theme(), 'UPPER.JSON': theme(), [`${'a'.repeat(49)}.json`]: theme(), 'varia-dark.json': theme()
    })
    await mkdir(join(themes, 'folder.json'))
    const scan = await scanThemes(themes)
    expect(scan.files).toBe(8)
    expect(scan.themes.map(item => [item.id, item.fileName, item.result.theme?.name]).sort()).toEqual([['folder', 'folder.json', undefined], ['good', 'good.json', 'Good'], ['mixed_case-1', 'Mixed_Case-1.json', 'Test']])
    expect(scan.themes.find(item => item.id === 'folder')?.result.problems).toMatchObject([{ severity: 'error', code: 'E_READ', file: 'folder.json', message: expect.stringContaining('does not follow links or read folders') }])
    expect(scan.problems.map(problem => [problem.file, problem.code]).sort()).toEqual([
      ['.hidden.json', 'E_FILE_NAME'], ['UPPER.JSON', 'E_FILE_NAME'], [`${'a'.repeat(49)}.json`, 'E_FILE_NAME'], ['bad name.json', 'E_FILE_NAME'], ['varia-dark.json', 'E_RESERVED']
    ])
  })
  it.skipIf(!posix)('reports symbolic links as unusable themes instead of following them', async () => {
    await writeFile(join(directory, 'outside.json'), theme())
    await themeFiles({ 'real.json': theme() })
    await symlink(join(directory, 'outside.json'), join(themes, 'link.json'))
    const scan = await scanThemes(themes)
    expect(scan.themes.map(item => [item.id, item.result.theme?.name, item.result.problems.map(problem => problem.code)])).toEqual([['link', undefined, ['E_READ']], ['real', 'Test', []]])
    // A selected linked theme, as a dotfiles setup makes, explains itself instead of reading as missing.
    await preference({ darkTheme: 'link' })
    const { appearance } = await service()
    expect(appearance.state).toMatchObject({ fallback: true, notice: 'The theme `link` has errors and cannot be used; Varia Dark is used instead.' })
    expect(appearance.state.problems).toMatchObject([{ file: 'link.json', code: 'E_READ', message: expect.stringContaining('copy the theme file itself into the themes folder') }])
    expect((await appearance.reload()).notice).toBe('Reloaded 2 themes; 1 has problems. The theme `link` has errors and cannot be used; Varia Dark is used instead.')
  })
  it('reports oversized, non-UTF-8, invalid JSON, and invalid theme files without changing them', async () => {
    const files = {
      'large.json': theme({ description: 'x'.repeat(themeLimits.fileBytes) }), 'latin1.json': Buffer.from([0x7b, 0xe9, 0x7d]),
      'comments.json': '{ // comment\n}', 'vscode.json': JSON.stringify({ name: 'x', colors: {} }), 'bom.json': '﻿' + theme({ name: 'Bom' })
    }
    await themeFiles(files)
    const scan = await scanThemes(themes)
    const codes = Object.fromEntries(scan.themes.map(item => [item.fileName, item.result.problems.map(problem => problem.code)]))
    expect(codes).toEqual({ 'large.json': ['E_TOO_LARGE'], 'latin1.json': ['E_ENCODING'], 'comments.json': ['E_JSON'], 'vscode.json': ['E_KIND', 'E_VERSION', 'E_FIELD'], 'bom.json': [] })
    expect(scan.themes.find(item => item.id === 'bom')?.result.theme?.name).toBe('Bom')
    for (const [name, content] of Object.entries(files)) expect(await readFile(join(themes, name))).toEqual(Buffer.from(content))
  })
  it('loads the first 64 files by name and warns about the rest', async () => {
    await themeFiles(Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`t${String(index).padStart(2, '0')}.json`, theme()])))
    const scan = await scanThemes(themes)
    expect(scan.files).toBe(64)
    expect(scan.themes).toHaveLength(64)
    expect(scan.themes.map(item => item.id)).not.toContain('t64')
    expect(scan.problems).toMatchObject([{ severity: 'warning', code: 'W_TOO_MANY_FILES', file: 't64.json' }])
    // The skipped file is listed, but it is not one of the reloaded themes with problems.
    const { appearance } = await service()
    expect(await appearance.reload()).toMatchObject({ notice: 'Reloaded 64 themes; 0 have problems.', problems: [{ code: 'W_TOO_MANY_FILES', file: 't64.json' }] })
  })
  it('rejects both files when ids differ only in case', async () => {
    await themeFiles({ 'Harbor.json': theme() })
    const caseSensitive = await stat(join(themes, 'harbor.json')).then(() => false, () => true)
    if (!caseSensitive) return
    await themeFiles({ 'harbor.json': theme() })
    const scan = await scanThemes(themes)
    expect(scan.themes).toHaveLength(1)
    expect(scan.themes[0]).toMatchObject({ id: 'harbor', result: { theme: null } })
    expect(scan.themes[0].result.problems.map(problem => [problem.code, problem.file])).toEqual([['E_DUPLICATE_ID', 'Harbor.json'], ['E_DUPLICATE_ID', 'harbor.json']])
  })
  it.skipIf(!posix || root)('reports unreadable files', async () => {
    await themeFiles({ 'locked.json': theme() })
    await chmod(join(themes, 'locked.json'), 0o000)
    try { expect((await scanThemes(themes)).themes[0].result.problems).toMatchObject([{ code: 'E_READ', message: 'The file could not be read (EACCES).' }]) }
    finally { await chmod(join(themes, 'locked.json'), 0o644) }
  })
  it('reads only the files that pass the filter', async () => {
    await themeFiles({ 'a.json': theme(), 'b.json': '{', 'c.json': theme() })
    const scan = await scanThemes(themes, id => id === 'c')
    expect(scan.themes.map(item => item.id)).toEqual(['c'])
  })
  it('reads a file only if it is still the one an earlier lstat saw', async () => {
    await themeFiles({ 'a.json': theme(), 'b.json': theme() })
    const a = await lstat(join(themes, 'a.json'), { bigint: true }), b = await lstat(join(themes, 'b.json'), { bigint: true })
    expect((await readRegularFile(join(themes, 'a.json'), 1024, { expect: a }))?.toString()).toBe(theme())
    expect(await readRegularFile(join(themes, 'a.json'), 1024, { expect: b })).toBeUndefined()
    expect(await readRegularFile(join(themes, 'a.json'), 4)).toHaveLength(5)
  })
  it.skipIf(!posix)('never waits on a FIFO swapped in for a file it reads', async () => {
    const fifo = (path: string) => execFileSync('mkfifo', [path])
    await mkdir(themes)
    // The type is checked on the opened handle, so there is no gap between check and read for a swap to slip into,
    // and opening a FIFO without a writer returns at once instead of blocking.
    fifo(join(themes, 'pipe.json'))
    expect(await readRegularFile(join(themes, 'pipe.json'), 1024)).toBeUndefined()
    fifo(join(themes, schemaFileName))
    expect(await writeSchemaFile(themes)).toBe(true)
    expect(JSON.parse(await readFile(join(themes, schemaFileName), 'utf8'))).toEqual(buildThemeJsonSchema())
    fifo(join(directory, 'appearance.json'))
    const { appearance } = await service()
    expect(appearance.state.notice).toBe('Theme preferences could not be read; the defaults are used and changes are not saved.')
    // The service's queue is not stuck behind the read.
    expect((await appearance.setPreference({ mode: 'light' })).active.id).toBe('varia-light')
  })
  it('rewrites the schema file only when its content differs', async () => {
    await mkdir(themes)
    const path = join(themes, schemaFileName)
    expect(await writeSchemaFile(themes)).toBe(true)
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(buildThemeJsonSchema())
    const first = await stat(path)
    expect(await writeSchemaFile(themes)).toBe(false)
    expect((await stat(path)).ino).toBe(first.ino)
    await writeFile(path, '{}')
    expect(await writeSchemaFile(themes)).toBe(true)
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(buildThemeJsonSchema())
  })
})

describe('appearance service', () => {
  it('starts on Varia Dark without writing anything', async () => {
    const { appearance, nativeTheme, published } = await service()
    expect(appearance.state).toMatchObject({ revision: 0, preference: { mode: 'dark' }, fallback: false, problems: [], problemsOmitted: 0 })
    expect(appearance.state.active).toEqual(resolveBuiltin('dark'))
    expect(appearance.state.notice).toBeUndefined()
    expect(appearance.state.themes.map(item => [item.id, item.name, item.types])).toEqual([['varia-dark', 'Varia Dark', ['dark']], ['varia-light', 'Varia Light', ['light']]])
    expect(nativeTheme.assignments).toEqual(['dark'])
    expect(appearance.windowChrome()).toEqual({ backgroundColor: '#11151c', overlay: { color: '#181f2a', symbolColor: '#d9e1ec' } })
    await appearance.scan()
    expect(published).toEqual([])
    expect(await readdir(directory)).toEqual([])
  })
  it('reads only the selected theme files at startup, then the whole folder', async () => {
    await themeFiles({ 'a.json': theme({ name: 'A' }), 'b.json': theme({ name: 'B', type: 'light' }), 'c.json': theme(), 'd.json': '{', 'e.json': theme({ type: 'dual' }) })
    await preference({ mode: 'dark', darkTheme: 'a', lightTheme: 'b' })
    const fixed = await service()
    expect(userThemes(fixed.appearance.state)).toEqual(['a'])
    expect(fixed.appearance.state.active).toMatchObject({ id: 'a', name: 'A', type: 'dark' })
    await preference({ mode: 'system', darkTheme: 'a', lightTheme: 'b' })
    const system = await service(false)
    expect(userThemes(system.appearance.state)).toEqual(['a', 'b'])
    expect(system.appearance.state.active).toMatchObject({ id: 'b', type: 'light' })
    expect(system.appearance.state.problems).toEqual([])
    await system.appearance.scan()
    // Sorted by name, then id; an unusable theme is listed under its id.
    expect(userThemes(system.appearance.state)).toEqual(['a', 'b', 'd', 'c', 'e'])
    expect(system.appearance.state.themes.find(item => item.id === 'd')).toMatchObject({ usable: false, types: [], errors: 1 })
    expect(system.appearance.state.themes.find(item => item.id === 'e')).toMatchObject({ usable: true, types: ['dark', 'light'] })
    expect(system.published.at(-1)?.revision).toBe(system.appearance.state.revision)
  })
  it('falls back to the built-in for a missing or broken theme and keeps the preference', async () => {
    await preference({ darkTheme: 'gone' })
    const bytes = await readFile(join(directory, 'appearance.json'))
    const missing = await service()
    expect(missing.appearance.state).toMatchObject({ fallback: true, preference: { darkTheme: 'gone' }, active: { id: 'varia-dark' }, notice: 'The theme `gone` was not found in the themes folder; Varia Dark is used instead.' })
    expect(await readFile(join(directory, 'appearance.json'))).toEqual(bytes)
    await themeFiles({ 'gone.json': '{"kind":"varia-color-theme","version":2}', 'other.json': '{' })
    const source = await readFile(join(themes, 'gone.json'))
    const broken = await service()
    expect(broken.appearance.state).toMatchObject({ fallback: true, active: { id: 'varia-dark' }, notice: 'The theme `gone` has errors and cannot be used; Varia Dark is used instead.' })
    await broken.appearance.reload()
    expect(broken.appearance.state.problems.map(problem => [problem.file, problem.code])).toEqual([['gone.json', 'E_VERSION'], ['gone.json', 'E_FIELD'], ['gone.json', 'E_FIELD'], ['other.json', 'E_JSON']])
    expect(broken.appearance.state.notice).toBe('Reloaded 2 themes; 2 have problems. The theme `gone` has errors and cannot be used; Varia Dark is used instead.')
    expect(await readFile(join(themes, 'gone.json'))).toEqual(source)
    await writeFile(join(themes, 'gone.json'), theme({ name: 'Gone' }))
    expect(await broken.appearance.reload()).toMatchObject({ fallback: false, active: { id: 'gone', name: 'Gone' }, notice: 'Reloaded 2 themes; 1 has problems.' })
    expect(await readFile(join(themes, 'other.json'), 'utf8')).toBe('{')
  })
  it('validates choices before applying or saving them', async () => {
    await themeFiles({ 'broken.json': '{', 'lighter.json': theme({ type: 'light' }), 'dual.json': theme({ type: 'dual', name: 'Dual' }) })
    const { appearance, published } = await service()
    const before = appearance.state
    for (const patch of [{ darkTheme: '../x' }, { darkTheme: 'Dual' }, { darkTheme: 'nope' }, { darkTheme: 'broken' }, { darkTheme: 'lighter' }, { lightTheme: 'varia-dark' }, { mode: 'dark', extra: 1 }, {}, null, 'dark', { mode: 'sepia' }]) {
      await expect(appearance.setPreference(patch), JSON.stringify(patch)).rejects.toThrow()
    }
    await expect(appearance.setPreference({ darkTheme: 'nope' })).rejects.toThrow('Unknown or unusable theme.')
    expect(appearance.state).toMatchObject({ preference: before.preference, active: before.active })
    expect(userThemes(appearance.state)).toEqual(['broken', 'dual', 'lighter'])
    expect(await readdir(directory)).toEqual(['themes'])
    const chosen = await appearance.setPreference({ darkTheme: 'dual', lightTheme: 'dual' })
    expect(chosen).toMatchObject({ preference: { mode: 'dark', darkTheme: 'dual', lightTheme: 'dual' }, active: { id: 'dual', name: 'Dual', type: 'dark' }, fallback: false })
    expect(chosen.notice).toBeUndefined()
    expect(published.at(-1)).toBe(chosen)
    expect(JSON.parse(await readFile(join(directory, 'appearance.json'), 'utf8'))).toEqual({ version: 1, mode: 'dark', darkTheme: 'dual', lightTheme: 'dual' })
    const revision = chosen.revision
    expect((await appearance.setPreference({ darkTheme: 'dual' })).revision).toBe(revision)
  })
  it('switches mode, drives themeSource, and follows the OS only in System mode', async () => {
    const { appearance, nativeTheme } = await service(true)
    expect((await appearance.setPreference({ mode: 'light' })).active.id).toBe('varia-light')
    expect(nativeTheme.assignments).toEqual(['dark', 'light'])
    nativeTheme.systemDark = false
    appearance.systemChanged()
    expect((await appearance.setPreference({ mode: 'system' })).active.type).toBe('light')
    expect(nativeTheme.assignments).toEqual(['dark', 'light', 'system'])
    const revision = appearance.state.revision
    nativeTheme.systemDark = true
    appearance.systemChanged()
    await vi.waitFor(() => expect(appearance.state.active.id).toBe('varia-dark'))
    expect(appearance.state.revision).toBe(revision + 1)
    appearance.systemChanged()
    await appearance.scan()
    expect(appearance.state.revision).toBe(revision + 1)
    expect(nativeTheme.assignments).toEqual(['dark', 'light', 'system'])
    expect(JSON.parse(await readFile(join(directory, 'appearance.json'), 'utf8')).mode).toBe('system')
  })
  it('reports warnings after a choice, and a failed save without undoing the choice', async () => {
    await themeFiles({ 'warned.json': theme({ name: 'Warned', palette: { accent: 'red' }, colors: { 'editor.backgroud': '#000000' } }) })
    const { appearance } = await service()
    const state = await appearance.setPreference({ darkTheme: 'warned' })
    expect(state.notice).toBe('`Warned` has 2 problems; the affected entries use their defaults.')
    expect(state.problems.map(problem => [problem.file, problem.path, problem.code])).toEqual([['warned.json', '/palette/accent', 'W_VALUE'], ['warned.json', '/colors/editor.backgroud', 'W_KEY_UNKNOWN']])
    expect((await appearance.setPreference({ mode: 'light' })).notice).toBeUndefined()
    await rm(join(directory, 'appearance.json'))
    await mkdir(join(directory, 'appearance.json'))
    const unsaved = await appearance.setPreference({ mode: 'dark' })
    expect(unsaved.active.id).toBe('warned')
    expect(unsaved.notice).toMatch(/^`Warned` has 2 problems; the affected entries use their defaults\. The theme was applied but could not be saved \(E[A-Z]+\)\.$/)
    // Choosing the same option again retries the save instead of silently dropping the warning.
    expect((await appearance.setPreference({ mode: 'dark' })).notice).toMatch(/could not be saved \(E[A-Z]+\)\.$/)
    await rm(join(directory, 'appearance.json'), { recursive: true })
    expect((await appearance.setPreference({ mode: 'dark' })).notice).toBe('`Warned` has 2 problems; the affected entries use their defaults.')
    expect(JSON.parse(await readFile(join(directory, 'appearance.json'), 'utf8'))).toMatchObject({ mode: 'dark', darkTheme: 'warned' })
    expect((await appearance.setPreference({ mode: 'dark' })).notice).toBe('`Warned` has 2 problems; the affected entries use their defaults.')
  })
  it('names the warnings of the theme a choice selects, even for the slot System mode is not showing', async () => {
    await themeFiles({ 'warnd.json': theme({ name: 'WarnD', palette: { accent: 'red' } }), 'warnl.json': theme({ name: 'WarnL', type: 'light', palette: { accent: 'blue' } }) })
    await preference({ mode: 'system', lightTheme: 'warnl' })
    const { appearance } = await service(false)
    const state = await appearance.setPreference({ darkTheme: 'warnd' })
    expect(state.active.id).toBe('warnl')
    expect(state.notice).toBe('`WarnD` has 1 problem; the affected entries use their defaults.')
    // A mode change is about the theme it shows.
    expect((await appearance.setPreference({ mode: 'dark' })).notice).toBe('`WarnD` has 1 problem; the affected entries use their defaults.')
    expect((await appearance.setPreference({ mode: 'light' })).notice).toBe('`WarnL` has 1 problem; the affected entries use their defaults.')
  })
  it('never overwrites a preferences file it could not read', async () => {
    await mkdir(join(directory, 'appearance.json'))
    await themeFiles({ 'dual.json': theme({ type: 'dual' }) })
    const { appearance } = await service()
    expect(appearance.state.notice).toBe('Theme preferences could not be read; the defaults are used and changes are not saved.')
    const state = await appearance.setPreference({ darkTheme: 'dual' })
    expect(state.active.id).toBe('dual')
    expect(state.notice).toBe('The theme was applied but could not be saved because the preferences file could not be read.')
    expect((await stat(join(directory, 'appearance.json'))).isDirectory()).toBe(true)
  })
  it('keeps the native window chrome opaque and readable', async () => {
    await themeFiles({
      'glass.json': theme({ colors: { 'editor.background': '#ff000080', 'titleBar.activeBackground': '#00ff0040', 'titleBar.controlsForeground': '#0000ff20' } }),
      'grey.json': theme({ colors: { 'titleBar.activeBackground': '#808080', 'titleBar.controlsForeground': '#888888' } })
    })
    const { appearance } = await service()
    await appearance.setPreference({ darkTheme: 'glass' })
    const glass = appearance.windowChrome()
    for (const color of [glass.backgroundColor, glass.overlay.color, glass.overlay.symbolColor]) expect(color).toMatch(/^#[0-9a-f]{6}$/)
    expect(glass.backgroundColor).toBe('#800000')
    await appearance.setPreference({ darkTheme: 'grey' })
    expect(appearance.windowChrome().overlay).toEqual({ color: '#808080', symbolColor: '#000000' })
  })
  it('creates starter themes without replacing files and selects them', async () => {
    await themeFiles({ 'custom-theme.json': 'mine' })
    const { appearance } = await service()
    await appearance.setPreference({ mode: 'light' })
    const path = await appearance.createStarterTheme()
    expect(path).toBe(join(themes, 'custom-theme-2.json'))
    expect(await readFile(join(themes, 'custom-theme.json'), 'utf8')).toBe('mine')
    const starter = JSON.parse(await readFile(path, 'utf8'))
    expect(parseThemeFile(starter, 'custom-theme-2.json').problems).toEqual([])
    expect(starter).toMatchObject({ type: 'light', palette: { accent: '#005fb8', accentHover: '#004c94', onAccent: '#ffffff', focus: '#005fb8' } })
    expect(appearance.state).toMatchObject({ preference: { mode: 'light', lightTheme: 'custom-theme-2' }, active: { id: 'custom-theme-2', name: 'My Theme' } })
    expect(await readFile(join(themes, schemaFileName), 'utf8')).toBe(JSON.stringify(buildThemeJsonSchema(), null, 2) + '\n')
    expect(await appearance.createStarterTheme()).toBe(join(themes, 'custom-theme-3.json'))
  })
  it('never creates a starter the next scan could not select', async () => {
    // Ids ignore case: on a case-sensitive file system custom-theme.json would collide with the user's own theme.
    await themeFiles({ 'Custom-Theme.json': theme({ name: 'Mine' }) })
    const { appearance } = await service()
    await appearance.setPreference({ darkTheme: 'custom-theme' })
    expect(await appearance.createStarterTheme()).toBe(join(themes, 'custom-theme-2.json'))
    expect(appearance.state).toMatchObject({ fallback: false, preference: { darkTheme: 'custom-theme-2' }, active: { id: 'custom-theme-2' } })
    expect(appearance.state.themes.find(item => item.id === 'custom-theme')).toMatchObject({ name: 'Mine', usable: true })
    // A starter that sorts past the 64-file cap would never load, so a full folder is refused and nothing is written.
    await rm(themes, { recursive: true })
    await themeFiles(Object.fromEntries(Array.from({ length: themeLimits.files }, (_, index) => [`a${String(index).padStart(2, '0')}.json`, theme()])))
    await expect(appearance.createStarterTheme()).rejects.toThrow('The themes folder already has 64 theme files, the most Varia loads; remove one before creating another.')
    expect((await readdir(themes)).filter(name => name.startsWith('custom-theme'))).toEqual([])
  })
  it('opens the folder even when the schema cannot be written, and reports failures as fixed sentences', async () => {
    await mkdir(join(themes, schemaFileName), { recursive: true })
    const { appearance } = await service()
    expect(await appearance.ensureFolder()).toBe(themes)
    expect(await appearance.createStarterTheme()).toBe(join(themes, 'custom-theme.json'))
    await rm(themes, { recursive: true })
    await writeFile(themes, 'not a folder')
    await expect(appearance.ensureFolder()).rejects.toThrow(/^The themes folder could not be created \(E[A-Z]+\)\.$/)
    await expect(appearance.createStarterTheme()).rejects.toThrow(/^The themes folder could not be created \(E[A-Z]+\)\.$/)
  })
  it.skipIf(!posix || root)('says the folder is not writable when a starter cannot be written there', async () => {
    await mkdir(themes)
    await writeSchemaFile(themes)
    await chmod(themes, 0o555)
    try {
      const { appearance } = await service()
      expect(await appearance.ensureFolder()).toBe(themes)
      await expect(appearance.createStarterTheme()).rejects.toThrow('The custom theme could not be created because the themes folder is not writable (EACCES).')
    } finally { await chmod(themes, 0o755) }
  })
  it('numbers each report, so a repeated action shows its notice again and a theme-only update does not', async () => {
    await themeFiles({ 'warned.json': theme({ name: 'Warned', palette: { accent: 'red' } }) })
    await preference({ mode: 'system' })
    const { appearance, nativeTheme } = await service(true)
    expect(appearance.state.noticeId).toBe(0)
    for (const action of [() => appearance.reload(), () => appearance.reload(), () => appearance.notify('Same.'), () => appearance.notify('Same.'),
      () => appearance.setPreference({ darkTheme: 'warned' }), () => appearance.setPreference({ darkTheme: 'warned' })]) {
      const before = appearance.state
      await action()
      expect(appearance.state.revision).toBeGreaterThan(before.revision)
      expect(appearance.state.noticeId).toBeGreaterThan(before.noticeId)
    }
    expect(appearance.state.notice).toBe('`Warned` has 1 problem; the affected entries use their defaults.')
    await appearance.reload()
    const reloaded = appearance.state
    // The OS switches to light: a new revision with the same report, which stays dismissed.
    nativeTheme.systemDark = false
    appearance.systemChanged()
    await vi.waitFor(() => expect(appearance.state.active.id).toBe('varia-light'))
    expect(appearance.state).toMatchObject({ revision: reloaded.revision + 1, noticeId: reloaded.noticeId, notice: reloaded.notice })
    // A choice with nothing to report changes nothing and numbers nothing.
    await appearance.setPreference({ lightTheme: 'varia-light' })
    const quiet = appearance.state
    expect(quiet.notice).toBeUndefined()
    await appearance.setPreference({ lightTheme: 'varia-light' })
    expect(appearance.state).toBe(quiet)
  })
  it('shows the built-in after the startup timeout and applies the real choice when it arrives', async () => {
    await preference({ mode: 'light' })
    let release!: () => void
    const load = AppearanceStore.prototype.load
    vi.spyOn(AppearanceStore.prototype, 'load').mockImplementation(async function (this: AppearanceStore) {
      await new Promise<void>(resolve => { release = resolve })
      return load.call(this)
    })
    const nativeTheme = new FakeNativeTheme()
    const appearance = new AppearanceService({ userData: directory, nativeTheme })
    const published: ThemeState[] = []
    appearance.onDidChange(state => published.push(state))
    const started = Date.now()
    await appearance.initialize(50)
    expect(Date.now() - started).toBeLessThan(1000)
    expect(appearance.state).toMatchObject({ revision: 1, active: { id: 'varia-dark' }, notice: 'Themes are taking longer than expected to load; Varia Dark is shown until they are ready.' })
    expect(nativeTheme.assignments).toEqual(['dark'])
    release()
    await vi.waitFor(() => expect(appearance.state.active.id).toBe('varia-light'))
    expect(appearance.state.revision).toBe(2)
    expect(appearance.state.notice).toBeUndefined()
    expect(published.map(state => state.active.id)).toEqual(['varia-dark', 'varia-light'])
    expect(nativeTheme.assignments).toEqual(['dark', 'light'])
  })
})
