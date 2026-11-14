import { describe, expect, it, vi } from 'vitest'
import { languagesContribution } from '../src/renderer/src/contributions/languages'
import { definitionMessages, definitionNode } from '../src/renderer/src/languages/definition'
import type { FoundDefinition } from '../src/renderer/src/languages/SqlLanguageService'
import { commandCatalog } from '../src/shared/commands/catalog'
import { gestureCatalog } from '../src/shared/commands/gestures'

type Handler = { when?: () => boolean; unavailable?: () => string; run: () => Promise<void> | void }
const range = { start: { line: 0, character: 14 }, end: { line: 0, character: 26 } }
const customer: FoundDefinition = { connectionId: 'c1', definition: { database: 'Sales', schema: 'dbo', name: 'Customer', kind: 'table', range } }

function fixture(answer: () => Promise<FoundDefinition | null | undefined>, options: { focused?: boolean; live?: boolean; language?: string } = {}) {
  const handlers: Record<string, Handler> = {}
  const model = { getLanguageId: () => options.language ?? 'sql', getWordAtPosition: () => ({ word: 'Customer', startColumn: 15, endColumn: 23 }) }
  const focus = { now: options.focused ?? true }
  const editor = { hasWidgetFocus: () => focus.now, getModel: () => model, getPosition: () => ({ lineNumber: 1, column: 20 }) }
  const other = { hasWidgetFocus: () => false, getModel: () => model, getPosition: () => ({ lineNumber: 1, column: 1 }) }
  const definition = vi.fn(answer)
  const scripting = { run: vi.fn(async () => {}), inform: vi.fn() }
  const peekTabs = { open: vi.fn(() => 'tab-1' as string | undefined) }
  const contribution = languagesContribution({
    commands: { register: (id: string, handler: Handler) => { handlers[id] = handler; return { dispose: () => { delete handlers[id] } } } } as never,
    documents: { get: () => undefined, getSnapshot: () => ({ activeId: '' }) } as never,
    connections: { isLive: () => options.live ?? true } as never,
    sqlLanguage: { refreshCache: vi.fn(), definition } as never,
    monaco: { editor: { getEditors: () => [other, editor] } } as never,
    scripting, peekTabs
  })
  return { handlers, definition, scripting, peekTabs, contribution, editor, model, focus }
}

describe('Go To Definition', () => {
  it('scripts the object under the caret of the focused SQL editor as CREATE to a new query (F12)', async () => {
    const f = fixture(async () => customer)
    expect(f.handlers['edit.goToDefinition']!.when!()).toBe(true)
    await f.handlers['edit.goToDefinition']!.run()
    expect(f.definition).toHaveBeenCalledWith(f.model, { lineNumber: 1, column: 20 })
    expect(f.scripting.run).toHaveBeenCalledWith('create', 'newQuery', definitionNode(customer))
    expect(definitionNode(customer)).toMatchObject({ connectionId: 'c1', kind: 'table', ref: { type: 'object', object: { kind: 'table', database: 'Sales', schema: 'dbo', name: 'Customer' } } })
    expect(f.scripting.inform).not.toHaveBeenCalled()
    expect(f.peekTabs.open).not.toHaveBeenCalled()
  })

  it('is not offered once focus has left every SQL editor', () => {
    const f = fixture(async () => customer)
    expect(f.handlers['edit.goToDefinition']!.when!()).toBe(true)
    // From the palette over Object Explorer or a grid, nothing is under a caret.
    f.focus.now = false
    expect(f.handlers['edit.goToDefinition']!.when!()).toBe(false)
  })

  it('opens the object in a Peek tab (Alt+F12)', async () => {
    const procedure: FoundDefinition = { connectionId: 'c1', definition: { database: 'Sales', schema: 'dbo', name: 'Load', kind: 'procedure', subtype: 'sql', range } }
    const f = fixture(async () => procedure)
    await f.handlers['edit.peekDefinition']!.run()
    expect(f.peekTabs.open).toHaveBeenCalledWith(definitionNode(procedure))
    expect(definitionNode(procedure).subtype).toBe('sql')
    expect(f.scripting.run).not.toHaveBeenCalled()
    f.peekTabs.open.mockReturnValueOnce(undefined)
    await f.handlers['edit.peekDefinition']!.run()
    expect(f.scripting.inform).toHaveBeenCalledWith(definitionMessages.notPeekable('dbo.Load'))
  })

  it('answers an unresolved name, a lost server, a failure and an unscriptable object with a quiet notice, never a thrown error', async () => {
    const notFound = fixture(async () => null)
    await expect(notFound.handlers['edit.goToDefinition']!.run()).resolves.toBeUndefined()
    expect(notFound.scripting.inform).toHaveBeenCalledWith('No definition found for Customer.')
    expect(notFound.scripting.run).not.toHaveBeenCalled()
    const lost = fixture(async () => customer, { live: false })
    await lost.handlers['edit.goToDefinition']!.run()
    expect(lost.scripting.inform).toHaveBeenCalledWith('No definition found for Customer.')
    const failed = fixture(async () => { throw new Error('The SQL language request exceeded its time limit.') })
    await expect(failed.handlers['edit.goToDefinition']!.run()).resolves.toBeUndefined()
    expect(failed.scripting.inform).toHaveBeenCalledWith(definitionMessages.failed('The SQL language request exceeded its time limit.'))
    const extended = fixture(async () => ({ connectionId: 'c1', definition: { database: 'master', schema: 'sys', name: 'xp_cmdshell', kind: 'procedure', subtype: 'extended', range } }))
    await extended.handlers['edit.goToDefinition']!.run()
    expect(extended.scripting.inform).toHaveBeenCalledWith(definitionMessages.notScriptable('sys.xp_cmdshell'))
    expect(extended.scripting.run).not.toHaveBeenCalled()
    const scriptFails = fixture(async () => customer)
    scriptFails.scripting.run.mockRejectedValueOnce(new Error('Connect to a SQL Server first.'))
    await scriptFails.handlers['edit.goToDefinition']!.run()
    expect(scriptFails.scripting.inform).toHaveBeenCalledWith(definitionMessages.failed('Connect to a SQL Server first.'))
  })

  it('does nothing visible for a stale answer, and is unavailable without a focused SQL editor', async () => {
    const stale = fixture(async () => undefined)
    await stale.handlers['edit.goToDefinition']!.run()
    expect(stale.scripting.inform).not.toHaveBeenCalled()
    expect(stale.scripting.run).not.toHaveBeenCalled()
    const unfocused = fixture(async () => customer, { focused: false })
    expect(unfocused.handlers['edit.goToDefinition']!.when!()).toBe(false)
    expect(unfocused.handlers['edit.peekDefinition']!.when!()).toBe(false)
    expect(unfocused.handlers['edit.goToDefinition']!.unavailable!()).toBe(definitionMessages.unavailable)
    const json = fixture(async () => customer, { language: 'json' })
    expect(json.handlers['edit.goToDefinition']!.when!()).toBe(false)
    json.contribution.dispose()
    expect(json.handlers['edit.goToDefinition']).toBeUndefined()
  })

  it('binds F12, Alt+F12 and Ctrl+click (⌘-click) only through the catalogues, in query and Peek editors alike', () => {
    expect(commandCatalog['edit.goToDefinition'].keybindings).toEqual([{ key: 'f12', when: 'editorTextFocus || peekEditorFocus' }])
    expect(commandCatalog['edit.peekDefinition'].keybindings).toEqual([{ key: 'alt+f12', when: 'editorTextFocus || peekEditorFocus' }])
    // Neither needs a query tab: no editorFocus, no active query document.
    for (const id of ['edit.goToDefinition', 'edit.peekDefinition'] as const) expect(commandCatalog[id].precondition).toBe('backendReady')
    expect(gestureCatalog['editor.goToDefinition']).toMatchObject({ kind: 'pointerCommand', modifiers: ['mod'], keyboard: ['edit.goToDefinition'] })
  })
})
