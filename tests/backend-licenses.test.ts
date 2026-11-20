import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
// @ts-expect-error The script is plain JavaScript without declarations.
import { lockedPackages } from '../scripts/package-licenses.mjs'

interface Entry { id: string; version: string; license: string }
const inventory = JSON.parse(readFileSync('backend/package-licenses.json', 'utf8')) as Entry[]
const lock = JSON.parse(readFileSync('backend/Varia.Backend/packages.lock.json', 'utf8')) as unknown

/** Licenses any backend package may carry; anything else needs a named, reviewed exception below. */
const allowed = new Set(['MIT', 'Apache-2.0', 'BSD-3-Clause'])
/** Reviewed exceptions: SqlClient's native SNI ships under Microsoft's own license file. */
const exceptions = new Map([['Microsoft.Data.SqlClient.SNI.runtime', 'file:LICENSE.txt']])

describe('backend package licenses', () => {
  it('lists every package the backend resolves at its locked version (node scripts/package-licenses.mjs regenerates it)', () => {
    expect(inventory.map(({ id, version }) => ({ id, version }))).toEqual(lockedPackages(lock))
  })
  it('allows only permissive licenses, and names each exception', () => {
    expect(inventory.filter(entry => !allowed.has(entry.license) && exceptions.get(entry.id) !== entry.license)).toEqual([])
    for (const id of exceptions.keys()) expect(inventory.some(entry => entry.id === id), id).toBe(true)
  })
  it('keeps BigQuery on Google\'s Apache-2.0 client libraries', () => {
    const google = inventory.filter(entry => entry.id.startsWith('Google.'))
    expect(google.map(entry => entry.id)).toEqual(expect.arrayContaining(['Google.Cloud.BigQuery.V2', 'Google.Apis.Auth', 'Google.Apis.Bigquery.v2']))
    expect(google.every(entry => entry.license === 'Apache-2.0' || entry.license === 'BSD-3-Clause')).toBe(true)
  })
})
