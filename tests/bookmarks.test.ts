import { describe, expect, it } from 'vitest'
import { EventBus } from '../src/renderer/src/core/events'
import { computeContextKeys } from '../src/renderer/src/core/contextkeys'
import { BookmarkService, maxBookmarksPerDocument, type BookmarkEditor, type BookmarkModel } from '../src/renderer/src/editor/bookmarks'
import type { TextRange } from '../src/renderer/src/editor/text-ops'

/** A model whose decorations are ranges by id; `collapse` moves every decoration on `from` to `to`, as deleting lines does. */
class FakeModel implements BookmarkModel {
  readonly decorations = new Map<string, TextRange & { options: object }>()
  private next = 0
  constructor(readonly name: string, public lineCount = 20) {}
  deltaDecorations(old: string[], added: { range: TextRange; options: object }[]): string[] {
    for (const id of old) this.decorations.delete(id)
    return added.map(decoration => { const id = `${this.name}-${++this.next}`; this.decorations.set(id, { ...decoration.range, options: decoration.options }); return id })
  }
  getDecorationRange(id: string): TextRange | null { return this.decorations.get(id) ?? null }
  getLineCount(): number { return this.lineCount }
  collapse(from: number, to: number): void { for (const [id, range] of this.decorations) if (range.startLineNumber === from) this.decorations.set(id, { ...range, startLineNumber: to, endLineNumber: to }) }
}
function setup(names = ['a', 'b', 'c']) {
  const models = new Map(names.map(name => [name, new FakeModel(name)]))
  const events = new EventBus()
  let activeId = names[0], tabs = [...names], focused = 0
  const editor: BookmarkEditor & { line: number } = {
    line: 1,
    getModel: () => models.get(activeId),
    getPosition: () => ({ lineNumber: editor.line, column: 3 }),
    setPosition: position => { editor.line = position.lineNumber },
    revealLineInCenterIfOutsideViewport: () => {},
    focus: () => { focused++ }
  }
  const documents = {
    getSnapshot: () => ({ documents: tabs.map(id => ({ id })), activeId }),
    getModel: (id: string) => models.get(id),
    activate: (id: string) => { activeId = id },
    boundEditor: editor as BookmarkEditor | undefined
  }
  const service = new BookmarkService(documents, events)
  const at = (tab: string, line: number) => { activeId = tab; editor.line = line }
  const where = () => `${activeId}:${editor.line}`
  const close = (tab: string) => { tabs = tabs.filter(id => id !== tab); models.delete(tab); events.emit({ type: 'documents.closed', tabId: tab }) }
  return { service, models, editor, documents, at, where, close, focused: () => focused }
}

describe('bookmarks', () => {
  it('toggle a whole-line glyph decoration on the caret line, and off again', () => {
    const { service, models, at, focused } = setup()
    at('a', 4)
    service.toggle()
    const [decoration] = models.get('a')!.decorations.values()
    expect(decoration).toMatchObject({ startLineNumber: 4, endLineNumber: 4, options: { isWholeLine: true, stickiness: 1, glyphMarginClassName: 'codicon codicon-bookmark varia-bookmark', glyphMarginHoverMessage: { value: 'Bookmark' } } })
    expect(service.getSnapshot().counts).toEqual({ a: 1 })
    expect(focused()).toBe(1)
    service.toggle()
    expect(models.get('a')!.decorations.size).toBe(0)
    expect(service.getSnapshot().counts).toEqual({})
  })
  it('remove every bookmark lines collapsed together, and count a collapsed line once when navigating', () => {
    const { service, models, at, where } = setup()
    at('a', 2); service.toggle()
    at('a', 3); service.toggle()
    models.get('a')!.collapse(3, 2)
    expect(service.lines('a')).toEqual([2])
    at('a', 1); service.go(1, 'document')
    expect(where()).toBe('a:2')
    service.go(1, 'document')
    expect(where()).toBe('a:2')
    service.toggle()
    expect(models.get('a')!.decorations.size).toBe(0)
  })
  it('go to the next and previous bookmark across documents in tab order, wrapping around', () => {
    const { service, at, where } = setup()
    at('a', 5); service.toggle()
    at('a', 10); service.toggle()
    at('c', 3); service.toggle()
    at('a', 1)
    const next = () => { service.go(1, 'all'); return where() }, previous = () => { service.go(-1, 'all'); return where() }
    expect([next(), next(), next(), next()]).toEqual(['a:5', 'a:10', 'c:3', 'a:5'])
    expect([previous(), previous(), previous()]).toEqual(['c:3', 'a:10', 'a:5'])
    // From a document without bookmarks, Next goes to the next one that has some.
    at('b', 7)
    expect(next()).toBe('c:3')
    at('b', 7)
    expect(previous()).toBe('a:10')
  })
  it('stay in the active document for the In Document variants', () => {
    const { service, at, where } = setup()
    at('a', 5); service.toggle()
    at('a', 9); service.toggle()
    at('b', 2); service.toggle()
    at('a', 6)
    service.go(1, 'document'); expect(where()).toBe('a:9')
    service.go(1, 'document'); expect(where()).toBe('a:5')
    service.go(-1, 'document'); expect(where()).toBe('a:9')
    // A document with none does nothing.
    at('c', 1); service.go(1, 'document'); expect(where()).toBe('c:1')
  })
  it('clamp to the line count, and do nothing without an editor', () => {
    const { service, models, at, where, documents } = setup()
    at('b', 15); service.toggle()
    models.get('b')!.lineCount = 8
    at('a', 1); service.go(1, 'all')
    expect(where()).toBe('b:8')
    documents.boundEditor = undefined
    expect(() => { service.toggle(); service.go(1, 'all') }).not.toThrow()
  })
  it('clear every bookmark in every document without asking', () => {
    const { service, models, at } = setup()
    at('a', 1); service.toggle()
    at('b', 2); service.toggle()
    service.clear()
    expect([...models.values()].map(model => model.decorations.size)).toEqual([0, 0, 0])
    expect(service.getSnapshot().counts).toEqual({})
  })
  it('forget a document when it closes', () => {
    const { service, at, close } = setup()
    at('a', 1); service.toggle()
    at('b', 1); service.toggle()
    close('a')
    expect(service.getSnapshot().counts).toEqual({ b: 1 })
  })
  it(`refuse more than ${maxBookmarksPerDocument} bookmarks in one document`, () => {
    const { service, models, at } = setup()
    models.get('a')!.lineCount = 2000
    for (let line = 1; line <= maxBookmarksPerDocument; line++) { at('a', line); service.toggle() }
    at('a', 1500)
    expect(() => service.toggle()).toThrow('This document has 1,000 bookmarks; clear some first.')
    expect(service.getSnapshot().counts).toEqual({ a: 1000 })
    // Removing one still works at the cap.
    at('a', 1); service.toggle()
    expect(service.getSnapshot().counts).toEqual({ a: 999 })
  })
  it('drive hasBookmarks and activeDocumentHasBookmarks', () => {
    const { service, at } = setup()
    const keys = (activeId: string) => computeContextKeys({
      platform: 'win32', documents: { documents: [{ id: 'a', name: 'a', dirty: false, savedVersionId: 1, database: 'master' }, { id: 'b', name: 'b', dirty: false, savedVersionId: 1, database: 'master' }], activeId, busy: false },
      queries: {}, connections: [], quickInputVisible: false, wordWrap: false, backendStatus: 'ready', bookmarks: service.getSnapshot().counts
    })
    expect([keys('a').hasBookmarks, keys('a').activeDocumentHasBookmarks]).toEqual([false, false])
    at('b', 1); service.toggle()
    expect([keys('a').hasBookmarks, keys('a').activeDocumentHasBookmarks, keys('b').activeDocumentHasBookmarks]).toEqual([true, false, true])
  })
})
