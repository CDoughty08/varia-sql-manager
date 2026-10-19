import { vi } from 'vitest'
import type { editor, IRange, ISelection } from 'monaco-editor'
import type { ApiResult, SqlFile, VariaApi } from '../../src/shared/contracts'
import { DocumentService, type DocumentOptions } from '../../src/renderer/src/services/documents'
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
  readonly options: Record<string, unknown> = {}
  private index = 0
  private version = 1
  constructor(value: string, readonly uri: string, readonly language = 'sql') { this.history = [{ value, alternative: 1 }] }
  getValue(): string { return this.history[this.index].value }
  getValueLength(): number { return this.getValue().length }
  getVersionId(): number { return this.version }
  getAlternativeVersionId(): number { return this.history[this.index].alternative }
  private offset(line: number, column: number): number {
    const lines = this.getValue().split('\n')
    return lines.slice(0, line - 1).reduce((total, text) => total + text.length + 1, 0) + column - 1
  }
  getValueInRange(range: IRange): string {
    return this.getValue().slice(this.offset(range.startLineNumber, range.startColumn), this.offset(range.endLineNumber, range.endColumn))
  }
  getLineCount(): number { return this.getValue().split('\n').length }
  getLineContent(line: number): string { return this.getValue().split('\n')[line - 1] }
  getValueLengthInRange(range: IRange): number { return this.getValueInRange(range).length }
  /** The indentation DocumentService set, as Monaco's resolved options. */
  getOptions() { return { tabSize: 4, indentSize: 4, insertSpaces: false, ...this.options } }
  getLineMaxColumn(line: number): number { return this.getValue().split('\n')[line - 1].length + 1 }
  /** Monaco's applyEdits: a new version, but no undo stop. */
  applyEdits(edits: { range: IRange; text: string }[]): void {
    let value = this.getValue()
    for (const { range, text } of edits) value = value.slice(0, this.offset(range.startLineNumber, range.startColumn)) + text + value.slice(this.offset(range.endLineNumber, range.endColumn))
    this.history[this.index] = { value, alternative: ++this.version }
    this.emit()
  }
  onDidChangeContent(listener: () => void) { this.listeners.add(listener); return { dispose: () => { this.listeners.delete(listener) } } }
  pushStackElement(): void {}
  updateOptions(options: Record<string, unknown>): void { Object.assign(this.options, options) }
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
  readonly options: Record<string, unknown>[] = []
  updateOptions(options: Record<string, unknown>): void { this.options.push(options) }
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

/** `options` stands for the settings DocumentService applies (indentation, bracket matching). */
export function documentFixture(options: DocumentOptions = {}) {
  const events = new EventBus(), models = new Map<string, TestModel>()
  const api = {
    saveSqlFile: vi.fn<VariaApi['saveSqlFile']>(async () => ({ ok: true, value: { id: 'file-id', name: 'saved.sql', path: 'C:/saved.sql' } })),
    closeQuerySession: vi.fn<VariaApi['closeQuerySession']>(async () => ({ ok: true, value: { closed: true } }))
  }
  const frames: (() => void)[] = []
  const documents = new DocumentService((text, uri, language) => {
    const model = new TestModel(text, uri, language); models.set(uri, model); return model.asModel()
  }, api, events, callback => { frames.push(callback) }, options)
  const model = (id: string) => models.get(`varia-sql://query/${id}`)!
  /** Runs the callbacks waiting for the next animation frame. */
  const frame = () => { for (const callback of frames.splice(0)) callback() }
  return { documents, events, api, model, models, frames, frame }
}
export type SaveResponse = ApiResult<SqlFile | null>
