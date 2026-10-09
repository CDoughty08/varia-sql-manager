import { describe, expect, it, vi } from 'vitest'
import { bindExplorerDrop, dropIntoEditor, explorerDragType, maxDropText, parseExplorerDrop, type DropEditor, type DropEvent } from '../src/renderer/src/explorer/drop'

interface Position { lineNumber: number; column: number }
/** A one-model editor over lines of text: edits insert at a collapsed range, and the log records what the drop did. */
function fakeEditor(lines = ['SELECT ', 'FROM t'], options: { model?: boolean; target?: Position | null; selectionEnd?: Position } = {}) {
  const log: string[] = []
  const listeners = new Map<string, EventListener>()
  const container = {
    addEventListener: vi.fn((type: string, listener: EventListener) => { listeners.set(type, listener) }),
    removeEventListener: vi.fn((type: string, listener: EventListener) => { if (listeners.get(type) === listener) listeners.delete(type) })
  }
  const editor: DropEditor & { readonly lines: string[] } = {
    lines,
    getContainerDomNode: () => container as unknown as HTMLElement,
    getModel: () => options.model === false ? null : {},
    getTargetAtClientPoint: (x, y) => { log.push(`target ${x},${y}`); return options.target === undefined ? { position: { lineNumber: 1, column: 8 } } : options.target === null ? null : { position: options.target } },
    getSelection: () => ({ getEndPosition: () => options.selectionEnd ?? { lineNumber: 2, column: 7 } }),
    pushUndoStop: () => { log.push('undo stop'); return true },
    executeEdits: (source, edits, endCursorState) => {
      const [{ range, text }] = edits
      const line = lines[range.startLineNumber - 1]
      lines[range.startLineNumber - 1] = line.slice(0, range.startColumn - 1) + text + line.slice(range.startColumn - 1)
      log.push(`edit ${source} ${JSON.stringify(text)}`)
      endCursorState([{ range: { endLineNumber: range.startLineNumber, endColumn: range.startColumn + text.length } }])
      return true
    },
    setPosition: position => { log.push(`caret ${position.lineNumber}:${position.column}`) },
    focus: () => { log.push('focus') }
  }
  return { editor, log, listeners, container }
}
function dropEvent(data: Record<string, string>, at = { clientX: 40, clientY: 12 }): DropEvent & { prevented: boolean; stopped: boolean } {
  const event = {
    ...at, prevented: false, stopped: false,
    dataTransfer: { types: Object.keys(data), getData: (type: string) => data[type] ?? '' },
    preventDefault: () => { event.prevented = true },
    stopPropagation: () => { event.stopped = true }
  }
  return event
}
const payload = (text: string) => ({ 'text/plain': text, [explorerDragType]: JSON.stringify({ v: 1, text }) })

describe('Object Explorer drag payloads', () => {
  it('accept only version 1 with a text of up to the script limit', () => {
    expect(parseExplorerDrop(JSON.stringify({ v: 1, text: '[dbo].[Orders]' }))).toBe('[dbo].[Orders]')
    expect(parseExplorerDrop(JSON.stringify({ v: 1, text: 'x'.repeat(maxDropText) }))).toHaveLength(maxDropText)
    for (const data of [
      '', 'not json', 'null', '[]', '"[dbo].[Orders]"', JSON.stringify({ v: 2, text: 'a' }), JSON.stringify({ v: '1', text: 'a' }), JSON.stringify({ v: 1 }), JSON.stringify({ v: 1, text: '' }),
      JSON.stringify({ v: 1, text: 7 }), JSON.stringify({ v: 1, text: 'a', html: '<b>' }), JSON.stringify({ v: 1, text: 'x'.repeat(maxDropText + 1) }), 'x'.repeat(maxDropText * 7)
    ]) expect(parseExplorerDrop(data), data.slice(0, 40)).toBeUndefined()
  })
})

describe('dropping on the query editor', () => {
  it('inserts at the drop point as one undo step, puts the caret after the text, and focuses the editor', () => {
    const { editor, log } = fakeEditor()
    const event = dropEvent(payload('[dbo].[Orders]'))
    expect(dropIntoEditor(editor, event)).toBe(true)
    expect(editor.lines).toEqual(['SELECT [dbo].[Orders]', 'FROM t'])
    expect(log).toEqual(['target 40,12', 'undo stop', 'edit explorer.drop "[dbo].[Orders]"', 'undo stop', 'caret 1:22', 'focus'])
    expect([event.prevented, event.stopped]).toEqual([true, true])
  })
  it('falls back to the end of the selection when the point is outside the text', () => {
    const { editor } = fakeEditor(['SELECT ', 'FROM t'], { target: null })
    dropIntoEditor(editor, dropEvent(payload('[Id], [Name]')))
    expect(editor.lines).toEqual(['SELECT ', 'FROM t[Id], [Name]'])
    const outside = fakeEditor(['SELECT '], { target: null, selectionEnd: { lineNumber: 1, column: 1 } })
    dropIntoEditor(outside.editor, dropEvent(payload('@id')))
    expect(outside.editor.lines).toEqual(['@idSELECT '])
  })
  it('leaves other drags alone: files, links and text from other apps', () => {
    const { editor, log } = fakeEditor()
    for (const data of [{ 'text/plain': 'hello' }, { Files: '' }, { 'text/uri-list': 'https://example.com' }] as Record<string, string>[]) {
      const event = dropEvent(data)
      expect(dropIntoEditor(editor, event)).toBe(false)
      expect([event.prevented, event.stopped]).toEqual([false, false])
    }
    expect(dropIntoEditor(editor, { ...dropEvent({}), dataTransfer: null })).toBe(false)
    expect(log).toEqual([])
  })
  it('consumes but ignores a malformed payload, and a drop with no query open', () => {
    const malformed = fakeEditor()
    const event = dropEvent({ [explorerDragType]: JSON.stringify({ v: 1, text: 'x', extra: true }) })
    expect(dropIntoEditor(malformed.editor, event)).toBe(true)
    expect([event.prevented, malformed.log]).toEqual([true, []])
    const empty = fakeEditor(['SELECT '], { model: false })
    expect(dropIntoEditor(empty.editor, dropEvent(payload('[a]')))).toBe(true)
    expect([empty.editor.lines, empty.log]).toEqual([['SELECT '], []])
  })
  it('listens on the editor\'s container until disposed', () => {
    const { editor, container, listeners } = fakeEditor()
    const binding = bindExplorerDrop(editor)
    expect(container.addEventListener).toHaveBeenCalledWith('drop', expect.any(Function))
    listeners.get('drop')!(dropEvent(payload('[t]')) as unknown as Event)
    expect(editor.lines[0]).toBe('SELECT [t]')
    binding.dispose()
    expect(listeners.has('drop')).toBe(false)
  })
})
