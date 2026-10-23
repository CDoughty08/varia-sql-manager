import type { EventBus } from '../core/events'
import { SnapshotStore } from '../core/store'
import type { Disposable } from '../core/types'
import type { TextRange } from './text-ops'
import { codiconClass } from '../../../shared/icons'

/** The model calls bookmarks make: decorations live on the model, so they survive tab switches and die with it. */
export interface BookmarkModel {
  deltaDecorations(oldDecorations: string[], newDecorations: { range: TextRange; options: object }[]): string[]
  getDecorationRange(id: string): TextRange | null
  getLineCount(): number
}
export interface BookmarkEditor {
  getModel(): unknown
  getPosition(): { readonly lineNumber: number; readonly column: number } | null
  setPosition(position: { lineNumber: number; column: number }): void
  revealLineInCenterIfOutsideViewport(lineNumber: number): void
  focus(): void
}
export interface BookmarkDocuments {
  getSnapshot(): { readonly documents: readonly { readonly id: string }[]; readonly activeId: string }
  getModel(id: string): BookmarkModel | undefined
  activate(id: string): void
  readonly boundEditor: BookmarkEditor | undefined
}
/** How many bookmarks each open document has (tab id → count): it drives hasBookmarks and activeDocumentHasBookmarks. */
export interface BookmarkSnapshot { readonly counts: Readonly<Record<string, number>> }

export const maxBookmarksPerDocument = 1000
/** Monaco's TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges: typing at a bookmarked line's edges does not move it. */
const neverGrowsWhenTypingAtEdges = 1
const bookmarkOptions = {
  isWholeLine: true, stickiness: neverGrowsWhenTypingAtEdges,
  glyphMarginClassName: codiconClass('bookmark') + ' varia-bookmark', glyphMarginHoverMessage: { value: 'Bookmark' }
}

/**
 * Edit › Bookmarks for this session: each bookmark is a whole-line decoration in the indicator margin. Next and
 * Previous go through the active query's bookmarks, then the other open queries' in tab-strip order, wrapping around;
 * the In Document variants stay in the active query. Bookmarks are not saved.
 */
export class BookmarkService extends SnapshotStore<BookmarkSnapshot> implements Disposable {
  private readonly ids = new Map<string, string[]>()
  private readonly subscription: Disposable
  constructor(private readonly documents: BookmarkDocuments, events: Pick<EventBus, 'subscribe'>) {
    super({ counts: {} })
    this.subscription = events.subscribe(event => {
      if (event.type === 'documents.closed' && this.ids.delete(event.tabId)) this.changed()
    })
  }
  private changed(): void {
    this.publish({ counts: Object.fromEntries([...this.ids].filter(([, ids]) => ids.length).map(([id, ids]) => [id, ids.length])) })
  }
  /** The bookmarked lines of a document, each once: deleting lines can collapse two bookmarks onto one. */
  lines(tabId: string): number[] {
    const model = this.documents.getModel(tabId), ids = this.ids.get(tabId)
    if (!model || !ids) return []
    return [...new Set(ids.flatMap(id => { const range = model.getDecorationRange(id); return range ? [range.startLineNumber] : [] }))].sort((a, b) => a - b)
  }
  /** The active document, its model and the editor showing it, or undefined when nothing is shown. */
  private active() {
    const tabId = this.documents.getSnapshot().activeId, model = tabId ? this.documents.getModel(tabId) : undefined, editor = this.documents.boundEditor
    return model && editor && editor.getModel() === model ? { tabId, model, editor, line: editor.getPosition()?.lineNumber ?? 1 } : undefined
  }
  /** Adds a bookmark on the caret's line, or removes every bookmark on it. */
  toggle(): void {
    const active = this.active()
    if (!active) return
    const { tabId, model, editor, line } = active, ids = this.ids.get(tabId) ?? []
    const onLine = ids.filter(id => model.getDecorationRange(id)?.startLineNumber === line)
    if (onLine.length) {
      model.deltaDecorations(onLine, [])
      this.ids.set(tabId, ids.filter(id => !onLine.includes(id)))
    } else {
      if (ids.length >= maxBookmarksPerDocument) throw new Error('This document has 1,000 bookmarks; clear some first.')
      const [id] = model.deltaDecorations([], [{ range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 }, options: bookmarkOptions }])
      this.ids.set(tabId, [...ids, id])
    }
    this.changed()
    editor.focus()
  }
  /** Next (1) or Previous (-1) Bookmark, through every open document or only the active one. */
  go(direction: 1 | -1, scope: 'all' | 'document'): void {
    const active = this.active()
    if (!active) return
    const { tabId, line } = active, own = this.lines(tabId)
    const inActive = direction > 0 ? own.find(value => value > line) : own.findLast(value => value < line)
    if (inActive !== undefined) { this.show(tabId, inActive); return }
    if (scope === 'all') {
      const tabs = this.documents.getSnapshot().documents.map(document => document.id), at = tabs.indexOf(tabId)
      for (let step = 1; step < tabs.length; step++) {
        const other = tabs[((at + direction * step) % tabs.length + tabs.length) % tabs.length], lines = this.lines(other)
        if (lines.length) { this.show(other, direction > 0 ? lines[0] : lines.at(-1)!); return }
      }
    }
    // Around to the active document's first (or last) bookmark.
    if (own.length) this.show(tabId, direction > 0 ? own[0] : own.at(-1)!)
  }
  private show(tabId: string, line: number): void {
    if (this.documents.getSnapshot().activeId !== tabId) this.documents.activate(tabId)
    const editor = this.documents.boundEditor, model = this.documents.getModel(tabId)
    if (!editor || !model || editor.getModel() !== model) return
    const lineNumber = Math.min(line, model.getLineCount())
    editor.setPosition({ lineNumber, column: 1 })
    editor.revealLineInCenterIfOutsideViewport(lineNumber)
    editor.focus()
  }
  /** Removes every bookmark in every open document. */
  clear(): void {
    for (const [tabId, ids] of this.ids) this.documents.getModel(tabId)?.deltaDecorations(ids, [])
    this.ids.clear()
    this.changed()
  }
  dispose(): void {
    this.subscription.dispose()
    this.clearListeners()
  }
}
