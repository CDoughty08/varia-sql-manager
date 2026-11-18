import { describe, expect, it, vi } from 'vitest'
import { languagesContribution } from '../src/renderer/src/contributions/languages'
import { definitionMessages, definitionNode } from '../src/renderer/src/languages/definition'
import type { FoundDefinition } from '../src/renderer/src/languages/SqlLanguageService'
import { commandCatalog } from '../src/shared/commands/catalog'
import { gestureCatalog } from '../src/shared/commands/gestures'
import { bindDefinitionPointer, monacoDefinitionLink } from '../src/renderer/src/editor/create-editor'
import { bindPeekCardKey, EditorPeekService, editorPeekAnchor, peekCardContextKey } from '../src/renderer/src/languages/EditorPeekService'

type Handler = { when?: () => boolean; unavailable?: () => string; run: () => Promise<void> | void }
const range = { start: { line: 0, character: 14 }, end: { line: 0, character: 26 } }
const customer: FoundDefinition = { connectionId: 'c1', definition: { database: 'Sales', schema: 'dbo', name: 'Customer', kind: 'table', range } }
const procedure: FoundDefinition = { connectionId: 'c1', definition: { database: 'Sales', schema: 'dbo', name: 'Load', kind: 'procedure', subtype: 'sql', range } }

function fixture(answer: () => Promise<FoundDefinition | null | undefined>, options: { focused?: boolean; live?: boolean; language?: string } = {}) {
  const handlers: Record<string, Handler> = {}
  const model = { getLanguageId: () => options.language ?? 'sql', getWordAtPosition: () => ({ word: 'Customer', startColumn: 15, endColumn: 23 }), uri: { toString: () => 'q1' }, getVersionId: () => 3 }
  const focus = { now: options.focused ?? true }
  const dom = { ownerDocument: { defaultView: null }, getBoundingClientRect: () => ({ left: 100, top: 50, right: 900, bottom: 650 }) }
  const editor = { hasWidgetFocus: () => focus.now, getModel: () => model, getPosition: () => ({ lineNumber: 1, column: 20 }), getDomNode: () => dom, focus: vi.fn() }
  const other = { hasWidgetFocus: () => false, getModel: () => model, getPosition: () => ({ lineNumber: 1, column: 1 }) }
  const definition = vi.fn(answer)
  const scripting = { run: vi.fn(async () => {}), inform: vi.fn() }
  const peekTabs = { open: vi.fn(() => 'tab-1' as string | undefined) }
  const peek = { peekAt: vi.fn(() => true), hoverAt: vi.fn(), cancelHover: vi.fn(), getSnapshot: vi.fn(() => ({}) as object) }
  const connections = { isLive: () => options.live ?? true }
  const editorPeek = new EditorPeekService({ sqlLanguage: { definition } as never, connections, scripting, peek: peek as never, peekTabs })
  const contribution = languagesContribution({
    commands: { register: (id: string, handler: Handler) => { handlers[id] = handler; return { dispose: () => { delete handlers[id] } } } } as never,
    documents: { get: () => undefined, getSnapshot: () => ({ activeId: '' }) } as never,
    connections: connections as never,
    sqlLanguage: { refreshCache: vi.fn() } as never,
    monaco: { editor: { getEditors: () => [other, editor] } } as never,
    editorPeek
  })
  const place = { editor, model, position: { lineNumber: 1, column: 20 } }
  return { handlers, definition, scripting, peekTabs, peek, editorPeek, contribution, editor, model, focus, place }
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
    expect(f.peek.peekAt).not.toHaveBeenCalled()
  })

  it('is not offered once focus has left every SQL editor', () => {
    const f = fixture(async () => customer)
    expect(f.handlers['edit.goToDefinition']!.when!()).toBe(true)
    // From the palette over Object Explorer or a grid, nothing is under a caret.
    f.focus.now = false
    expect(f.handlers['edit.goToDefinition']!.when!()).toBe(false)
  })

  it('opens Peek\'s card beside the name at the caret (Alt+F12), from the keyboard so it takes focus', async () => {
    const f = fixture(async () => procedure)
    await f.handlers['edit.peekDefinition']!.run()
    expect(f.peek.peekAt).toHaveBeenCalledWith(definitionNode(procedure), expect.objectContaining({ document: f.editor.getDomNode().ownerDocument }), 'keyboard')
    expect(definitionNode(procedure).subtype).toBe('sql')
    expect(f.scripting.run).not.toHaveBeenCalled()
    expect(f.peekTabs.open).not.toHaveBeenCalled()
    f.peek.peekAt.mockReturnValueOnce(false)
    await f.handlers['edit.peekDefinition']!.run()
    expect(f.scripting.inform).toHaveBeenCalledWith(definitionMessages.notPeekable('dbo.Load'))
  })

  it('opens the object in a Peek tab (Open Definition in Peek Tab, the Ctrl+click command)', async () => {
    const f = fixture(async () => procedure)
    await f.handlers['edit.openPeekTab']!.run()
    expect(f.peekTabs.open).toHaveBeenCalledWith(definitionNode(procedure))
    expect(f.peek.peekAt).not.toHaveBeenCalled()
    f.peekTabs.open.mockReturnValueOnce(undefined)
    await f.handlers['edit.openPeekTab']!.run()
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
    for (const id of ['edit.goToDefinition', 'edit.peekDefinition', 'edit.openPeekTab']) expect(unfocused.handlers[id]!.when!()).toBe(false)
    expect(unfocused.handlers['edit.goToDefinition']!.unavailable!()).toBe(definitionMessages.unavailable)
    const json = fixture(async () => customer, { language: 'json' })
    expect(json.handlers['edit.goToDefinition']!.when!()).toBe(false)
    json.contribution.dispose()
    expect(json.handlers['edit.goToDefinition']).toBeUndefined()
  })

  it('peeks a name the pointer rests on after the hover delay, quietly, and never a keyword or the name already shown', async () => {
    const f = fixture(async () => customer)
    f.editorPeek.hover(f.place as never)
    expect(f.peek.hoverAt).toHaveBeenCalledTimes(1)
    const [key, open] = f.peek.hoverAt.mock.calls[0] as unknown as [string, () => void]
    expect(key).toBe('q1\n3\n1\n15')
    open()
    await vi.waitFor(() => expect(f.peek.peekAt).toHaveBeenCalledWith(definitionNode(customer), expect.anything(), 'hover'))
    // Resting on it again asks nothing while its card is open.
    f.peek.getSnapshot.mockReturnValue({ open: { source: 'hover', anchor: {} } })
    f.editorPeek.hover(f.place as never)
    expect(f.peek.hoverAt).toHaveBeenCalledTimes(1)
    // A card the keyboard opened keeps its place, as in Object Explorer.
    f.peek.getSnapshot.mockReturnValue({ open: { source: 'keyboard' } })
    f.editorPeek.hover({ ...f.place, position: { lineNumber: 2, column: 1 } } as never)
    expect(f.peek.hoverAt).toHaveBeenCalledTimes(1)
    // A keyword asks nothing, and forgets a hover waiting.
    f.peek.getSnapshot.mockReturnValue({})
    f.editorPeek.hover({ ...f.place, model: { ...f.model, getWordAtPosition: () => ({ word: 'select', startColumn: 1, endColumn: 7 }) } } as never)
    expect(f.peek.hoverAt).toHaveBeenCalledTimes(1)
    expect(f.peek.cancelHover).toHaveBeenCalled()
    // Nothing found, a failure or an object Peek cannot show says nothing from a hover.
    const quiet = fixture(async () => null)
    await quiet.editorPeek.run('card', quiet.place as never, 'hover')
    const failed = fixture(async () => { throw new Error('x') })
    await failed.editorPeek.run('card', failed.place as never, 'hover')
    const refused = fixture(async () => customer)
    refused.peek.peekAt.mockReturnValue(false)
    await refused.editorPeek.run('card', refused.place as never, 'hover')
    for (const each of [quiet, failed, refused]) expect(each.scripting.inform).not.toHaveBeenCalled()
  })

  it('opens nothing when the hover is cancelled or the text changes while the name is looked up, and asks once per name', async () => {
    let answer!: (found: FoundDefinition) => void
    const f = fixture(() => new Promise(resolve => { answer = resolve }))
    f.editorPeek.hover(f.place as never)
    const open = f.peek.hoverAt.mock.calls[0]![1] as unknown as (wanted: () => boolean) => void
    let wanted = true
    open(() => wanted)
    // The pointer moving within the name while it is looked up starts nothing more.
    f.editorPeek.hover(f.place as never)
    expect(f.peek.hoverAt).toHaveBeenCalledTimes(1)
    expect(f.definition).toHaveBeenCalledTimes(1)
    // The modifier went up (or the pointer left) before the answer came.
    wanted = false
    answer(customer)
    // Once the lookup has finished, resting on the name waits again.
    await vi.waitFor(() => { f.editorPeek.hover(f.place as never); expect(f.peek.hoverAt).toHaveBeenCalledTimes(2) })
    expect(f.peek.peekAt).not.toHaveBeenCalled()
    // Typing while Alt+F12 looks the name up: the name may have moved, so no card.
    let version = 3
    const typed = fixture(async () => { version = 4; return customer })
    await typed.editorPeek.run('card', { ...typed.place, model: { ...typed.model, getVersionId: () => version } } as never)
    expect(typed.peek.peekAt).not.toHaveBeenCalled()
    expect(typed.scripting.inform).not.toHaveBeenCalled()
    // Switching the editor to another tab while Alt+F12 looks the name up: no card in the other document.
    const switched = fixture(async () => { switched.editor.getModel = () => ({}) as never; return customer })
    await switched.editorPeek.run('card', switched.place as never)
    expect(switched.peek.peekAt).not.toHaveBeenCalled()
    expect(switched.scripting.inform).not.toHaveBeenCalled()
  })

  it('remembers a hovered name only once its card opens, so a name whose card did not open can be hovered again', async () => {
    const f = fixture(async () => customer)
    // Another name's card is open; this name's card is refused (or its hover cancelled).
    f.peek.getSnapshot.mockReturnValue({ open: { id: 7, source: 'hover', anchor: {} } })
    f.peek.peekAt.mockReturnValue(false)
    f.editorPeek.hover(f.place as never)
    const open = f.peek.hoverAt.mock.calls[0]![1] as unknown as (wanted: () => boolean) => void
    open(() => true)
    await vi.waitFor(() => expect(f.peek.peekAt).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => { f.editorPeek.hover(f.place as never); expect(f.peek.hoverAt).toHaveBeenCalledTimes(2) })
    // Once it opens, resting on it asks nothing while that card is open.
    f.peek.peekAt.mockReturnValue(true)
    ;(f.peek.hoverAt.mock.calls[1]![1] as unknown as (wanted: () => boolean) => void)(() => true)
    await vi.waitFor(() => expect((f.editorPeek as unknown as { shown?: unknown }).shown).toBeDefined())
    f.editorPeek.hover(f.place as never)
    expect(f.peek.hoverAt).toHaveBeenCalledTimes(2)
  })

  it('anchors the card at the name while it is in view, follows it, and closes when the text changes', () => {
    const listeners: Record<string, () => void> = {}
    const on = (name: string) => (listener: () => void) => { listeners[name] = listener; return { dispose: () => { delete listeners[name] } } }
    const visible = { at: { top: 20, left: 60, height: 18 } }
    const editor = {
      getDomNode: () => ({ ownerDocument: 'doc', getBoundingClientRect: () => ({ left: 100, top: 50, right: 900, bottom: 650 }) }),
      getScrolledVisiblePosition: (position: { column: number }) => ({ ...visible.at, left: visible.at.left + (position.column - 15) * 8 }),
      getLayoutInfo: () => ({ contentLeft: 40, width: 800 }),
      onDidScrollChange: on('scroll'), onDidLayoutChange: on('layout'), onDidChangeModelContent: on('content'), onDidChangeModel: on('model'), onDidDispose: on('dispose'), focus: vi.fn()
    }
    const model = { getWordAtPosition: () => ({ word: 'Customer', startColumn: 15, endColumn: 23 }) }
    const anchor = editorPeekAnchor({ editor, model, position: { lineNumber: 1, column: 20 } } as never)!
    expect(anchor.document).toBe('doc')
    expect(anchor.rect()).toEqual({ left: 160, top: 70, right: 224, bottom: 88 })
    // Scrolled above the editor's top: the card keeps its place.
    visible.at = { top: -40, left: 60, height: 18 }
    expect(anchor.rect()).toBeUndefined()
    const moved = vi.fn(), gone = vi.fn()
    const unwatch = anchor.watch(moved, gone)
    listeners.scroll!()
    listeners.content!()
    expect(moved).toHaveBeenCalledTimes(1)
    expect(gone).toHaveBeenCalledTimes(1)
    unwatch()
    expect(Object.keys(listeners)).toEqual([])
    anchor.focus()
    expect(editor.focus).toHaveBeenCalled()
  })

  it("makes Escape in a query editor close Peek's card, beside a name or a row, and drop an Alt+F12 still looking one up", async () => {
    let answer!: (found: FoundDefinition) => void
    const f = fixture(() => new Promise<FoundDefinition>(resolve => { answer = resolve }))
    const snapshot: { open?: object } = {}, peekListeners = new Set<() => void>()
    f.peek.getSnapshot.mockImplementation(() => snapshot)
    const close = vi.fn(() => { delete snapshot.open; peekListeners.forEach(listener => listener()) })
    Object.assign(f.peek, { close, subscribe: (listener: () => void) => { peekListeners.add(listener); return () => peekListeners.delete(listener) } })
    const values: boolean[] = [], key = { set: vi.fn((value: boolean) => values.push(value)), reset: vi.fn() }
    const createContextKey = vi.fn(() => key)
    const binding = bindPeekCardKey(Object.assign(f.editor, { createContextKey }) as never, f.editorPeek)
    expect(createContextKey).toHaveBeenCalledWith(peekCardContextKey, false)
    expect(values).toEqual([false])

    // Alt+F12 while its lookup runs: Escape there is the card's, and the lookup then opens nothing, not even a notice.
    const pending = f.handlers['edit.peekDefinition']!.run()
    expect(values.at(-1)).toBe(true)
    expect(f.editorPeek.cardIn(f.editor)).toBe(true)
    // Another editor's Escape is not the lookup's: the card it would open belongs beside this editor's caret.
    expect(f.editorPeek.cardIn({})).toBe(false)
    f.editorPeek.closeCard({})
    expect(values.at(-1)).toBe(true)
    f.editorPeek.closeCard(f.editor)
    expect(values.at(-1)).toBe(false)
    answer(procedure)
    await pending
    expect(f.peek.peekAt).not.toHaveBeenCalled()
    expect(f.scripting.inform).not.toHaveBeenCalled()
    // A dropped lookup that fails says nothing either.
    let fail!: (error: Error) => void
    f.definition.mockImplementationOnce(() => new Promise<FoundDefinition>((_resolve, reject) => { fail = reject }))
    const failing = f.handlers['edit.peekDefinition']!.run()
    f.editorPeek.closeCard(f.editor)
    fail(new Error('lost'))
    await failing
    expect(f.scripting.inform).not.toHaveBeenCalled()

    // A card a hover opened beside a name here, or beside an Object Explorer row while typing here, leaves focus in the text:
    // Escape in the editor closes either.
    for (const open of [{ anchor: {} }, { rowId: 'oe-1' }]) {
      snapshot.open = open
      peekListeners.forEach(listener => listener())
      expect(values.at(-1)).toBe(true)
      expect(f.editorPeek.cardIn({})).toBe(true)
      f.editorPeek.closeCard(f.editor)
      expect(values.at(-1)).toBe(false)
    }
    expect(close).toHaveBeenCalledTimes(2)
    // With no card, Escape is the editor's own.
    f.editorPeek.closeCard(f.editor)
    expect(close).toHaveBeenCalledTimes(2)

    // A lookup that finishes clears its claim: the card it opened holds Escape from then on.
    delete snapshot.open
    f.peek.peekAt.mockImplementationOnce(() => { snapshot.open = { anchor: {} }; peekListeners.forEach(listener => listener()); return true })
    const opened = f.handlers['edit.peekDefinition']!.run()
    expect(values.at(-1)).toBe(true)
    answer(procedure)
    await opened
    expect(f.peek.peekAt).toHaveBeenCalledTimes(1)
    expect(values.at(-1)).toBe(true)
    f.editorPeek.closeCard(f.editor)
    expect(values.at(-1)).toBe(false)

    binding.dispose()
    expect(key.reset).toHaveBeenCalled()
    expect(peekListeners.size).toBe(0)
  })

  it('leaves Escape alone while a hover looks a name up: the pointer opened nothing yet', async () => {
    const f = fixture(() => new Promise<FoundDefinition>(() => {}))
    void f.editorPeek.run('card', f.place as never, 'hover')
    expect(f.editorPeek.cardIn(f.editor)).toBe(false)
  })

  it('opens a Peek tab on a plain Ctrl+click on a name, never a cursor-adding, selecting, double or margin click', () => {
    type Up = { event: { leftButton: boolean; detail: number; browserEvent: Partial<MouseEvent> }; target: { type: number } }
    let up: ((event: Up) => void) | undefined
    const link = { dispose: vi.fn() }
    const state = { cursor: 'altKey' as 'altKey' | 'ctrlKey' | 'metaKey', empty: true, matches: true }
    const instance = {
      getContribution: (id: string) => id === monacoDefinitionLink ? link : null,
      onMouseUp: (listener: (event: Up) => void) => { up = listener; return { dispose: () => { up = undefined } } },
      getOption: () => state.cursor, getSelection: () => ({ isEmpty: () => state.empty })
    }
    const execute = vi.fn(async () => true)
    const matches = vi.fn(() => state.matches)
    const binding = bindDefinitionPointer({
      gestures: { matches } as never, commands: { execute } as never,
      monaco: { editor: { MouseTargetType: { CONTENT_TEXT: 6 }, EditorOption: { multiCursorModifier: 80 } } } as never
    }, instance as never)
    // Monaco's own Ctrl+hover link would ask the backend for every word under a Ctrl-held pointer.
    expect(link.dispose).toHaveBeenCalledTimes(1)
    const click = (browserEvent: Partial<MouseEvent>, extra: Partial<Up['event']> = {}, type = 6) => up!({ event: { leftButton: true, detail: 1, browserEvent, ...extra }, target: { type } })
    click({ ctrlKey: true })
    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute).toHaveBeenLastCalledWith('edit.openPeekTab', undefined, 'keybinding')
    expect(matches).toHaveBeenLastCalledWith('editor.goToDefinition', { ctrlKey: true })
    // Ctrl+Alt+click adds a cursor (Alt is Monaco's multi-cursor key): never a Peek tab too.
    click({ ctrlKey: true, altKey: true })
    // With Ctrl+click as multi-cursor (Tools › Options), Ctrl+click is Monaco's.
    state.cursor = 'ctrlKey'
    click({ ctrlKey: true })
    state.cursor = 'altKey'
    click({ ctrlKey: true }, { detail: 2 })
    click({ ctrlKey: true }, { leftButton: false })
    click({ ctrlKey: true }, {}, 2)
    state.empty = false
    click({ ctrlKey: true })
    state.empty = true
    state.matches = false
    click({})
    expect(execute).toHaveBeenCalledTimes(1)
    binding.dispose()
    expect(up).toBeUndefined()
  })

  it('peeks on Ctrl+hover only over text with the modifier and no button held, and forgets the hover otherwise', () => {
    type Move = { event: { browserEvent: Partial<MouseEvent> }; target: { type: number; position?: { lineNumber: number; column: number } } }
    let move: ((event: Move) => void) | undefined, leave: (() => void) | undefined
    const instance = {
      getContribution: () => null, getModel: () => 'model',
      onMouseUp: () => ({ dispose() {} }),
      onMouseMove: (listener: (event: Move) => void) => { move = listener; return { dispose: () => { move = undefined } } },
      onMouseLeave: (listener: () => void) => { leave = listener; return { dispose: () => { leave = undefined } } }
    }
    const editorPeek = { hover: vi.fn(), cancelHover: vi.fn() }
    const matches = vi.fn((id: string, event: Partial<MouseEvent>) => id === 'editor.peekHover' && !!event.ctrlKey)
    const workbench = {
      gestures: { matches } as never, commands: { execute: vi.fn() } as never, editorPeek: editorPeek as never,
      monaco: { editor: { MouseTargetType: { CONTENT_TEXT: 6 }, EditorOption: { multiCursorModifier: 80 } } } as never
    }
    const binding = bindDefinitionPointer(workbench, instance as never)
    const position = { lineNumber: 1, column: 3 }
    move!({ event: { browserEvent: { ctrlKey: true, buttons: 0 } }, target: { type: 6, position } })
    expect(editorPeek.hover).toHaveBeenCalledWith({ editor: instance, model: 'model', position })
    move!({ event: { browserEvent: { ctrlKey: false, buttons: 0 } }, target: { type: 6, position } })
    move!({ event: { browserEvent: { ctrlKey: true, buttons: 1 } }, target: { type: 6, position } })
    move!({ event: { browserEvent: { ctrlKey: true, buttons: 0 } }, target: { type: 2, position } })
    leave!()
    expect(editorPeek.hover).toHaveBeenCalledTimes(1)
    expect(editorPeek.cancelHover).toHaveBeenCalledTimes(4)
    binding.dispose()
    expect(move).toBeUndefined()
    expect(leave).toBeUndefined()
    // Peek's own editors take no hover: a card there would replace the card they are in.
    bindDefinitionPointer(workbench, instance as never, false)
    expect(move).toBeUndefined()
  })

  it('binds F12, Alt+F12 and the definition gestures only through the catalogues, in query and Peek editors alike', () => {
    expect(commandCatalog['edit.goToDefinition'].keybindings).toEqual([{ key: 'f12', when: 'editorTextFocus || peekEditorFocus' }])
    expect(commandCatalog['edit.peekDefinition'].keybindings).toEqual([{ key: 'alt+f12', when: 'editorTextFocus || peekEditorFocus' }])
    // None needs a query tab: no editorFocus, no active query document.
    for (const id of ['edit.goToDefinition', 'edit.peekDefinition', 'edit.openPeekTab'] as const) expect(commandCatalog[id].precondition).toBe('backendReady')
    expect(gestureCatalog['editor.goToDefinition']).toMatchObject({ kind: 'pointerCommand', modifiers: ['mod'], keyboard: ['edit.openPeekTab'] })
    expect(gestureCatalog['editor.peekHover']).toMatchObject({ kind: 'modifier', action: 'hover', modifiers: ['mod'], keyboard: ['edit.peekDefinition'] })
  })
})
