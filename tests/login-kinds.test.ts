// New Login's other kinds (D2e): Microsoft Entra, certificate and asymmetric key logins, Managed Instance's SQL Server login without
// policy options, Map to Credential in New Login and Login Properties, and Search…'s server-side Check Names: main's schemas, the
// draft helpers and requests (src/renderer/src/dialogs/new-login.ts and login-properties.ts), the General page, and the object dialog
// service's windowsPrincipal read.
import { createElement, type ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { actionsCatalogJson } from '../src/shared/actions/catalog'
import {
  checkNamesText, credentialAuths, defaultsAuths, entraBoxBand, loginLimits, loginMessages, loginPropertiesRefusal, newLoginAuthOffered, newLoginMessages, newLoginPolicyEngines,
  windowsPrincipalDescribe, type NewLoginGeneral, type NewLoginModel
} from '../src/shared/actions/logins'
import { actionDescribeSchema, actionExecuteRequestSchema, actionScriptRequestSchema, type ActionDescribeResult } from '../src/shared/actions/schema'
import type { ApiResult, VariaApi } from '../src/shared/contracts'
import type { ObjectRef } from '../src/shared/explorer/refs'
import type { Workbench } from '../src/renderer/src/core/workbench'
import { WorkbenchProvider } from '../src/renderer/src/core/WorkbenchContext'
import { initialLoginPropertiesDraft, loginAuthOf, loginMappingChanges, loginPropertiesChanges, loginPropertiesEnabled, loginPropertiesModelOf, loginPropertiesProblem, type LoginPropertiesDraft, type LoginPropertiesModel } from '../src/renderer/src/dialogs/login-properties'
import {
  addCredential, credentialAddProblem, credentialProvider, emptySecrets, initialNewLoginDraft, newLoginEnabled, newLoginHints, newLoginKindNotes, newLoginRequest, offeredAuths,
  removeCredential, setMapped, setMappingSchema, signingAuth, type NewLoginDraft, type SecretState
} from '../src/renderer/src/dialogs/new-login'
import type { PageProps } from '../src/renderer/src/dialogs/ObjectDialog'
import { ObjectDialogService, type OpenObjectDialog } from '../src/renderer/src/dialogs/ObjectDialogService'
import { NewLoginGeneralPage } from '../src/renderer/src/dialogs/pages/NewLoginPages'
import UserMappingPage from '../src/renderer/src/dialogs/pages/UserMappingPage'
import type { ExplorerMenuNode } from '../src/renderer/src/menus/targets'
import { ConnectionService } from '../src/renderer/src/services/connections'
import { deferred } from './fixtures/documents'
import { loginPropertiesDescribe } from './fixtures/login-properties'
import { securablesModel } from './fixtures/securables'
import { connectionInfo, connectionOptions } from './fixtures/workbench'

const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()) })

const server: ObjectRef = { kind: 'server' }
const ids = () => ({ connectionId: crypto.randomUUID(), requestId: crypto.randomUUID() })
const set: SecretState = { password: 'set', matches: true, wellFormed: true, tooLong: false }
const model = (changes: Partial<NewLoginModel['server']> = {}, lists: Partial<NewLoginModel> = {}): NewLoginModel => ({
  server: { level: 17, linux: false, windowsOnly: false, canCreate: true, engine: 'box', ...changes },
  databases: [{ name: 'AppData', state: 0, accessible: true, readOnly: false }, { name: 'master', state: 0, accessible: true, readOnly: false }], databasesTruncated: false,
  languages: [{ name: 'us_english', alias: 'English' }], serverRoles: [{ name: 'public', fixed: true }, { name: 'sysadmin', fixed: true }], serverRolesTruncated: false,
  certificates: ['AppSigning', 'Other'], certificatesTruncated: false, asymmetricKeys: ['AppKey'], asymmetricKeysTruncated: false,
  credentials: [{ name: 'AzureBlob' }, { name: 'Vault', provider: 'EkmProv' }], credentialsTruncated: false, securables: securablesModel(), ...lists
})
const managed = () => model({ engine: 'managedInstance', level: 16 })
const draft = (of: NewLoginModel, changes: Partial<NewLoginDraft> = {}): NewLoginDraft => ({ ...initialNewLoginDraft(of), name: 'app', ...changes })
const built = (of: NewLoginModel, changes: Partial<NewLoginDraft>, secrets: SecretState = emptySecrets) => newLoginRequest(server, of, draft(of, changes), secrets)
const problem = (of: NewLoginModel, changes: Partial<NewLoginDraft>, secrets: SecretState = emptySecrets) => { const value = built(of, changes, secrets); return 'problem' in value ? value.problem : undefined }
const create = (login: NewLoginGeneral, extra: Record<string, unknown> = {}) => ({ action: 'createLogin', ...ids(), target: server, login, serverRoles: [], mappings: [], status: { connect: 'grant', enabled: true }, ...extra })
const catalogJson = () => JSON.parse(actionsCatalogJson()) as { logins: { newLogin: Record<string, unknown> & { authEngines: unknown }; checkNames: unknown }; actions: { action: string; engines: string[] }[] }
const scripts = (value: unknown) => actionScriptRequestSchema.safeParse(value).success
const executes = (value: unknown) => actionExecuteRequestSchema.safeParse(value).success

describe('the other kinds in main\'s schemas', () => {
  it('takes each kind with exactly its own fields, hostile names verbatim', () => {
    const hostile = "a]'; DROP LOGIN x; --‮"
    for (const login of [
      { auth: 'entra', name: hostile, defaultDatabase: hostile, defaultLanguage: hostile },
      { auth: 'certificate', name: hostile, certificate: hostile, credentials: [hostile, 'b'] },
      { auth: 'asymmetricKey', name: hostile, asymmetricKey: hostile },
      // Managed Instance's SQL Server login: no policy options.
      { auth: 'sql', name: 'app', defaultDatabase: 'master' },
      { auth: 'windows', name: 'D\\u', defaultDatabase: 'master', credentials: Array.from({ length: loginLimits.credentials }, (_, index) => `c${index}`) }
    ] as const) expect(scripts(create(login)), login.auth).toBe(true)
    expect(executes({ ...create({ auth: 'certificate', name: 'c', certificate: 'cert' }) })).toBe(true)
    expect(executes({ ...create({ auth: 'sql', name: 'm', defaultDatabase: 'master' }), secrets: { password: 'Throwaway-1' } })).toBe(true)
  })
  it('refuses a field another kind owns, defaults on a certificate or key login, credentials beyond their bounds or for Entra, and a certificate login\'s default schema', () => {
    for (const [name, login, extra] of [
      ['a certificate login without its certificate', { auth: 'certificate', name: 'c' }, {}],
      ['a certificate login with a key too', { auth: 'certificate', name: 'c', certificate: 'x', asymmetricKey: 'k' }, {}],
      ['a key login with a default database', { auth: 'asymmetricKey', name: 'k', asymmetricKey: 'k', defaultDatabase: 'master' }, {}],
      ['a certificate login with a language', { auth: 'certificate', name: 'c', certificate: 'x', defaultLanguage: 'us_english' }, {}],
      ['an Entra login without a default database', { auth: 'entra', name: 'e' }, {}],
      ['an Entra login with credentials', { auth: 'entra', name: 'e', defaultDatabase: 'master', credentials: ['v'] }, {}],
      ['an Entra login with policy options', { auth: 'entra', name: 'e', defaultDatabase: 'master', checkPolicy: true, checkExpiration: false, mustChange: false }, {}],
      ['a SQL Server login with one option', { auth: 'sql', name: 's', defaultDatabase: 'master', checkPolicy: true }, {}],
      ['a Windows login naming a certificate', { auth: 'windows', name: 'D\\u', defaultDatabase: 'master', certificate: 'x' }, {}],
      ['duplicate credentials', { auth: 'windows', name: 'D\\u', defaultDatabase: 'master', credentials: ['v', 'v'] }, {}],
      ['too many credentials', { auth: 'windows', name: 'D\\u', defaultDatabase: 'master', credentials: Array.from({ length: loginLimits.credentials + 1 }, (_, index) => `c${index}`) }, {}],
      ['an overlong certificate', { auth: 'certificate', name: 'c', certificate: 'x'.repeat(129) }, {}],
      ['a fifth kind', { auth: 'token', name: 't', defaultDatabase: 'master' }, {}],
      ['a certificate login\'s user with a default schema', { auth: 'certificate', name: 'c', certificate: 'x' }, { mappings: [{ database: 'AppData', user: 'c', defaultSchema: 'dbo', rolesAdd: [] }] }]
    ] as const) expect(scripts(create(login as unknown as NewLoginGeneral, extra)), name).toBe(false)
    // A password only for a SQL Server login.
    expect(executes({ ...create({ auth: 'certificate', name: 'c', certificate: 'x' }), secrets: { password: 'x' } })).toBe(false)
  })
  it('takes Check Names as a login ref holding DOMAIN\\name and nothing else', () => {
    const names = (target: unknown, extra: Record<string, unknown> = {}) => actionDescribeSchema.safeParse({ ...ids(), dialog: windowsPrincipalDescribe, target, ...extra }).success
    expect(names({ kind: 'login', name: 'CONTOSO\\ann' })).toBe(true)
    for (const target of [{ kind: 'login', name: 'ann' }, { kind: 'login', name: 'A\\b\\c' }, { kind: 'login', name: '\\b' }, { kind: 'server' }, { kind: 'login', database: 'master', name: 'A\\b' }])
      expect(names(target), JSON.stringify(target)).toBe(false)
    expect(names({ kind: 'login', name: 'A\\b' }, { login: 'A\\b' })).toBe(false)
  })
  it('takes Login Properties\' credentials to map and remove, distinct and never both', () => {
    const properties = (loginChanges: Record<string, unknown>) => scripts({ action: 'loginProperties', ...ids(), target: { kind: 'login', name: 'app' }, loginIdentity: { sid: '0A', created: '2026-01-02T03:04:05.000' }, loginChanges })
    expect(properties({ credentialsAdd: ['a', "b]'"], credentialsDrop: ['c'] })).toBe(true)
    expect(properties({ credentialsAdd: ['a', 'a'] })).toBe(false)
    expect(properties({ credentialsAdd: ['a'], credentialsDrop: ['a'] })).toBe(false)
    expect(properties({ credentialsDrop: Array.from({ length: loginLimits.credentials + 1 }, (_, index) => `c${index}`) })).toBe(false)
  })
  it('shares the engine rules with the backend through actions-catalog.json', () => {
    const rules = catalogJson().logins.newLogin
    expect(rules).toMatchObject({ entraBand: entraBoxBand, policyEngines: [...newLoginPolicyEngines], credentialAuths: [...credentialAuths], defaultsAuths: [...defaultsAuths] })
    expect(rules.authEngines).toEqual({ windows: ['box'], sql: ['box', 'managedInstance'], entra: ['box', 'managedInstance'], certificate: ['box'], asymmetricKey: ['box'] })
    expect(catalogJson().logins.checkNames).toEqual({ describe: windowsPrincipalDescribe, permission: checkNamesText.permission, notFound: checkNamesText.notFound, lookupFailed: checkNamesText.lookupFailed })
    expect(catalogJson().actions.find(row => row.action === 'createLogin')?.engines).toEqual(['box', 'managedInstance'])
  })
  it('names Select User or Group\'s parts as Windows\' object picker does, without its (examples) link', () => {
    expect([checkNamesText.title, checkNamesText.nameLabel, checkNamesText.check]).toEqual(['Select User or Group', 'Enter the object name to select', 'Check Names'])
  })
})

describe('New Login\'s kinds per server', () => {
  it('offers Windows, certificate and key logins on SQL Server only, Entra from 2022 and on Managed Instance', () => {
    expect(offeredAuths(model().server)).toEqual(['windows', 'sql', 'entra', 'certificate', 'asymmetricKey'])
    expect(offeredAuths(model({ level: 15 }).server)).toEqual(['windows', 'sql', 'certificate', 'asymmetricKey'])
    expect(offeredAuths(managed().server)).toEqual(['sql', 'entra'])
    expect(newLoginAuthOffered({ engine: 'managedInstance', level: 12 }, 'entra')).toBe(true)
    // Managed Instance has no Windows logins, so New Login opens on SQL Server authentication there.
    expect(initialNewLoginDraft(managed()).auth).toBe('sql')
    expect(initialNewLoginDraft(model({}, { certificates: [], asymmetricKeys: [], credentials: [] }))).toMatchObject({ certificate: '', asymmetricKey: '', credential: '', credentials: [] })
  })
  it('enables each control for its kind: Search… for Windows, a list for its kind, the defaults where CREATE LOGIN takes them, the policy options only on SQL Server', () => {
    const of = model()
    expect(newLoginEnabled(draft(of, { auth: 'windows' }), of.server)).toMatchObject({ search: true, certificate: false, asymmetricKey: false, defaults: true, mapCredential: true, credential: false })
    expect(newLoginEnabled(draft(of, { auth: 'certificate', mapCredential: true }), of.server)).toMatchObject({ search: false, certificate: true, defaults: false, mapCredential: true, credential: true, password: false })
    expect(newLoginEnabled(draft(of, { auth: 'asymmetricKey' }), of.server)).toMatchObject({ asymmetricKey: true, certificate: false, defaults: false })
    expect(newLoginEnabled(draft(of, { auth: 'entra', mapCredential: true }), of.server)).toMatchObject({ defaults: true, mapCredential: false, credential: false, search: false })
    const mi = managed()
    expect(newLoginEnabled(draft(mi, { auth: 'sql' }), mi.server)).toMatchObject({ password: true, policy: false, checkPolicy: false, checkExpiration: false, mustChange: false })
    expect(newLoginHints(draft(mi, { auth: 'sql' }), mi.server)).toEqual([newLoginMessages.policyManagedInstance, newLoginMessages.passwordScript])
    // A blank password: Managed Instance has no Enforce password policy to point to; SQL Server says it needs it.
    expect(problem(mi, { auth: 'sql' }, { ...set, password: 'empty' })).toBe(newLoginMessages.passwordRequired)
    expect(problem(of, { auth: 'sql', checkPolicy: false }, { ...set, password: 'empty' })).toBe(newLoginMessages.blankWithoutPolicy)
  })
  it('sends each kind with its own fields: certificate and key without defaults, Entra with them, Managed Instance\'s SQL Server login without options', () => {
    const of = model()
    expect(built(of, { auth: 'certificate', certificate: 'AppSigning', defaultLanguage: 'us_english' })).toMatchObject({ login: { auth: 'certificate', name: 'app', certificate: 'AppSigning' } })
    expect((built(of, { auth: 'certificate', certificate: 'AppSigning' }) as { login: NewLoginGeneral }).login).toEqual({ auth: 'certificate', name: 'app', certificate: 'AppSigning' })
    expect((built(of, { auth: 'asymmetricKey', asymmetricKey: 'AppKey' }) as { login: NewLoginGeneral }).login).toEqual({ auth: 'asymmetricKey', name: 'app', asymmetricKey: 'AppKey' })
    expect((built(of, { auth: 'entra', name: 'ann@contoso.com', defaultLanguage: 'us_english' }) as { login: NewLoginGeneral }).login)
      .toEqual({ auth: 'entra', name: 'ann@contoso.com', defaultDatabase: 'master', defaultLanguage: 'us_english' })
    const mi = managed()
    expect((built(mi, { auth: 'sql' }, set) as { login: NewLoginGeneral }).login).toEqual({ auth: 'sql', name: 'app', defaultDatabase: 'master' })
    for (const value of [built(of, { auth: 'certificate', certificate: 'AppSigning' }), built(of, { auth: 'entra', name: 'e' }), built(mi, { auth: 'sql' }, set)]) expect(scripts({ ...value, ...ids() })).toBe(true)
  })
  it('says what is missing for a kind: its certificate or key, one the lists no longer hold, a kind the server does not offer', () => {
    const of = model()
    expect(problem(of, { auth: 'certificate', certificate: '' })).toBe(newLoginMessages.certificate)
    // Nothing is chosen until the user picks one: master lists SQL Server's own signing certificates first, which no login should take by default.
    const own = model({}, { certificates: ['##MS_AgentSigningCertificate##', '##MS_SchemaSigningCertificateX##', 'AppSigning'] })
    expect(initialNewLoginDraft(own)).toMatchObject({ certificate: '', asymmetricKey: '' })
    expect(problem(own, { auth: 'certificate' })).toBe(newLoginMessages.certificate)
    expect(problem(of, { auth: 'asymmetricKey' })).toBe(newLoginMessages.asymmetricKey)
    expect(problem(of, { auth: 'certificate', certificate: 'Gone' })).toBe(newLoginMessages.certificate)
    expect(problem(of, { auth: 'asymmetricKey', asymmetricKey: 'Gone' })).toBe(newLoginMessages.asymmetricKey)
    expect(problem(model({ level: 15 }), { auth: 'entra' })).toBe(newLoginMessages.authNotOffered)
    expect(problem(managed(), { auth: 'windows', name: 'D\\u' })).toBe(newLoginMessages.authNotOffered)
    expect(problem(managed(), { auth: 'certificate' })).toBe(newLoginMessages.authNotOffered)
    // The other kinds' fields wait in the draft: a certificate chosen, then Windows, sends no certificate.
    expect((built(of, { auth: 'windows', name: 'D\\u' }) as { login: NewLoginGeneral }).login).toEqual({ auth: 'windows', name: 'D\\u', defaultDatabase: 'master' })
  })
  it('notes how to name an Entra principal and what SQL Server needs first, and that a certificate or key login cannot connect', () => {
    expect(newLoginKindNotes(model(), { auth: 'entra' })).toEqual([newLoginMessages.entraName, newLoginMessages.entraBox])
    expect(newLoginKindNotes(managed(), { auth: 'entra' })).toEqual([newLoginMessages.entraName])
    expect(newLoginKindNotes(model(), { auth: 'certificate' })).toEqual([newLoginMessages.signingOnly])
    expect(newLoginKindNotes(model({}, { asymmetricKeys: [] }), { auth: 'asymmetricKey' })).toEqual([newLoginMessages.noAsymmetricKeys, newLoginMessages.signingOnly])
    expect(newLoginKindNotes(model(), { auth: 'sql' })).toEqual([])
  })
  it('maps credentials in the grid\'s order, each once, at most loginLimits.credentials, and only for the kinds that take them', () => {
    const of = model()
    let current = draft(of, { auth: 'sql', mapCredential: true, credential: 'Vault' })
    current = { ...current, ...addCredential(of, current) }
    current = { ...current, credential: 'AzureBlob', ...addCredential(of, { ...current, credential: 'AzureBlob' }) }
    expect(current.credentials).toEqual(['Vault', 'AzureBlob'])
    expect(credentialAddProblem(of, current)).toBe(newLoginMessages.credentialTwice)
    expect(addCredential(of, current).credentials).toBe(current.credentials)
    expect(credentialAddProblem(model({}, { credentials: [] }), { credential: '', credentials: [] })).toBe(newLoginMessages.noCredentials)
    expect(credentialAddProblem(of, { credential: 'Gone', credentials: [] })).toBe(newLoginMessages.credential)
    expect(credentialAddProblem({ credentials: [{ name: 'x' }] }, { credential: 'x', credentials: Array.from({ length: loginLimits.credentials }, (_, index) => `c${index}`) })).toBe(newLoginMessages.credentialsLimit)
    expect(credentialProvider(of, 'Vault')).toBe('EkmProv')
    expect(credentialProvider(of, 'AzureBlob')).toBe('')
    expect(built(of, { ...current }, set)).toMatchObject({ login: { credentials: ['Vault', 'AzureBlob'] } })
    // Map to Credential cleared keeps the grid's rows, which OK still sends (SSMS's grid keeps them too).
    expect(built(of, { ...current, mapCredential: false }, set)).toMatchObject({ login: { credentials: ['Vault', 'AzureBlob'] } })
    expect(removeCredential(current, 'Vault').credentials).toEqual(['AzureBlob'])
    // An Entra login takes none: the grid's rows stay in the draft but are not sent.
    expect((built(of, { ...current, auth: 'entra' }) as { login: NewLoginGeneral }).login).not.toHaveProperty('credentials')
    // A credential the describe no longer lists is refused before anything is sent.
    expect(problem(of, { auth: 'sql', credentials: ['Gone'] }, set)).toBe(newLoginMessages.credential)
  })
  it('sends no default schema for a certificate or key login\'s users, and its User Mapping keeps Default Schema closed', () => {
    const of = model()
    const mapped = (auth: NewLoginDraft['auth']) => { let value = draft(of, { auth, certificate: 'AppSigning' }); value = { ...value, ...setMapped(value, 'AppData', true) }; return { ...value, ...setMappingSchema(value, 'AppData', 'dbo') } }
    expect(signingAuth('certificate') && signingAuth('asymmetricKey') && !signingAuth('entra')).toBe(true)
    expect(built(of, mapped('certificate'))).toMatchObject({ mappings: [{ database: 'AppData', user: 'app', rolesAdd: [] }] })
    expect((built(of, mapped('certificate')) as unknown as { mappings: { defaultSchema?: string }[] }).mappings[0]).not.toHaveProperty('defaultSchema')
    expect(built(of, mapped('sql'), set)).toMatchObject({ mappings: [{ defaultSchema: 'dbo' }] })
    const html = render(UserMappingPage, newLoginOpen(of, mapped('certificate'), 'userMapping'))
    expect(html).toContain(loginMessages.signingSchema)
    expect(html).not.toContain('aria-label="Select Schema for AppData"')
    expect(render(UserMappingPage, newLoginOpen(of, mapped('sql'), 'userMapping'))).toContain('aria-label="Select Schema for AppData"')
  })
})

const render = (Page: ComponentType<PageProps>, open: OpenObjectDialog) =>
  renderToStaticMarkup(createElement(WorkbenchProvider, { workbench: { dialogs: { updateDraft: vi.fn(), setSecret: vi.fn(), loadDatabaseRoles: vi.fn(), checkNames: vi.fn() } } as unknown as Workbench, children: createElement(Page, { open, editable: true }) }))
const newLoginOpen = (of: NewLoginModel, value: NewLoginDraft, page: OpenObjectDialog['page'] = 'general'): OpenObjectDialog => ({
  id: 1, dialog: 'newLogin', connectionId: 'c', nodeId: 1, target: server, label: 's', title: 'Login - New', server: 's', page, phase: 'ready', model: of, draft: value, secretState: emptySecrets
})

describe('New Login\'s General page', () => {
  it('shows the kinds the server offers, Search… only for Windows, and the policy options only on SQL Server', () => {
    const box = render(NewLoginGeneralPage, newLoginOpen(model(), draft(model(), { auth: 'windows' })))
    for (const label of ['Windows authentication', 'SQL Server authentication', 'Microsoft Entra authentication', 'Mapped to certificate', 'Mapped to asymmetric key'])
      expect(box).toContain(`${label}</label>`)
    expect(box).toContain('<button type="button">Search…</button>')
    expect(box).toContain('Enforce password policy')
    const mi = managed(), html = render(NewLoginGeneralPage, newLoginOpen(mi, draft(mi)))
    expect(html).not.toContain('Windows authentication')
    expect(html).not.toContain('Mapped to certificate')
    expect(html).toContain('Microsoft Entra authentication')
    expect(html).not.toContain('Enforce password policy')
    expect(html).toContain(newLoginMessages.policyManagedInstance)
    expect(html).toContain('<button type="button" disabled="">Search…</button>')
  })
  it('enables the chosen kind\'s list, greys the defaults for a certificate login, and lists Mapped Credentials with their providers', () => {
    const of = model(), value = draft(of, { auth: 'certificate', credentials: ['Vault'], mapCredential: true })
    const html = render(NewLoginGeneralPage, newLoginOpen(of, value))
    expect(html).toMatch(/<select id="new-login-certificate">/)
    expect(html).toMatch(/<select id="new-login-asymmetricKey" disabled="">/)
    expect(html).toMatch(/<select id="new-login-database" disabled="">/)
    expect(html).toContain(newLoginMessages.signingOnly)
    expect(html).toContain('<td role="gridcell"><bdi>Vault</bdi></td><td role="gridcell"><bdi>EkmProv</bdi></td>')
    expect(html).toContain('<button type="button">Remove</button>')
    const entra = render(NewLoginGeneralPage, newLoginOpen(of, draft(of, { auth: 'entra' })))
    expect(entra).toContain(newLoginMessages.credentialsEntra)
    expect(entra).toContain(newLoginMessages.entraBox)
  })
})

describe('Login Properties on the other kinds', () => {
  const lpModel = (changes: Parameters<typeof loginPropertiesDescribe>[0] = {}): LoginPropertiesModel => {
    const described = loginPropertiesDescribe(changes)
    return loginPropertiesModelOf({ ...described, newLogin: { ...described.newLogin, credentials: [{ name: 'Old' }, { name: 'New' }, { name: 'Vault', provider: 'EkmProv' }] } })!
  }
  const target: ObjectRef = { kind: 'login', name: 'app_login' }
  const lpDraft = (of: LoginPropertiesModel, changes: Partial<LoginPropertiesDraft> = {}): LoginPropertiesDraft => ({ ...initialLoginPropertiesDraft(of, target), ...changes })
  it('checks the login\'s own kind and shows its certificate or key', () => {
    expect(['S', 'U', 'G', 'E', 'X', 'C', 'K'].map(loginAuthOf)).toEqual(['sql', 'windows', 'windows', 'entra', 'entra', 'certificate', 'asymmetricKey'])
    const cert = lpModel({ login: { type: 'C', subtype: 'certificateMapped', policyChecked: undefined, expirationChecked: undefined }, lock: null, properties: { certificate: 'AppSigning', credentials: ['Old'] } })
    expect(lpDraft(cert)).toMatchObject({ auth: 'certificate', certificate: 'AppSigning', credentials: ['Old'], mapCredential: false })
  })
  it('maps and removes credentials as Mapped Credentials changed, and refuses them for an Entra login', () => {
    const of = lpModel({ properties: { credentials: ['Old', 'Vault'] } })
    expect(loginPropertiesChanges(of, lpDraft(of))).toEqual({})
    const changed = lpDraft(of, { credentials: ['Vault', 'New'] })
    expect(loginPropertiesChanges(of, changed)).toEqual({ credentialsAdd: ['New'], credentialsDrop: ['Old'] })
    expect(loginPropertiesProblem(of, lpDraft(of, { credentials: ['Old', 'Vault', 'Gone'] }))).toBe(newLoginMessages.credential)
    const entra = lpModel({ login: { type: 'E', subtype: 'externalUser', policyChecked: undefined, expirationChecked: undefined }, lock: null })
    expect(loginPropertiesEnabled(entra, lpDraft(entra, { mapCredential: true }))).toMatchObject({ mapCredential: false, credential: false })
    expect(loginPropertiesProblem(entra, lpDraft(entra, { credentials: ['New'] }))).toBe(loginMessages.externalCredentials)
    expect(loginPropertiesRefusal({ type: 'X', subtype: 'externalGroup', own: false }, { credentialsDrop: ['Old'] })).toBe('externalCredentials')
  })
  it('never sends a default schema for a certificate or key login\'s users (15259)', () => {
    const cert = lpModel({ login: { type: 'C', subtype: 'certificateMapped', policyChecked: undefined, expirationChecked: undefined }, lock: null, properties: { users: [], read: ['AppData', 'master', 'Owned', 'Sales'] } })
    const mapped = lpDraft(cert, { mappings: [{ database: 'AppData', map: true, user: 'c', defaultSchema: 'dbo', roles: [] }] })
    expect(loginMappingChanges(cert, mapped)).toEqual([{ database: 'AppData', change: 'map', user: 'c', rolesAdd: [] }])
    expect(loginPropertiesRefusal({ type: 'K', subtype: 'asymmetricKeyMapped', own: false }, { mappings: [{ database: 'AppData', change: 'map', user: 'k', defaultSchema: 'dbo' }] })).toBe('signingSchema')
  })
})

/** The service over fakes, opened on a Logins folder whose describe answers New Login's model, and whose windowsPrincipal read waits. */
function setup() {
  const check = deferred<ApiResult<ActionDescribeResult>>()
  const api = {
    describeObject: vi.fn<VariaApi['describeObject']>(async request => request.dialog === windowsPrincipalDescribe ? check.promise : ({ ok: true, value: { newLogin: model(), elapsedMs: 1 } as ActionDescribeResult })),
    scriptObjectAction: vi.fn<VariaApi['scriptObjectAction']>(),
    executeObjectAction: vi.fn<VariaApi['executeObjectAction']>(),
    cancelObjectActions: vi.fn<VariaApi['cancelObjectActions']>(async ids => ({ ok: true, value: { cancelled: ids.length } })),
    writeClipboardText: vi.fn<VariaApi['writeClipboardText']>(),
    confirmOpenConnections: vi.fn<VariaApi['confirmOpenConnections']>(),
    confirmAction: vi.fn<VariaApi['confirmAction']>()
  }
  const connections = new ConnectionService()
  connections.add({ ...connectionInfo('server-a'), login: 'sa' }, connectionOptions)
  let ids = 0
  const dialogs = new ObjectDialogService({ api, connections, explorer: { listingFolderOf: () => undefined, reconcile: vi.fn() }, documents: { newQuery: vi.fn() }, files: { saveCopy: vi.fn() }, newId: () => `id-${++ids}` })
  cleanups.push(() => dialogs.dispose())
  const node: ExplorerMenuNode = { id: 5, connectionId: 'server-a', ref: { type: 'folder', owner: server, folder: 'logins' }, kind: 'folder', folder: 'logins', label: 'Logins', lost: false, engine: 'box' }
  const settle = () => new Promise(resolve => setTimeout(resolve, 0))
  return { dialogs, api, check, node, settle }
}

describe('Check Names in the object dialog service', () => {
  it('asks the server about DOMAIN\\name through windowsPrincipal and shows its answer for that name', async () => {
    const { dialogs, api, check, node, settle } = setup()
    dialogs.open('newLogin', node)
    await settle()
    dialogs.checkNames('contoso\\ann')
    expect(dialogs.current?.checkNames).toEqual({ name: 'contoso\\ann', state: 'checking' })
    expect(api.describeObject.mock.calls[1][0]).toMatchObject({ dialog: windowsPrincipalDescribe, target: { kind: 'login', name: 'contoso\\ann' } })
    expect(actionDescribeSchema.safeParse({ ...api.describeObject.mock.calls[1][0], ...ids() }).success).toBe(true)
    check.resolve({ ok: true, value: { elapsedMs: 1, windowsPrincipal: { accountName: 'contoso\\ann', access: true, type: 'user' } } as ActionDescribeResult })
    await settle()
    expect(dialogs.current?.checkNames).toEqual({ name: 'contoso\\ann', state: 'ready', value: { accountName: 'contoso\\ann', access: true, type: 'user' } })
  })
  it('refuses a name that is not DOMAIN\\name without a request, cancels a check still running, and answers failures as values', async () => {
    const { dialogs, api, check, node, settle } = setup()
    dialogs.open('newLogin', node)
    await settle()
    dialogs.checkNames('ann')
    expect(dialogs.current?.checkNames).toMatchObject({ name: 'ann', state: 'failed', error: { message: newLoginMessages.windowsName } })
    expect(api.describeObject).toHaveBeenCalledTimes(1)
    dialogs.checkNames('A\\one')
    dialogs.checkNames('A\\two')
    expect(api.cancelObjectActions).toHaveBeenCalledWith([api.describeObject.mock.calls[1][0].requestId])
    // The first answer comes late, for a check that was cancelled: it is dropped.
    check.resolve({ ok: true, value: { elapsedMs: 1, error: { code: 'NOT_FOUND', message: checkNamesText.notFound, retryable: false } } as ActionDescribeResult })
    await settle()
    expect(dialogs.current?.checkNames).toMatchObject({ name: 'A\\two', state: 'failed', error: { code: 'NOT_FOUND', message: checkNamesText.notFound } })
  })
  it('cancels a check still running when the dialog closes', async () => {
    const { dialogs, api, node, settle } = setup()
    dialogs.open('newLogin', node)
    await settle()
    dialogs.checkNames('A\\b')
    dialogs.close()
    expect(api.cancelObjectActions).toHaveBeenCalledWith([api.describeObject.mock.calls[1][0].requestId])
  })
})
