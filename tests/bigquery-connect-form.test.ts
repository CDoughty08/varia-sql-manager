import { describe, expect, it } from 'vitest'
import {
  bigQueryDefaults, bigQueryFormOptions, bigQueryReady, bigQueryRowDetail, bigQueryRowText, joinBytes, lastServerType, maxListedProjects, mergeProjects, parseExtraProjects,
  projectError, serverOf, splitBytes, switchServerType, undoServerType, withAuthentication, advancedCostPrompt, savedCostPrompt, withoutCostPrompt } from '../src/renderer/src/bigquery-connect-form'
import { bigQueryAdvancedSummary, accountText } from '../src/renderer/src/BigQueryConnectFields'

const keyFile = '6f0c2b8e-4d1a-4c3b-9e2f-1a2b3c4d5e6f'

describe('Connect dialog: Server type', () => {
  it('switches type remembering the one Undo returns to, and Undo forgets it', () => {
    const start = { type: 'sqlserver' as const }
    expect(switchServerType(start, 'sqlserver')).toBe(start)
    const switched = switchServerType(start, 'bigquery')
    expect(switched).toEqual({ type: 'bigquery', previous: 'sqlserver' })
    expect(undoServerType(switched)).toEqual({ type: 'sqlserver' })
    // Nothing to undo: the state stays as it is.
    expect(undoServerType(start)).toBe(start)
    // A switch back is a switch of its own, which Undo reverses in turn.
    expect(undoServerType(switchServerType(switched, 'sqlserver'))).toEqual({ type: 'bigquery' })
  })
  it('opens with the type of the connection used last, SQL Server when there is none', () => {
    expect(lastServerType([], [])).toBe('sqlserver')
    expect(lastServerType([{ lastConnected: '2026-11-01T10:00:00.000Z' }], [{ lastConnected: '2026-11-02T10:00:00.000Z' }])).toBe('bigquery')
    expect(lastServerType([{ lastConnected: '2026-11-03T10:00:00.000Z' }], [{ lastConnected: '2026-11-02T10:00:00.000Z' }, {}])).toBe('sqlserver')
    // Saved but never connected is not "used".
    expect(lastServerType([], [{}])).toBe('sqlserver')
  })
})

describe('Connect dialog: BigQuery fields', () => {
  it('forgets the key file when the authentication changes, and needs one for the file modes', () => {
    const form = { ...bigQueryDefaults(), project: 'varia-alpha' }
    expect(bigQueryReady(form)).toBe(true)
    const keyed = { ...withAuthentication(form, 'serviceAccountKey') }
    expect(bigQueryReady(keyed)).toBe(false)
    expect(bigQueryReady({ ...keyed, keyFile })).toBe(true)
    expect(withAuthentication({ ...keyed, keyFile }, 'externalAccount')).not.toHaveProperty('keyFile')
    expect(withAuthentication({ ...keyed, keyFile }, 'serviceAccountKey')).toHaveProperty('keyFile', keyFile)
  })
  it('checks the project id as BigQuery spells one', () => {
    expect(projectError('')).toBe('Enter a project.')
    expect(projectError('varia-alpha')).toBeUndefined()
    expect(projectError('example.com:varia-alpha')).toBeUndefined()
    expect(projectError('Varia Alpha')).toBe('Enter a Google Cloud project id.')
    expect(bigQueryReady({ ...bigQueryDefaults(), project: 'no' })).toBe(false)
  })
  it('sends the form trimmed, leaving empty fields out, and refuses what the schema refuses', () => {
    expect(bigQueryFormOptions({ provider: 'bigquery', project: ' varia-alpha ', authentication: 'gcloud', location: '', dataset: ' sales ', extraProjects: [' ', 'varia-beta'], impersonateServiceAccount: ' ', displayName: ' ', keyFile }))
      .toEqual({ provider: 'bigquery', project: 'varia-alpha', authentication: 'gcloud', dataset: 'sales', extraProjects: ['varia-beta'] })
    expect(bigQueryFormOptions({ provider: 'bigquery', project: 'varia-alpha', authentication: 'serviceAccountKey', keyFile, location: 'EU', maximumBytesBilled: 1024, environment: 'Production', color: '#112233' }))
      .toEqual({ provider: 'bigquery', project: 'varia-alpha', authentication: 'serviceAccountKey', keyFile, location: 'EU', maximumBytesBilled: 1024, environment: 'Production', color: '#112233' })
    expect(() => bigQueryFormOptions({ provider: 'bigquery', project: 'varia-alpha', authentication: 'serviceAccountKey' })).toThrow('This authentication needs a key file.')
    expect(() => bigQueryFormOptions({ provider: 'bigquery', project: 'varia-alpha', authentication: 'gcloud', dataset: 'sales-2024' })).toThrow('letters, numbers and underscores')
  })
  it('lists each project once across pages, sorted, up to the cap', () => {
    const merged = mergeProjects([{ id: 'varia-beta' }], [{ id: 'varia-alpha', friendlyName: 'Alpha' }, { id: 'varia-beta', friendlyName: 'Later spelling' }])
    expect(merged).toEqual([{ id: 'varia-alpha', friendlyName: 'Alpha' }, { id: 'varia-beta' }])
    const many = Array.from({ length: maxListedProjects + 5 }, (_, index) => ({ id: `varia-${String(index).padStart(6, '0')}` }))
    expect(mergeProjects([], many)).toHaveLength(maxListedProjects)
  })
  it('shows Maximum bytes billed in the largest whole binary unit and reads it back', () => {
    expect(splitBytes(undefined)).toEqual({ amount: '', unit: 'GiB' })
    expect(splitBytes(500 * 2 ** 30)).toEqual({ amount: '500', unit: 'GiB' })
    expect(splitBytes(2 * 2 ** 40)).toEqual({ amount: '2', unit: 'TiB' })
    expect(splitBytes(3 * 2 ** 20)).toEqual({ amount: '3', unit: 'MiB' })
    expect(splitBytes(1000)).toEqual({ amount: '1', unit: 'MiB' })
    expect(joinBytes('', 'GiB')).toEqual({ ok: true })
    expect(joinBytes('1.5', 'GiB')).toEqual({ ok: true, bytes: 1.5 * 2 ** 30 })
    expect(joinBytes('ten', 'GiB').ok).toBe(false)
    expect(joinBytes('0', 'MiB').ok).toBe(false)
    expect(joinBytes('99999999999', 'TiB').ok).toBe(false)
  })
  it('reads extra projects as typed: each once, never the billing project, at most sixteen', () => {
    expect(parseExtraProjects('varia-beta, varia-gamma\nvaria-beta varia-alpha', 'varia-alpha')).toEqual({ ok: true, projects: ['varia-beta', 'varia-gamma'] })
    expect(parseExtraProjects('varia-beta Not_A_Project', 'varia-alpha')).toEqual({ ok: false, error: 'Not_A_Project is not a Google Cloud project id.' })
    const seventeen = Array.from({ length: 17 }, (_, index) => `varia-extra-${index}`).join(' ')
    expect(parseExtraProjects(seventeen, 'varia-alpha').ok).toBe(false)
  })
  it('describes a saved BigQuery entry by engine, dataset and sign-in, with the key file by name only', () => {
    const profile = { options: { provider: 'bigquery' as const, project: 'varia-alpha', dataset: 'sales', authentication: 'serviceAccountKey' as const, keyFile }, keyFileName: 'reader.json' }
    expect(bigQueryRowDetail(profile)).toBe('BigQuery · sales · Service account key file (reader.json)')
    expect(bigQueryRowDetail({ options: { provider: 'bigquery', project: 'varia-alpha', authentication: 'gcloud' } })).toBe('BigQuery · <no default dataset> · gcloud credentials (ADC)')
    expect(bigQueryRowText(profile)).toContain('reader.json')
    expect(serverOf(profile.options)).toBe('varia-alpha')
    expect(serverOf({ server: 'sql01', database: '', authentication: 'windows', trustServerCertificate: false })).toBe('sql01')
  })
  it('summarises Advanced and the account line', () => {
    expect(bigQueryAdvancedSummary({ ...bigQueryDefaults(), project: 'varia-alpha' })).toBe('')
    expect(bigQueryAdvancedSummary({ ...bigQueryDefaults(), project: 'varia-alpha', maximumBytesBilled: 1, extraProjects: ['varia-beta'] })).toBe('2 properties set')
    // Don't ask again counts as a property set; the prompt left on (or turned back on) does not.
    expect(bigQueryAdvancedSummary({ ...bigQueryDefaults(), project: 'varia-alpha', costPrompt: false })).toBe('1 property set')
    expect(bigQueryAdvancedSummary({ ...bigQueryDefaults(), project: 'varia-alpha', costPrompt: true })).toBe('')
    // The form sends the choice when it names one, so Connect keeps or clears the saved entry's.
    expect(bigQueryFormOptions({ provider: 'bigquery', project: 'varia-alpha', authentication: 'gcloud', costPrompt: false })).toMatchObject({ costPrompt: false })
    expect(bigQueryFormOptions({ provider: 'bigquery', project: 'varia-alpha', authentication: 'gcloud' })).not.toHaveProperty('costPrompt')
  })
  it("shows the saved entry's cost-prompt choice and names one only when Advanced Properties changes it", () => {
    const form = { provider: 'bigquery', project: 'varia-alpha', authentication: 'gcloud' } as const
    // The dialog's form never starts with a choice: a remembered true from an earlier connect cannot undo a later opt-out.
    expect(withoutCostPrompt({ ...form, costPrompt: true })).toEqual(form)
    const entries = [{ options: { ...form, dataset: 'other' } }, { options: { ...form, costPrompt: false as const } }]
    expect(savedCostPrompt(entries, form)).toBe(false)
    expect(savedCostPrompt(entries, { ...form, project: 'varia-beta' })).toBeUndefined()
    // Saved off, the box shows off: ticking it names true (turns the prompt back on); OK unchanged names nothing.
    expect(advancedCostPrompt(form, false, true)).toBe(true)
    expect(advancedCostPrompt(form, false, false)).toBeUndefined()
    // Saved on: unticking names false; left ticked names nothing, so the saved entry's choice stands.
    expect(advancedCostPrompt(form, undefined, false)).toBe(false)
    expect(advancedCostPrompt(form, undefined, true)).toBeUndefined()
    // A change made earlier in this dialog stays when OK leaves the box as it shows.
    expect(advancedCostPrompt({ ...form, costPrompt: true }, false, true)).toBe(true)
    expect(accountText({ kind: 'user', account: 'ada@example.com' })).toBe('Signed in to gcloud as ada@example.com')
    expect(accountText({ kind: 'serviceAccount', account: 'reader@varia-alpha.iam.gserviceaccount.com', impersonated: 'etl@varia-alpha.iam.gserviceaccount.com' }))
      .toBe('Service account reader@varia-alpha.iam.gserviceaccount.com, acting as etl@varia-alpha.iam.gserviceaccount.com')
  })
})
