import { describe, expect, it, vi } from 'vitest'
import type { ApiResult, ExplorerChildrenResult } from '../src/shared/contracts'
import type { PeekResult } from '../src/shared/explorer/peek'
import type { ObjectSearchHit } from '../src/shared/explorer/search'
import type { ScriptingOptions } from '../src/shared/scripting/options'
import { PeekService } from '../src/renderer/src/explorer/PeekService'
import { detailsDrag, detailsKey, scriptable, searchDetailsLimits, SearchDetailsService } from '../src/renderer/src/search/SearchDetailsService'
import { hitKindSpec, hitProperties, matchedLine, scrollKey } from '../src/renderer/src/search/SearchDetails'

const ok = <T>(value: T): ApiResult<T> => ({ ok: true, value })
const flush = () => new Promise(resolve => setTimeout(resolve, 0))
const connectionId = 'server-a'
const table: ObjectSearchHit = { object: { kind: 'table', database: 'Sales', schema: 'dbo', name: 'Orders' }, folder: 'tables', label: 'dbo.Orders' }
const procedure: ObjectSearchHit = {
  object: { kind: 'procedure', database: 'Sales', schema: 'dbo', name: 'usp_Ship' }, folder: 'storedProcedures', label: 'dbo.usp_Ship', subtype: 'sql',
  definition: { line: 3, column: 5, preview: '  UPDATE dbo.Orders SET Shipped = 1', range: [9, 10], before: false, after: false, matches: 1, cut: false }
}
const trigger: ObjectSearchHit = { object: { kind: 'trigger', database: 'Sales', parent: { kind: 'table', schema: 'dbo', name: 'Orders' }, name: 'trg_Audit' }, folder: 'tableTriggers', label: 'dbo.Orders.trg_Audit' }
const column: ObjectSearchHit = { object: { kind: 'column', database: 'Sales', parent: { kind: 'table', schema: 'dbo', name: 'Orders' }, name: 'Id' }, folder: 'columns', label: 'dbo.Orders.Id' }

function setup() {
  const pending: { peek: ((value: ApiResult<PeekResult>) => void)[]; script: ((value: ApiResult<{ text?: string }>) => void)[]; columns: ((value: ApiResult<ExplorerChildrenResult>) => void)[] } = { peek: [], script: [], columns: [] }
  const api = {
    explorerPeek: vi.fn(() => new Promise<ApiResult<PeekResult>>(resolve => { pending.peek.push(resolve) })),
    explorerCancel: vi.fn(async () => ok({ cancelled: 1 })),
    scriptObjects: vi.fn(() => new Promise(resolve => { pending.script.push(resolve as never) })),
    cancelScripting: vi.fn(async () => ok({ cancelled: 1 })),
    explorerChildren: vi.fn(() => new Promise<ApiResult<ExplorerChildrenResult>>(resolve => { pending.columns.push(resolve) })),
    writeClipboardText: vi.fn(async () => ok(undefined))
  }
  let live = [{ id: connectionId }]
  const connectionListeners = new Set<() => void>()
  const connections = { getSnapshot: () => live, subscribe: (listener: () => void) => { connectionListeners.add(listener); return () => connectionListeners.delete(listener) } }
  let documents: Record<string, unknown> = { tab: {} }
  const searchListeners = new Set<() => void>()
  const searches = { getSnapshot: () => ({ documents }), subscribe: (listener: () => void) => { searchListeners.add(listener); return () => searchListeners.delete(listener) } }
  const scriptingOptions = { getSnapshot: () => ({ options: {} as ScriptingOptions }), subscribe: () => () => {} }
  const timers: { callback?: () => void; ms?: number; cleared: number } = { cleared: 0 }
  const fakeTimers = { setTimeout: (callback: () => void, ms: number) => { timers.callback = callback; timers.ms = ms; return 1 }, clearTimeout: () => { timers.callback = undefined; timers.cleared++ } }
  let ids = 0
  const newId = () => `id-${++ids}`
  const peek = new PeekService({ api: api as never, connections, scriptingOptions, newId })
  const service = new SearchDetailsService({ api: api as never, peek, connections, searches, scriptingOptions, timers: fakeTimers, newId })
  const settle = () => { const callback = timers.callback; timers.callback = undefined; callback?.() }
  return {
    service, api, pending, timers, settle,
    lose: () => { live = []; for (const listener of connectionListeners) listener() },
    restore: () => { live = [{ id: connectionId }]; for (const listener of connectionListeners) listener() },
    close: () => { documents = {}; for (const listener of searchListeners) listener() }
  }
}

describe('Search Objects details pane', () => {
  it('shows the hit at once and reads it only once the selection settles, so arrowing past hits reads nothing', () => {
    const { service, api, timers, settle } = setup()
    service.show('tab', connectionId, table)
    expect(service.getSnapshot().documents.tab).toMatchObject({ hit: table, kind: 'table', facts: { status: 'loading' }, definition: { status: 'loading' } })
    expect(timers.ms).toBe(searchDetailsLimits.settleMs)
    service.show('tab', connectionId, procedure)
    expect(timers.cleared).toBe(1)
    expect(api.explorerPeek).not.toHaveBeenCalled()
    settle()
    // Only the hit the selection rested on is read; a procedure's text comes with its facts, as Peek reads it.
    expect(api.explorerPeek).toHaveBeenCalledTimes(1)
    expect(api.explorerPeek).toHaveBeenCalledWith(expect.objectContaining({ connectionId, target: procedure.object }))
    expect(api.scriptObjects).not.toHaveBeenCalled()
    // The hit already shown reads nothing again.
    service.show('tab', connectionId, procedure)
    expect(timers.callback).toBeUndefined()
  })

  it('fills a module\'s facts and text, and a table\'s CREATE script, through Peek\'s reads', async () => {
    const { service, api, pending, settle } = setup()
    service.show('tab', connectionId, procedure)
    settle()
    pending.peek[0]!(ok({ facts: { schema: 'dbo', executeAs: 'CALLER' }, definition: 'CREATE PROCEDURE dbo.usp_Ship AS\nBEGIN\n  UPDATE dbo.Orders SET Shipped = 1\nEND', elapsedMs: 2 }))
    await flush()
    expect(service.getSnapshot().documents.tab).toMatchObject({ facts: { status: 'ready', value: { executeAs: 'CALLER' } }, definition: { status: 'ready', value: { text: expect.stringContaining('UPDATE dbo.Orders') } } })
    service.show('tab', connectionId, table)
    settle()
    expect(api.scriptObjects).toHaveBeenCalledWith(expect.objectContaining({ verb: 'create', targets: [table.object] }))
    pending.script[0]!(ok({ text: 'CREATE TABLE [dbo].[Orders]' }))
    await flush()
    expect(service.getSnapshot().documents.tab?.definition).toEqual({ status: 'ready', value: { text: 'CREATE TABLE [dbo].[Orders]' } })
  })

  it('scripts any other kind Script As can write, and says when a kind has no definition', async () => {
    const { service, api, pending, settle } = setup()
    expect(scriptable(trigger)).toBe(true)
    expect(scriptable(column)).toBe(false)
    service.show('tab', connectionId, trigger)
    expect(service.getSnapshot().documents.tab).not.toHaveProperty('facts')
    settle()
    expect(api.explorerPeek).not.toHaveBeenCalled()
    expect(api.scriptObjects).toHaveBeenCalledWith(expect.objectContaining({ verb: 'create', targets: [trigger.object] }))
    pending.script[0]!(ok({ error: { code: 'SCRIPT_FAILED', message: 'The trigger could not be scripted.' } } as never))
    await flush()
    expect(service.getSnapshot().documents.tab?.definition).toEqual({ status: 'error', message: 'The trigger could not be scripted.' })
    service.show('tab', connectionId, column)
    settle()
    expect(service.getSnapshot().documents.tab?.definition).toEqual({ status: 'none' })
    expect(api.scriptObjects).toHaveBeenCalledTimes(1)
  })

  it('reads a table\'s columns when the pane shows them, once per hit', async () => {
    const { service, api, pending, settle } = setup()
    service.show('tab', connectionId, table)
    settle()
    service.setView('columns')
    expect(api.explorerChildren).toHaveBeenCalledWith(expect.objectContaining({ connectionId, node: { type: 'folder', owner: table.object, folder: 'columns' }, pageSize: searchDetailsLimits.columns }))
    pending.columns[0]!(ok({ nodes: [
      { ref: { type: 'object', object: column.object }, label: 'Id', icon: 'key', hasChildren: false, sublabel: '(PK, int, not null)' },
      { ref: { type: 'object', object: { ...column.object, name: 'Note' } }, label: 'Note', icon: 'symbol-field', hasChildren: false }
    ], elapsedMs: 1 }))
    await flush()
    expect(service.getSnapshot().documents.tab?.columns).toEqual({ status: 'ready', value: [{ name: 'Id', detail: '(PK, int, not null)' }, { name: 'Note' }] })
    service.setView('definition')
    service.setView('columns')
    expect(api.explorerChildren).toHaveBeenCalledTimes(1)
    // A procedure has no columns to read.
    service.show('tab', connectionId, procedure)
    settle()
    expect(api.explorerChildren).toHaveBeenCalledTimes(1)
  })

  it('cancels a tab\'s reads on a new hit, a closed tab, a hidden pane or a lost server', async () => {
    const { service, api, settle, close, lose } = setup()
    service.show('tab', connectionId, trigger)
    settle()
    service.show('tab', connectionId, procedure)
    expect(api.cancelScripting).toHaveBeenCalledWith(['id-1'])
    settle()
    // Hiding the pane ends its reads and keeps nothing; showing it reads the selection again (SearchPanel shows it).
    service.setHidden(true)
    expect(api.explorerCancel).toHaveBeenCalledWith(['id-2'])
    expect(service.getSnapshot().documents).toEqual({})
    service.show('tab', connectionId, procedure)
    expect(service.getSnapshot().documents).toEqual({})
    service.setHidden(false)
    service.show('tab', connectionId, procedure)
    settle()
    lose()
    expect(api.explorerCancel).toHaveBeenLastCalledWith(['id-3'])
    expect(service.getSnapshot().documents.tab).toMatchObject({ facts: { status: 'error', message: 'The server is not connected.' }, definition: { status: 'error' } })
    close()
    expect(service.getSnapshot().documents).toEqual({})
    service.dispose()
  })

  it('takes a new answer\'s hit for the same object, reads columns once while settling and again after failing, and reads a lost hit again on reconnect', async () => {
    const { service, api, pending, settle, lose, restore } = setup()
    service.show('tab', connectionId, procedure)
    settle()
    // Another query matches the same procedure on another line: the pane shows that match, without reading again.
    const again: ObjectSearchHit = { ...procedure, definition: { ...procedure.definition!, line: 9, preview: 'RETURN 0' } }
    service.show('tab', connectionId, again)
    expect(service.getSnapshot().documents.tab?.hit).toBe(again)
    expect(api.explorerPeek).toHaveBeenCalledTimes(1)
    // Columns chosen while the table settles are read once, by the settled read.
    service.show('tab', connectionId, table)
    service.setView('columns')
    expect(api.explorerChildren).not.toHaveBeenCalled()
    settle()
    expect(api.explorerChildren).toHaveBeenCalledTimes(1)
    pending.columns[0]!(ok({ nodes: [], elapsedMs: 1, error: { code: 'TIMEOUT', message: 'Timed out.', retryable: true } } as never))
    await flush()
    expect(service.getSnapshot().documents.tab?.columns).toMatchObject({ status: 'error' })
    service.setView('definition')
    service.setView('columns')
    expect(api.explorerChildren).toHaveBeenCalledTimes(2)
    // A lost server marks the hit once; its return reads the hit again.
    lose()
    expect(service.getSnapshot().documents.tab).toMatchObject({ lost: true, facts: { status: 'error', message: 'The server is not connected.' } })
    const marked = service.getSnapshot()
    lose()
    expect(service.getSnapshot()).toBe(marked)
    restore()
    expect(service.getSnapshot().documents.tab).toMatchObject({ facts: { status: 'loading' }, columns: { status: 'loading' } })
    expect(service.getSnapshot().documents.tab?.lost).toBeUndefined()
    expect(api.explorerPeek).toHaveBeenCalledTimes(3)
    service.dispose()
  })

  it('sizes the pane by its sash, within its limits', () => {
    expect(detailsDrag(600, 0, 1000)).toBe(0.4)
    expect(detailsDrag(50, 0, 1000)).toBe(searchDetailsLimits.maximum)
    expect(detailsDrag(990, 0, 1000)).toBe(searchDetailsLimits.minimum)
    expect(detailsKey(0.45, 'ArrowLeft')).toBe(0.5)
    expect(detailsKey(0.45, 'ArrowRight')).toBe(0.4)
    expect(detailsKey(0.45, 'Home')).toBe(searchDetailsLimits.maximum)
    expect(detailsKey(0.45, 'Enter')).toBeUndefined()
    const { service } = setup()
    service.setSize(2)
    expect(service.getSnapshot().size).toBe(searchDetailsLimits.maximum)
    service.setSize(undefined)
    expect(service.getSnapshot().size).toBeUndefined()
  })

  it('marks the matched line: the module\'s own line, or the preview\'s line nearest it in a script', () => {
    const module = 'CREATE PROCEDURE dbo.usp_Ship AS\nBEGIN\n  UPDATE dbo.Orders SET Shipped = 1\nEND'
    expect(matchedLine(module, procedure, true)).toBe(3)
    // SMO's script adds header lines above the module's text.
    const script = 'SET ANSI_NULLS ON\nGO\nSET QUOTED_IDENTIFIER ON\nGO\n' + module
    expect(matchedLine(script, procedure, false)).toBe(7)
    expect(matchedLine(module, table, true)).toBeUndefined()
    expect(matchedLine('SELECT 1', procedure, true)).toBeUndefined()
    // A new answer's hit for the same object (same read) matching another line scrolls again; the same line does not.
    const later: ObjectSearchHit = { ...procedure, definition: { ...procedure.definition!, line: 1, preview: 'CREATE PROCEDURE' } }
    expect(scrollKey(1, matchedLine(module, later, true))).not.toBe(scrollKey(1, matchedLine(module, procedure, true)))
    expect(scrollKey(1, 3)).toBe(scrollKey(1, matchedLine(module, procedure, true)))
  })

  it('lists a hit\'s type and place before anything is read', () => {
    expect(hitProperties(table)).toEqual([{ label: 'Type', value: 'Table' }, { label: 'Database', value: 'Sales' }, { label: 'Schema', value: 'dbo' }])
    expect(hitProperties(trigger)).toEqual([{ label: 'Type', value: 'Trigger' }, { label: 'Database', value: 'Sales' }, { label: 'Schema', value: 'dbo' }, { label: 'Table', value: 'Orders' }])
    expect(hitProperties({ object: { kind: 'login', name: 'app_reader' }, folder: 'logins', label: 'app_reader' })).toEqual([{ label: 'Type', value: 'Login' }])
  })

  it('shows a hit whose kind this build does not know (from a newer backend) as a plain object rather than failing the pane', () => {
    const future = { object: { kind: 'futureKind', database: 'Sales', schema: 'dbo', name: 'X', parent: { kind: 'futureParent', schema: 'dbo', name: 'P' } }, folder: 'tables', label: 'dbo.X' } as unknown as ObjectSearchHit
    expect(hitProperties(future)).toEqual([{ label: 'Type', value: 'Object' }, { label: 'Database', value: 'Sales' }, { label: 'Schema', value: 'dbo' }, { label: 'Object', value: 'P' }])
    expect(hitKindSpec('futureKind')).toMatchObject({ title: 'Object', icon: 'file' })
    expect(hitKindSpec('toString')).toMatchObject({ title: 'Object' })
    expect(hitKindSpec('table')).toMatchObject({ title: 'Table', icon: 'table' })
  })
})
