import { vi } from 'vitest'
import type { ConnectionInfo, QueryResult, VariaApi } from '../../src/shared/contracts'
import type { Platform } from '../../src/shared/commands/keybindings'
import { CommandService } from '../../src/renderer/src/core/commands'
import { ContextKeyService } from '../../src/renderer/src/core/contextkeys'
import { KeybindingService } from '../../src/renderer/src/core/keybindings'
import type { Timers } from '../../src/renderer/src/core/timers'
import { ConnectionService } from '../../src/renderer/src/services/connections'
import { EditorOptionsService } from '../../src/renderer/src/services/editor-options'
import { FileService } from '../../src/renderer/src/services/files'
import { QueryService } from '../../src/renderer/src/services/queries'
import { TargetService } from '../../src/renderer/src/services/targets'
import { editorContribution } from '../../src/renderer/src/contributions/editor'
import { filesContribution } from '../../src/renderer/src/contributions/files'
import { paletteContribution } from '../../src/renderer/src/contributions/palette'
import { queryContribution } from '../../src/renderer/src/contributions/query'
import { shellContribution, type ShellHost } from '../../src/renderer/src/contributions/shell'
import { CommandHistory, type HistoryStorage } from '../../src/renderer/src/quickinput/history'
import { QuickInputService, type FocusAdapter } from '../../src/renderer/src/quickinput/QuickInputService'
import { deferred, documentFixture } from './documents'

export const connectionInfo = (id: string): ConnectionInfo => ({ id, server: `${id}.example`, database: 'master', serverVersion: '17.0' })
export const queryOutput: QueryResult = { status: 'completed', resultSets: [], messages: [], recordsAffected: 0, elapsedMs: 1, completedBatches: 1, totalBatches: 1, database: 'master', messagesTruncated: false }

/** Storage backed by a Map, for the command history. */
export function memoryStorage(initial: Record<string, string> = {}): HistoryStorage & { readonly values: Map<string, string> } {
  const values = new Map(Object.entries(initial))
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value) } }
}
/** Focus as a variable: `capture` returns `focused`, and `restore` sets it and records the call. */
export function fakeFocus(initial: unknown = 'editor') {
  const state = { focused: initial, restored: [] as unknown[] }
  const adapter: FocusAdapter = { capture: () => state.focused, restore: target => { state.focused = target; state.restored.push(target) } }
  return { adapter, state }
}
/** Timers that run only when the test says so; `advance` runs every timer due by then, in order. */
export function manualTimers() {
  let now = 0, next = 1
  const pending = new Map<number, { at: number; callback: () => void }>()
  const timers: Timers = { setTimeout: (callback, ms) => { pending.set(next, { at: now + ms, callback }); return next++ }, clearTimeout: handle => { pending.delete(handle as number) } }
  const advance = (ms: number) => {
    const until = now + ms
    for (;;) {
      const due = [...pending].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
      if (!due) break
      pending.delete(due[0])
      now = due[1].at
      due[1].callback()
    }
    now = until
  }
  return { timers, pending, advance }
}

/**
 * The renderer's services and every command contribution, wired as createWorkbench does but with fake IPC and a fake
 * shell host, so command enablement can be tested in Node.
 */
export function workbenchFixture(options: { platform?: Platform; modal?: () => boolean; storage?: HistoryStorage; timers?: Timers } = {}) {
  const doc = documentFixture()
  const api = {
    ...doc.api,
    execute: vi.fn<VariaApi['execute']>(async () => ({ ok: true, value: queryOutput })),
    cancel: vi.fn<VariaApi['cancel']>(async () => ({ ok: true, value: { cancelled: true } })),
    openSqlFiles: vi.fn<VariaApi['openSqlFiles']>(async () => ({ ok: true, value: [] })),
    releaseSqlFile: vi.fn<VariaApi['releaseSqlFile']>(async () => ({ ok: true, value: undefined })),
    confirmClose: vi.fn<VariaApi['confirmClose']>(async () => ({ ok: true, value: 'discard' })),
    closeWindow: vi.fn<VariaApi['closeWindow']>(async () => {}),
    databases: vi.fn<VariaApi['databases']>(async () => ({ ok: true, value: [] }))
  }
  const { documents, events } = doc
  const connections = new ConnectionService(), editorOptions = new EditorOptionsService()
  const queries = new QueryService(documents, api, id => connections.get(id), events)
  const files = new FileService(documents, queries, api)
  const targets = new TargetService(documents, queries, connections, files, api)
  const platform = options.platform ?? 'win32', focus = fakeFocus()
  const quickInput = new QuickInputService(focus.adapter, options.timers)
  const context = new ContextKeyService({ platform, documents, queries, connections, editorOptions, quickInput: quickInput.visibility, activeElement: () => null })
  const commands = new CommandService({ state: () => context.getState(), modalOpen: options.modal })
  const keybindings = new KeybindingService({ platform, commands, context, modalOpen: options.modal ?? (() => false), editorHasTextFocus: () => false })
  const host: ShellHost = { disconnect: vi.fn(async () => {}), reveal: vi.fn(), manageLayouts: vi.fn(), resetLayout: vi.fn(), flushLayout: vi.fn(async () => {}), showConnect: vi.fn(), refreshExplorer: vi.fn() }
  const history = new CommandHistory(options.storage ?? memoryStorage())
  const workbench = { commands, documents, queries, files, editorOptions, connections, targets, quickInput, keybindings, events }
  const contributions = [queryContribution(workbench, api), filesContribution(workbench), editorContribution(workbench), shellContribution(workbench, host), paletteContribution(workbench, history)]
  /** Starts a query on the active document that stays running until `finish` is called. */
  const startQuery = () => {
    const pending = deferred<Awaited<ReturnType<VariaApi['execute']>>>()
    api.execute.mockReturnValueOnce(pending.promise)
    const running = queries.execute()
    return { finish: async () => { pending.resolve({ ok: true, value: queryOutput }); await running } }
  }
  const dispose = () => { quickInput.dispose(); contributions.forEach(contribution => contribution.dispose()); commands.dispose(); context.dispose(); files.dispose(); queries.dispose(); documents.dispose() }
  return { ...doc, api, connections, editorOptions, queries, files, targets, context, commands, keybindings, quickInput, focus: focus.state, history, host, startQuery, dispose }
}
