import { vi } from 'vitest'
import type { editor, IRange, ISelection } from 'monaco-editor'
import type { ApiResult, SqlFile, VariaApi } from '../../src/shared/contracts'
import { DocumentService } from '../../src/renderer/src/services/documents'
import { EventBus } from '../../src/renderer/src/core/events'

export function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(complete => { resolve = complete })
  return { promise, resolve }
}

// Unit-test model contract; Electron smoke tests exercise real Monaco history.
export class TestModel {
  disposed = false
  private listeners = new Set<() => void>()
  private history: { value: string; alternative: number }[]
  private index = 0
  private version = 1
  constructor(value: string, readonly uri: string) { this.history = [{ value, alternative: 1 }] }
  getValue(): string { return this.history[this.index].value }
  getValueLength(): number { return this.getValue().length }
  getVersionId(): number { return this.version }
  getAlternativeVersionId(): number { return this.history[this.index].alternative }
  getValueInRange(range: IRange): string {
    const lines = this.getValue().split('\n')
    const offset = (line: number, column: number) => lines.slice(0, line - 1).reduce((total, text) => total + text.length + 1, 0) + column - 1
    return this.getValue().slice(offset(range.startLineNumber, range.startColumn), offset(range.endLineNumber, range.endColumn))
  }
  onDidChangeContent(listener: () => void) { this.listeners.add(listener); return { dispose: () => { this.listeners.delete(listener) } } }
  pushStackElement(): void {}
  edit(value: string): void {
    this.history = this.history.slice(0, this.index + 1)
    this.history.push({ value, alternative: ++this.version })
    this.index++
    this.emit()
  }
  undo(): void { if (this.index) { this.index--; this.version++; this.emit() } }
  redo(): void { if (this.index < this.history.length - 1) { this.index++; this.version++; this.emit() } }
  private emit(): void { this.listeners.forEach(listener => listener()) }
  dispose(): void { this.disposed = true; this.listeners.clear() }
  asModel(): editor.ITextModel { return this as unknown as editor.ITextModel }
}

export class TestEditor {
  model: editor.ITextModel | null = null
  selection: (IRange & ISelection & { isEmpty?(): boolean }) | null = null
  viewState: editor.ICodeEditorViewState | null = null
  getModel(): editor.ITextModel | null { return this.model }
  setModel(model: editor.ITextModel | null): void { this.model = model; this.selection = null; this.viewState = null }
  getSelection() {
    const selection = this.selection
    return selection && { ...selection, isEmpty: () => selection.startLineNumber === selection.endLineNumber && selection.startColumn === selection.endColumn }
  }
  saveViewState(): editor.ICodeEditorViewState | null { return this.viewState }
  restoreViewState(state: editor.ICodeEditorViewState): void { this.viewState = state }
  asEditor(): editor.IStandaloneCodeEditor { return this as unknown as editor.IStandaloneCodeEditor }
}

export function documentFixture() {
  const events = new EventBus(), models = new Map<string, TestModel>()
  const api = {
    saveSqlFile: vi.fn<VariaApi['saveSqlFile']>(async () => ({ ok: true, value: { id: 'file-id', name: 'saved.sql', path: 'C:/saved.sql' } })),
    closeQuerySession: vi.fn<VariaApi['closeQuerySession']>(async () => ({ ok: true, value: { closed: true } }))
  }
  const documents = new DocumentService((sql, uri) => {
    const model = new TestModel(sql, uri); models.set(uri, model); return model.asModel()
  }, api, events)
  const model = (id: string) => models.get(`varia-sql://query/${id}`)!
  return { documents, events, api, model, models }
}
export type SaveResponse = ApiResult<SqlFile | null>
