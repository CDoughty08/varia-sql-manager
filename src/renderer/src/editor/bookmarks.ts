import type { EventBus } from '../core/events'
import { SnapshotStore } from '../core/store'
import type { Disposable } from '../core/types'
import type { TextRange } from './text-ops'
import { codiconClass } from '../../../shared/icons'
import type { ProviderId } from '../../../shared/providers'

export type BookmarkPane = 'primary' | 'secondary'

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
export interface BookmarkDocumentRef {
  readonly id: string
  readonly multiMode?: 'same' | 'cross'
  readonly crossView?: 'split' | 'file'
  readonly activePane?: BookmarkPane
}
export interface BookmarkDocuments {
  getSnapshot(): { readonly documents: readonly BookmarkDocumentRef[]; readonly activeId: string }
  getModel(id: string): BookmarkModel | undefined
  getSecondaryModel?(id: string): BookmarkModel | undefined
  activeModel?(id: string): BookmarkModel | undefined
  editorOf?(id: string, pane?: BookmarkPane): BookmarkEditor | undefined
  setActivePane?(id: string, pane: BookmarkPane): void
  revision?(id: string): number
  revealLine?(id: string, line: number, revision: number, dialect?: ProviderId): boolean
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

interface ModelBookmarks {
  readonly model: BookmarkModel
  ids: string[]
}

interface TabBookmarks {
  crossView?: 'split' | 'file'
  primary?: ModelBookmarks
  secondary?: ModelBookmarks
}

/**
 * Edit › Bookmarks for this session: each bookmark is a whole-line decoration in the indicator margin. Next and
 * Previous go through the active query's bookmarks (spanning both Transact-SQL and GoogleSQL panes on Cross-Engine
 * Split tabs), then the other open queries' in tab-strip order, wrapping around; the In Document variants stay in the
 * active query. Bookmarks are not saved and clear cleanly on Split ↔ File view switches.
 */
export class BookmarkService extends SnapshotStore<BookmarkSnapshot> implements Disposable {
  private readonly tabs = new Map<string, TabBookmarks>()
  private readonly subscription: Disposable
  constructor(private readonly documents: BookmarkDocuments, events: Pick<EventBus, 'subscribe'>) {
    super({ counts: {} })
    this.subscription = events.subscribe(event => {
      if (event.type === 'documents.closed') {
        if (this.tabs.delete(event.tabId)) this.changed()
      } else if (event.type === 'documents.changed') {
        this.reconcileCrossViews()
      }
    })
  }
  private modelOf(tabId: string, pane: BookmarkPane): BookmarkModel | undefined {
    return pane === 'secondary' ? this.documents.getSecondaryModel?.(tabId) : this.documents.getModel(tabId)
  }
  private crossViewOf(tabId: string): 'split' | 'file' | undefined {
    const doc = this.documents.getSnapshot().documents.find(item => item.id === tabId)
    return doc?.multiMode === 'cross' ? doc.crossView ?? 'split' : undefined
  }
  /** Clears stale decorations when a Cross-Engine tab toggles between Split and File view or replaces a pane model. */
  private reconcileCrossViews(): void {
    if (!this.tabs.size) return
    let dirty = false
    for (const [tabId, entry] of [...this.tabs]) {
      const view = this.crossViewOf(tabId)
      if (entry.crossView !== undefined && view !== undefined && entry.crossView !== view) {
        const primary = this.modelOf(tabId, 'primary')
        if (entry.primary && primary === entry.primary.model && entry.primary.ids.length) {
          primary.deltaDecorations(entry.primary.ids, [])
        }
        const secondary = this.modelOf(tabId, 'secondary')
        if (entry.secondary && secondary === entry.secondary.model && entry.secondary.ids.length) {
          secondary.deltaDecorations(entry.secondary.ids, [])
        }
        this.tabs.delete(tabId)
        dirty = true
        continue
      }
      if (entry.primary && this.modelOf(tabId, 'primary') !== entry.primary.model) {
        entry.primary = undefined
        dirty = true
      }
      if (entry.secondary && this.modelOf(tabId, 'secondary') !== entry.secondary.model) {
        entry.secondary = undefined
        dirty = true
      }
      if (!entry.primary?.ids.length && !entry.secondary?.ids.length) {
        this.tabs.delete(tabId)
        dirty = true
      }
    }
    if (dirty) this.changed()
  }
  private totalCount(entry: TabBookmarks | undefined): number {
    return (entry?.primary?.ids.length ?? 0) + (entry?.secondary?.ids.length ?? 0)
  }
  private changed(): void {
    const counts: Record<string, number> = {}
    for (const [tabId, entry] of this.tabs) {
      const total = this.totalCount(entry)
      if (total > 0) counts[tabId] = total
    }
    this.publish({ counts })
  }
  /** The bookmarked lines of a document's pane (defaults to primary), each once: deleting lines can collapse two bookmarks onto one. */
  lines(tabId: string, pane: BookmarkPane = 'primary'): number[] {
    const model = this.modelOf(tabId, pane), slot = this.tabs.get(tabId)?.[pane]
    if (!model || !slot || slot.model !== model || !slot.ids.length) return []
    return [...new Set(slot.ids.flatMap(id => { const range = model.getDecorationRange(id); return range ? [range.startLineNumber] : [] }))].sort((a, b) => a - b)
  }
  /** The active document, its focused pane and model, and the editor showing it, or undefined when nothing is shown. */
  private active(): { readonly tabId: string; readonly pane: BookmarkPane; readonly model: BookmarkModel; readonly editor: BookmarkEditor; readonly line: number } | undefined {
    const tabId = this.documents.getSnapshot().activeId
    if (!tabId) return undefined
    const editor = this.documents.boundEditor
    if (!editor) return undefined
    const editorModel = editor.getModel()
    const secondary = this.modelOf(tabId, 'secondary')
    const primary = this.modelOf(tabId, 'primary')
    const expected = this.documents.activeModel?.(tabId)
    if (secondary && editorModel === secondary && (!expected || expected === secondary)) {
      return { tabId, pane: 'secondary', model: secondary, editor, line: editor.getPosition()?.lineNumber ?? 1 }
    }
    if (primary && editorModel === primary && (!expected || expected === primary)) {
      return { tabId, pane: 'primary', model: primary, editor, line: editor.getPosition()?.lineNumber ?? 1 }
    }
    return undefined
  }
  /** Adds a bookmark on the caret's line in the active pane, or removes every bookmark on it. */
  toggle(): void {
    const active = this.active()
    if (!active) return
    const { tabId, pane, model, editor, line } = active
    let entry = this.tabs.get(tabId)
    if (!entry) {
      entry = { crossView: this.crossViewOf(tabId) }
      this.tabs.set(tabId, entry)
    } else if (entry.crossView === undefined) {
      entry.crossView = this.crossViewOf(tabId)
    }
    const existing = entry[pane]?.model === model ? entry[pane]! : { model, ids: [] }
    const ids = existing.ids
    const onLine = ids.filter(id => model.getDecorationRange(id)?.startLineNumber === line)
    if (onLine.length) {
      model.deltaDecorations(onLine, [])
      const remaining = ids.filter(id => !onLine.includes(id))
      entry[pane] = remaining.length ? { model, ids: remaining } : undefined
      if (!entry.primary && !entry.secondary) this.tabs.delete(tabId)
    } else {
      if (this.totalCount(entry) >= maxBookmarksPerDocument) throw new Error('This document has 1,000 bookmarks; clear some first.')
      const [id] = model.deltaDecorations([], [{ range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 }, options: bookmarkOptions }])
      entry[pane] = { model, ids: [...ids, id] }
    }
    this.changed()
    editor.focus()
  }
  private panesOf(tabId: string): readonly BookmarkPane[] {
    return this.modelOf(tabId, 'secondary') ? ['primary', 'secondary'] : ['primary']
  }
  /** Next (1) or Previous (-1) Bookmark, through every open document (and both panes on Cross-Engine Split) or only the active one. */
  go(direction: 1 | -1, scope: 'all' | 'document'): void {
    const active = this.active()
    if (!active) return
    const { tabId, pane, line } = active
    const own = this.lines(tabId, pane)
    const inPane = direction > 0 ? own.find(value => value > line) : own.findLast(value => value < line)
    if (inPane !== undefined) { this.show(tabId, pane, inPane); return }
    const panes = this.panesOf(tabId)
    const paneIndex = panes.indexOf(pane)
    const nextPaneIndex = paneIndex + direction
    if (nextPaneIndex >= 0 && nextPaneIndex < panes.length) {
      const siblingPane = panes[nextPaneIndex]!
      const siblingLines = this.lines(tabId, siblingPane)
      if (siblingLines.length) { this.show(tabId, siblingPane, direction > 0 ? siblingLines[0]! : siblingLines.at(-1)!); return }
    }
    if (scope === 'all') {
      const tabs = this.documents.getSnapshot().documents.map(document => document.id), at = tabs.indexOf(tabId)
      for (let step = 1; step < tabs.length; step++) {
        const other = tabs[((at + direction * step) % tabs.length + tabs.length) % tabs.length]!
        const otherPanes = direction > 0 ? this.panesOf(other) : [...this.panesOf(other)].reverse()
        for (const otherPane of otherPanes) {
          const lines = this.lines(other, otherPane)
          if (lines.length) { this.show(other, otherPane, direction > 0 ? lines[0]! : lines.at(-1)!); return }
        }
      }
    }
    // Wrap around within the active document: check panes from the wrapping end (primary->secondary for Next, secondary->primary for Prev).
    const wrapPanes = direction > 0 ? panes : [...panes].reverse()
    for (const targetPane of wrapPanes) {
      const targetLines = this.lines(tabId, targetPane)
      if (targetLines.length) { this.show(tabId, targetPane, direction > 0 ? targetLines[0]! : targetLines.at(-1)!); return }
    }
  }
  private show(tabId: string, pane: BookmarkPane, line: number): void {
    this.documents.setActivePane?.(tabId, pane)
    if (this.documents.getSnapshot().activeId !== tabId) this.documents.activate(tabId)
    const model = this.modelOf(tabId, pane)
    if (!model) return
    const lineNumber = Math.min(line, model.getLineCount())
    const editor = this.documents.editorOf?.(tabId, pane) ?? this.documents.boundEditor
    if (!editor || editor.getModel() !== model) {
      if (this.documents.revealLine && this.documents.revision) {
        this.documents.revealLine(tabId, lineNumber, this.documents.revision(tabId), pane === 'secondary' ? 'bigquery' : 'sqlserver')
      }
      return
    }
    editor.setPosition({ lineNumber, column: 1 })
    editor.revealLineInCenterIfOutsideViewport(lineNumber)
    editor.focus()
  }
  /** Removes every bookmark in every open document and pane. */
  clear(): void {
    for (const [tabId, entry] of this.tabs) {
      if (entry.primary && this.modelOf(tabId, 'primary') === entry.primary.model) {
        entry.primary.model.deltaDecorations(entry.primary.ids, [])
      }
      if (entry.secondary && this.modelOf(tabId, 'secondary') === entry.secondary.model) {
        entry.secondary.model.deltaDecorations(entry.secondary.ids, [])
      }
    }
    this.tabs.clear()
    this.changed()
  }
  dispose(): void {
    this.subscription.dispose()
    this.clearListeners()
  }
}
