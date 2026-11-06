import { describe, expect, it, vi } from 'vitest'
import type { SerializedDockview } from 'dockview-react'
import { captureEditorGroups, editorGroupLimits, editorGroupsLayoutSchema, layoutViews, remapEditorGroups, restoreEditorGroups, type EditorGroupsLayout } from '../src/shared/editor-groups'
import { EditorGroupService, type EditorGroupHost, type EditorGroupSnapshot } from '../src/renderer/src/services/editor-groups'

const leaf = (views: number[], active?: number) => ({ type: 'leaf' as const, views, ...active !== undefined ? { active } : {} })
const split = (...children: EditorGroupsLayout['root'][]) => ({ type: 'branch' as const, children })
const layout = (root: EditorGroupsLayout['root'], extra: Partial<EditorGroupsLayout> = {}): EditorGroupsLayout => ({ root, orientation: 'HORIZONTAL', width: 800, height: 600, ...extra })

describe('the kept editor groups layout', () => {
  it('accepts groups of distinct documents and refuses duplicates, missing actives, a leaf root and too many groups', () => {
    expect(editorGroupsLayoutSchema.safeParse(layout(split(leaf([0, 1], 1), leaf([2])), { activeGroup: 1 })).success).toBe(true)
    expect(editorGroupsLayoutSchema.safeParse(layout(split(leaf([0, 1]), leaf([1])))).success).toBe(false)
    expect(editorGroupsLayoutSchema.safeParse(layout(split(leaf([0], 3)))).success).toBe(false)
    expect(editorGroupsLayoutSchema.safeParse(layout(leaf([0]))).success).toBe(false)
    expect(editorGroupsLayoutSchema.safeParse(layout(split(leaf([0]), leaf([1])), { activeGroup: 2 })).success).toBe(false)
    const many = split(...Array.from({ length: editorGroupLimits.groups + 1 }, (_, index) => leaf([index])))
    expect(editorGroupsLayoutSchema.safeParse(layout(many)).success).toBe(false)
    expect(editorGroupsLayoutSchema.safeParse(layout(split(leaf([editorGroupLimits.documents])))).success).toBe(false)
    expect(editorGroupsLayoutSchema.safeParse({ ...layout(split(leaf([0]))), extra: 1 }).success).toBe(false)
    // Floating groups count, and their documents are unique with the grid's.
    const floating = [{ root: leaf([0]), position: { left: 10, top: 10, width: 300, height: 200 } }]
    expect(editorGroupsLayoutSchema.safeParse(layout(split(leaf([0])), { floating })).success).toBe(false)
    expect(editorGroupsLayoutSchema.safeParse(layout(split(leaf([1])), { floating, activeGroup: 1 })).success).toBe(true)
  })

  it('moves documents to their new places, dropping empty groups and collapsing splits left with one child', () => {
    const kept = layout(split(leaf([0, 1], 1), split(leaf([2]), leaf([3], 3))), { activeGroup: 2 })
    expect(layoutViews(kept)).toEqual([0, 1, 2, 3])
    // Document 2 went: its split keeps one group, which takes the split's place; the active group follows document 3.
    expect(remapEditorGroups(kept, place => place === 2 ? undefined : place)).toEqual(layout(split(leaf([0, 1], 1), leaf([3], 3)), { activeGroup: 1 }))
    // Only the nested split is left: it becomes the root, turned the other way.
    expect(remapEditorGroups(kept, place => place >= 2 ? place - 2 : undefined)).toEqual(layout(split(leaf([0]), leaf([1], 1)), { orientation: 'VERTICAL', activeGroup: 1 }))
    // The active group's document went: the first group is active, and a group whose shown document went shows none.
    expect(remapEditorGroups(kept, place => place === 3 || place === 1 ? undefined : place)).toEqual(layout(split(leaf([0]), leaf([2])), { activeGroup: 0 }))
    expect(remapEditorGroups(kept, () => undefined)).toBeUndefined()
  })

  it('round-trips Dockview layouts, naming documents by place and leaving out what has no place', () => {
    const json = {
      grid: { orientation: 'HORIZONTAL', width: 800, height: 600, root: { type: 'branch', data: [
        { type: 'leaf', size: 400, data: { id: '1', views: ['a', 'designer', 'b'], activeView: 'b' } },
        { type: 'leaf', size: 400, data: { id: '2', views: ['c'], activeView: 'c' } },
        { type: 'leaf', size: 0, data: { id: '3', views: ['designer2'] } }
      ] } },
      floatingGroups: [{ data: { id: '4', views: ['d'], activeView: 'd' }, position: { left: 20, top: 30, width: 300, height: 200 } }],
      panels: {}, activeGroup: '4'
    } as unknown as SerializedDockview
    const places: Record<string, number> = { a: 0, b: 1, c: 2, d: 3 }
    const captured = captureEditorGroups(json, id => places[id])!
    expect(captured).toEqual({
      root: { type: 'branch', children: [{ type: 'leaf', views: [0, 1], active: 1, size: 400 }, { type: 'leaf', views: [2], active: 2, size: 400 }] },
      orientation: 'HORIZONTAL', width: 800, height: 600,
      floating: [{ root: { type: 'leaf', views: [3], active: 3 }, position: { left: 20, top: 30, width: 300, height: 200 } }],
      activeGroup: 2
    })
    expect(editorGroupsLayoutSchema.safeParse(captured).success).toBe(true)
    const ids = ['x', 'y', 'z', 'w']
    const restored = restoreEditorGroups(captured, place => ids[place], id => ({ id, title: id })) as unknown as { grid: { root: { data: { data: unknown }[] } }; panels: Record<string, unknown>; floatingGroups: unknown[]; activeGroup: string }
    expect(restored.grid.root.data.map(node => node.data)).toEqual([{ id: 'g1', views: ['x', 'y'], activeView: 'y' }, { id: 'g2', views: ['z'], activeView: 'z' }])
    expect(restored.floatingGroups).toEqual([{ data: { id: 'g3', views: ['w'], activeView: 'w' }, position: { left: 20, top: 30, width: 300, height: 200 } }])
    expect(restored.activeGroup).toBe('g3')
    expect(Object.keys(restored.panels)).toEqual(['x', 'y', 'z', 'w'])
    // A place whose document did not reopen is left out with its group.
    const partial = restoreEditorGroups(captured, place => place === 2 ? undefined : ids[place], id => ({ id })) as unknown as { grid: { root: { data: { data: { views: string[] } }[] } } }
    expect(partial.grid.root.data.map(node => node.data.views)).toEqual([['x', 'y']])
    expect(restoreEditorGroups(captured, () => undefined, id => ({ id }))).toBeUndefined()
  })

  it('keeps every query floating: the grid’s empty group is left out, and the grid comes back as an empty split', () => {
    const json = {
      grid: { orientation: 'HORIZONTAL', width: 800, height: 600, root: { type: 'branch', data: [{ type: 'leaf', size: 800, data: { id: '9', views: [] } }] } },
      floatingGroups: [
        { data: { id: '1', views: ['a'], activeView: 'a' }, position: { left: 20, top: 30, width: 300, height: 200 } },
        { data: { id: '2', views: ['b'], activeView: 'b' }, position: { left: 60, top: 70, width: 300, height: 200 } }
      ],
      panels: {}, activeGroup: '2'
    } as unknown as SerializedDockview
    const captured = captureEditorGroups(json, id => ({ a: 0, b: 1 } as Record<string, number>)[id])!
    expect(captured.root).toEqual({ type: 'branch', children: [] })
    expect(captured.floating?.map(group => group.root)).toEqual([{ type: 'leaf', views: [0], active: 0 }, { type: 'leaf', views: [1], active: 1 }])
    expect(captured.activeGroup).toBe(1)
    expect(editorGroupsLayoutSchema.safeParse(captured).success).toBe(true)
    const restored = restoreEditorGroups(captured, place => ['x', 'y'][place], id => ({ id })) as unknown as { grid: { root: { type: string; data: unknown[] } }; floatingGroups: unknown[]; activeGroup: string }
    expect(restored.grid.root).toMatchObject({ type: 'branch', data: [] })
    expect(restored.floatingGroups).toHaveLength(2)
    expect(restored.activeGroup).toBe('g2')
  })
})

function service() {
  const documents = { list: ['a', 'b', 'c'], active: 'b' }
  const docs = {
    getSnapshot: () => ({ documents: documents.list.map(id => ({ id })), activeId: documents.active }) as never,
    move: vi.fn((id: string, index: number) => { documents.list.splice(documents.list.indexOf(id), 1); documents.list.splice(index, 0, id); return true }),
    get: () => undefined
  }
  const host: EditorGroupHost = { move: vi.fn(), focusGroup: vi.fn(), join: vi.fn(), capture: vi.fn(() => layout(split(leaf([0]), leaf([1])))), restore: vi.fn(), focusedDocument: vi.fn(() => 'c') }
  return { groups: new EditorGroupService(docs), docs, documents, host }
}
const twoGroups: EditorGroupSnapshot = { groups: [{ id: 'g1', documents: ['a', 'b'], active: 'b', floating: false }, { id: 'g2', documents: ['c'], active: 'c', floating: false }], activeGroup: 'g1' }

describe('the editor group service', () => {
  it('treats every document as one group without an editor area, moving along DocumentService\'s order', () => {
    const { groups, docs, documents } = service()
    expect(groups.count).toBe(1)
    expect(groups.groupOf('c')?.documents).toEqual(['a', 'b', 'c'])
    expect(groups.canMoveInGroup('a', -1)).toBe(false)
    groups.moveInGroup('a', 1)
    expect(docs.move).toHaveBeenCalledWith('a', 1)
    expect(documents.list).toEqual(['b', 'a', 'c'])
    // Splits, floats and moves between groups need the editor area.
    expect(groups.canSplit('a')).toBe(false)
    expect(groups.canFloat('a')).toBe(false)
    expect(groups.canMoveToGroup('a', 1)).toBe(false)
    expect(groups.capture(() => 0)).toBeUndefined()
  })

  it('asks the editor area for splits, moves between groups, focus, float, dock and join', () => {
    const { groups, host } = service()
    groups.attach(host)
    groups.update(twoGroups)
    expect(groups.count).toBe(2)
    groups.moveInGroup('a', 1)
    expect(host.move).toHaveBeenLastCalledWith('a', { group: 'g1', index: 1 })
    expect(groups.canSplit('c')).toBe(false)
    groups.split('b', 'down')
    expect(host.move).toHaveBeenLastCalledWith('b', { split: 'down', beside: 'g1' })
    groups.moveToGroup('b', 1)
    expect(host.move).toHaveBeenLastCalledWith('b', { group: 'g2' })
    expect(groups.canMoveToGroup('a', -1)).toBe(false)
    groups.moveToGroup('c', -1)
    expect(host.move).toHaveBeenLastCalledWith('c', { group: 'g1' })
    // Past the last group, into a new one on the right, but only when its own group keeps a tab.
    expect(groups.canMoveToGroup('c', 1)).toBe(false)
    groups.focusGroup(-1)
    expect(host.focusGroup).toHaveBeenLastCalledWith('g2')
    groups.float('c')
    expect(host.move).toHaveBeenLastCalledWith('c', { float: true })
    groups.update({ ...twoGroups, groups: [twoGroups.groups[0], { ...twoGroups.groups[1], floating: true }] })
    expect(groups.canFloat('c')).toBe(false)
    groups.dock('c')
    expect(host.move).toHaveBeenLastCalledWith('c', { dock: true })
    groups.join()
    expect(host.join).toHaveBeenCalledTimes(1)
    expect(groups.capture(() => 0)).toEqual(layout(split(leaf([0]), leaf([1]))))
  })

  it('floats a document only while the grid keeps another, and names the next tab in its group as a closing one\'s successor', () => {
    const { groups, host } = service()
    // Without an editor area there are no groups to hand over within, and no tab has focus.
    expect(groups.successor('b')).toBeUndefined()
    expect(groups.focusedDocument()).toBeUndefined()
    groups.attach(host)
    groups.update(twoGroups)
    // The editor area says which tab has focus, which keys on a tab act on.
    expect(groups.focusedDocument()).toBe('c')
    // c is its grid group's only document, but g1 stays in the grid: it can float.
    expect(groups.canFloat('c')).toBe(true)
    expect(groups.canFloat('a')).toBe(true)
    expect(groups.successor('a')).toBe('b')
    expect(groups.successor('b')).toBe('a')
    expect(groups.successor('c')).toBeUndefined()
    // One grid group with one document: floating it would leave the editor area empty behind it.
    groups.update({ groups: [{ id: 'g1', documents: ['a'], active: 'a', floating: false }, { id: 'g2', documents: ['b', 'c'], active: 'b', floating: true }], activeGroup: 'g1' })
    expect(groups.canFloat('a')).toBe(false)
    groups.update({ groups: [{ id: 'g1', documents: ['a', 'b'], active: 'a', floating: false }], activeGroup: 'g1' })
    expect(groups.canFloat('a')).toBe(true)
    groups.update({ groups: [{ id: 'g1', documents: ['a'], active: 'a', floating: false }], activeGroup: 'g1' })
    expect(groups.canFloat('a')).toBe(false)
    groups.float('a')
    expect(host.move).not.toHaveBeenCalledWith('a', { float: true })
  })

  it('publishes only real changes, restores once the editor area attaches, and forgets the area when it goes', () => {
    const { groups, host } = service()
    const listener = vi.fn()
    groups.subscribe(listener)
    groups.restore(layout(split(leaf([0]), leaf([1]))), () => 'a')
    expect(host.restore).not.toHaveBeenCalled()
    const attached = groups.attach(host)
    expect(host.restore).toHaveBeenCalledTimes(1)
    groups.update(twoGroups)
    groups.update({ ...twoGroups, groups: twoGroups.groups.map(group => ({ ...group, documents: [...group.documents] })) })
    expect(listener).toHaveBeenCalledTimes(1)
    attached.dispose()
    expect(groups.getSnapshot().groups).toEqual([])
    expect(groups.canSplit('a')).toBe(false)
  })
})
