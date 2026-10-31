import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { loginDetail, loginDetailWords, loginStatusOf, loginTypeSubtypes } from '../src/shared/actions/logins'
import { actionsCatalogJson } from '../src/shared/actions/catalog'
import { nodeStatuses, statusBadges } from '../src/shared/explorer/catalog'
import { loginChipDocs, loginChips } from '../src/shared/explorer/status'

const none = { disabled: false, connectDenied: false, policyChecked: false, expirationChecked: false }

describe('Logins listing (D4a)', () => {
  it('keeps a disabled login apart from one denied permission to connect, disabled first', () => {
    expect(loginStatusOf(false, false)).toBeUndefined()
    expect(loginStatusOf(true, false)).toBe('disabled')
    expect(loginStatusOf(false, true)).toBe('noAccess')
    expect(loginStatusOf(true, true)).toBe('disabled')
    // Each is a status with its own badge, so the two never look alike again.
    expect(nodeStatuses).toEqual(expect.arrayContaining(['disabled', 'noAccess']))
    expect(statusBadges.disabled).not.toBe(statusBadges.noAccess)
  })
  it('names a login\'s kind, state and password policy in its detail', () => {
    expect(loginDetail('S ', { ...none, policyChecked: true, expirationChecked: true })).toBe('SQL Server authentication · Password policy enforced · Password expiration enforced')
    expect(loginDetail('G', { ...none, disabled: true, connectDenied: true })).toBe('Windows group · Disabled · Permission to connect denied')
    expect(loginDetail('U', none)).toBe('Windows user')
    expect(loginDetail('C', { ...none, connectDenied: true })).toBe('Mapped to a certificate · Permission to connect denied')
    expect(loginDetail('K', { ...none, disabled: true })).toBe('Mapped to an asymmetric key · Disabled')
    expect(loginDetail('E', none)).toBe('Microsoft Entra user or application')
    expect(loginDetail('X', none)).toBe('Microsoft Entra group')
    // A server role is not a login: no kind of its own.
    expect(loginDetail('R', none)).toBe('')
    expect(Object.keys(loginDetailWords.types).sort()).toEqual(Object.keys(loginTypeSubtypes).sort())
  })
  it('gives the backend the same words through actions-catalog.json, so C# composes the detail from them', () => {
    const catalog = JSON.parse(actionsCatalogJson()) as { logins: { detail: typeof loginDetailWords } }
    expect(catalog.logins.detail).toEqual(loginDetailWords)
    expect(JSON.parse(readFileSync('backend/Varia.Backend/Actions/actions-catalog.json', 'utf8')).logins.detail).toEqual(loginDetailWords)
  })
  it('draws Disabled and Connect denied as different static chips, and none for a login that can connect', () => {
    expect(loginChips(undefined)).toEqual([])
    expect(loginChips('readOnly')).toEqual([])
    expect(loginChips('disabled')).toEqual([{ id: 'state', tone: 'neutral', label: 'DISABLED', words: 'Disabled', title: 'The login is disabled: new connections are refused; open sessions continue.', icon: 'arrow-small-down' }])
    expect(loginChips('noAccess')).toEqual([{ id: 'state', tone: 'warning', label: 'CONNECT DENIED', words: 'Permission to connect denied', title: 'CONNECT SQL is denied: the login cannot connect.', icon: 'circle-slash' }])
    expect(loginChipDocs.map(doc => [doc.status, doc.chip])).toEqual([['disabled', 'DISABLED'], ['noAccess', 'CONNECT DENIED']])
    // The chip's glyph is the badge's, so the row says one thing twice rather than two things.
    expect(loginChips('disabled')[0].icon).toBe(statusBadges.disabled)
    expect(loginChips('noAccess')[0].icon).toBe(statusBadges.noAccess)
  })
  it('documents the listing, its subtypes and the chips in docs/object-explorer.md', () => {
    const docs = readFileSync('docs/object-explorer.md', 'utf8')
    expect(docs).toContain('## Login status')
    expect(docs).toContain('| `noAccess` | CONNECT DENIED | warning | Permission to connect denied | CONNECT SQL is denied: the login cannot connect. |')
    expect(docs).toContain('| `G` | `windowsGroup` | Windows group |')
  })
})
