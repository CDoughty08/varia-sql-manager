import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { LayoutStore } from '../src/main/layout-store'
import { emptyLayoutState, hidesHeader, layoutFile, paneIds, paneTitles, parseLayoutFile, parseLayoutState, parseWorkspaceLayout, withoutHeaderState, type WorkspaceLayout } from '../src/shared/layouts'

function fixture(): WorkspaceLayout {
  return parseWorkspaceLayout({
    grid: { width: 1440, height: 800, orientation: 'HORIZONTAL', root: { type: 'branch', data: paneIds.map((id, index) => ({ type: 'leaf', size: 400, data: { id: 'group-' + index, views: [id], activeView: id } })) } },
    panels: Object.fromEntries(paneIds.map(id => [id, { id, title: paneTitles[id], contentComponent: 'workbench', renderer: 'always', minimumWidth: id === 'editor' ? 320 : 200, minimumHeight: id === 'editor' ? 180 : 100 }])), activeGroup: 'group-1'
  })
}
let directory: string
beforeEach(async () => { await mkdir('artifacts', { recursive: true }); directory = await mkdtemp(join(resolve('artifacts'), 'layout-test-')) })
afterEach(async () => { expect(directory.startsWith(resolve('artifacts') + sep)).toBe(true); await rm(directory, { recursive: true, force: true }) })

describe('workspace layout validation', () => {
  it('round trips geometry, tab groups, and floating panels', () => {
    const layout = fixture()
    const root = layout.grid.root.data as { type: string; data: { id: string; views: string[]; activeView: string } }[]
    root.pop()
    layout.floatingGroups = [{ data: { id: 'floating', views: ['output'], activeView: 'output' }, position: { left: 20, top: 20, width: 400, height: 260 } }]
    expect(parseLayoutFile(layoutFile(layout))).toEqual(layout)
    layout.floatingGroups[0].position.height = 90
    expect(parseWorkspaceLayout(layout).floatingGroups?.[0].position.height).toBe(90)
  })
  it('accepts the React tab renderer and omits undefined optional runtime fields', () => {
    const layout = fixture()
    layout.panels.editor.tabComponent = 'props.defaultTabComponent'
    layout.panels.editor.maximumWidth = undefined
    expect(parseWorkspaceLayout(layout).panels.editor.tabComponent).toBe('props.defaultTabComponent')
    expect(parseWorkspaceLayout(layout).panels.editor).not.toHaveProperty('maximumWidth')
    layout.panels.editor.tabComponent = 'arbitrary-renderer'
    expect(() => parseWorkspaceLayout(layout)).toThrow('Invalid or unsupported')
  })
  it('accepts closed panels, hidden groups, ordinary constraints, and an empty workspace', () => {
    const closed = fixture(); delete closed.panels.output; (closed.grid.root.data as unknown[]).pop()
    expect(Object.keys(parseWorkspaceLayout(closed).panels)).toEqual(['explorer', 'editor'])
    const hidden = fixture(); hidden.grid.root.visible = false
    hidden.panels.editor.maximumWidth = Infinity
    expect(parseWorkspaceLayout(hidden).grid.root.visible).toBe(false)
    expect(parseWorkspaceLayout(hidden).panels.editor.maximumWidth).toBeUndefined()
    const empty = fixture(); empty.panels = {}; empty.grid.root.data = []; delete empty.activeGroup
    expect(parseLayoutFile(layoutFile(empty)).panels).toEqual({})
  })
  it('rejects inconsistent, duplicated, or unknown panels and dangling groups', () => {
    const missing = fixture(); delete (missing.panels as Partial<typeof missing.panels>).output
    const duplicated = fixture(); ((duplicated.grid.root.data as WorkspaceLayout['grid']['root'][])[2].data as { views: string[] }).views = ['editor']
    const dangling = fixture(); dangling.activeGroup = 'missing'
    const unknown = fixture(); unknown.panels.editor.contentComponent = 'arbitrary-code'
    for (const layout of [missing, duplicated, dangling, unknown]) expect(() => parseWorkspaceLayout(layout)).toThrow('Invalid or unsupported')
    expect(() => parseWorkspaceLayout(missing)).toThrow('panels.output')
  })
  it('rejects query/credential data and external popout configuration', () => {
    const layout = fixture(); layout.panels.editor.params = { sql: 'SELECT secret', password: 'sensitive' }
    expect(() => parseWorkspaceLayout(layout)).toThrow('Invalid or unsupported')
    const popout = { ...fixture(), popoutGroups: [{ url: 'https://example.com' }] }
    expect(() => parseWorkspaceLayout(popout)).toThrow('Invalid or unsupported')
  })
  it('bounds recursive structures and numeric dimensions before restoring them', () => {
    const layout = fixture(); layout.grid.width = Infinity
    expect(() => parseWorkspaceLayout(layout)).toThrow()
    let deep: unknown = {}
    for (let index = 0; index < 40; index++) deep = { data: [deep] }
    expect(() => parseWorkspaceLayout(deep)).toThrow('too complex')
  })
  it('rejects unsupported versions and duplicate saved names or IDs', () => {
    const saved = { id: crypto.randomUUID(), name: 'Analysis', layout: fixture() }
    expect(() => parseLayoutState({ version: 2, current: fixture(), saved: [] })).toThrow()
    expect(() => parseLayoutState({ version: 1, current: fixture(), saved: [saved, { ...saved, id: crypto.randomUUID(), name: 'analysis' }] })).toThrow('unique')
    expect(() => parseLayoutState({ version: 1, current: fixture(), saved: [saved, { ...saved, name: 'Other' }] })).toThrow('unique')
    expect(() => parseLayoutFile({ ...layoutFile(fixture()), kind: 'sql' })).toThrow()
  })
})

describe('dock headers', () => {
  it('hide only for a docked group with one panel, unless panel tabs are shown', () => {
    expect([hidesHeader({ location: 'grid', panels: 1 }, false), hidesHeader({ location: 'grid', panels: 2 }, false), hidesHeader({ location: 'floating', panels: 1 }, false),
      hidesHeader({ location: 'popout', panels: 1 }, false), hidesHeader({ location: 'grid', panels: 1 }, true)]).toEqual([true, false, false, false, false])
  })
  it('stay out of saved layouts, docked and floating, so loading one follows the rule rather than the save', () => {
    const layout = fixture()
    const root = layout.grid.root.data as { type: string; data: { id: string; views: string[]; activeView: string; hideHeader?: boolean } }[]
    root[0].data.hideHeader = true
    root.pop()
    layout.floatingGroups = [{ data: { id: 'floating', views: ['output'], activeView: 'output', hideHeader: false }, position: { left: 20, top: 20, width: 400, height: 260 } }]
    const stripped = withoutHeaderState(parseWorkspaceLayout(layout))
    expect(JSON.stringify(stripped)).not.toContain('hideHeader')
    expect(parseWorkspaceLayout(stripped)).toEqual(stripped)
    // The input is not changed.
    expect(root[0].data.hideHeader).toBe(true)
  })
})

describe('layout preferences and files', () => {
  it('remembers current and named layouts across store instances and serializes concurrent writes', async () => {
    const path = join(directory, 'preferences.json')
    const store = new LayoutStore(path)
    expect((await store.load()).state).toEqual(emptyLayoutState())
    const first = { version: 1 as const, current: fixture(), saved: [{ id: crypto.randomUUID(), name: 'Analysis', layout: fixture() }] }
    const last = { ...first, saved: [{ ...first.saved[0], name: 'Last write' }] }
    await Promise.all([store.save(first), store.save(last)])
    expect((await new LayoutStore(path).load()).state).toEqual(last)
    expect((await readdir(directory)).filter(name => name.endsWith('.tmp'))).toEqual([])
  })
  it('keeps a corrupt preferences file and returns a recoverable default', async () => {
    const path = join(directory, 'preferences.json')
    await writeFile(path, '{unfinished')
    const loaded = await new LayoutStore(path).load()
    expect(loaded.state).toEqual(emptyLayoutState())
    expect(loaded.warning).toContain('preserved')
    const backup = (await readdir(directory)).find(name => name.includes('.invalid-'))!
    expect(await readFile(join(directory, backup), 'utf8')).toBe('{unfinished')
  })
  it('quarantines preferences that are not UTF-8 instead of failing, so autosave cannot destroy them', async () => {
    const path = join(directory, 'preferences.json')
    await writeFile(path, Buffer.from([0x7b, 0xff, 0xfe, 0x7d]))
    const loaded = await new LayoutStore(path).load()
    expect(loaded.state).toEqual(emptyLayoutState())
    expect(loaded.warning).toContain('preserved')
    expect((await readdir(directory)).some(name => name.includes('.invalid-'))).toBe(true)
  })
  it('imports and exports validated layout files and rejects oversized files', async () => {
    const store = new LayoutStore(join(directory, 'preferences.json'))
    const path = join(directory, 'analysis.json')
    await store.export(path, fixture())
    expect(await store.import(path)).toEqual(fixture())
    await writeFile(path, 'x'.repeat(200_001))
    await expect(store.import(path)).rejects.toThrow('size limit')
  })
  it('does not overwrite files or preferences when layout validation fails', async () => {
    const path = join(directory, 'preferences.json'), exported = join(directory, 'exported.json')
    const store = new LayoutStore(path)
    await store.save(emptyLayoutState()); await writeFile(exported, 'original')
    expect(() => store.save({ version: 1, current: { invalid: true }, saved: [] })).toThrow()
    await expect(store.export(exported, {} as WorkspaceLayout)).rejects.toThrow()
    expect(await readFile(exported, 'utf8')).toBe('original')
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(emptyLayoutState())
  })
  it('does not move a directory mistaken for a preferences file', async () => {
    const store = new LayoutStore(directory)
    await expect(store.load()).rejects.toThrow('regular file')
    await expect(store.save(emptyLayoutState())).rejects.toThrow()
    expect(await readdir(directory)).toEqual([])
  })
})
