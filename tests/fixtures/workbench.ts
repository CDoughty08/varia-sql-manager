import { vi } from 'vitest'
import type { ConnectionInfo, QueryResult, VariaApi } from '../../src/shared/contracts'
import type { Platform } from '../../src/shared/commands/keybindings'
import { CommandService } from '../../src/renderer/src/core/commands'
import { ContextKeyService } from '../../src/renderer/src/core/contextkeys'
import { ConnectionService } from '../../src/renderer/src/services/connections'
import { EditorOptionsService } from '../../src/renderer/src/services/editor-options'
import { FileService } from '../../src/renderer/src/services/files'
import { QueryService } from '../../src/renderer/src/services/queries'
import { TargetService } from '../../src/renderer/src/services/targets'
import { editorContribution } from '../../src/renderer/src/contributions/editor'
import { filesContribution } from '../../src/renderer/src/contributions/files'
import { queryContribution } from '../../src/renderer/src/contributions/query'
import { shellContribution, type ShellHost } from '../../src/renderer/src/contributions/shell'
import { deferred, documentFixture } from './documents'

export const connectionInfo = (id: string): ConnectionInfo => ({ id, server: `${id}.example`, database: 'master', serverVersion: '17.0' })
export const queryOutput: QueryResult = { status: 'completed', resultSets: [], messages: [], recordsAffected: 0, elapsedMs: 1, completedBatches: 1, totalBatches: 1, database: 'master', messagesTruncated: false }

/**
 * The renderer's services and every command contribution, wired as createWorkbench does but with fake IPC and a fake
 * shell host, so command enablement can be tested in Node.
 */
export function workbenchFixture(options: { platform?: Platform; modal?: () => boolean } = {}) {
  const doc = documentFixture()
  const api = {
    ...doc.api,
    execute: vi.fn<VariaApi['execute']>(async () => ({ ok: true, value: queryOutput })),
    cancel: vi.fn<VariaApi['cancel']>(async () => ({ ok: true, value: { cancelled: true } })),
    openSqlFiles: vi.fn<VariaApi['openSqlFiles']>(async () => ({ ok: true, value: [] })),
    releaseSqlFile: vi.fn<VariaApi['releaseSqlFile']>(async () => ({ ok: true, value: undefined })),
    confirmClose: vi.fn<VariaApi['confirmClose']>(async () => ({ ok: true, value: 'discard' })),
    closeWindow: vi.fn<VariaApi['closeWindow']>(async () => {})
  }
  const { documents, events } = doc
  const connections = new ConnectionService(), editorOptions = new EditorOptionsService()
  const queries = new QueryService(documents, api, id => connections.get(id), events)
  const files = new FileService(documents, queries, api)
  const targets = new TargetService(documents, queries, connections, files, api)
  const context = new ContextKeyService({ platform: options.platform ?? 'win32', documents, queries, connections, editorOptions, activeElement: () => null })
  const commands = new CommandService({ state: () => context.getState(), modalOpen: options.modal })
  const host: ShellHost = { reveal: vi.fn(), manageLayouts: vi.fn(), resetLayout: vi.fn(), flushLayout: vi.fn(async () => {}), showConnect: vi.fn(), refreshExplorer: vi.fn() }
  const workbench = { commands, documents, queries, files, editorOptions }
  const contributions = [queryContribution(workbench), filesContribution(workbench), editorContribution(workbench), shellContribution(workbench, host)]
  /** Starts a query on the active document that stays running until `finish` is called. */
  const startQuery = () => {
    const pending = deferred<Awaited<ReturnType<VariaApi['execute']>>>()
    api.execute.mockReturnValueOnce(pending.promise)
    const running = queries.execute()
    return { finish: async () => { pending.resolve({ ok: true, value: queryOutput }); await running } }
  }
  const dispose = () => { contributions.forEach(contribution => contribution.dispose()); commands.dispose(); context.dispose(); files.dispose(); queries.dispose(); documents.dispose() }
  return { ...doc, api, connections, editorOptions, queries, files, targets, context, commands, host, startQuery, dispose }
}
