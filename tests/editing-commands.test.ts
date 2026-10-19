import { afterEach, describe, expect, it, vi } from 'vitest'
import type { editor, IRange } from 'monaco-editor'
import { TestEditor } from './fixtures/documents'
import { workbenchFixture } from './fixtures/workbench'
import type { TextSelection } from '../src/renderer/src/editor/text-ops'

/** The query editor as the editing commands use it: actions, selections, edits as one undo step, and snippet insertion. */
class EditingEditor extends TestEditor {
  readonly calls: string[] = []
  position = { lineNumber: 1, column: 1 }
  selections: TextSelection[] = [{ selectionStartLineNumber: 1, selectionStartColumn: 1, positionLineNumber: 1, positionColumn: 1 }]
  readonly inserted: string[] = []
  controller: unknown = { insert: (body: string, options: unknown) => { this.inserted.push(body); this.calls.push(`insert ${JSON.stringify(options)}`) } }
  focus(): void { this.calls.push('focus') }
  trigger(_source: string, action: string): void { this.calls.push(action) }
  getPosition() { return this.position }
  setPosition(position: { lineNumber: number; column: number }): void { this.position = position }
  getSelections() { return this.selections }
  setSelections(selections: TextSelection[]): void { this.selections = selections }
  getContribution(id: string) { return id === 'snippetController2' ? this.controller : null }
  pushUndoStop(): boolean { this.calls.push('stop'); return true }
  executeEdits(source: string, edits: { range: IRange; text: string }[], end: (inverse: { range: IRange }[]) => null): boolean {
    this.calls.push(source)
    const model = this.getModel() as unknown as { applyEdits(edits: { range: IRange; text: string }[]): void }
    model.applyEdits([...edits].reverse())
    // Single-line edits in these tests: each new text starts where its range did.
    end(edits.map(edit => ({ range: { startLineNumber: edit.range.startLineNumber, startColumn: edit.range.startColumn, endLineNumber: edit.range.startLineNumber, endColumn: edit.range.startColumn + edit.text.length } })))
    return true
  }
}
const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); vi.restoreAllMocks() })
function setup(options: Parameters<typeof workbenchFixture>[0] = {}) {
  const fixture = workbenchFixture(options)
  cleanups.push(fixture.dispose)
  const target = new EditingEditor()
  const tab = fixture.documents.create('one.sql', 'select 1\nfrom t', 'master')
  fixture.documents.bindEditor(target as unknown as editor.IStandaloneCodeEditor)
  const text = () => fixture.documents.getModel(tab.id)!.getValue()
  return { ...fixture, target, tab, text }
}

describe('editing commands', () => {
  it('register the catalogue bridge chords with Monaco', () => {
    const { monaco } = setup()
    expect(monaco.editor.registerCommand.mock.calls.map(call => call[0])).toEqual(['varia.edit.toggleBookmark', 'varia.edit.previousBookmark', 'varia.edit.nextBookmark', 'varia.edit.clearBookmarks',
      'varia.edit.insertSnippet', 'varia.edit.surroundWith'])
    expect(monaco.editor.addKeybindingRules.mock.calls[0][0].every(rule => rule.when === 'editorTextFocus')).toBe(true)
  })
  it("run Find Next and Previous as Monaco's find actions, in the focused editor", async () => {
    const { commands, target } = setup()
    await commands.execute('edit.findNext', undefined, 'menu')
    await commands.execute('edit.findPrevious', undefined, 'keybinding')
    expect(target.calls).toEqual(['focus', 'editor.action.nextMatchFindAction', 'focus', 'editor.action.previousMatchFindAction'])
  })
  it('open Go To Line with the caret line and the line count, only with a document', async () => {
    const { commands, target, editorDialogs, tab, documents } = setup()
    target.position = { lineNumber: 2, column: 4 }
    await commands.execute('edit.goToLine', undefined, 'keybinding')
    expect(editorDialogs.getSnapshot().goToLine).toEqual({ tabId: tab.id, lineCount: 2, line: 2 })
    expect(target.calls).toEqual(['focus'])
    editorDialogs.closeGoToLine()
    target.setModel(null)
    await commands.execute('edit.goToLine', undefined, 'palette')
    expect(editorDialogs.getSnapshot().goToLine).toBeUndefined()
    expect(documents.getSnapshot().activeId).toBe(tab.id)
  })
  it('change case as one undo step and keep the selection', async () => {
    const { commands, target, text } = setup()
    target.selections = [{ selectionStartLineNumber: 1, selectionStartColumn: 1, positionLineNumber: 1, positionColumn: 7 }]
    await commands.execute('edit.makeUppercase', undefined, 'keybinding')
    expect(text()).toBe('SELECT 1\nfrom t')
    expect(target.calls).toEqual(['focus', 'stop', 'varia.makeUppercase', 'stop'])
    expect(target.selections).toEqual([{ selectionStartLineNumber: 1, selectionStartColumn: 1, positionLineNumber: 1, positionColumn: 7 }])
    await commands.execute('edit.makeLowercase', undefined, 'menu')
    expect(text()).toBe('select 1\nfrom t')
  })
  it("indent by the model's unit: a tab under Keep tabs (the default), spaces under Insert spaces", async () => {
    const { commands, text, settings } = setup()
    await commands.execute('edit.increaseIndent', undefined, 'menu')
    expect(text()).toBe('\tselect 1\nfrom t')
    await commands.execute('edit.decreaseIndent', undefined, 'menu')
    expect(text()).toBe('select 1\nfrom t')
    await settings.update({ 'textEditor.sql.tabs': 'spaces', 'textEditor.sql.indentSize': 2 })
    await commands.execute('edit.increaseIndent', undefined, 'menu')
    expect(text()).toBe('  select 1\nfrom t')
  })
  it('report a selection too large to change in the command banner', async () => {
    const { commands, target, documents, tab } = setup()
    documents.getModel(tab.id)!.getValueLengthInRange = () => 1_000_001
    target.selections = [{ selectionStartLineNumber: 1, selectionStartColumn: 1, positionLineNumber: 2, positionColumn: 7 }]
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(commands.execute('edit.makeUppercase', undefined, 'menu')).resolves.toBe(false)
    expect(commands.getSnapshot().error).toBe('Could not run “Edit: Make Uppercase”: The selection is too large to change (more than 1,000,000 characters).')
  })
  it('toggle View White Space and line numbers through settings, and their checks follow', async () => {
    const { commands, api, context, editorOptions } = setup()
    expect([commands.isToggled('editor.toggleWhitespace'), commands.isToggled('editor.toggleLineNumbers')]).toEqual([false, true])
    await commands.execute('editor.toggleWhitespace', undefined, 'menu')
    await commands.execute('editor.toggleLineNumbers', undefined, 'palette')
    expect(api.updateSettings.mock.calls).toEqual([[{ 'textEditor.sql.viewWhiteSpace': true }], [{ 'textEditor.sql.lineNumbers': false }]])
    expect([context.getState().editorWhitespace, context.getState().editorLineNumbers]).toEqual([true, false])
    expect(editorOptions.monacoOptions()).toMatchObject({ renderWhitespace: 'all', lineNumbers: 'off' })
  })
  it('keep a toggle for the session with one warning when settings cannot be saved, without failing', async () => {
    const { commands, api, context } = setup()
    api.updateSettings.mockResolvedValue({ ok: false, error: 'The disk is full.' })
    await expect(commands.execute('editor.toggleWhitespace', undefined, 'menu')).resolves.toBe(true)
    expect(context.getState().editorWhitespace).toBe(true)
    expect(commands.getSnapshot()).toEqual({ error: 'Settings could not be saved: The disk is full. The change applies until you close Varia SQL Manager.', kind: 'warning' })
  })
  it('toggle bookmarks and enable the bookmark commands from their counts', async () => {
    const { commands, bookmarks, tab, documents } = setup()
    const model = Object.assign(documents.getModel(tab.id)!, {
      deltaDecorations: vi.fn(() => ['d1']), getDecorationRange: vi.fn(() => ({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }))
    })
    expect([commands.isEnabled('edit.toggleBookmark'), commands.isEnabled('edit.nextBookmark'), commands.isEnabled('edit.nextBookmarkInDocument')]).toEqual([true, false, false])
    await commands.execute('edit.toggleBookmark', undefined, 'keybinding')
    expect(bookmarks.getSnapshot().counts).toEqual({ [tab.id]: 1 })
    expect([commands.isEnabled('edit.nextBookmark'), commands.isEnabled('edit.nextBookmarkInDocument'), commands.isEnabled('edit.clearBookmarks')]).toEqual([true, true, true])
    await commands.execute('edit.clearBookmarks', undefined, 'menu')
    expect(model.deltaDecorations).toHaveBeenLastCalledWith(['d1'], [])
    expect(commands.isEnabled('edit.previousBookmark')).toBe(false)
  })
  it('list the expansion snippets by category, and insert the accepted one into the query it was opened for', async () => {
    const { commands, quickInput, target } = setup()
    await commands.execute('edit.insertSnippet', undefined, 'keybinding')
    const view = quickInput.getSnapshot()
    expect([view.placeholder, view.noun]).toEqual(['Insert Snippet: type to filter by name or category', 'snippets'])
    expect(view.rows.flatMap(row => row.group ? [row.group] : []).slice(0, 3)).toEqual(['Function', 'Index', 'Login'])
    // The palette's ranking: the shortest title wins a tie, so Create Table comes before Create Table Type.
    quickInput.filter('create table')
    expect(quickInput.getSnapshot().rows[0].item.label).toBe('Create Table')
    quickInput.accept()
    expect(target.inserted).toHaveLength(1)
    expect(target.inserted[0].startsWith('CREATE TABLE ${1:dbo}.${2:TableName}')).toBe(true)
    expect(target.calls.at(-1)).toBe('insert {"undoStopBefore":true,"undoStopAfter":true}')
  })
  it('insert nothing when another query became active, and fail without the snippet controller', async () => {
    const { commands, quickInput, target, documents, tab } = setup()
    await commands.execute('edit.surroundWith', undefined, 'menu')
    expect(quickInput.getSnapshot().rows.map(row => row.item.label)).toEqual(['Begin', 'If', 'While'])
    expect(quickInput.getSnapshot().placeholder).toBe('Surround With:')
    documents.newQuery()
    quickInput.accept()
    expect(target.inserted).toEqual([])
    documents.activate(tab.id)
    target.controller = null
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await commands.execute('edit.insertSnippet', undefined, 'menu')
    expect(commands.getSnapshot().error).toBe('Could not run “Edit: Insert Snippet…”: Snippets are unavailable.')
    expect(quickInput.getSnapshot().visible).toBe(false)
  })
})
