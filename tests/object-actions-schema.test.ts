import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { databaseOptionDefs, scopedConfigurationDefs } from '../src/shared/actions/database'
import { actionCancelSchema, actionDescribeSchema, actionExecuteResultSchema, actionRequestSchema, actionTargetProblems } from '../src/shared/actions/schema'

const table = { kind: 'table', database: 'AppData', schema: 'dbo', name: 'Orders' } as const
const database = { kind: 'database', name: 'AppData' } as const
const ids = () => ({ connectionId: randomUUID(), requestId: randomUUID() })
const rename = (changes: Record<string, unknown> = {}) => ({ action: 'rename', ...ids(), target: table, newName: 'Orders2', ...changes })
const remove = (changes: Record<string, unknown> = {}) => ({ action: 'delete', ...ids(), target: table, closeConnections: false, deleteHistory: false, ...changes })
const properties = (changes: Record<string, unknown> = {}) => ({ action: 'properties', ...ids(), target: database, closeConnections: false, changes: { options: { autoClose: 'true' } }, ...changes })
const valid = (value: unknown) => actionRequestSchema.safeParse(value).success

describe('object action request schemas', () => {
  it('accepts hostile names verbatim: brackets, quotes, comment ends, line breaks, bidi controls, a single space, 128 units', () => {
    for (const newName of [']', "'", '*/', 'a\nGO\nb', 'a‮b', ' ', 'x'.repeat(128), "q]'); DROP TABLE dbo.Canary; --"]) {
      const request = rename({ newName })
      expect(actionRequestSchema.parse(request), JSON.stringify(newName)).toEqual(request)
    }
    expect(valid(rename({ target: { ...table, name: ' o]1 ' }, newName: 'o]1' }))).toBe(true)
    expect(valid(remove({ target: database, closeConnections: true, deleteHistory: true }))).toBe(true)
    expect(valid(rename({ target: { kind: 'function', database: 'AppData', schema: 'dbo', name: 'Total' } }))).toBe(true)
  })
  it('refuses U+0000, 129 units, the same name, an empty one, delete options on a table, and kinds or objects that never offer the action', () => {
    for (const [name, request] of [
      ['U+0000', rename({ newName: 'a\u0000b' })], ['129 units', rename({ newName: 'x'.repeat(129) })], ['the same name', rename({ newName: 'Orders' })], ['empty', rename({ newName: '' })],
      ['close connections on a table', remove({ closeConnections: true })], ['history on a table', remove({ deleteHistory: true })], ['a login\'s delete', remove({ target: { kind: 'login', name: 'AppUser' } })],
      ['a system database', rename({ target: { kind: 'database', name: 'master' } })], ['a system view', remove({ target: { kind: 'view', database: 'AppData', schema: 'sys', name: 'objects' } })],
      ['a synonym', remove({ target: { kind: 'synonym', database: 'AppData', schema: 'dbo', name: 's' } })], ['an unknown action', rename({ action: 'drop' })],
      ['a new name on a delete', remove({ newName: 'x' })], ['delete flags on a rename', rename({ closeConnections: false })], ['delete flags missing', { ...remove(), deleteHistory: undefined }],
      ['an extra member', rename({ extra: 1 })], ['a bad request id', rename({ requestId: 'r1' })], ['a ref of the wrong shape', rename({ target: { kind: 'table', database: 'AppData', name: 'Orders' } })]
    ] as const) expect(valid(request), name).toBe(false)
    expect(actionTargetProblems({ kind: 'database', name: 'tempdb' }, 'delete')).toEqual(['System objects cannot be changed.'])
    expect(actionTargetProblems({ kind: 'column', database: 'd', name: 'c', parent: { kind: 'table', schema: 'dbo', name: 't' } }, 'rename')).toEqual(['A column cannot be renamed.'])
  })
  it('describes only for a known dialog and a kind it serves', () => {
    const request = { ...ids(), dialog: 'deleteObject', target: table }
    expect(actionDescribeSchema.parse(request)).toEqual(request)
    expect(actionDescribeSchema.safeParse({ ...request, dialog: 'loginProperties' }).success).toBe(false)
    // Database Properties serves every database, SQL Server's own included, and nothing else.
    expect(actionDescribeSchema.safeParse({ ...request, dialog: 'databaseProperties', target: { kind: 'database', name: 'master' } }).success).toBe(true)
    expect(actionDescribeSchema.safeParse({ ...request, dialog: 'databaseProperties' }).success).toBe(false)
    expect(actionDescribeSchema.safeParse({ ...request, dialog: 'deleteObject', target: { kind: 'database', name: 'master' } }).success).toBe(false)
    expect(actionDescribeSchema.safeParse({ ...request, target: { kind: 'login', name: 'sa' } }).success).toBe(false)
    expect(actionDescribeSchema.safeParse({ ...request, extra: true }).success).toBe(false)
  })
  it('takes a login\'s Disable and Enable with only a target and the login\'s identity, and refuses SQL Server\'s own logins and other kinds', () => {
    const login = { kind: 'login', name: 'AppUser' } as const
    const state = (action: 'disable' | 'enable', changes: Record<string, unknown> = {}) => ({ action, ...ids(), target: login, ...changes })
    const request = state('disable')
    expect(actionRequestSchema.parse(request)).toEqual(request)
    expect([valid(state('enable')), valid(rename({ target: login, newName: 'App]User' })), valid(state('enable', { target: { kind: 'login', name: 'CONTOSO\\Ops' } }))]).toEqual([true, true, true])
    // The login the facts were read from: its SID as CONVERT(varchar(172), sid, 2) writes it, and its create_date.
    const identity = { sid: '0'.repeat(171) + 'F', created: '2026-01-02T03:04:05.000' }
    expect([valid(state('disable', { loginIdentity: identity })), valid(state('enable', { loginIdentity: { ...identity, sid: '01' } }))]).toEqual([true, true])
    expect([{ ...identity, sid: '0' }, { ...identity, sid: '0'.repeat(172) + 'F' }, { ...identity, sid: '0a' }, { ...identity, sid: '01\n' }, { ...identity, created: '2026-01-02 03:04:05' },
      { ...identity, created: '2026-01-02T03:04:05.000\n' }, { sid: '01' }, { ...identity, id: 1 }].map(loginIdentity => valid(state('disable', { loginIdentity })))).toEqual(Array(8).fill(false))
    expect([valid(rename({ target: login, newName: 'x', loginIdentity: identity })), valid({ action: 'delete', ...ids(), target: login, closeConnections: false, deleteHistory: false, loginIdentity: identity })])
      .toEqual([false, false])
    // A backslash is left to the preflight, which knows whether the login is a SQL Server or a Windows login.
    expect(valid(rename({ target: { kind: 'login', name: 'sa' }, newName: 'a\\b' }))).toBe(true)
    const system = { kind: 'login', name: '##MS_PolicyTsqlExecutionLogin##' } as const
    for (const [name, value] of [
      ['a new name on a disable', state('disable', { newName: 'x' })], ['delete flags on an enable', state('enable', { closeConnections: false })], ['changes on a disable', state('disable', { changes: {} })],
      ['a table\'s disable', state('disable', { target: table })], ['a database\'s enable', state('enable', { target: database })], ['SQL Server\'s own login', state('disable', { target: system })],
      ['SQL Server\'s own login\'s rename', rename({ target: system })], ['secrets on a disable', state('disable', { secrets: { password: 'x' } })], ['a login without a name', state('disable', { target: { kind: 'login' } })]
    ] as const) expect(valid(value), name).toBe(false)
    expect(actionTargetProblems(system, 'disable')).toEqual(['This login belongs to SQL Server and cannot be changed.'])
    // SQL Server compares names without trailing spaces: "##x## " is SQL Server's own ##x## too. A login's new name in that form is
    // refused, since Varia would then take the login for one of SQL Server's own; a database may still take one.
    const spaced = { ...system, name: system.name + '  ' }
    expect([valid(state('disable', { target: spaced })), valid(rename({ target: spaced, newName: 'x' })), valid(rename({ target: login, newName: '##AppUser##' })), valid(rename({ target: login, newName: '##AppUser## ' }))])
      .toEqual([false, false, false, false])
    expect(actionRequestSchema.safeParse(rename({ target: login, newName: '##AppUser##' })).error?.issues.map(issue => issue.message)).toEqual(["Names that start and end with ## are reserved for SQL Server's own logins."])
    expect(valid(rename({ target: database, newName: '##Sales##' }))).toBe(true)
    expect(actionTargetProblems({ kind: 'login', name: '##' }, 'disable')).toEqual([])
    // The loginFacts describe reads a login Disable may act on.
    const describe = { ...ids(), dialog: 'loginFacts', target: login }
    expect(actionDescribeSchema.parse(describe)).toEqual(describe)
    for (const target of [table, database, system]) expect(actionDescribeSchema.safeParse({ ...describe, target }).success, target.kind).toBe(false)
    // The reply carries the sessions connected as the login, bounded.
    const reply = { steps: [{ status: 'done', title: 'Disable the login' }], messages: [], elapsedMs: 3 }
    expect([0, 1_000_000].map(sessions => actionExecuteResultSchema.safeParse({ ...reply, sessions }).success)).toEqual([true, true])
    expect([-1, 1_000_001, 1.5].map(sessions => actionExecuteResultSchema.safeParse({ ...reply, sessions }).success)).toEqual([false, false, false])
  })
  it('cancels 1 to 16 distinct request ids', () => {
    const id = randomUUID()
    expect(actionCancelSchema.parse({ requestIds: [id] })).toEqual({ requestIds: [id] })
    expect(actionCancelSchema.safeParse({ requestIds: Array.from({ length: 16 }, () => randomUUID()) }).success).toBe(true)
    for (const value of [{ requestIds: [] }, { requestIds: [id, id] }, { requestIds: Array.from({ length: 17 }, () => randomUUID()) }, { requestIds: ['x'] }, { requestIds: [id], extra: 1 }]) {
      expect(actionCancelSchema.safeParse(value).success, JSON.stringify(value).slice(0, 60)).toBe(false)
    }
  })
  it('accepts Database Properties changes: owners verbatim, every settable option\'s tokens, numbers at their bounds, and system databases', () => {
    for (const owner of [']', "'", '--', 'a\r\nGO\r\nb', ' ', 'x'.repeat(128), "q]'); DROP TABLE dbo.Canary; --"]) {
      const request = properties({ changes: { owner } })
      expect(actionRequestSchema.parse(request), JSON.stringify(owner)).toEqual(request)
    }
    for (const def of [...databaseOptionDefs, ...scopedConfigurationDefs].filter(item => item.settable)) {
      const scoped = def.category === 'Database Scoped Configurations'
      const tokens = def.key === 'collation' ? ['Latin1_General_100_CI_AS_SC_UTF8'] : [...def.choices?.map(choice => choice.token) ?? [], ...def.range ? [String(def.range.min), String(def.range.max)] : []]
      for (const token of tokens) expect(valid(properties({ changes: scoped ? { scoped: { [def.key]: token } } : { options: { [def.key]: token } } })), def.key + ' ' + token).toBe(true)
    }
    expect(valid(properties({ target: { kind: 'database', name: 'tempdb' } }))).toBe(true)
    expect(valid(properties({ closeConnections: true, changes: { options: { readOnly: 'true', autoClose: 'true' } } }))).toBe(true)
  })
  it('refuses Database Properties changes zod can see are wrong', () => {
    for (const [name, request] of [
      ['U+0000 in the owner', properties({ changes: { owner: 'a\u0000b' } })], ['a 129-unit owner', properties({ changes: { owner: 'x'.repeat(129) } })], ['an empty owner', properties({ changes: { owner: '' } })],
      ['an unknown option', properties({ changes: { options: { autoCloseX: 'true' } } })], ['a read-only option', properties({ changes: { options: { trustworthy: 'true' } } })],
      ['a scoped key among options', properties({ changes: { options: { maxDop: '1' } } })], ['a wrong token', properties({ changes: { options: { recoveryModel: 'PARTIAL' } } })],
      ['MAXDOP 32,768', properties({ changes: { scoped: { maxDop: '32768' } } })], ['a padded number', properties({ changes: { scoped: { maxDop: ' 1' } } })],
      ['a leading zero', properties({ changes: { scoped: { maxDop: '01' } } })], ['a negative number', properties({ changes: { options: { targetRecoveryTime: '-1' } } })],
      ['a collation with a quote', properties({ changes: { options: { collation: "Latin1'" } } })], ['an unknown compatibility level', properties({ changes: { options: { compatibilityLevel: '90' } } })],
      ['no changes', properties({ changes: {} })], ['an unknown change', properties({ changes: { files: {} } })],
      ['closeConnections without an exclusive change', properties({ closeConnections: true })], ['a table target', properties({ target: table })],
      ['changes on a rename', rename({ changes: { options: { autoClose: 'true' } } })], ['changes on a delete', remove({ changes: { options: { autoClose: 'true' } } })],
      ['a new name on properties', properties({ newName: 'x' })], ['closeConnections missing', { ...properties(), closeConnections: undefined }]
    ] as const) expect(valid(request), name).toBe(false)
    expect(actionTargetProblems({ kind: 'database', name: 'master' }, 'properties')).toEqual([])
    expect(actionTargetProblems(table, 'properties')).toEqual(['A table cannot be shown in Properties.'])
  })
})
