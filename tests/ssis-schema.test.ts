import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { validateRequest, requestSchemas } from '../src/main/validation'
import { ssisCancelSchema, ssisCatalogSetupSchema, ssisDescribeSchema, ssisExecuteSchema } from '../src/shared/ssis/schema'
import { describeTargets, describeViews } from '../src/shared/ssis/catalog'
import type { ObjectRef } from '../src/shared/explorer/refs'

const ids = () => ({ connectionId: randomUUID(), requestId: randomUUID() })
const targets: { readonly [V in typeof describeViews[number]]: ObjectRef } = {
  catalog: { kind: 'ssisCatalog', name: 'SSISDB' },
  folder: { kind: 'ssisFolder', name: 'F]in\'an"ce -- /*' },
  project: { kind: 'ssisProject', ssisFolder: 'Finance', name: 'Loads' },
  package: { kind: 'ssisPackage', ssisFolder: 'Finance', ssisProject: 'Loads', name: 'p'.repeat(260) },
  environment: { kind: 'ssisEnvironment', ssisFolder: 'Finance', name: ' ' }
}
const accepts = (value: unknown) => expect(ssisDescribeSchema.safeParse(value).success, JSON.stringify(value)).toBe(true)
const rejects = (value: unknown) => expect(ssisDescribeSchema.safeParse(value).success, JSON.stringify(value)).toBe(false)

describe('ssis.describe requests', () => {
  it('accepts each view with a ref of the kind it describes, names verbatim', () => {
    for (const view of describeViews) {
      const request = { ...ids(), view, target: targets[view] }
      accepts(request)
      expect(targets[view].kind).toBe(describeTargets[view])
      expect(validateRequest('ssis.describe', request)).toEqual(request)
    }
  })
  it('refuses a ref of another kind, an unknown view, extra members and bad ids', () => {
    rejects({ ...ids(), view: 'folder', target: targets.project })
    rejects({ ...ids(), view: 'catalog', target: { kind: 'database', name: 'SSISDB' } })
    rejects({ ...ids(), view: 'run', target: targets.package })
    rejects({ ...ids(), view: 'folder', target: targets.folder, extra: 1 })
    rejects({ ...ids(), view: 'folder', target: { ...targets.folder, extra: 1 } })
    rejects({ ...ids(), connectionId: 'server-a', view: 'folder', target: targets.folder })
    rejects({ connectionId: randomUUID(), view: 'folder', target: targets.folder })
    expect(() => validateRequest('ssis.describe', { ...ids(), view: 'configure', target: targets.project })).toThrow('Invalid request')
  })
  it('bounds names: folders, projects and environments at 128, packages at 260, never U+0000 or a split surrogate', () => {
    rejects({ ...ids(), view: 'package', target: { ...targets.package, name: 'p'.repeat(261) } })
    rejects({ ...ids(), view: 'package', target: { ...targets.package, ssisProject: 'x'.repeat(129) } })
    rejects({ ...ids(), view: 'project', target: { ...targets.project, name: 'x'.repeat(129) } })
    rejects({ ...ids(), view: 'folder', target: { kind: 'ssisFolder', name: 'a\u0000b' } })
    rejects({ ...ids(), view: 'folder', target: { kind: 'ssisFolder', name: '' } })
    rejects({ ...ids(), view: 'environment', target: { kind: 'ssisEnvironment', name: 'Env' } })
    rejects({ ...ids(), view: 'package', target: { kind: 'ssisPackage', ssisFolder: 'F', name: 'p.dtsx' } })
    accepts({ ...ids(), view: 'folder', target: { kind: 'ssisFolder', name: '𝒜'.repeat(64) } })
    rejects({ ...ids(), view: 'folder', target: { kind: 'ssisFolder', name: '𝒜'.repeat(64) + 'a' } })
  })
  it('is one of the renderer\'s methods, and its cancel takes 1-64 distinct ids', () => {
    expect(requestSchemas['ssis.describe']).toBe(ssisDescribeSchema)
    expect(ssisCancelSchema.safeParse({ requestIds: [randomUUID()] }).success).toBe(true)
    expect(ssisCancelSchema.safeParse({ requestIds: Array.from({ length: 64 }, () => randomUUID()) }).success).toBe(true)
    expect(ssisCancelSchema.safeParse({ requestIds: Array.from({ length: 65 }, () => randomUUID()) }).success).toBe(false)
    const id = randomUUID()
    for (const value of [{ requestIds: [] }, { requestIds: [id, id] }, { requestIds: ['x'] }, { requestIds: [randomUUID()], extra: 1 }]) expect(ssisCancelSchema.safeParse(value).success).toBe(false)
  })
})

describe('ssis.execute requests', () => {
  const stop = (operationId: unknown, extra: Record<string, unknown> = {}) => ({ ...ids(), action: { verb: 'stopOperation', operationId }, ...extra })
  const valid = (value: unknown) => ssisExecuteSchema.safeParse(value).success
  it('accepts Stop Operation with an operation id from 1 to 2^53 - 1', () => {
    for (const id of [1, 42, Number.MAX_SAFE_INTEGER]) {
      expect(valid(stop(id)), String(id)).toBe(true)
      const request = stop(id)
      expect(validateRequest('ssis.execute', request)).toEqual(request)
    }
  })
  it('refuses other ids, unknown verbs and members, SYNCHRONIZED, and a revision Stop Operation does not take', () => {
    for (const id of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '42', null, undefined]) expect(valid(stop(id)), String(id)).toBe(false)
    expect(valid({ ...ids(), action: { verb: 'startExecution', operationId: 1 } })).toBe(false)
    expect(valid({ ...ids(), action: { operationId: 1 } })).toBe(false)
    expect(valid({ ...ids() })).toBe(false)
    expect(valid({ ...ids(), action: { verb: 'stopOperation', operationId: 1, synchronized: true } })).toBe(false)
    expect(valid(stop(1, { extra: 1 }))).toBe(false)
    expect(valid(stop(1, { revision: 'a'.repeat(64) }))).toBe(false)
    expect(valid({ ...stop(1), connectionId: 'server-a' })).toBe(false)
    expect(() => validateRequest('ssis.execute', stop(0))).toThrow('Invalid request')
  })
})

describe('Create Catalog requests', () => {
  const quoted = "Pa'ss]--w0rd"
  const create = (action: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({ ...ids(), action: { verb: 'createCatalog', password: quoted, enableClr: true, startupProcedure: false, ...action }, ...extra })
  const valid = (value: unknown) => ssisExecuteSchema.safeParse(value).success
  it('accepts the password verbatim, quotes and all, up to 128 UTF-16 code units, with both choices', () => {
    for (const password of ['x', quoted, 'p'.repeat(128), '𝒜'.repeat(64), ' leading and trailing ']) {
      const request = create({ password })
      expect(valid(request), password).toBe(true)
      expect(validateRequest('ssis.execute', request)).toEqual(request)
    }
    expect(valid(create({ enableClr: false, startupProcedure: true }))).toBe(true)
  })
  it('refuses an empty, long or NUL password, a missing choice, members of other verbs, and a revision', () => {
    for (const password of ['', 'p'.repeat(129), '𝒜'.repeat(64) + 'a', 'a\u0000b', 42, null]) expect(valid(create({ password })), String(password)).toBe(false)
    expect(valid(create({ enableClr: undefined }))).toBe(false)
    expect(valid(create({ startupProcedure: 'yes' }))).toBe(false)
    expect(valid(create({ operationId: 1 }))).toBe(false)
    expect(valid(create({ catalog: 'Other' }))).toBe(false)
    expect(valid(create({}, { revision: 'a'.repeat(64) }))).toBe(false)
    expect(valid({ ...ids(), action: { verb: 'stopOperation', operationId: 1, password: 'x' } })).toBe(false)
    // Main's error never repeats what was sent.
    expect(() => validateRequest('ssis.execute', create({ password: 'secret-marker'.repeat(20) }))).toThrow(/^Invalid request\. Check the connection or query settings\.$/)
  })
  it('reads the dialog setup with ids only', () => {
    expect(requestSchemas['ssis.catalogSetup']).toBe(ssisCatalogSetupSchema)
    const request = ids()
    expect(validateRequest('ssis.catalogSetup', request)).toEqual(request)
    for (const value of [{ ...ids(), extra: 1 }, { connectionId: randomUUID() }, { ...ids(), requestId: 'x' }]) expect(ssisCatalogSetupSchema.safeParse(value).success).toBe(false)
  })
})
