import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { connectionPrincipalIdSchema, verifiedConnectionAuthentication } from '../src/main/connection-principal'
import type { ConnectionInfo } from '../src/shared/contracts'

const info = (principalId?: string): ConnectionInfo => ({ id: randomUUID(), generation: 1, server: 'server', database: 'master', serverVersion: '17', login: 'same display account', principalId })
describe('stable backend principal proof', () => {
  it('accepts one through 85 whole SID bytes and refuses partial or oversized evidence', () => {
    for (const bytes of [1, 2, 84, 85]) expect(connectionPrincipalIdSchema.safeParse(`sid:${'ab'.repeat(bytes)}`).success).toBe(true)
    for (const hex of ['', 'a', 'abc', 'a'.repeat(169), 'a'.repeat(171), 'ab'.repeat(86), 'a'.repeat(1_000_000)])
      expect(connectionPrincipalIdSchema.safeParse(`sid:${hex}`).success).toBe(false)
  })
  it('normalizes bounded SID and tenant/object evidence without accepting display login fallbacks', () => {
    expect(verifiedConnectionAuthentication(info('SID:Ab01'), 'sql')?.principal.id).toBe('sid:ab01')
    const entra = `entra:${randomUUID()}:${randomUUID()}`
    expect(verifiedConnectionAuthentication(info(entra.toUpperCase()), 'entraMfa')?.principal.id).toBe(entra)
    for (const invalid of [undefined, 'same display account', 'sid:1', 'sid:gg', `sid:${'ff'.repeat(86)}`, `entra:${randomUUID()}`])
      expect(verifiedConnectionAuthentication(info(invalid), 'sql')).toBeUndefined()
    expect(verifiedConnectionAuthentication(info(entra), 'windows')).toBeUndefined()
    expect(verifiedConnectionAuthentication(info('sid:01020304'), 'entraPassword')).toBeUndefined()
  })
})
