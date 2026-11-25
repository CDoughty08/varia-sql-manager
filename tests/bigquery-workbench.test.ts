import { describe, expect, it, vi } from 'vitest'
import type { PersistedConnectionTarget } from '../src/shared/connection-targets'
import { defaultSettings } from '../src/shared/settings/catalog'
import { bindStartupReconnect } from '../src/renderer/src/services/connection-startup'
import { queryStatusModel } from '../src/renderer/src/results/query-status'
import { queryContextModel } from '../src/renderer/src/query-context'
import type { LiveConnection } from '../src/renderer/src/services/connections'
import { executePendingQuery } from '../src/renderer/src/services/connection-opening'
import { connectBigQueryProfile } from '../src/renderer/src/services/connect-profile'
import type { VariaApi } from '../src/shared/contracts'
import { deferred, TestEditor } from './fixtures/documents'
import { readyBackend, workbenchFixture } from './fixtures/workbench'

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`
const principal = { provider: 'bigquery' as const, project: 'varia-alpha', principal: 'bigquery:user:ada@example.com' }
const target = (): PersistedConnectionTarget => ({ id: id(1), options: { provider: 'bigquery', project: 'varia-alpha', dataset: 'sales', extraProjects: ['varia-beta'], authentication: 'gcloud' },
  details: { autoReconnect: 'inherit', environment: 'Production' }, inExplorer: true, resumeWanted: true, expectedPrincipal: principal })

describe('BigQuery connections in the workbench', () => {
  // The comma commands read GoogleSQL by its own tokens (editing-commands.test.ts runs them). A command that targets a SQL Server
  // object still edits the bound GoogleSQL model by GoogleSQL's rules, so both stay enabled in either engine's query.
  it('offers Move Commas in a GoogleSQL query, from its own tab or a command that targets a SQL Server object', () => {
    const value = workbenchFixture()
    try {
      const sql = 'SELECT a # total,\n  b\nFROM t\n, u', query = value.documents.restore('commas.sql', sql, 'sql', 'lf', undefined, 'bigquery')
      value.documents.bindEditor(new TestEditor().asEditor())
      expect(value.documents.getModel(query.id)?.getLanguageId()).toBe('googlesql')
      const node = { id: 1, connectionId: 'sql-server', kind: 'server', label: 'server', ref: { type: 'object', object: { kind: 'server' } }, lost: false } as const
      for (const id of ['edit.commasToFront', 'edit.commasToEnd'] as const) {
        expect(value.commands.isEnabled(id), id).toBe(true)
        expect(value.commands.unavailableReason(id), id).toBeUndefined()
        expect(value.commands.isEnabled(id, { target: { kind: 'explorer' as const, node } }), id).toBe(true)
      }
      // A SQL Server query keeps both commands, with no reason to grey them.
      const tsql = value.documents.restore('commas-tsql.sql', 'SELECT a,\n  b\nFROM t', 'sql', 'lf')
      expect(value.documents.boundEditor?.getModel()).toBe(value.documents.getModel(tsql.id))
      expect(value.documents.boundEditor?.getModel()?.getLanguageId()).toBe('sql')
      for (const id of ['edit.commasToFront', 'edit.commasToEnd'] as const) {
        expect(value.commands.isEnabled(id), id).toBe(true)
        expect(value.commands.unavailableReason(id), id).toBeUndefined()
      }
    } finally { value.dispose() }
  })

  it('keeps Toggle Brackets from rewriting the bound GoogleSQL model when a command targets a SQL Server object', async () => {
    const value = workbenchFixture()
    try {
      const sql = 'SELECT [1] AS items', query = value.documents.restore('arrays.sql', sql, 'sql', 'lf', undefined, 'bigquery')
      const editor = new TestEditor()
      value.documents.bindEditor(editor.asEditor())
      expect(value.documents.getModel(query.id)?.getLanguageId()).toBe('googlesql')
      const node = { id: 1, connectionId: 'sql-server', kind: 'server', label: 'server', ref: { type: 'object', object: { kind: 'server' } }, lost: false } as const
      const args = { target: { kind: 'explorer' as const, node } }
      expect(value.commands.isEnabled('edit.toggleBrackets', args)).toBe(false)
      expect(await value.commands.execute('edit.toggleBrackets', args, 'toolbar')).toBe(false)
      expect(value.documents.getModel(query.id)?.getValue()).toBe(sql)
    } finally { value.dispose() }
  })

  it('lists a restored BigQuery target by its project and dataset, and reconnects it at startup with its pinned account', async () => {
    const value = workbenchFixture(), ready = deferred<void>()
    try {
      value.connectionTargets.restore({ version: 1, targets: [target()] })
      // Before reconnecting: the project where SQL Server shows the server, the dataset as the database.
      expect(value.connections.get(id(1))).toMatchObject({ server: 'varia-alpha', database: 'sales', providerId: 'bigquery', environment: 'Production', lost: true })
      value.api.connect.mockImplementation(async (_options, context) => ({ ok: true, value: { id: id(50), targetId: context!.targetId, generation: 1, server: 'varia-alpha', database: 'sales', serverVersion: 'BigQuery', login: 'ada@example.com', providerId: 'bigquery', authentication: { principal } } }))
      const binding = bindStartupReconnect({ ...value, api: value.api, ready: ready.promise })
      try {
        value.api.push(readyBackend(1))
        await value.settings.load()
        ready.resolve()
        await Promise.resolve()
        await binding.scheduler.whenIdle()
        expect(value.api.connect).toHaveBeenCalledTimes(1)
        const [options, context] = value.api.connect.mock.calls[0]!
        expect(options).toEqual({ provider: 'bigquery', project: 'varia-alpha', dataset: 'sales', extraProjects: ['varia-beta'], authentication: 'gcloud', environment: 'Production' })
        expect(context).toMatchObject({ mode: 'background', targetId: id(1), expectedPrincipal: principal })
        expect(value.connections.get(id(1))).toMatchObject({ id: id(50), server: 'varia-alpha', login: 'ada@example.com' })
        expect(value.connections.isLive(id(50))).toBe(true)
      } finally { binding.dispose() }
    } finally { value.dispose() }
  })

  // Show in Job History for a project the page is not connected to: the records' saved connection, with no Connect dialog.
  it('connects a saved BigQuery connection by its id for Show in Job History, onto its disconnected target', async () => {
    const value = workbenchFixture()
    try {
      value.connectionTargets.restore({ version: 1, targets: [target()] })
      value.api.push(readyBackend(1))
      const profile = { id: id(300), favorite: false, autoReconnect: 'on' as const, options: { provider: 'bigquery' as const, project: 'varia-alpha', dataset: 'sales', extraProjects: ['varia-beta'], authentication: 'gcloud' as const, environment: 'Production' } }
      const loadConnectionLibrary = vi.fn<VariaApi['loadConnectionLibrary']>(async () => ({ ok: true, value: { bigQuery: { profiles: [profile] } } }) as unknown as Awaited<ReturnType<VariaApi['loadConnectionLibrary']>>)
      const api = Object.assign(value.api, { loadConnectionLibrary }) as typeof value.api & Pick<VariaApi, 'loadConnectionLibrary'>
      value.api.connect.mockImplementation(async (_options, context) => ({ ok: true, value: { id: id(50), targetId: context!.targetId, generation: 1, server: 'varia-alpha', database: 'sales', serverVersion: 'BigQuery', login: 'ada@example.com', providerId: 'bigquery', authentication: { principal } } }))
      const signal = new AbortController().signal, deps = { ...value, api, signal }
      expect(await connectBigQueryProfile(deps, id(300))).toEqual({ ok: true, connectionId: id(50) })
      const [options, context] = value.api.connect.mock.calls[0]!
      expect(options).toEqual(profile.options)
      // Interactive, as Connect is (a sign-in can still be asked for); main records it in the saved entry.
      expect(context).toMatchObject({ mode: 'interactive', targetId: id(1), selectedProfileId: id(300), credentialIntent: 'preserve', autoReconnect: 'on', expectedPrincipal: principal })
      expect(value.connections.isLive(id(50))).toBe(true)
      expect(value.connections.get(id(1))).toMatchObject({ id: id(50), server: 'varia-alpha' })
      // A removed entry, a library that cannot be read and a failed connect each say why, and connect nothing.
      expect(await connectBigQueryProfile(deps, id(301))).toEqual({ ok: false, error: 'The saved BigQuery connection these jobs ran on was removed.' })
      loadConnectionLibrary.mockResolvedValueOnce({ ok: false, error: 'Unreadable.' })
      expect(await connectBigQueryProfile(deps, id(300))).toEqual({ ok: false, error: 'Unreadable.' })
      expect(value.api.connect).toHaveBeenCalledTimes(1)
    } finally { value.dispose() }
  })

  it('shows the project, account and default dataset in the query status bar', () => {
    const connection = { server: 'varia-alpha', serverVersion: 'BigQuery', providerId: 'bigquery', login: 'ada@example.com' }
    const model = queryStatusModel({ connection, database: 'sales', running: false, now: 0, settings: defaultSettings, variant: 'segment' })
    expect(model.segments.map(segment => `${segment.label}: ${segment.text}`)).toEqual(['Project: varia-alpha', 'Account: ada@example.com', 'Dataset: sales'])
    expect(queryStatusModel({ connection, database: '', running: false, now: 0, settings: defaultSettings, variant: 'segment' }).place).toBe('varia-alpha | ada@example.com | No default dataset')
  })

  it('lists the project\'s datasets in the query tab\'s database box, with no default dataset as a choice', () => {
    const connection = { id: id(50), generation: 1, server: 'varia-alpha', database: 'sales', serverVersion: 'BigQuery', providerId: 'bigquery', options: { provider: 'bigquery', project: 'varia-alpha', authentication: 'gcloud' } } as LiveConnection
    const input = { connectionId: id(50), connections: [connection], databases: [{ name: 'sales', isSystem: false, isSnapshot: false }, { name: 'staging', isSystem: false, isSnapshot: false }], query: true, running: false, busy: false }
    expect(queryContextModel({ ...input, database: 'sales' })).toMatchObject({ datasets: true, databases: ['', 'sales', 'staging'], database: 'sales' })
    expect(queryContextModel({ ...input, database: '' })).toMatchObject({ databases: ['', 'sales', 'staging'] })
    // SQL Server's box is unchanged.
    const sql = { ...connection, providerId: undefined, options: { server: 'sql01', database: '', authentication: 'windows', trustServerCertificate: false } } as LiveConnection
    expect(queryContextModel({ ...input, connections: [sql], database: 'master', databases: [{ name: 'master', isSystem: true, isSnapshot: false }] })).toMatchObject({ datasets: false, databases: ['master'] })
  })

  it('keeps SQL Server-only tools off a BigQuery connection: Activity Monitor, Integration Services, Search Objects', async () => {
    const value = workbenchFixture()
    value.api.push(readyBackend())
    try {
      const info = { id: id(60), generation: 1, server: 'varia-alpha', database: 'sales', serverVersion: 'BigQuery', providerId: 'bigquery' }
      value.connections.add(info as never, { provider: 'bigquery', project: 'varia-alpha', authentication: 'gcloud' } as never)
      expect(value.connections.isLive(id(60))).toBe(true)
      expect(value.connections.isLiveSqlServer(id(60))).toBe(false)
      expect(value.connections.liveSqlServer()).toEqual([])
      expect(() => value.activity.open(id(60))).toThrow('Activity Monitor is available for SQL Server connections only.')
      // With only BigQuery connected, Activity Monitor asks for a SQL Server connection rather than opening on it.
      const asked: string[] = []
      const off = value.events.subscribe(event => { asked.push(event.type) })
      try { await value.commands.execute('activity.open', undefined, 'palette') } finally { off.dispose() }
      expect(asked).toContain('activity.connectRequested')
      expect(Object.values(value.documents.getSnapshot().documents ?? {}).some(document => (document as { kind?: string }).kind === 'activityMonitor')).toBe(false)
    } finally { value.dispose() }
  })

  it('attaches a waiting query to a BigQuery connection made from Execute without running it', async () => {
    const connection = { id: id(61), targetId: id(2), generation: 1, providerId: 'bigquery', options: { provider: 'bigquery', project: 'varia-alpha', authentication: 'gcloud' } }
    const execute = vi.fn(async () => {})
    await executePendingQuery({
      tabId: 'tab', opened: { id: id(61), targetId: id(2), generation: 1, bindingRevision: 1 } as never,
      connections: { get: () => connection, isLive: () => true, bindingRevision: () => 1 } as never,
      documents: { get: () => ({ kind: 'sql', connectionId: id(61), targetId: id(2), attachWanted: true }), getSnapshot: () => ({ busy: false }) } as never,
      targets: { changeConnection: vi.fn() } as never, queries: { isRunning: () => false, execute } as never
    })
    expect(execute).not.toHaveBeenCalled()
  })

  it('opens a new query on BigQuery with no default dataset, and never opens the SSMS T-SQL shortcuts there', async () => {
    const value = workbenchFixture()
    value.api.push(readyBackend())
    try {
      value.connections.add({ id: id(62), generation: 1, server: 'varia-alpha', database: '', serverVersion: 'BigQuery', providerId: 'bigquery' } as never, { provider: 'bigquery', project: 'varia-alpha', authentication: 'gcloud' } as never)
      const first = value.documents.newQuery('', undefined, id(62))
      expect(first.database).toBe('')
      // Ctrl+N from it: the same connection, still no dataset (SQL Server's would start in master).
      expect(value.documents.newQuery().database).toBe('')
      const count = value.documents.getSnapshot().documents.length
      await value.commands.execute('query.newSpWho', undefined, 'palette')
      expect(value.documents.getSnapshot().documents.length).toBe(count)
      expect(value.documents.newQuery('', undefined, undefined, undefined).connectionId).toBe(id(62))
      // A file opened from it takes its connection, and no dataset either.
      value.api.openRecentFile.mockResolvedValueOnce({ ok: true, value: { files: [{ id: 'opened', path: 'C:/opened.sql', name: 'opened.sql', content: 'SELECT 1', encoding: 'utf8', readOnly: false, eol: 'lf', mixedEol: false }], errors: [] } })
      await value.files.openRecent('6f7f1d7a-3c0e-4b8e-9d55-2f0f0a6f0b11')
      expect(value.documents.active).toMatchObject({ name: 'opened.sql', connectionId: id(62), database: '' })
    } finally { value.dispose() }
  })
})
