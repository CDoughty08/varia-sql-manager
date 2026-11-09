import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ConnectionInfo, MessageEntry, VariaApi } from '../src/shared/contracts'
import { messagesContribution } from '../src/renderer/src/contributions/messages'
import { CommandService } from '../src/renderer/src/core/commands'
import { GestureService } from '../src/renderer/src/core/gestures'
import { WorkbenchProvider } from '../src/renderer/src/core/WorkbenchContext'
import type { Workbench } from '../src/renderer/src/core/workbench'
import type { TabResults } from '../src/renderer/src/results/ResultsService'
import MessagesView from '../src/renderer/src/results/MessagesView'
import { QueryService } from '../src/renderer/src/services/queries'
import { documentFixture } from './fixtures/documents'
import { summaryOf } from './fixtures/results'

async function fixture() {
  const docs = documentFixture(), commands = new CommandService()
  const connection: ConnectionInfo = { id: 'connection', server: 'localhost', database: 'master', serverVersion: '17', commandTimeout: 0, generation: 1 }
  const tab = docs.documents.create('error.sql', 'SELECT 1;\nSELECT missing;\nSELECT 3;', 'master', connection.id)
  let queryId = ''
  const messages: MessageEntry[] = [{ text: 'Msg 207, Level 16, State 1, Line 2\nInvalid column name.', kind: 'error', line: 2 }]
  const api = {
    execute: vi.fn<VariaApi['execute']>(async () => ({ ok: true, value: { ...summaryOf([]), messages, status: 'completedWithErrors' } })),
    cancel: vi.fn(), confirmSessions: vi.fn(), querySessionState: vi.fn()
  }
  const queries = new QueryService(docs.documents, api, id => id === connection.id ? connection : undefined, docs.events,
    { begin: vi.fn((_tabId, id) => { queryId = id }), finish: vi.fn() })
  const snapshot = () => ({ queryId, status: 'completedWithErrors', messages, notices: 0 } as unknown as TabResults)
  const results = { getSnapshot: () => ({ [tab.id]: snapshot() }) } as unknown as Workbench['results']
  const workbench = { commands, documents: docs.documents, queries, results, gestures: new GestureService('win32') } as Workbench
  const contribution = messagesContribution(workbench)
  await queries.execute(tab.id)
  const args = () => ({ tabId: tab.id, message: { queryId, index: 0, line: 2 } })
  return { ...docs, tab, commands, queries, snapshot, messages, args, workbench, contribution }
}

describe('SQL error source navigation', () => {
  it('activates the exact query and reveals the structured line without parsing its error text', async () => {
    const f = await fixture(), reveal = vi.spyOn(f.documents, 'revealLine')
    f.documents.create('other.sql', 'SELECT 4;', 'master')
    expect(f.commands.isEnabled('output.revealError', f.args())).toBe(true)
    await f.commands.run('output.revealError', f.args())
    expect(reveal).toHaveBeenCalledWith(f.tab.id, 2, f.documents.revision(f.tab.id))
    expect(f.documents.active?.id).toBe(f.tab.id)
  })
  it('disables stale execution IDs, shifted entries, missing locations and edited query text', async () => {
    const f = await fixture(), old = f.args()
    expect(f.commands.isEnabled('output.revealError', { ...old, message: { ...old.message, index: 9 } })).toBe(false)
    expect(f.commands.isEnabled('output.revealError', { ...old, message: { ...old.message, line: 3 } })).toBe(false)
    await f.queries.execute(f.tab.id)
    expect(f.commands.isEnabled('output.revealError', old)).toBe(false)
    expect(f.commands.isEnabled('output.revealError', f.args())).toBe(true)
    expect(f.queries.sourceLine(f.tab.id, f.args().message.queryId, undefined)).toBeUndefined()
    expect(f.queries.sourceLine(f.tab.id, f.args().message.queryId, 4)).toBeUndefined()
    f.model(f.tab.id).applyEdits([{ range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }, text: '-- edit\n' }])
    expect(f.commands.isEnabled('output.revealError', f.args())).toBe(false)
  })
  it('does not infer a source from procedure messages or retain locations after close', async () => {
    const f = await fixture()
    f.messages[0] = { text: 'Procedure dbo.example, Line 2\nError in a stored procedure.', kind: 'error' }
    expect(f.commands.isEnabled('output.revealError', f.args())).toBe(false)
    await f.documents.close(f.tab.id)
    expect(f.queries.sourceLine(f.tab.id, f.args().message.queryId, 2)).toBeUndefined()
  })
  it('keeps message text separate from accessible navigation buttons, disabling them on edit', async () => {
    const f = await fixture()
    const render = () => renderToStaticMarkup(createElement(WorkbenchProvider, { workbench: f.workbench, children: createElement(MessagesView, { tabId: f.tab.id, tab: f.snapshot() }) }))
    const initial = render()
    expect(initial).toContain('<pre class="msg error">Msg 207, Level 16, State 1, Line 2\nInvalid column name.</pre>')
    expect(initial).toContain('Go to line 2')
    expect(initial).not.toContain('disabled=""')
    f.model(f.tab.id).applyEdits([{ range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }, text: ' ' }])
    expect(render()).toContain('disabled=""')
  })
})
