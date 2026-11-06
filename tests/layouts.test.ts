import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { LayoutStore } from '../src/main/layout-store'
import { canPopOut, dockReference, emptyLayoutState, hidesHeader, layoutFile, outputIndex, paneIds, paneTitles, parseLayoutFile, parseLayoutState, parseWorkspaceLayout, withoutHeaderState, type PaneId, type WorkspaceLayout } from '../src/shared/layouts'

function fixture(): WorkspaceLayout {
  return parseWorkspaceLayout({
    grid: { width: 1440, height: 800, orientation: 'HORIZONTAL', root: { type: 'branch', data: paneIds.map((id, index) => ({ type: 'leaf', size: 400, data: { id: 'group-' + index, views: [id], activeView: id } })) } },
    panels: Object.fromEntries(paneIds.map(id => [id, { id, title: paneTitles[id], contentComponent: 'workbench', renderer: 'always', minimumWidth: id === 'editor' ? 320 : 200, minimumHeight: id === 'editor' ? 180 : 100 }])), activeGroup: 'group-1'
  })
}
/** A version 1 layout as Varia wrote it: Object Explorer beside the editor over Query output, which had one panel, `output`. */
function legacy(output: Record<string, unknown> = { type: 'leaf', size: 280, data: { id: '3', views: ['output'], activeView: 'output' } }) {
  const panel = (id: string, title: string, minimumWidth = 200, minimumHeight = 100) => ({ id, title, contentComponent: 'workbench', tabComponent: 'props.defaultTabComponent', renderer: 'always', minimumWidth, minimumHeight })
  return {
    grid: { width: 1440, height: 800, orientation: 'HORIZONTAL', root: { type: 'branch', size: 800, data: [
      { type: 'leaf', size: 278, data: { id: '1', views: ['explorer'], activeView: 'explorer' } },
      { type: 'branch', size: 1162, data: [{ type: 'leaf', size: 520, data: { id: '2', views: ['editor'], activeView: 'editor' } }, output] }
    ] } },
    panels: { explorer: panel('explorer', 'Object Explorer'), editor: panel('editor', 'Query editor', 320, 180), output: { ...panel('output', 'Query output'), minimumHeight: 140 } },
    activeGroup: '2'
  }
}
let directory: string
beforeEach(async () => { await mkdir('artifacts', { recursive: true }); directory = await mkdtemp(join(resolve('artifacts'), 'layout-test-')) })
afterEach(async () => { expect(directory.startsWith(resolve('artifacts') + sep)).toBe(true); await rm(directory, { recursive: true, force: true }) })

describe('workspace layout validation', () => {
  it('round trips geometry, tab groups, and floating panels', () => {
    const layout = fixture()
    const root = layout.grid.root.data as { type: string; data: { id: string; views: string[]; activeView: string } }[]
    root.pop()
    layout.floatingGroups = [{ data: { id: 'floating', views: ['plan'], activeView: 'plan' }, position: { left: -300, top: 20, width: 400, height: 260 } }]
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
    const closed = fixture(); delete closed.panels.plan; (closed.grid.root.data as unknown[]).pop()
    expect(Object.keys(parseWorkspaceLayout(closed).panels)).toEqual(['explorer', 'editor', 'results', 'messages'])
    const hidden = fixture(); hidden.grid.root.visible = false
    hidden.panels.editor.maximumWidth = Infinity
    expect(parseWorkspaceLayout(hidden).grid.root.visible).toBe(false)
    expect(parseWorkspaceLayout(hidden).panels.editor.maximumWidth).toBeUndefined()
    const empty = fixture(); empty.panels = {}; empty.grid.root.data = []; delete empty.activeGroup
    expect(parseLayoutFile(layoutFile(empty)).panels).toEqual({})
  })
  it('rejects inconsistent, duplicated, or unknown panels and dangling groups', () => {
    const missing = fixture(); delete (missing.panels as Partial<typeof missing.panels>).plan
    const duplicated = fixture(); ((duplicated.grid.root.data as WorkspaceLayout['grid']['root'][])[2].data as { views: string[] }).views = ['editor']
    const dangling = fixture(); dangling.activeGroup = 'missing'
    const unknown = fixture(); unknown.panels.editor.contentComponent = 'arbitrary-code'
    for (const layout of [missing, duplicated, dangling, unknown]) expect(() => parseWorkspaceLayout(layout)).toThrow('Invalid or unsupported')
    expect(() => parseWorkspaceLayout(missing)).toThrow('panels.plan')
    const legacyPanel = fixture(); (legacyPanel.panels as Record<string, unknown>).output = { id: 'output', contentComponent: 'workbench' }
    expect(() => parseWorkspaceLayout(legacyPanel)).toThrow('Invalid or unsupported')
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
    expect(() => parseLayoutState({ version: 4, current: fixture(), saved: [] })).toThrow()
    expect(() => parseLayoutState({ version: 2, current: fixture(), saved: [saved, { ...saved, id: crypto.randomUUID(), name: 'analysis' }] })).toThrow('unique')
    expect(() => parseLayoutState({ version: 2, current: fixture(), saved: [saved, { ...saved, name: 'Other' }] })).toThrow('unique')
    expect(() => parseLayoutFile({ ...layoutFile(fixture()), kind: 'sql' })).toThrow()
  })
})

/** The fixture with `panes` taken out of the grid and its panels, into one popout window. */
function popped(panes: PaneId[], bounds = { x: 1600, y: 80, width: 640, height: 420 }): Record<string, unknown> {
  const layout = fixture() as unknown as { grid: { root: { data: { data: { views: string[] } }[] } }; panels: Record<string, unknown> }
  layout.grid.root.data = layout.grid.root.data.filter(leaf => !panes.includes(leaf.data.views[0] as PaneId))
  for (const id of panes) delete layout.panels[id]
  return { ...layout, windows: [{ id: crypto.randomUUID(), panes, active: panes[0], bounds }] }
}

describe('popout windows (version 3)', () => {
  it('keep panels popped out in their own windows, with bounds, through preferences and files', () => {
    const layout = popped(['explorer', 'results'])
    const parsed = parseWorkspaceLayout(layout)
    expect(parsed.windows).toEqual(layout.windows)
    expect(Object.keys(parsed.panels)).toEqual(['editor', 'messages', 'plan'])
    expect(parseLayoutFile(layoutFile(parsed))).toEqual(parsed)
    expect(parseLayoutState({ version: 3, current: parsed, saved: [] }).current?.windows).toEqual(layout.windows)
    // On a monitor left of or above the primary one, coordinates are negative.
    expect(parseWorkspaceLayout(popped(['plan'], { x: -1900, y: -400, width: 300, height: 200 })).windows?.[0].bounds.x).toBe(-1900)
  })
  it('read version 2 preferences and files, which have none', () => {
    expect(parseLayoutState({ version: 2, current: fixture(), saved: [] })).toEqual({ version: 3, current: fixture(), saved: [] })
    expect(parseLayoutFile({ kind: 'varia-workspace-layout', version: 2, layout: fixture() }).windows).toBeUndefined()
  })
  it('reject the query editor, a panel that is also docked or in two windows, and impossible windows', () => {
    expect(canPopOut('editor')).toBe(false)
    expect(['explorer', 'results', 'messages', 'plan'].every(canPopOut)).toBe(true)
    const window = (layout: Record<string, unknown>) => (layout.windows as Record<string, unknown>[])[0]
    const editor = popped(['explorer']); window(editor).panes = ['editor']; window(editor).active = 'editor'
    expect(() => parseWorkspaceLayout(editor)).toThrow()
    const docked = popped(['explorer']); window(docked).panes = ['explorer', 'plan']
    expect(() => parseWorkspaceLayout(docked)).toThrow('more than once')
    const twice = popped(['explorer']); twice.windows = [window(twice), { ...window(twice), id: crypto.randomUUID() }]
    expect(() => parseWorkspaceLayout(twice)).toThrow('more than once')
    const sameId = popped(['explorer', 'plan']); sameId.windows = [{ ...window(sameId), panes: ['explorer'], active: 'explorer' }, { ...window(sameId), panes: ['plan'], active: 'plan' }]
    expect(() => parseWorkspaceLayout(sameId)).toThrow('Invalid popout window')
    const inactive = popped(['explorer']); window(inactive).active = 'plan'
    expect(() => parseWorkspaceLayout(inactive)).toThrow()
    for (const bounds of [{ x: 0, y: 0, width: 100, height: 400 }, { x: 0, y: 0, width: 400, height: 20 }, { x: 99_999, y: 0, width: 400, height: 400 }, { x: 0.5, y: 0, width: 400, height: 400 }])
      expect(() => parseWorkspaceLayout(popped(['explorer'], bounds))).toThrow()
    expect(() => parseWorkspaceLayout({ ...popped(['explorer']), windows: [{ ...window(popped(['explorer'])), extra: 1 }] })).toThrow()
  })
})

describe('version 1 layouts', () => {
  it('turn Query output into Results, Messages and Execution plan, tabbed where it was with Results selected', () => {
    const state = parseLayoutState({ version: 1, current: legacy(), saved: [{ id: crypto.randomUUID(), name: 'Analysis', layout: legacy() }] })
    expect(state.version).toBe(3)
    for (const layout of [state.current!, state.saved[0].layout]) {
      const group = ((layout.grid.root.data as { data: unknown[] }[])[1].data[1] as { data: { views: string[]; activeView: string } }).data
      expect(group).toMatchObject({ views: ['results', 'messages', 'plan'], activeView: 'results' })
      expect(Object.keys(layout.panels)).toEqual(['explorer', 'editor', 'results', 'messages', 'plan'])
      // Each keeps Query output's constraints, under its own id and title.
      expect(layout.panels.messages).toMatchObject({ id: 'messages', title: 'Messages', minimumWidth: 200, minimumHeight: 140 })
      expect(layout.panels).not.toHaveProperty('output')
    }
  })
  it('keep the other panels of Query output\'s group in their places, and a closed Query output stays closed', () => {
    // Object Explorer was tabbed after Query output, and selected.
    const tabbed = legacy({ type: 'leaf', size: 280, data: { id: '3', views: ['output', 'explorer'], activeView: 'explorer' } })
    tabbed.grid.root.data.shift()
    const group = (layout: WorkspaceLayout) => ((layout.grid.root.data as { data: unknown[] }[])[0].data[1] as { data: { views: string[]; activeView: string } }).data
    expect(group(parseLayoutFile({ kind: 'varia-workspace-layout', version: 1, layout: tabbed }))).toMatchObject({ views: ['results', 'messages', 'plan', 'explorer'], activeView: 'explorer' })
    const closed = legacy({ type: 'leaf', size: 280, data: { id: '3', views: ['explorer'], activeView: 'explorer' } }) as Partial<ReturnType<typeof legacy>>
    closed.grid!.root.data.shift()
    delete (closed.panels as Partial<ReturnType<typeof legacy>['panels']>).output
    expect(Object.keys(parseLayoutFile({ kind: 'varia-workspace-layout', version: 1, layout: closed }).panels)).toEqual(['explorer', 'editor'])
  })
  it('migrate floating groups, imported files, and preferences read by the store, which then writes version 3', async () => {
    const floating = legacy({ type: 'leaf', size: 280, data: { id: '3', views: ['editor'], activeView: 'editor' } }) as Record<string, unknown>
    const branch = ((floating.grid as { root: { data: { data: unknown[] }[] } }).root.data[1])
    branch.data = [{ type: 'leaf', size: 520, data: { id: '2', views: ['editor'], activeView: 'editor' } }]
    floating.floatingGroups = [{ data: { id: '4', views: ['output'], activeView: 'output' }, position: { right: -200, bottom: 10, width: 500, height: 300 } }]
    const imported = parseLayoutFile({ kind: 'varia-workspace-layout', version: 1, layout: floating })
    expect(imported.floatingGroups?.[0]).toEqual({ data: { id: '4', views: ['results', 'messages', 'plan'], activeView: 'results' }, position: { right: -200, bottom: 10, width: 500, height: 300 } })
    expect(layoutFile(imported).version).toBe(3)
    const path = join(directory, 'preferences.json')
    await writeFile(path, JSON.stringify({ version: 1, current: legacy(), saved: [] }))
    const store = new LayoutStore(path), loaded = await store.load()
    expect(loaded.warning).toBeUndefined()
    expect(Object.keys(loaded.state.current!.panels)).toEqual(['explorer', 'editor', 'results', 'messages', 'plan'])
    await store.save(loaded.state)
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ version: 3, current: { panels: { results: { id: 'results' } } } })
  })
  it('reject version 2 panels in a version 1 layout, and quarantine a preferences file holding one', async () => {
    expect(() => parseLayoutState({ version: 1, current: fixture(), saved: [] })).toThrow('unknown panel')
    expect(() => parseLayoutFile({ kind: 'varia-workspace-layout', version: 1, layout: fixture() })).toThrow('unknown panel')
    const path = join(directory, 'preferences.json')
    await writeFile(path, JSON.stringify({ version: 1, current: fixture(), saved: [] }))
    const loaded = await new LayoutStore(path).load()
    expect(loaded.state).toEqual(emptyLayoutState())
    expect(loaded.warning).toContain('preserved')
    expect((await readdir(directory)).some(name => name.includes('.invalid-'))).toBe(true)
  })
})

describe('output panel order', () => {
  it('puts an output panel after those before it in Results, Messages, Execution plan, else before those after it, else last', () => {
    expect(outputIndex('messages', ['results', 'plan'])).toBe(1)
    expect(outputIndex('results', ['messages', 'plan'])).toBe(0)
    expect(outputIndex('plan', ['explorer', 'results', 'messages', 'editor'])).toBe(3)
    expect(outputIndex('messages', ['explorer', 'plan'])).toBe(1)
    expect(outputIndex('results', ['explorer', 'editor'])).toBeUndefined()
  })
})

describe('dock headers', () => {
  it('hide only for a docked group with one panel or only output panels, unless panel tabs are shown', () => {
    expect([hidesHeader({ location: 'grid', panels: ['editor'] }, false), hidesHeader({ location: 'grid', panels: ['editor', 'explorer'] }, false), hidesHeader({ location: 'floating', panels: ['editor'] }, false),
      hidesHeader({ location: 'popout', panels: ['editor'] }, false), hidesHeader({ location: 'grid', panels: ['editor'] }, true)]).toEqual([true, false, false, false, false])
    // The output panels' toolbars tab between them, so their group needs no dock tabs; tabbed with another panel it does.
    expect([hidesHeader({ location: 'grid', panels: ['results', 'messages', 'plan'] }, false), hidesHeader({ location: 'grid', panels: ['messages', 'plan'] }, false),
      hidesHeader({ location: 'grid', panels: ['results', 'explorer'] }, false), hidesHeader({ location: 'floating', panels: ['results', 'messages'] }, false),
      hidesHeader({ location: 'grid', panels: ['results', 'messages', 'plan'] }, true), hidesHeader({ location: 'grid', panels: [] }, false)]).toEqual([true, true, false, false, false, false])
  })
  it('dock a panel beside a docked panel, never inside a floating window, or at the grid\'s edge when none is docked', () => {
    const at = (id: PaneId, panels: [string, string][]) => dockReference(id, panels.map(([panel, location]) => ({ id: panel, location })))?.id
    expect(at('results', [['explorer', 'grid'], ['editor', 'grid'], ['results', 'grid']])).toBe('editor')
    expect(at('editor', [['explorer', 'grid'], ['editor', 'grid'], ['results', 'grid']])).toBe('explorer')
    // The preferred panel floats: another docked one stands in for it.
    expect(at('editor', [['explorer', 'floating'], ['editor', 'grid'], ['results', 'grid']])).toBe('results')
    expect(at('results', [['explorer', 'grid'], ['editor', 'floating'], ['results', 'grid']])).toBe('explorer')
    expect(at('explorer', [['explorer', 'floating'], ['editor', 'popout'], ['results', 'grid']])).toBe('results')
    expect(at('editor', [['explorer', 'floating'], ['editor', 'grid']])).toBeUndefined()
    expect(at('editor', [['explorer', 'floating'], ['editor', 'floating'], ['results', 'floating']])).toBeUndefined()
  })
  it('stay out of saved layouts, docked and floating, so loading one follows the rule rather than the save', () => {
    const layout = fixture()
    const root = layout.grid.root.data as { type: string; data: { id: string; views: string[]; activeView: string; hideHeader?: boolean } }[]
    root[0].data.hideHeader = true
    root.pop()
    layout.floatingGroups = [{ data: { id: 'floating', views: ['plan'], activeView: 'plan', hideHeader: false }, position: { left: 20, top: 20, width: 400, height: 260 } }]
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
    const first = { version: 3 as const, current: fixture(), saved: [{ id: crypto.randomUUID(), name: 'Analysis', layout: fixture() }] }
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
    expect(() => store.save({ version: 2, current: { invalid: true }, saved: [] })).toThrow()
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
