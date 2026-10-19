import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { asInputMode, InputModeService } from '../src/renderer/src/core/input-mode'
import { computeContextKeys } from '../src/renderer/src/core/contextkeys'
import { displayColumn, EditorStatusService } from '../src/renderer/src/services/editor-status'
import { fakeInputMode } from './fixtures/workbench'

describe('display columns', () => {
  it('expands tabs to the next tab stop and counts a surrogate pair once, as Visual Studio\'s Col does', () => {
    expect(displayColumn('SELECT 1', 1, 4)).toBe(1)
    expect(displayColumn('SELECT 1', 9, 4)).toBe(9)
    expect(displayColumn('\tSELECT', 2, 4)).toBe(5)
    expect(displayColumn('ab\tc', 4, 4)).toBe(5)
    expect(displayColumn('abcd\tc', 6, 4)).toBe(9)
    expect(displayColumn('\t\tx', 3, 8)).toBe(17)
    // 😀 is two UTF-16 units (Ch counts both) but one column.
    expect(displayColumn('😀x', 3, 4)).toBe(2)
    expect(displayColumn('😀x', 4, 4)).toBe(3)
    // A caret between the halves of a pair (Monaco never puts it there) still counts the high half once.
    expect(displayColumn('😀', 2, 4)).toBe(2)
    expect(displayColumn('a', 99, 4)).toBe(2)
    expect(displayColumn('\t', 2, 0)).toBe(2)
  })
})

describe('the editor status service', () => {
  /** An editor stand-in: a caret on a line, a model's tab size and line ending, and Monaco's events. */
  function editor() {
    const listeners = new Map<string, Set<() => void>>()
    const on = (name: string) => (listener: () => void) => {
      const set = listeners.get(name) ?? new Set(); set.add(listener); listeners.set(name, set)
      return { dispose: () => { set.delete(listener) } }
    }
    const state = { line: 'SELECT\t1', lineNumber: 3, column: 8, tabSize: 4, eol: '\r\n', model: true }
    const instance = {
      getModel: () => state.model ? { getLineContent: () => state.line, getOptions: () => ({ tabSize: state.tabSize }), getEOL: () => state.eol } : null,
      getPosition: () => ({ lineNumber: state.lineNumber, column: state.column }),
      onDidChangeCursorPosition: on('cursor'), onDidChangeModel: on('model'), onDidChangeModelContent: on('content'), onDidChangeModelOptions: on('options')
    }
    const fire = (name: string) => listeners.get(name)?.forEach(listener => listener())
    return { state, instance: instance as unknown as Parameters<EditorStatusService['bindEditor']>[0], fire, listeners }
  }
  it('publishes Ln, Col, Ch and the line ending at most once a frame, and only numbers', () => {
    const frames: (() => void)[] = [], frame = () => frames.splice(0).forEach(callback => callback())
    const service = new EditorStatusService(callback => { frames.push(callback) })
    let published = 0
    service.subscribe(() => published++)
    const { state, instance, fire, listeners } = editor()
    const binding = service.bindEditor(instance)
    expect(service.getSnapshot()).toBeNull()
    frame()
    expect(service.getSnapshot()).toEqual({ line: 3, column: 9, character: 8, eol: 'crlf' })
    expect(published).toBe(1)
    // Typing moves the caret on every key; one frame publishes once.
    for (let column = 9; column <= 20; column++) { state.column = column; fire('cursor'); fire('content') }
    expect(frames).toHaveLength(1)
    state.line = 'SELECT\t1' + 'x'.repeat(20)
    frame()
    expect(service.getSnapshot()).toEqual({ line: 3, column: 21, character: 20, eol: 'crlf' })
    expect(published).toBe(2)
    // Nothing changed: nothing published.
    fire('cursor'); frame()
    expect(published).toBe(2)
    state.tabSize = 8; state.column = 8; fire('options'); frame()
    expect(service.getSnapshot()?.column).toBe(9)
    state.tabSize = 2; fire('options'); frame()
    expect(service.getSnapshot()?.column).toBe(9)
    state.eol = '\n'; fire('content'); frame()
    expect(service.getSnapshot()?.eol).toBe('lf')
    state.model = false; fire('model'); frame()
    expect(service.getSnapshot()).toBeNull()
    expect(Object.values({ ...service.getSnapshot() }).every(value => typeof value !== 'string' || ['crlf', 'lf'].includes(value))).toBe(true)
    binding.dispose()
    expect([...listeners.values()].every(set => set.size === 0)).toBe(true)
    service.dispose()
  })
})

describe('insert and overtype', () => {
  it('finds the members it relies on in Monaco\'s InputMode, so an upgrade that changes them fails here', async () => {
    const { InputMode } = await import('monaco-editor/editor/common/inputMode.js')
    const target = asInputMode(InputMode)
    expect(target).toBeDefined()
    const service = new InputModeService(target)
    expect(service.getSnapshot()).toEqual({ mode: 'insert', available: true })
    // The cursor reads the mode from the same module instance the adapter changes, not a copy.
    const cursorCommon = 'monaco-editor/editor/common/cursorCommon.js'
    const { CursorConfiguration } = await import(cursorCommon) as { CursorConfiguration: { prototype: object } }
    const reads = () => Object.getOwnPropertyDescriptor(CursorConfiguration.prototype, 'inputMode')!.get!.call({})
    try {
      service.toggle()
      expect(service.getSnapshot()).toEqual({ mode: 'overtype', available: true })
      expect(reads()).toBe('overtype')
      service.toggle()
      expect(reads()).toBe('insert')
    } finally { service.set('insert'); service.dispose() }
    // And the bundle resolves the adapter's import to the file the cursor imports.
    const require = createRequire(import.meta.url)
    const adapter = require.resolve('monaco-editor/editor/common/inputMode.js'), cursor = require.resolve('monaco-editor/editor/common/cursorCommon.js')
    expect(readFileSync(cursor, 'utf8')).toMatch(/from '\.\/inputMode\.js'/)
    expect(resolve(dirname(cursor), 'inputMode.js')).toBe(adapter)
    expect(join('esm', 'vs', 'editor', 'common', 'inputMode.js')).toBe(join(...adapter.split(/[\\/]/).slice(-5)))
  })
  it('leaves Insert mode alone and disables the toggle when Monaco no longer has those members', () => {
    expect(asInputMode(undefined)).toBeUndefined()
    for (const changed of [null, {}, { _inputMode: 'insert', getInputMode: () => 'insert' }, { ...fakeInputMode(), _onDidChangeInputMode: {} }, { ...fakeInputMode(), _inputMode: 'replace' }]) {
      expect(asInputMode(changed)).toBeUndefined()
      const service = new InputModeService(changed)
      expect(service.getSnapshot()).toEqual({ mode: 'insert', available: false })
      expect(() => { service.toggle(); service.set('overtype') }).not.toThrow()
      expect(service.get()).toBe('insert')
      service.dispose()
    }
  })
  it('publishes a change the editor makes, and feeds editorOvertype', () => {
    const target = fakeInputMode(), service = new InputModeService(target)
    const seen: string[] = []
    service.subscribe(() => seen.push(service.get()))
    service.toggle()
    target._inputMode = 'insert'; target._onDidChangeInputMode.fire('insert')
    service.set('insert')
    expect(seen).toEqual(['overtype', 'insert'])
    const keys = (overtype: boolean, dirty: boolean) => computeContextKeys({
      platform: 'win32', documents: { documents: [{ id: 'a', name: 'a.sql', dirty, savedVersionId: 1, database: 'master' }], activeId: 'a', busy: false }, queries: {}, connections: [],
      quickInputVisible: false, wordWrap: false, backendStatus: 'ready', overtype
    })
    expect([keys(true, false).editorOvertype, keys(false, false).editorOvertype]).toEqual([true, false])
    expect([keys(false, true).anyDocumentDirty, keys(false, false).anyDocumentDirty]).toEqual([true, false])
    service.dispose()
  })
})
