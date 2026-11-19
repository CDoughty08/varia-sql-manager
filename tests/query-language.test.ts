import { describe, expect, it, vi } from 'vitest'
import { documentInfo, documentProvider, queryLanguages } from '../src/renderer/src/documents'
import { providerSwitchKey, providerSwitchToast, switchModelLanguage } from '../src/renderer/src/languages/query-language'
import { keptSession } from '../src/renderer/src/services/session'
import { googleSqlLanguageId } from '../src/renderer/src/languages/googlesql'
import { sessionLimits } from '../src/shared/files/session'
import type { ConnectionInfo } from '../src/shared/contracts'
import { documentFixture } from './fixtures/documents'
import { connectionInfo, workbenchFixture } from './fixtures/workbench'

const bigQuery = (id: string): ConnectionInfo => ({ ...connectionInfo(id), server: 'analytics-proj', providerId: 'bigquery' })
const providers: Record<string, 'sqlserver' | 'bigquery'> = { sql: 'sqlserver', bq: 'bigquery' }
const fixture = () => documentFixture({ provider: id => providers[id], providerChanged: vi.fn() })

describe('a query document\'s provider and language (docs/bigquery-plan.md, BQ-4)', () => {
  it('names each engine\'s Monaco language and caption, and keeps every other document Transact-SQL\'s or kind\'s own', () => {
    expect(queryLanguages).toEqual({ sqlserver: 'sql', bigquery: googleSqlLanguageId })
    expect(documentInfo({ provider: 'bigquery' })).toMatchObject({ language: 'googlesql', label: 'GoogleSQL', icon: 'database' })
    expect(documentInfo({})).toMatchObject({ language: 'sql', label: 'Transact-SQL' })
    expect(documentInfo({ kind: 'json', provider: 'bigquery' })).toMatchObject({ language: 'json', label: 'JSON document' })
    expect([documentProvider(undefined), documentProvider({}), documentProvider({ provider: 'bigquery' }), documentProvider({ kind: 'activityMonitor' })]).toEqual(['', 'sqlserver', 'bigquery', 'sqlserver'])
  })

  it('opens a query on a connection in that connection\'s engine, and one without a connection as SQL Server\'s', () => {
    const { documents, model } = fixture()
    const onBigQuery = documents.create('a.sql', 'SELECT 1', 'sales', 'bq'), onSqlServer = documents.create('b.sql', 'SELECT 1', 'master', 'sql'), alone = documents.newQuery('', undefined, undefined)
    expect([onBigQuery.provider, model(onBigQuery.id).language]).toEqual(['bigquery', 'googlesql'])
    expect([onSqlServer.provider, model(onSqlServer.id).language]).toEqual([undefined, 'sql'])
    expect([alone.provider, model(alone.id).language]).toEqual([undefined, 'sql'])
    // A value opened from a BigQuery result is still a value in its own language.
    const value = documents.openText({ name: 'v.json', text: '{}', kind: 'json' })
    expect([value.provider, model(value.id).language]).toEqual([undefined, 'json'])
    documents.dispose()
  })

  it('switches the language, clears markers and says so when the connection changes engine, and keeps both on disconnect', () => {
    const changed = vi.fn(), setLanguage = vi.fn((model: { language: string }, language: string) => { model.language = language })
    const { documents, model } = documentFixture({ provider: id => providers[id], providerChanged: changed, setLanguage: setLanguage as never })
    const query = documents.create('q.sql', 'SELECT name FROM sys.databases', 'master', 'sql')
    documents.update(query.id, { connectionId: 'bq', database: 'sales' })
    expect(setLanguage).toHaveBeenCalledTimes(1)
    expect([documents.get(query.id)?.provider, model(query.id).language]).toEqual(['bigquery', 'googlesql'])
    expect(changed).toHaveBeenCalledTimes(1)
    expect(changed.mock.calls[0][0]).toMatchObject({ id: query.id, provider: 'bigquery', connectionId: 'bq', database: 'sales' })
    // Disconnecting keeps the engine and the language: the tab still holds GoogleSQL.
    documents.update(query.id, { connectionId: undefined })
    expect([documents.get(query.id)?.provider, model(query.id).language, setLanguage.mock.calls.length]).toEqual(['bigquery', 'googlesql', 1])
    // Another connection of the same engine changes nothing; SQL Server again switches back and drops the provider.
    documents.update(query.id, { connectionId: 'bq' })
    expect(setLanguage).toHaveBeenCalledTimes(1)
    documents.update(query.id, { connectionId: 'sql' })
    expect([documents.get(query.id)?.provider, model(query.id).language, changed.mock.calls.length]).toEqual([undefined, 'sql', 2])
    // An unknown handle (a connection already gone) changes nothing.
    documents.update(query.id, { connectionId: 'gone' })
    expect([documents.get(query.id)?.provider, model(query.id).language, setLanguage.mock.calls.length]).toEqual([undefined, 'sql', 2])
    documents.dispose()
  })

  it('switches an empty query silently, and never switches a value or a custom document', () => {
    const { documents, model } = fixture(), changed = vi.fn()
    const quiet = documentFixture({ provider: id => providers[id], providerChanged: changed })
    const empty = quiet.documents.create('e.sql', '', 'master')
    quiet.documents.update(empty.id, { connectionId: 'bq' })
    expect([quiet.documents.get(empty.id)?.provider, quiet.model(empty.id).language, changed.mock.calls.length]).toEqual(['bigquery', 'googlesql', 0])
    const value = documents.openText({ name: 'v.xml', text: '<a/>', kind: 'xml' })
    documents.update(value.id, { connectionId: 'bq' })
    expect([documents.get(value.id)?.provider, model(value.id).language]).toEqual([undefined, 'xml'])
    documents.dispose()
    quiet.documents.dispose()
  })

  it('keeps the engine when a closed query reopens, and restores it from hot exit and AutoRecover', async () => {
    const { documents, model } = fixture()
    const query = documents.create('q.sql', 'SELECT 1', 'sales', 'bq')
    await documents.close(query.id, 'rollback')
    const reopened = documents.reopenClosed()!
    expect([reopened.provider, reopened.connectionId, model(reopened.id).language]).toEqual(['bigquery', undefined, 'googlesql'])
    const restored = documents.reopen({ name: 'r.sql', kind: 'sql', eol: 'lf', dirty: true, text: 'SELECT 2', server: 'analytics-proj', database: 'sales', provider: 'bigquery' })
    expect([restored.provider, restored.lastServer, model(restored.id).language]).toEqual(['bigquery', 'analytics-proj', 'googlesql'])
    const old = documents.reopen({ name: 'o.sql', kind: 'sql', eol: 'lf', dirty: true, text: 'SELECT 3' })
    expect([old.provider, model(old.id).language]).toEqual([undefined, 'sql'])
    const recovered = documents.restore('k.sql', 'SELECT 4', 'sql', 'lf', undefined, 'bigquery')
    expect([recovered.provider, model(recovered.id).language]).toEqual(['bigquery', 'googlesql'])
    // A BigQuery tab restored without a dataset has none, rather than SQL Server's master.
    expect([restored.database, recovered.database, documents.reopen({ name: 'n.sql', kind: 'sql', eol: 'lf', dirty: true, text: '', provider: 'bigquery' }).database, old.database]).toEqual(['sales', '', '', 'master'])
    documents.dispose()
  })

  it('keeps a BigQuery tab\'s provider and its dataset at BigQuery\'s length in the session, and SQL Server tabs as before', () => {
    const { documents } = fixture()
    const dataset = 'd'.repeat(600)
    documents.create('bq.sql', 'SELECT 1', dataset, 'bq')
    documents.create('sql.sql', 'SELECT 1', 'master', 'sql')
    const { session } = keptSession(documents, id => id === 'bq' ? 'analytics-proj' : 'sql01')
    expect(session.documents[0]).toMatchObject({ provider: 'bigquery', server: 'analytics-proj', database: dataset })
    expect(dataset.length).toBeGreaterThan(sessionLimits.databaseChars)
    expect(session.documents[1]).not.toHaveProperty('provider')
    documents.dispose()
  })

  it('clears every owner\'s markers before changing a model\'s language', () => {
    const calls: string[] = []
    const model = { uri: { toString: () => 'varia-sql://query/1' } } as never
    const monaco = { editor: {
      getModelMarkers: vi.fn(() => [{ owner: 'sql' }, { owner: 'sql' }, { owner: 'other' }]),
      setModelMarkers: vi.fn((_model: unknown, owner: string, markers: unknown[]) => { calls.push(`clear ${owner} ${markers.length}`) }),
      setModelLanguage: vi.fn((_model: unknown, language: string) => { calls.push(`language ${language}`) })
    } }
    switchModelLanguage(monaco as never, model, 'googlesql')
    expect(monaco.editor.getModelMarkers).toHaveBeenCalledWith({ resource: (model as { uri: unknown }).uri })
    expect(calls).toEqual(['clear sql 0', 'clear other 0', 'language googlesql'])
  })

  it('says which language the query is in now and why, once per tab', () => {
    expect(providerSwitchToast({ id: 't1', name: 'SQLQuery3.sql', provider: 'bigquery', dirty: false, savedVersionId: null, database: 'sales' })).toEqual({
      severity: 'info', key: providerSwitchKey('t1'), message: 'SQLQuery3.sql is now GoogleSQL, the language of its BigQuery connection. Its Transact-SQL is unlikely to run as is.'
    })
    expect(providerSwitchToast({ id: 't1', name: 'SQLQuery3.sql', dirty: false, savedVersionId: null, database: 'master' }).message)
      .toBe('SQLQuery3.sql is now Transact-SQL, the language of its SQL Server connection. Its GoogleSQL is unlikely to run as is.')
  })

  it('in the workbench: the context key, the toast and AutoRecover follow the tab\'s connection', async () => {
    const workbench = workbenchFixture()
    try {
      const { documents, targets, context, notifications, api } = workbench
      workbench.connect(connectionInfo('c1'))
      workbench.connect(bigQuery('b1'))
      const query = documents.create('q.sql', 'SELECT 1', 'master')
      targets.update(query.id, { connectionId: 'c1' })
      expect(context.getState().activeDocumentProvider).toBe('sqlserver')
      workbench.model(query.id).edit('SELECT 2')
      expect(await workbench.commands.execute('file.autoRecoverNow', undefined, 'menu')).toBe(true)
      await vi.waitFor(() => expect(api.writeRecovery).toHaveBeenCalledTimes(1))
      expect(api.writeRecovery.mock.calls[0][0]).not.toHaveProperty('provider')
      // Moving the query changes no text, yet the next copy must reopen it as GoogleSQL.
      targets.update(query.id, { connectionId: 'b1', database: 'sales' })
      expect(context.getState().activeDocumentProvider).toBe('bigquery')
      expect(workbench.model(query.id).language).toBe('googlesql')
      expect(notifications.getSnapshot().visible.map(toast => toast.message)).toEqual(['q.sql is now GoogleSQL, the language of its BigQuery connection. Its Transact-SQL is unlikely to run as is.'])
      expect(await workbench.commands.execute('file.autoRecoverNow', undefined, 'menu')).toBe(true)
      await vi.waitFor(() => expect(api.writeRecovery).toHaveBeenCalledTimes(2))
      expect(api.writeRecovery.mock.calls[1][0]).toMatchObject({ provider: 'bigquery', server: 'analytics-proj', database: 'sales', text: 'SELECT 2' })
    } finally { workbench.dispose() }
  })
})
