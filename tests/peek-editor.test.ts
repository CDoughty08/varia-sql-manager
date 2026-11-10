import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { contextRecord, type ContextKeys } from '../src/shared/commands/context-keys'
import { platforms, type Platform } from '../src/shared/commands/keybindings'
import { computeContextKeys, focusFacts, type FocusElement } from '../src/renderer/src/core/contextkeys'
import { KeybindingService, type KeyDownEvent } from '../src/renderer/src/core/keybindings'
import { createQueryEditor } from '../src/renderer/src/editor/create-editor'
import { bridgeWhen } from '../src/renderer/src/editor/keybinding-bridge'
import { editorIdAttribute, inPeekEditorWidgets, PeekEditor, peekEditorAttribute, peekEditorContextKey, peekEditorHasTextFocus, peekEditorUse, peekModelContext } from '../src/renderer/src/explorer/peek-editor'
import type { QueryEditorInstance } from '../src/renderer/src/editor/create-editor'
import type { DocumentSnapshot } from '../src/renderer/src/services/documents'
import { WorkbenchProvider } from '../src/renderer/src/core/WorkbenchContext'
import { nextStop, PeekBody } from '../src/renderer/src/explorer/PeekCard'
import type { OpenPeek } from '../src/renderer/src/explorer/PeekService'

/** Just enough DOM for the editor host: elements that know their document and parent. */
class FakeElement {
  parentElement: FakeElement | null = null
  readonly children: FakeElement[] = []
  readonly attributes = new Map<string, string>()
  className = ''
  constructor(readonly ownerDocument: FakeDocument) {}
  append(child: FakeElement): void { child.remove(); child.parentElement = this; this.children.push(child) }
  remove(): void { const parent = this.parentElement; if (!parent) return; parent.children.splice(parent.children.indexOf(this), 1); this.parentElement = null }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value) }
}
class FakeDocument { createElement(): FakeElement { return new FakeElement(this) } }

function fakeMonaco() {
  const models: { value: string; uri: string; disposed: boolean; dispose(): void }[] = []
  const editors: { container: FakeElement; model: unknown; disposed: boolean; models: unknown[] }[] = []
  const monaco = {
    editor: { createModel: (value: string, _language: string, uri: unknown) => { const model = { value, uri: String(uri), disposed: false, dispose() { model.disposed = true } }; models.push(model); return model as never } },
    Uri: { parse: (value: string) => value }
  }
  const create = (container: HTMLElement): QueryEditorInstance => {
    const entry = { container: container as unknown as FakeElement, model: null as unknown, disposed: false, models: [] as unknown[] }
    editors.push(entry)
    const instance = { getId: () => `editor-${editors.length}`, getModel: () => entry.model, setModel: (model: unknown) => { entry.model = model; entry.models.push(model) } }
    return { instance: instance as never, contains: () => false, setVisible: () => {}, dispose: () => { entry.disposed = true } }
  }
  return { monaco, create, models, editors }
}
const text = (key: string, value = `CREATE PROCEDURE dbo.P${key} AS SELECT 1`) => ({ key, text: value, connectionId: 'c1', database: 'Sales' })

describe('Peek editor', () => {
  it('makes one editor per view, a model per definition with its connection and database, and disposes each model as the view moves on', () => {
    const { monaco, create, models, editors } = fakeMonaco()
    let ids = 0
    const peek = new PeekEditor({ monaco, create, newId: () => `m${++ids}` })
    const doc = new FakeDocument(), slot = doc.createElement()
    peek.show(slot as never, text('1'))
    expect(editors).toHaveLength(1)
    const host = editors[0]!.container
    expect(host.parentElement).toBe(slot)
    expect(host.attributes.has(peekEditorAttribute)).toBe(true)
    // Named after its editor, as that editor's widget host is, so the card knows its own widgets.
    expect(host.attributes.get(editorIdAttribute)).toBe('editor-1')
    expect(models.map(model => model.uri)).toEqual(['varia-sql://peek/m1'])
    expect(peekModelContext(models[0]!)).toEqual({ connectionId: 'c1', database: 'Sales' })
    expect(editors[0]!.model).toBe(models[0])
    // The same definition again (a render) makes nothing new.
    peek.show(slot as never, text('1'))
    expect(models).toHaveLength(1)
    // Another tab shows: the editor leaves the document, keeping its model; Definition again reuses both.
    peek.hide(slot as never)
    expect(host.parentElement).toBeNull()
    const again = doc.createElement()
    peek.show(again as never, text('1'))
    expect(editors).toHaveLength(1)
    expect(host.parentElement).toBe(again)
    expect(models).toHaveLength(1)
    // A followed dependency (or Refresh, or Back): a new model in the same editor, the old one disposed.
    peek.show(again as never, text('2'))
    expect(editors).toHaveLength(1)
    expect(models.map(model => model.disposed)).toEqual([true, false])
    expect(editors[0]!.model).toBe(models[1])
    // The text of the same object changing (a kept script found stale) is a new model too.
    peek.show(again as never, text('2', 'CREATE TABLE dbo.T (Id int)'))
    expect(models.map(model => model.disposed)).toEqual([true, true, false])
    // Moving on while another tab shows (Back from Dependencies) disposes the model at once.
    peek.hide(again as never)
    peek.keep('3')
    expect(models.every(model => model.disposed)).toBe(true)
    expect(editors[0]!.model).toBeNull()
    peek.keep(undefined)
    // Closing the view disposes the editor (and a model it holds); nothing shows after that.
    peek.show(slot as never, text('4'))
    peek.dispose()
    expect(editors[0]!.disposed).toBe(true)
    expect(models.every(model => model.disposed)).toBe(true)
    expect(host.parentElement).toBeNull()
    peek.show(slot as never, text('5'))
    expect(editors).toHaveLength(1)
    expect(models).toHaveLength(4)
  })

  it('makes the editor again in another window, since Monaco binds to the window it was made in, keeping the model', () => {
    const { monaco, create, models, editors } = fakeMonaco()
    const peek = new PeekEditor({ monaco, create })
    const main = new FakeDocument(), popout = new FakeDocument()
    peek.show(main.createElement() as never, text('1'))
    const there = popout.createElement()
    peek.show(there as never, text('1'))
    expect(editors).toHaveLength(2)
    expect(editors[0]!.disposed).toBe(true)
    expect(editors[0]!.container.parentElement).toBeNull()
    expect(editors[1]!.container.ownerDocument).toBe(popout)
    expect(models).toHaveLength(1)
    expect(editors[1]!.model).toBe(models[0])
  })

  it('creates the query editor read-only, compact and keyed for Peek, without Object Explorer drops, with Tools › Options bound', () => {
    const contextKeys: [string, unknown][] = [], listeners: string[] = []
    let created: Record<string, unknown> | undefined
    const instance = {
      createContextKey: (key: string, value: unknown) => { contextKeys.push([key, value]) },
      getContainerDomNode: () => ({ addEventListener: (type: string) => { listeners.push(type) }, removeEventListener: () => {} }),
      dispose: vi.fn(), getId: () => 'peek-1', getDomNode: () => null, onDidChangeModel: () => ({ dispose: () => {} })
    }
    const unbind = vi.fn()
    // The Query editor pane is closed: an editor group's widget host hides with it, the Peek card's does not.
    const hosts: { hidden: boolean; className: string; attributes: Record<string, string>; setAttribute(name: string, value: string): void; remove(): void }[] = []
    const container = { ownerDocument: { createElement: () => {
      const host = { hidden: false, className: '', attributes: {} as Record<string, string>, setAttribute(name: string, value: string) { this.attributes[name] = value }, remove: () => {} }
      hosts.push(host)
      return host
    }, body: { appendChild: () => {} } } } as unknown as HTMLElement
    const workbench = {
      monaco: { editor: { create: (_container: unknown, options: Record<string, unknown>) => { created = options; return instance } } },
      editorOptions: { monacoOptions: () => ({ fontSize: 15, lineNumbers: 'on' }), bindEditor: () => ({ dispose: unbind }) },
      panes: { getSnapshot: () => ({ editor: false }), subscribe: () => () => {} }
    }
    vi.stubGlobal('MutationObserver', class { observe() {} disconnect() {} })
    const editor = createQueryEditor(workbench as never, container, peekEditorUse)
    expect(hosts[0]!.hidden).toBe(false)
    // Its widget host is marked as Peek's, so a press on a hover or message widget does not close the card.
    expect(hosts[0]!.attributes).toEqual({ 'data-query-editor-id': 'peek-1', [peekEditorAttribute]: '' })
    expect(created).toMatchObject({ theme: 'varia', fontSize: 15, lineNumbers: 'on', readOnly: true, tabFocusMode: true, glyphMargin: false, padding: { top: 4 }, ariaLabel: 'Definition text', contextmenu: false })
    expect(created?.readOnlyMessage).toEqual({ value: expect.stringContaining('Script to New Query') })
    expect(contextKeys).toEqual([[peekEditorContextKey, true]])
    expect(listeners).toEqual([])
    editor.dispose()
    expect(unbind).toHaveBeenCalled()
    expect(instance.dispose).toHaveBeenCalled()
    // An editor group's editor takes drops and keeps its margin, with no read-only options.
    listeners.length = 0
    createQueryEditor(workbench as never, container)
    expect(hosts[1]!.hidden).toBe(true)
    expect(hosts[1]!.attributes).toEqual({ 'data-query-editor-id': 'peek-1' })
    expect(created).toMatchObject({ glyphMargin: true, padding: { top: 16 } })
    expect(created).not.toHaveProperty('readOnly')
    expect(listeners.length).toBeGreaterThan(0)
    vi.unstubAllGlobals()
  })
})

/** An element inside Peek's editor (its text, or its find widget), in the card or in a Peek tab. */
function peekElement(where: 'card' | 'tab', part: 'text' | 'find'): FocusElement & Element {
  const marks: Record<string, boolean> = { [`[${peekEditorAttribute}]`]: true, '.native-edit-context, .inputarea': part === 'text', '.find-widget': part === 'find',
    '[data-peek-card]': where === 'card', '[data-peek-tab]': where === 'tab' }
  return {
    matches: (selector: string) => part === 'find' && selector === 'input, textarea, select',
    closest: (selector: string) => marks[selector] ? { getAttribute: () => null } : selector === '[data-pane]' && where === 'tab' ? { getAttribute: () => 'editor' } : null
  } as never
}
const documents: DocumentSnapshot = { documents: [{ id: 'q1', name: 'SQLQuery1.sql', connectionId: 'c1', database: 'Sales', dirty: false, savedVersionId: 1 }], activeId: 'q1', busy: false } as never
function keysIn(platform: Platform, element: FocusElement): ContextKeys {
  // The query editor is not focused: Peek's editor is its own Monaco instance.
  const queryEditor = { getContainerDomNode: () => ({ contains: () => false }), hasTextFocus: () => false }
  return computeContextKeys({ platform, focus: focusFacts(element, queryEditor), documents, queries: { byTab: {} } as never, connections: [{ id: 'c1' }], quickInputVisible: false, wordWrap: false, backendStatus: 'ready' })
}
function press(platform: Platform, values: ContextKeys, code: string, keyValue: string, modifiers: { ctrl?: boolean; shift?: boolean; meta?: boolean; alt?: boolean } = {}) {
  const ran: string[] = []
  const service = new KeybindingService({ platform, commands: { execute: async id => { ran.push(id); return true } }, context: { get: () => values }, modalOpen: () => false, editorHasTextFocus: () => true, editorContains: () => false })
  const event: KeyDownEvent & { consumed: boolean } = { key: keyValue, code, ctrlKey: !!modifiers.ctrl, shiftKey: !!modifiers.shift, altKey: !!modifiers.alt, metaKey: !!modifiers.meta, repeat: false, isComposing: false, keyCode: 0,
    defaultPrevented: false, consumed: false, preventDefault: () => { event.consumed = true }, stopPropagation: () => { event.consumed = true } }
  service.handleKeyDown(event)
  service.dispose()
  return { ran, consumed: event.consumed }
}

describe('Peek editor keys', () => {
  it.each(platforms)('gives Peek\'s editor its own focus key, never the query editor\'s, on %s', platform => {
    for (const where of ['card', 'tab'] as const) {
      const text = keysIn(platform, peekElement(where, 'text'))
      expect(text).toMatchObject({ peekEditorFocus: true, editorFocus: false, editorTextFocus: false, textInputFocus: true })
      expect(text.peekFocus).toBe(where === 'card')
      expect(text.peekTabFocus).toBe(where === 'tab')
      expect(keysIn(platform, peekElement(where, 'find'))).toMatchObject({ peekEditorFocus: true, editorFocus: false, inputFocus: true, textInputFocus: true })
    }
    expect(contextRecord(platform, {}).peekEditorFocus).toBe(false)
  })

  it.each(platforms)('keeps query commands (Execute, Parse, Display Estimated Plan) off Peek\'s editor and leaves Find, Copy and Select All to Monaco, on %s', platform => {
    const mod = platform === 'darwin' ? { meta: true } : { ctrl: true }
    for (const where of ['card', 'tab'] as const) {
      const values = keysIn(platform, peekElement(where, 'text'))
      // F5 refreshes the Peek instead of executing the query tab behind it.
      expect(press(platform, values, 'F5', 'F5').ran).toEqual(['peek.refresh'])
      expect(press(platform, values, 'KeyL', 'l', mod).ran).toEqual([])
      expect(press(platform, values, 'Enter', 'Enter', mod).ran).toEqual(where === 'card' ? ['explorer.openPeekTab'] : [])
      if (platform !== 'darwin') {
        expect(press(platform, values, 'KeyE', 'e', { ctrl: true }).ran).toEqual([])
        expect(press(platform, values, 'KeyM', 'm', { ctrl: true }).ran).toEqual([])
      }
      // Monaco's own keys: the workbench does not consume them, so Find, Copy and Select All work in the read-only text.
      for (const [code, keyValue] of [['KeyF', 'f'], ['KeyC', 'c'], ['KeyA', 'a']] as const) expect(press(platform, values, code, keyValue, mod), `${where} ${keyValue}`).toEqual({ ran: [], consumed: false })
    }
  })

  it('leaves Peek\'s editor out of the chord bridge, and finds its text (not its find widget) for Monaco\'s chord mode', () => {
    expect(bridgeWhen).toBe(`editorTextFocus && !${peekEditorContextKey}`)
    expect(peekEditorHasTextFocus(peekElement('card', 'text'))).toBe(true)
    expect(peekEditorHasTextFocus(peekElement('tab', 'find'))).toBe(false)
    expect(peekEditorHasTextFocus(null)).toBe(false)
  })
  it('counts a press on the widget host of the card\'s own Peek editor as inside the card, and another view\'s or anything else as outside', () => {
    const widgets = (id: string | undefined) => ({ closest: (selector: string) => id !== undefined && selector === `.editor-overflow-widgets[${peekEditorAttribute}]` ? { getAttribute: (name: string) => name === editorIdAttribute ? id : null } : null })
    const card = { querySelectorAll: (selector: string) => selector === `[${peekEditorAttribute}][${editorIdAttribute}]` ? [{ getAttribute: () => 'editor-1' }] : [] }
    expect(inPeekEditorWidgets(widgets('editor-1') as never, card as never)).toBe(true)
    // A promoted tab's Peek editor is another view's: a press there closes the card.
    expect(inPeekEditorWidgets(widgets('editor-2') as never, card as never)).toBe(false)
    expect(inPeekEditorWidgets(widgets(undefined) as never, card as never)).toBe(false)
    // A text node's element decides.
    expect(inPeekEditorWidgets({ parentElement: widgets('editor-1') } as never, card as never)).toBe(true)
    expect(inPeekEditorWidgets(null, card as never)).toBe(false)
    expect(inPeekEditorWidgets(widgets('editor-1') as never, null)).toBe(false)
  })
})

describe('Peek card focus loop', () => {
  // Stops in document order by index; `at` elements compare by their position too.
  const element = (position: number, inFind = false) => ({ position, closest: (selector: string) => inFind && selector === '.find-widget' ? {} : null,
    compareDocumentPosition(other: { position: number }) { return other.position > this.position ? 4 : 2 } })
  const stops = [element(1), element(2), element(5)] as never as HTMLElement[]
  it('moves Tab to the next stop and wraps, from a stop, from the definition text between stops, and from the card itself', () => {
    expect(nextStop(stops, stops[0]!, false, false)).toBe(stops[1])
    expect(nextStop(stops, stops[2]!, false, false)).toBe(stops[0])
    expect(nextStop(stops, stops[0]!, true, false)).toBe(stops[2])
    // The definition's text sits between the second and third stops: Tab goes on to the third, Shift+Tab back to the second.
    const text = element(3) as never as Element
    expect(nextStop(stops, text, false, false)).toBe(stops[2])
    expect(nextStop(stops, text, true, false)).toBe(stops[1])
    // Past the last stop it wraps to the first, never out of the card.
    expect(nextStop(stops, element(9) as never, false, false)).toBe(stops[0])
    expect(nextStop(stops, null, false, true)).toBe(stops[0])
    expect(nextStop(stops, null, true, true)).toBe(stops[2])
    // Find's own inputs keep the browser's Tab.
    expect(nextStop(stops, element(4, true) as never, false, false)).toBe('native')
    expect(nextStop([], text, false, false)).toBeUndefined()
  })
})

describe('Peek definition actions', () => {
  const peekOf = (kind: 'table' | 'procedure', subtype?: 'sql'): OpenPeek => ({
    id: 1, rowId: 1, kind, source: 'menu', tab: 'definition', back: [], facts: { status: 'ready', value: {} }, definition: { status: 'ready', value: { text: 'CREATE PROCEDURE dbo.P AS SELECT 1' } },
    node: { id: 1, connectionId: 'c1', kind, label: 'dbo.P', lost: false, ...subtype ? { subtype } : {}, ref: { type: 'object', object: { kind, database: 'Sales', schema: 'dbo', name: 'P' } } }
  })
  function render(open: OpenPeek) {
    const enabled: [string, unknown][] = []
    const workbench = { commands: { isEnabled: (id: string, args: unknown) => { enabled.push([id, args]); return true }, execute: vi.fn() } }
    const view = { connected: true, getSnapshot: () => ({ open }), subscribe: () => () => {} }
    const markup = renderToStaticMarkup(createElement(WorkbenchProvider, { workbench: workbench as never, children: createElement(PeekBody, { view: view as never, open, idPrefix: 'peek' }) }))
    return { markup, enabled }
  }
  it('offers Script to New Query for every kind and Modify for a kind that has it, with the shown object\'s own selection keys', () => {
    const procedure = render(peekOf('procedure', 'sql'))
    expect(procedure.markup).toContain('>Script to New Query</button>')
    expect(procedure.markup).toContain('>Modify</button>')
    const modify = procedure.enabled.find(([id]) => id === 'explorer.modify')?.[1] as { target: unknown; state: Record<string, unknown> }
    expect(modify.target).toMatchObject({ kind: 'explorer', node: { kind: 'procedure', subtype: 'sql' } })
    expect(modify.state).toMatchObject({ explorerSelectionModifiable: true, explorerScriptAlter: 'enabled', explorerSelectionKind: 'procedure' })
    const table = render(peekOf('table'))
    expect(table.markup).toContain('>Script to New Query</button>')
    expect(table.markup).not.toContain('>Modify</button>')
    expect(table.enabled.map(([id]) => id)).not.toContain('explorer.modify')
    // The editor is made once the body is mounted (an effect), into the panel's slot; the static markup holds only the slot.
    expect(procedure.markup).toContain('class="peek-editor"')
    expect(procedure.markup).not.toContain('<pre')
  })
})
