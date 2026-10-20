import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { databaseOptionDefs, scopedConfigurationDefs } from '../src/shared/actions/database'
import { actionCancelSchema, actionDescribeSchema, actionRequestSchema, actionTargetProblems } from '../src/shared/actions/schema'

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
      ['close connections on a table', remove({ closeConnections: true })], ['history on a table', remove({ deleteHistory: true })], ['a login', rename({ target: { kind: 'login', name: 'sa' } })],
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
