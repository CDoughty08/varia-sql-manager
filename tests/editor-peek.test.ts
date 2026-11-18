import { describe, expect, it, vi } from 'vitest'
import { peekLimits, type PeekResult } from '../src/shared/explorer/peek'
import { cardHeight, cardWidth, gap, minAnchoredHeight, placePeekAt } from '../src/renderer/src/explorer/peek-format'
import { PeekService, type PeekAnchor } from '../src/renderer/src/explorer/PeekService'
import type { ApiResult } from '../src/shared/contracts'
import type { ExplorerMenuNode } from '../src/renderer/src/menus/targets'
import type { ScriptingOptions } from '../src/shared/scripting/options'

const connectionId = '11111111-1111-4111-8111-111111111111'
const node = (kind: 'table' | 'procedure' | 'user', id = 1, name = 'Customer'): ExplorerMenuNode => ({
  id, connectionId, kind, label: name, lost: false,
  ref: { type: 'object', object: kind === 'user' ? { kind, database: 'Sales', name } : { kind, database: 'Sales', schema: 'dbo', name } }
})
const anchor = (name = 'a'): PeekAnchor => ({ document: name as never, rect: () => undefined, watch: () => () => {}, focus: () => {} })

function setup() {
  const api = {
    explorerPeek: vi.fn(() => new Promise<ApiResult<PeekResult>>(() => {})),
    explorerPeekDefinition: vi.fn(() => new Promise<never>(() => {})),
    explorerCancel: vi.fn(async () => ({ ok: true, value: { cancelled: 1 } })),
    scriptObjects: vi.fn(() => new Promise<never>(() => {})),
    cancelScripting: vi.fn(async () => ({ ok: true, value: { cancelled: 1 } })),
    writeClipboardText: vi.fn()
  }
  const live = [{ id: connectionId }]
  const timers: { callback?: () => void; ms?: number } = {}
  const service = new PeekService({
    api: api as never, connections: { getSnapshot: () => live, subscribe: () => () => {} },
    scriptingOptions: { getSnapshot: () => ({ options: {} as ScriptingOptions }), subscribe: () => () => {} },
    timers: { setTimeout: (callback, ms) => { timers.callback = callback; timers.ms = ms; return 1 }, clearTimeout: () => { timers.callback = undefined } },
    newId: () => 'id', platform: 'win32'
  })
  return { service, api, timers }
}

describe('Peek anchored in a query editor', () => {
  it('opens the card at an editor anchor, which Back, a followed dependency and Refresh keep and a row peek drops', () => {
    const { service, api } = setup()
    const at = anchor()
    expect(service.peekAt({ ...node('table'), id: -1 }, at, 'keyboard')).toBe(true)
    expect(service.getSnapshot().open).toMatchObject({ rowId: -1, source: 'keyboard', anchor: at })
    expect(api.explorerPeek).toHaveBeenCalledTimes(1)
    // The same object at another name moves the card and reads nothing again; a hover never takes focus from a keyboard card.
    const other = anchor('b')
    expect(service.peekAt({ ...node('table'), id: -1 }, other, 'hover')).toBe(true)
    expect(service.getSnapshot().open).toMatchObject({ source: 'keyboard', anchor: other })
    expect(api.explorerPeek).toHaveBeenCalledTimes(1)
    // Another object reads it, still at the editor.
    service.peekAt({ ...node('procedure', -1, 'Ship') }, at, 'hover')
    expect(service.getSnapshot().open).toMatchObject({ source: 'hover', anchor: at, node: { label: 'Ship' } })
    service.follow({ kind: 'table', schema: 'dbo', name: 'Customer' } as never)
    expect(service.getSnapshot().open?.anchor).toBe(at)
    service.goBack()
    expect(service.getSnapshot().open?.anchor).toBe(at)
    service.refresh()
    expect(service.getSnapshot().open?.anchor).toBe(at)
    // A row's peek is beside its row again.
    service.peek(node('table', 4), 'keyboard')
    expect(service.getSnapshot().open?.anchor).toBeUndefined()
    expect(service.getSnapshot().open?.rowId).toBe(4)
  })
  it('refuses an object Peek cannot describe, or one on a server that is gone', () => {
    const { service } = setup()
    expect(service.peekAt({ ...node('table'), id: -1, connectionId: 'other' }, anchor(), 'keyboard')).toBe(false)
    expect(service.peekAt({ ...node('table'), id: -1, kind: 'folder' } as never, anchor(), 'keyboard')).toBe(false)
    expect(service.getSnapshot().open).toBeUndefined()
  })
  it('waits on one name at a time with the row hover\'s timer, which the modifier going up cancels', () => {
    const { service, timers } = setup()
    const open = vi.fn()
    service.hoverAt('a', open)
    expect(timers.ms).toBe(peekLimits.hoverMs)
    const first = timers.callback
    // Resting on the same name keeps the timer; another name starts again.
    service.hoverAt('a', open)
    expect(timers.callback).toBe(first)
    service.hoverAt('b', open)
    expect(timers.callback).not.toBe(first)
    service.keyUp('Control')
    expect(timers.callback).toBeUndefined()
    service.hoverAt('b', open)
    timers.callback!()
    expect(open).toHaveBeenCalledTimes(1)
    // A row hover replaces an editor one, and the other way round.
    service.hoverAt('c', open)
    service.hover(node('table', 2))
    timers.callback!()
    expect(open).toHaveBeenCalledTimes(1)
    expect(service.getSnapshot().open?.rowId).toBe(2)
  })
  it('tells a hover\'s lookup it is no longer wanted once the hover is cancelled', () => {
    const { service, timers } = setup()
    let wanted: (() => boolean) | undefined
    service.hoverAt('a', check => { wanted = check })
    timers.callback!()
    expect(wanted!()).toBe(true)
    service.hoverAt('b', () => {})
    expect(wanted!()).toBe(false)
  })
  it('forgets a hover when the remapped modifier goes up, not Ctrl', () => {
    const api = { explorerCancel: vi.fn(), cancelScripting: vi.fn() }
    const timers: { callback?: () => void } = {}
    const service = new PeekService({
      api: api as never, connections: { getSnapshot: () => [], subscribe: () => () => {} },
      scriptingOptions: { getSnapshot: () => ({ options: {} as ScriptingOptions }), subscribe: () => () => {} },
      timers: { setTimeout: callback => { timers.callback = callback; return 1 }, clearTimeout: () => { timers.callback = undefined } },
      newId: () => 'id', platform: 'win32', hoverModifier: key => key === 'Shift'
    })
    service.hoverAt('a', () => {})
    service.keyUp('Control')
    expect(timers.callback).toBeDefined()
    service.keyUp('Shift')
    expect(timers.callback).toBeUndefined()
  })
  it('keeps an editor hover whose modifier is remapped apart from Object Explorer\'s while it repeats, and arms only Object Explorer\'s cursor', () => {
    const timers: { callback?: () => void } = {}
    const service = new PeekService({
      api: {} as never, connections: { getSnapshot: () => [], subscribe: () => () => {} },
      scriptingOptions: { getSnapshot: () => ({ options: {} as ScriptingOptions }), subscribe: () => () => {} },
      timers: { setTimeout: callback => { timers.callback = callback; return 1 }, clearTimeout: () => { timers.callback = undefined } },
      newId: () => 'id', platform: 'win32',
      gestures: { isModifierKey: (_id, key) => key === 'Control' }, hoverModifier: key => key === 'Control' || key === 'Shift'
    })
    service.keyDown('Shift')
    service.hoverAt('a', () => {})
    // Held Shift repeats: the query editor's modifier, not a typed key, so its hover keeps waiting and arms no row cursor.
    service.keyDown('Shift', true)
    expect(timers.callback).toBeDefined()
    expect(service.armed.getSnapshot()).toBe(false)
    // A typed key still ends it.
    service.keyDown('a')
    expect(timers.callback).toBeUndefined()
  })
})

describe('placePeekAt', () => {
  const view = { width: 1600, height: 1000 }
  it('opens below the name at its left edge, or above it when there is more room there', () => {
    expect(placePeekAt({ left: 300, top: 100, bottom: 118 }, view)).toEqual({ left: 300, top: 120, width: cardWidth, height: cardHeight })
    const above = placePeekAt({ left: 300, top: 900, bottom: 918 }, view)
    expect(above.top + above.height).toBe(898)
    expect(above.height).toBe(cardHeight)
  })
  it('stays inside the window', () => {
    expect(placePeekAt({ left: 1500, top: 100, bottom: 118 }, view).left).toBe(1600 - gap - cardWidth)
    const short = placePeekAt({ left: 10, top: 300, bottom: 318 }, { width: 800, height: 700 })
    expect(short).toMatchObject({ left: gap, top: 320, width: 800 - 2 * gap })
    expect(short.top + short.height).toBeLessThanOrEqual(700 - gap)
  })
  it('covers the name when neither side has room for a useful card, and keeps its place while the name is out of view', () => {
    const tight = placePeekAt({ left: 10, top: 150, bottom: 168 }, { width: 1000, height: 330 })
    expect(minAnchoredHeight).toBeGreaterThan(330 - 168)
    expect(tight.top).toBe(gap)
    expect(tight.height).toBe(330 - 2 * gap)
    const last = { left: 5, top: 6, width: 7, height: 8 }
    expect(placePeekAt(undefined, view, last)).toBe(last)
  })
})
