// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ComponentProps } from 'react'
import { createRoot } from 'react-dom/client'
import ConnectDialog from '../src/renderer/src/ConnectDialog'
import { WorkbenchProvider } from '../src/renderer/src/core/WorkbenchContext'
import type { Workbench } from '../src/renderer/src/core/workbench'
import type { ConnectionLibrary } from '../src/shared/connections'
import type { BigQueryConnectionOptions, ProviderConnectionOptions, VariaApi } from '../src/shared/contracts'
import type { BigQueryConnectionProfile, BigQueryProfileInput } from '../src/shared/bigquery-connections'
import { connectionDefaults } from '../src/shared/connections'
import { readyBackend, workbenchFixture } from './fixtures/workbench'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).reverse().forEach(cleanup => cleanup()); vi.restoreAllMocks() })
const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`
const keyFile = '6f0c2b8e-4d1a-4c3b-9e2f-1a2b3c4d5e6f'

async function mount(setup: { initial?: ProviderConnectionOptions; bigQuery?: BigQueryConnectionProfile[]; sqlLastConnected?: string } = {}) {
  const workbench = workbenchFixture(), host = document.body.appendChild(document.createElement('div')), root = createRoot(host)
  workbench.api.push(readyBackend())
  let bigQuery: BigQueryConnectionProfile[] = setup.bigQuery ?? []
  const sql: ConnectionLibrary = { version: 1, profiles: setup.sqlLastConnected ? [{ id: id(9), options: { ...connectionDefaults('win32'), server: 'sql01' }, favorite: false, registered: false, lastConnected: setup.sqlLastConnected }] : [] }
  const api = {
    loadConnectionLibrary: vi.fn<VariaApi['loadConnectionLibrary']>(async () => ({ ok: true, value: { library: sql, savedPasswords: [], windowsIdentity: 'DOMAIN\\reader', passwordStorage: { available: true }, bigQuery: { profiles: bigQuery } } })),
    saveConnectionProfile: vi.fn<VariaApi['saveConnectionProfile']>(async value => {
      const input = value as BigQueryProfileInput, existing = bigQuery.find(profile => profile.id === input.id)
      const saved: BigQueryConnectionProfile = { id: existing?.id ?? id(70), options: input.options, favorite: input.favorite ?? existing?.favorite ?? false, ...input.saved ? { saved: true } : {}, autoReconnect: input.autoReconnect }
      bigQuery = existing ? bigQuery.map(profile => profile === existing ? saved : profile) : [...bigQuery, saved]
      return { ok: true, value: { library: sql, savedPasswords: [], bigQuery: { profiles: bigQuery } } }
    }),
    removeConnectionProfile: vi.fn<VariaApi['removeConnectionProfile']>(async value => { bigQuery = bigQuery.filter(profile => profile.id !== value); return { ok: true, value: { library: sql, savedPasswords: [], bigQuery: { profiles: bigQuery } } } }),
    bigQueryAccount: vi.fn<VariaApi['bigQueryAccount']>(async () => ({ ok: true, value: { kind: 'user', account: 'ada@example.com' } })),
    bigQueryProjects: vi.fn<VariaApi['bigQueryProjects']>(async params => params.pageToken
      ? { ok: true, value: { projects: [{ id: 'varia-gamma' }] } }
      : { ok: true, value: { projects: [{ id: 'varia-beta', friendlyName: 'Beta' }, { id: 'varia-alpha', friendlyName: 'Alpha' }], nextPageToken: 'page-2' } }),
    pickKeyFile: vi.fn<VariaApi['pickKeyFile']>(async () => ({ ok: true, value: { keyFile, name: 'reader.json' } })),
    confirmFederationSource: vi.fn<VariaApi['confirmFederationSource']>(async () => ({ ok: true, value: undefined })),
    discoverDatabases: vi.fn<VariaApi['discoverDatabases']>(async () => ({ ok: true, value: [{ name: 'sales', isSystem: false, isSnapshot: false, location: 'EU' }, { name: 'staging', isSystem: false, isSnapshot: false }] }))
  }
  workbench.api.connect.mockImplementation(async (value, context) => {
    const options = value as BigQueryConnectionOptions
    return { ok: true, value: { id: id(100), targetId: context!.targetId, server: options.project, database: options.dataset ?? '', generation: 1, serverVersion: 'BigQuery', login: 'ada@example.com', providerId: 'bigquery', principalId: 'bigquery:user:ada@example.com',
      authentication: { principal: { provider: 'bigquery', project: options.project, principal: 'bigquery:user:ada@example.com' } } } }
  })
  const original = Object.getOwnPropertyDescriptor(window, 'varia')
  Object.defineProperty(window, 'varia', { configurable: true, value: { ...workbench.api, ...api } })
  const onConnected = vi.fn<ComponentProps<typeof ConnectDialog>['onConnected']>(async () => {}), onClose = vi.fn()
  const theme = { ...workbench.theme, getSnapshot: () => workbench.theme.state, subscribe: () => () => {}, accent: (color?: string) => color }
  const renderer = { ...workbench, platform: 'win32', theme } as unknown as Workbench
  await act(async () => root.render(createElement(WorkbenchProvider, { workbench: renderer, children: createElement(ConnectDialog, { initial: setup.initial ?? connectionDefaults('win32'), onConnected, onClose }) })))
  cleanups.push(() => {
    act(() => root.unmount()); workbench.dispose(); host.remove()
    if (original) Object.defineProperty(window, 'varia', original)
    else Reflect.deleteProperty(window, 'varia')
  })
  const $ = <T extends Element>(selector: string) => host.querySelector<T>(selector)
  const button = (label: string) => {
    const found = [...document.body.querySelectorAll('button')].find(value => value.textContent?.trim() === label || value.getAttribute('aria-label') === label)
    if (!found) throw new Error('Missing button: ' + label)
    return found
  }
  const click = async (label: string) => { await act(async () => button(label).click()) }
  const set = async (selector: string, value: string) => {
    const element = $<HTMLInputElement | HTMLSelectElement>(selector)!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype, 'value')!.set!
      setter.call(element, value)
      element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
    })
  }
  const serverType = () => $<HTMLButtonElement>('[data-server-type][aria-pressed="true"]')?.dataset.serverType
  const setServerType = async (type: 'sqlserver' | 'bigquery') => { await act(async () => $<HTMLButtonElement>(`[data-server-type="${type}"]`)!.click()) }
  return { ...workbench, host, $, button, click, set, serverType, setServerType, api, connect: workbench.api.connect, onConnected, onClose, library: () => bigQuery, text: () => document.body.textContent ?? '' }
}

describe('Connect dialog: BigQuery', () => {
  it('swaps the field block for BigQuery, keeps each type\'s fields across switches, and Undo restores the previous type', async () => {
    const view = await mount()
    await view.set('#connect-server', 'sql01.example')
    await view.setServerType('bigquery')
    expect(view.$('#connect-server')).toBeNull()
    expect(view.$('#connect-bq-project')).not.toBeNull()
    // Encrypt, TLS, SqlClient's Advanced Properties and the connection string are SQL Server's.
    for (const selector of ['#connect-encrypt', '#connect-hostname']) expect(view.$(selector), selector).toBeNull()
    expect([...view.host.querySelectorAll('[role="tab"]')].map(tab => tab.textContent)).not.toContain('Connection String')
    await view.set('#connect-bq-project', 'varia-alpha')
    await view.click('Undo')
    expect(view.serverType()).toBe('sqlserver')
    expect(view.$<HTMLInputElement>('#connect-server')!.value).toBe('sql01.example')
    await view.setServerType('bigquery')
    expect(view.$<HTMLInputElement>('#connect-bq-project')!.value).toBe('varia-alpha')
    // Undo is offered only for the switch just made.
    await view.click('Undo')
    expect(() => view.button('Undo')).toThrow('Missing button')
  })

  it('opens with the type used last, and shows the account gcloud signs in as', async () => {
    const profile: BigQueryConnectionProfile = { id: id(1), options: { provider: 'bigquery', project: 'varia-alpha', authentication: 'gcloud' }, favorite: false, lastConnected: '2026-11-10T10:00:00.000Z' }
    const view = await mount({ bigQuery: [profile], sqlLastConnected: '2026-11-09T10:00:00.000Z' })
    expect(view.serverType()).toBe('bigquery')
    await vi.waitFor(() => expect(view.host.querySelector('.bq-account')?.textContent).toContain('Signed in to gcloud as ada@example.com'))
    expect(view.api.bigQueryAccount).toHaveBeenLastCalledWith({ authentication: 'gcloud' })
  })

  it('asks Google nothing while SQL Server shows: the account line is read once BigQuery is chosen', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    cleanups.push(() => vi.useRealTimers())
    const view = await mount()
    // Past the account line's 250 ms debounce, with timers under the test's control (no real wait).
    const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    await settle()
    expect(view.api.bigQueryAccount).not.toHaveBeenCalled()
    await view.setServerType('bigquery')
    await settle()
    expect(view.api.bigQueryAccount).toHaveBeenCalledTimes(1)
    await view.click('Undo')
    await settle()
    expect(view.api.bigQueryAccount).toHaveBeenCalledTimes(1)
  })

  it('says why the account could not be read and checks again on request', async () => {
    const view = await mount({ initial: { provider: 'bigquery', project: '', authentication: 'gcloud' } })
    view.api.bigQueryAccount.mockResolvedValueOnce({ ok: false, error: 'No Google credentials were found. Run gcloud auth application-default login to sign in, or choose a service account key.', code: 'AUTH_EXPIRED' })
    await vi.waitFor(() => expect(view.host.querySelector('.bq-account')?.textContent).toContain('gcloud auth application-default login'))
    await view.click('Check again')
    await vi.waitFor(() => expect(view.host.querySelector('.bq-account')?.textContent).toContain('ada@example.com'))
  })

  it('picks a key file through main, naming it by file name only, and asks about a federation token file first', async () => {
    const view = await mount({ initial: { provider: 'bigquery', project: 'varia-alpha', authentication: 'gcloud' } })
    await view.set('#connect-bq-auth', 'serviceAccountKey')
    expect(view.button('Connect').disabled).toBe(true)
    await view.click('Browse…')
    expect(view.api.pickKeyFile).toHaveBeenCalledWith('serviceAccountKey')
    expect(view.$<HTMLInputElement>('#connect-bq-keyfile')!.value).toBe('reader.json')
    await vi.waitFor(() => expect(view.api.bigQueryAccount).toHaveBeenLastCalledWith({ authentication: 'serviceAccountKey', keyFile }))
    expect(view.button('Connect').disabled).toBe(false)
    // Another mode's file is not this one's.
    await view.set('#connect-bq-auth', 'externalAccount')
    expect(view.$<HTMLInputElement>('#connect-bq-keyfile')!.value).toBe('')
    view.api.pickKeyFile.mockResolvedValueOnce({ ok: true, value: { keyFile, name: 'federation.json', source: '/var/run/token', sourceConfirmed: false } })
    await view.click('Browse…')
    expect(view.text()).toContain('/var/run/token')
    expect(view.$<HTMLInputElement>('#connect-bq-keyfile')!.value).toBe('')
    await view.click('Use It')
    expect(view.api.confirmFederationSource).toHaveBeenCalledWith(keyFile, '/var/run/token')
    expect(view.$<HTMLInputElement>('#connect-bq-keyfile')!.value).toBe('federation.json')
    // A confirmed source does not ask again; Cancel on an unconfirmed one keeps no file.
    await view.set('#connect-bq-auth', 'serviceAccountKey')
    await view.set('#connect-bq-auth', 'externalAccount')
    view.api.pickKeyFile.mockResolvedValueOnce({ ok: true, value: { keyFile, name: 'federation.json', source: '/var/run/other', sourceConfirmed: false } })
    await view.click('Browse…')
    const prompt = [...document.querySelectorAll<HTMLButtonElement>('.sub-dialog button')].find(value => value.textContent?.trim() === 'Cancel')!
    await act(async () => prompt.click())
    expect(document.querySelector('.sub-dialog')).toBeNull()
    expect(view.onClose).not.toHaveBeenCalled()
    expect(view.$<HTMLInputElement>('#connect-bq-keyfile')!.value).toBe('')
    expect(view.api.confirmFederationSource).toHaveBeenCalledTimes(1)
  })

  it('lists projects across pages for the Project combo and Browse, and the project\'s datasets with their locations', async () => {
    const view = await mount({ initial: { provider: 'bigquery', project: '', authentication: 'gcloud' } })
    await view.click('Load projects')
    await vi.waitFor(() => expect([...view.host.querySelectorAll('#bq-projects option')].map(option => (option as HTMLOptionElement).value)).toEqual(['varia-alpha', 'varia-beta', 'varia-gamma']))
    expect(view.api.bigQueryProjects).toHaveBeenLastCalledWith({ authentication: 'gcloud', pageToken: 'page-2' })
    await view.click('Browse')
    const beta = [...view.host.querySelectorAll<HTMLButtonElement>('.discovered-server')].find(row => row.textContent?.includes('varia-beta'))!
    await act(async () => beta.click())
    expect(view.$<HTMLInputElement>('#connect-bq-project')!.value).toBe('varia-beta')
    await view.click('Load datasets')
    expect(view.api.discoverDatabases).toHaveBeenLastCalledWith({ provider: 'bigquery', project: 'varia-beta', authentication: 'gcloud' }, expect.objectContaining({ requestId: expect.any(String) }))
    await vi.waitFor(() => expect([...view.host.querySelectorAll('#bq-datasets option')].map(option => (option as HTMLOptionElement).value)).toEqual(['sales', 'staging']))
    await view.set('#connect-bq-dataset', 'sales')
    expect(view.host.textContent).toContain('sales is in EU.')
  })

  it('connects through the connection owner with BigQuery\'s options and no password, then hands the receipt on', async () => {
    const view = await mount({ initial: { provider: 'bigquery', project: 'varia-alpha', authentication: 'gcloud' } })
    await view.set('#connect-bq-dataset', 'sales')
    await view.set('#connect-bq-location', 'EU')
    await view.click('Connect')
    const [options, context] = view.connect.mock.calls[0]!
    expect(options).toEqual({ provider: 'bigquery', project: 'varia-alpha', authentication: 'gcloud', dataset: 'sales', location: 'EU' })
    expect(context).toMatchObject({ mode: 'interactive', credentialIntent: 'preserve', targetId: expect.any(String) })
    expect(context).not.toHaveProperty('remember')
    expect(context).not.toHaveProperty('profileId')
    expect(view.onConnected).toHaveBeenCalledWith(expect.objectContaining({ providerId: 'bigquery', server: 'varia-alpha' }), options, 'inherit', expect.anything(), expect.any(String), expect.anything(), [])
    expect(view.connectionTargets.getSnapshot()[0]?.options).toMatchObject({ provider: 'bigquery', project: 'varia-alpha' })
  })

  it('sets the cost cap, impersonation and extra projects in Advanced', async () => {
    const view = await mount({ initial: { provider: 'bigquery', project: 'varia-alpha', authentication: 'gcloud' } })
    await view.click('Advanced')
    await view.set('#bq-max-bytes', '500')
    await view.set('#bq-impersonate', 'etl@varia-alpha.iam.gserviceaccount.com')
    await view.set('#bq-extra-project', 'bigquery-public-data')
    await view.click('Add')
    expect(view.button('Advanced (3 set)').querySelector('.connect-tab-badge')?.textContent).toBe('3')
    await view.click('Connect')
    expect(view.connect.mock.calls[0]![0]).toMatchObject({ maximumBytesBilled: 500 * 2 ** 30, impersonateServiceAccount: 'etl@varia-alpha.iam.gserviceaccount.com', extraProjects: ['bigquery-public-data'] })
  })

  it('lists BigQuery entries in History beside SQL Server\'s: choose, favourite, save and remove', async () => {
    const profile: BigQueryConnectionProfile = { id: id(1), options: { provider: 'bigquery', project: 'varia-alpha', dataset: 'sales', authentication: 'serviceAccountKey', keyFile }, favorite: false, lastConnected: '2026-11-10T10:00:00.000Z', keyFileName: 'reader.json' }
    const view = await mount({ bigQuery: [profile] })
    const row = [...view.host.querySelectorAll<HTMLButtonElement>('.connection-choice')].find(value => value.textContent?.includes('varia-alpha'))!
    expect(row.textContent).toContain('BigQuery · sales · Service account key file (reader.json)')
    await act(async () => row.click())
    expect(view.serverType()).toBe('bigquery')
    expect(view.$<HTMLInputElement>('#connect-bq-keyfile')!.value).toBe('reader.json')
    await view.click('Favorite varia-alpha')
    expect(view.api.saveConnectionProfile).toHaveBeenLastCalledWith(expect.objectContaining({ id: profile.id, favorite: true, options: profile.options }))
    await view.set('#connect-bq-dataset', 'staging')
    await view.click('Save')
    expect(view.api.saveConnectionProfile).toHaveBeenLastCalledWith(expect.objectContaining({ id: profile.id, saved: true, options: { ...profile.options, dataset: 'staging' } }))
    expect(view.host.textContent).toContain('Saved to History.')
    await view.click('Remove saved varia-alpha')
    expect(view.api.removeConnectionProfile).toHaveBeenCalledWith(profile.id)
    expect(view.library()).toEqual([])
  })

  it('asks before closing a new BigQuery connection that was filled in and never saved', async () => {
    const view = await mount({ initial: { provider: 'bigquery', project: '', authentication: 'gcloud' } })
    await view.set('#connect-bq-project', 'varia-alpha')
    await view.click('Cancel')
    expect(view.text()).toContain('Save varia-alpha to History?')
    expect(view.onClose).not.toHaveBeenCalled()
    await view.click("Don't Save")
    expect(view.onClose).toHaveBeenCalled()
  })

  it('keeps Reconnect on startup per type across a switch and Undo', async () => {
    const profile: BigQueryConnectionProfile = { id: id(1), options: { provider: 'bigquery', project: 'varia-alpha', authentication: 'gcloud' }, favorite: false, lastConnected: '2026-11-10T10:00:00.000Z', autoReconnect: 'off' }
    const view = await mount({ bigQuery: [profile], sqlLastConnected: '2026-11-11T10:00:00.000Z' })
    expect(view.serverType()).toBe('sqlserver')
    await view.set('#connect-auto-reconnect', 'on')
    const row = [...view.host.querySelectorAll<HTMLButtonElement>('.connection-choice')].find(value => value.textContent?.includes('varia-alpha'))!
    await act(async () => row.click())
    expect(view.$<HTMLSelectElement>('#connect-auto-reconnect')!.value).toBe('off')
    // Reset clears the shown type's value only.
    await view.click('Reset')
    expect(view.$<HTMLSelectElement>('#connect-auto-reconnect')!.value).toBe('inherit')
    await view.click('Undo')
    expect(view.serverType()).toBe('sqlserver')
    expect(view.$<HTMLSelectElement>('#connect-auto-reconnect')!.value).toBe('on')
  })

  it('asks about unsaved edits in the type not shown before closing, showing that type', async () => {
    const view = await mount()
    await view.set('#connect-server', 'sql02.example')
    await view.setServerType('bigquery')
    await view.click('Cancel')
    expect(view.text()).toContain('Save sql02.example to History?')
    expect(view.serverType()).toBe('sqlserver')
    expect(view.onClose).not.toHaveBeenCalled()
    await view.click("Don't Save")
    expect(view.onClose).toHaveBeenCalledTimes(1)
  })

  it('disables Connect when BigQuery Advanced validation fails and re-enables once fixed', async () => {
    const view = await mount({ initial: { provider: 'bigquery', project: 'varia-alpha', authentication: 'gcloud' } })
    await view.click('Advanced')
    await view.set('#bq-max-bytes', '-5')
    expect(view.button('Connect').disabled).toBe(true)
    expect(view.button('Save').disabled).toBe(true)
    await view.set('#bq-max-bytes', '100')
    expect(view.button('Connect').disabled).toBe(false)
  })

  it('keeps BigQuery Advanced validation errors and invalid drafts across tab switches instead of connecting with a prefix', async () => {
    const view = await mount({ initial: { provider: 'bigquery', project: 'varia-alpha', authentication: 'gcloud' } })
    await view.click('Advanced')
    // Typing a valid prefix followed by an invalid suffix must keep Connect disabled even after switching tabs.
    await view.set('#bq-impersonate', 'svc@proj.iam')
    await view.set('#bq-impersonate', 'svc@proj.iam.')
    expect(view.button('Connect').disabled).toBe(true)
    await view.click('Connection Properties')
    expect(view.button('Connect').disabled).toBe(true)
    expect(view.button('Save').disabled).toBe(true)
    expect(view.button('Test Connection').disabled).toBe(true)
    expect(view.host.querySelector('.connect-outcome')?.textContent).toContain('service account as its email address')
    await view.click('Advanced (1 set)')
    expect(view.$<HTMLInputElement>('#bq-impersonate')!.value).toBe('svc@proj.iam.')
    await view.set('#bq-impersonate', 'svc@proj.iam.gserviceaccount.com')
    expect(view.button('Connect').disabled).toBe(false)
  })

  it('does not rewrite Maximum bytes billed amount or unit while typing', async () => {
    const view = await mount({ initial: { provider: 'bigquery', project: 'varia-alpha', authentication: 'gcloud' } })
    await view.click('Advanced')
    await view.set('#bq-max-bytes', '1024')
    expect(view.$<HTMLInputElement>('#bq-max-bytes')!.value).toBe('1024')
    expect(view.$<HTMLSelectElement>('.bq-unit')!.value).toBe('GiB')
    await view.set('#bq-max-bytes', '0.5')
    expect(view.$<HTMLInputElement>('#bq-max-bytes')!.value).toBe('0.5')
    expect(view.$<HTMLSelectElement>('.bq-unit')!.value).toBe('GiB')
    await view.set('#bq-max-bytes', '1.3')
    expect(view.$<HTMLInputElement>('#bq-max-bytes')!.value).toBe('1.3')
    expect(view.$<HTMLSelectElement>('.bq-unit')!.value).toBe('GiB')
  })

  it('preserves pending Extra projects text across tab switches and includes it on Save/Connect', async () => {
    const view = await mount({ initial: { provider: 'bigquery', project: 'varia-alpha', authentication: 'gcloud' } })
    await view.click('Advanced')
    await view.set('#bq-extra-project', 'bigquery-public-data')
    await view.click('Connection Properties')
    await view.click('Advanced')
    expect(view.$<HTMLInputElement>('#bq-extra-project')!.value).toBe('bigquery-public-data')
    await view.click('Connect')
    expect(view.connect.mock.calls[0]![0]).toMatchObject({ extraProjects: ['bigquery-public-data'] })
  })

  it("shows the saved entry's own Prompt above threshold for a live connection's settings, and names one only when changed", async () => {
    const options = { provider: 'bigquery', project: 'varia-alpha', authentication: 'gcloud' } as const
    const profile: BigQueryConnectionProfile = { id: id(3), options: { ...options, costThreshold: 50 }, favorite: false, lastConnected: '2026-11-10T10:00:00.000Z' }
    // Opened on a live connection's settings, which never carry the threshold: the field shows the saved entry's.
    const view = await mount({ initial: options, bigQuery: [profile] })
    await view.click('Advanced (1 set)')
    const field = () => view.$<HTMLInputElement>('#bq-cost-threshold')!
    expect(field().value).toBe('50')
    expect(field().placeholder).toBe('Options default (10 GiB)')
    // Left as it shows, Connect names none, so the saved one stands.
    await view.click('Connect')
    expect(view.connect.mock.calls.at(-1)![0]).not.toHaveProperty('costThreshold')
    // Out of range: an alert, and nothing named.
    await view.set('#bq-cost-threshold', '0')
    expect(view.text()).toContain('Enter Prompt above as a whole number of GiB')
    expect(field().getAttribute('aria-invalid')).toBe('true')
    await view.set('#bq-cost-threshold', '20')
    expect(view.text()).not.toContain('Enter Prompt above')
    await view.click('Connect')
    expect(view.connect.mock.calls.at(-1)![0]).toMatchObject({ costThreshold: 20 })
    // Emptied: back to the Options threshold (0 clears the saved one).
    await view.set('#bq-cost-threshold', '')
    expect(view.button('Advanced').textContent).not.toContain('set')
    await view.click('Connect')
    expect(view.connect.mock.calls.at(-1)![0]).toMatchObject({ costThreshold: 0 })
  })

  it('does not ask on Cancel when Prompt above is typed back to the saved threshold', async () => {
    const alpha = { provider: 'bigquery', project: 'varia-alpha', authentication: 'gcloud' } as const
    const profiles: BigQueryConnectionProfile[] = [
      { id: id(4), options: { ...alpha, costThreshold: 50 }, favorite: false, lastConnected: '2026-11-10T10:00:00.000Z' },
      { id: id(5), options: { ...alpha, project: 'varia-beta', costThreshold: 100 }, favorite: false, lastConnected: '2026-11-09T10:00:00.000Z' }
    ]
    const view = await mount({ initial: alpha, bigQuery: profiles })
    await view.click('Advanced (1 set)')
    // Typed back to the saved value: no change, so closing does not ask.
    await view.set('#bq-cost-threshold', '5')
    await view.set('#bq-cost-threshold', '50')
    await view.click('Cancel')
    expect(view.onClose).toHaveBeenCalled()
  })
  it('sends what Prompt above shows after the settings change to another entry with its own saved threshold', async () => {
    const alpha = { provider: 'bigquery', project: 'varia-alpha', authentication: 'gcloud' } as const
    const profiles: BigQueryConnectionProfile[] = [
      { id: id(4), options: { ...alpha, costThreshold: 50 }, favorite: false, lastConnected: '2026-11-10T10:00:00.000Z' },
      { id: id(5), options: { ...alpha, project: 'varia-beta', costThreshold: 100 }, favorite: false, lastConnected: '2026-11-09T10:00:00.000Z' }
    ]
    const second = await mount({ initial: alpha, bigQuery: profiles })
    await second.click('Advanced (1 set)')
    await second.set('#bq-cost-threshold', '5')
    await second.set('#bq-cost-threshold', '50')
    // Now the settings become varia-beta's (saved 100): the field still shows 50, and Connect sends 50, not nothing.
    await second.click('Connection Properties')
    await second.set('#connect-bq-project', 'varia-beta')
    await second.click('Advanced (1 set)')
    expect(second.$<HTMLInputElement>('#bq-cost-threshold')!.value).toBe('50')
    await second.click('Connect')
    expect(second.connect.mock.calls.at(-1)![0]).toMatchObject({ project: 'varia-beta', costThreshold: 50 })
  })

  it("resets BigQuery cost prompt back to asking when Reset Advanced runs on a saved Don't ask again entry", async () => {
    const profile: BigQueryConnectionProfile = {
      id: id(2),
      options: { provider: 'bigquery', project: 'varia-alpha', authentication: 'gcloud', costPrompt: false, maximumBytesBilled: 50 * 2 ** 30, costThreshold: 40 },
      favorite: false, lastConnected: '2026-11-10T10:00:00.000Z'
    }
    const view = await mount({ bigQuery: [profile] })
    const connectedWith = vi.spyOn(view.bigQueryCost as unknown as { connectedWith: (options: unknown, saved?: boolean) => void }, 'connectedWith')
    const row = [...view.host.querySelectorAll<HTMLButtonElement>('.connection-choice')].find(value => value.textContent?.includes('varia-alpha'))!
    await act(async () => row.click())
    await view.click('Advanced (3 set)')
    expect(view.$<HTMLInputElement>('#bq-cost-threshold')!.value).toBe('40')
    const box = () => [...view.host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(input => input.parentElement?.textContent?.includes('cost threshold'))!
    expect(box().checked).toBe(false)
    await view.click('Reset Advanced')
    expect(box().checked).toBe(true)
    expect(view.$<HTMLInputElement>('#bq-max-bytes')!.value).toBe('')
    expect(view.$<HTMLInputElement>('#bq-cost-threshold')!.value).toBe('')
    await view.click('Save')
    expect(view.api.saveConnectionProfile).toHaveBeenLastCalledWith(expect.objectContaining({ options: expect.objectContaining({ costPrompt: true, costThreshold: 0 }) }))
    // A live connection with these settings follows what Save named at once.
    expect(connectedWith).toHaveBeenLastCalledWith(expect.objectContaining({ costPrompt: true, costThreshold: 0 }), true)
  })
})
