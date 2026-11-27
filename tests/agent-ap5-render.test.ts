// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import type { ActionDescribeResult } from '../src/shared/actions/schema'
import { notifyEmail, type AgentAlertDocumentModel } from '../src/shared/actions/agent-alert'
import type { AgentOperatorDocumentModel, AgentOperatorsModel } from '../src/shared/actions/agent-operator'
import { initialAgentPropertiesDraft, type AgentPropertiesModel } from '../src/shared/actions/agent-properties'
import type { AgentProxyDocumentModel, CredentialDocumentModel } from '../src/shared/actions/agent-proxy'
import AlertDocument from '../src/renderer/src/agent/AlertDocument'
import CredentialDocument from '../src/renderer/src/agent/CredentialDocument'
import OperatorDocument from '../src/renderer/src/agent/OperatorDocument'
import OperatorsDocument from '../src/renderer/src/agent/OperatorsDocument'
import ProxyDocument from '../src/renderer/src/agent/ProxyDocument'
import { WorkbenchProvider } from '../src/renderer/src/core/WorkbenchContext'
import type { Workbench } from '../src/renderer/src/core/workbench'
import type { OpenObjectDialog } from '../src/renderer/src/dialogs/ObjectDialogService'
import { AgentGeneralPage, AgentHistoryPage } from '../src/renderer/src/dialogs/pages/AgentPropertiesPages'
import { connectionInfo, readyBackend, workbenchFixture } from './fixtures/workbench'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const settled = async () => { for (let turn = 0; turn < 10; turn++) await new Promise(resolve => setImmediate(resolve)) }
const cleanups: (() => void)[] = []
afterEach(() => {
  localStorage.clear()
  cleanups.splice(0).forEach(cleanup => cleanup())
})

async function mount(workbench: Workbench, element: ReturnType<typeof createElement>): Promise<HTMLElement> {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => { root.render(createElement(WorkbenchProvider, { workbench, children: element })) })
  cleanups.unshift(() => { act(() => root.unmount()); host.remove() })
  return host
}

const operatorsModel = (): AgentOperatorsModel => ({
  login: 'sa', sysadmin: true, platform: 'windows',
  operators: [
    { id: 9, name: 'DBA Team', enabled: true, email: 'dba@example.test', pager: 'pager@example.test', netSend: '', pagerDays: 127, weekday: { start: 80000, end: 180000 }, saturday: { start: 80000, end: 180000 }, sunday: { start: 80000, end: 180000 } },
    { id: 10, name: 'On Call', enabled: true, email: 'oncall@example.test', pager: '', netSend: '', pagerDays: 127, weekday: { start: 80000, end: 180000 }, saturday: { start: 80000, end: 180000 }, sunday: { start: 80000, end: 180000 } }
  ],
  alerts: [{ id: 7, name: 'Severity 017', enabled: true, kind: 'event', messageId: 0, severity: 17 }],
  notifications: [{ alertId: 7, operatorId: 9, methods: notifyEmail }],
  jobs: [{ id: '11111111-1111-1111-1111-111111111111', name: 'Nightly load', email: 'DBA Team', page: '', netSend: '' }],
  mail: { checked: true, xps: true, profiles: 1, sysadmin: true, useDatabaseMail: true, agentProfile: 'Ops' }
})

const alertModel = (existing = true): AgentAlertDocumentModel => ({
  ...existing ? {
    alert: {
      id: 7, name: 'Severity 017', enabled: true, kind: 'event', messageId: 0, severity: 17, database: '', keyword: '', condition: '',
      wmiNamespace: '', wmiQuery: '', jobId: '', jobName: '', delay: 60, includeIn: notifyEmail, message: '', occurrences: 2,
      lastOccurred: '2026-11-25T18:14:00', lastResponse: '2026-11-25T18:14:01'
    }
  } : {},
  login: 'sa', sysadmin: true, platform: 'windows',
  operators: [{ name: 'DBA Team', enabled: true, email: true, pager: false, netSend: false, pagerDays: 127, weekday: { start: 0, end: 235959 }, saturday: { start: 0, end: 235959 }, sunday: { start: 0, end: 235959 } }],
  notifications: existing ? [{ operator: 'DBA Team', methods: notifyEmail }] : [],
  jobs: [{ id: '11111111-1111-1111-1111-111111111111', name: 'Nightly load' }],
  databases: ['master', 'Sales'],
  mail: { checked: true, xps: true, profiles: 1, sysadmin: true, useDatabaseMail: true, agentProfile: 'Ops' }
})

const operatorModel = (existing = true): AgentOperatorDocumentModel => ({
  ...existing ? {
    operator: {
      id: 9, name: 'DBA Team', enabled: true, email: 'dba@example.test', pager: 'pager@example.test', netSend: '', pagerDays: 127,
      weekday: { start: 80000, end: 180000 }, saturday: { start: 80000, end: 180000 }, sunday: { start: 80000, end: 180000 },
      lastEmail: '2026-11-25T18:14:01'
    }
  } : {},
  login: 'sa', sysadmin: true, platform: 'windows',
  alerts: [{ id: 7, name: 'Severity 017', enabled: true, kind: 'event', messageId: 0, severity: 17 }],
  notifications: existing ? [{ alertId: 7, operatorId: 9, methods: notifyEmail }] : [],
  jobs: [{ id: '11111111-1111-1111-1111-111111111111', name: 'Nightly load', email: 'DBA Team', page: '', netSend: '' }],
  mail: { checked: true, xps: true, profiles: 1, sysadmin: true, useDatabaseMail: true, agentProfile: 'Ops' }
})

const proxyModel = (): AgentProxyDocumentModel => ({
  proxy: {
    id: 1, name: 'FileShareWriter', enabled: true, description: 'Writes extracts', credential: 'FileShareWriterCred',
    credentialIdentity: 'CONTOSO\\svc-fswriter', subsystems: [3, 12], principals: [{ name: 'CONTOSO\\etl', kind: 'login' }]
  },
  platform: 'windows',
  subsystems: [{ id: 3, name: 'CmdExec' }, { id: 11, name: 'SSIS' }, { id: 12, name: 'PowerShell' }],
  credentials: [{ name: 'FileShareWriterCred', identity: 'CONTOSO\\svc-fswriter' }],
  credentialsTruncated: false, canCreateCredential: true,
  principalChoices: [{ name: 'CONTOSO\\etl', kind: 'login' }, { name: 'SQLAgentOperatorRole', kind: 'msdbRole' }],
  references: [{ job: 'Nightly', stepId: 2, step: 'Copy extracts', subsystem: 'CmdExec' }],
  referencesTruncated: false
})

const credentialModel = (): CredentialDocumentModel => ({
  credential: { id: 65536, name: 'FileShareWriterCred', identity: 'CONTOSO\\svc-fswriter', created: '2025-03-02T10:20:00', modified: '2026-11-08T16:02:11.123' },
  platform: 'box', providers: [],
  usedBy: [{ proxy: 'FileShareWriter', subsystems: ['CmdExec', 'PowerShell'], steps: [{ job: 'Nightly', stepId: 2, step: 'Copy extracts' }] }],
  usedByTruncated: false
})

describe('AP-5 inspector and properties rendering', () => {
  it('renders OperatorsDocument on ObjectInspectorFrame with 2 fill tabs, ResizableSplit, FactGrid, and matrix dirty state', async () => {
    const fixture = workbenchFixture()
    cleanups.push(() => fixture.dispose())
    fixture.api.push(readyBackend())
    fixture.connect(connectionInfo('c1'))
    fixture.api.describeObject.mockImplementation(async () => ({ ok: true, value: { agentOperators: operatorsModel(), elapsedMs: 1 } as ActionDescribeResult }))
    const id = fixture.operatorsDocuments.open('c1', { kind: 'agent' })
    await settled()

    const host = await mount({ ...fixture, platform: 'win32' } as unknown as Workbench, createElement(OperatorsDocument, { documentId: id }))
    const tabs = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    expect(tabs.map(tab => tab.querySelector('.inspector-tab-label')?.textContent)).toEqual(['Alerts Matrix', 'Jobs Notifying Operators'])
    expect(tabs.map(tab => tab.querySelector('.inspector-tab-count')?.textContent)).toEqual(['1', '1'])

    const separator = host.querySelector<HTMLElement>('[role="separator"]')!
    expect(separator).not.toBeNull()
    expect(separator.getAttribute('aria-valuemin')).toBe('220')
    expect(separator.getAttribute('aria-valuemax')).toBe('400')
    expect(separator.getAttribute('aria-valuenow')).toBe('264')

    await act(async () => {
      separator.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    })
    expect(separator.getAttribute('aria-valuenow')).toBe('276')
    expect(localStorage.getItem('varia.split.agent.operators.side')).toBe('276')

    const sideFacts = host.querySelector('.agent-operators-side .fact-grid')
    expect(sideFacts?.textContent).toContain('dba@example.test')
    expect(sideFacts?.textContent).toContain('pager@example.test')
    expect(host.querySelectorAll('[aria-label="Operator DBA Team"]')).toHaveLength(1)
    expect(host.querySelector('.varia-split-rail')?.hasAttribute('role')).toBe(false)
    expect(host.querySelector('.agent-operators-side-actions')?.textContent).toContain('Open Operator')
    expect(host.querySelector('.agent-operators-side-actions')?.textContent).toContain('Send test e-mail')
    expect(host.querySelector('.agent-operators-side-actions')?.textContent).toContain('Delete & reassign…')

    const cell = host.querySelector<HTMLButtonElement>('[data-cell="0:1"]')!
    await act(async () => { cell.click() })
    expect(cell.closest('td')?.hasAttribute('data-changed')).toBe(true)
    expect(tabs[0].querySelector('.inspector-tab-dot')).not.toBeNull()

    await act(async () => { tabs[1].click() })
    expect(host.querySelector('[aria-label="Jobs that notify operators"]')?.textContent).toContain('Nightly load')
  })

  it('renders AlertDocument in one ObjectInspectorFrame flow tab with FactGrid and OperatorDocument in 3 tabs', async () => {
    const fixture = workbenchFixture()
    cleanups.push(() => fixture.dispose())
    fixture.api.push(readyBackend())
    fixture.connect(connectionInfo('c1'))
    fixture.api.describeObject.mockImplementation(async params => ({
      ok: true,
      value: (params.dialog === 'agentAlert'
        ? { agentAlertDocument: alertModel(params.target.kind === 'agentAlert'), elapsedMs: 1 }
        : { agentOperatorDocument: operatorModel(params.target.kind === 'agentOperator'), elapsedMs: 1 }) as ActionDescribeResult
    }))
    const newAlertId = fixture.alertDocuments.openNew('c1')
    const existingAlertId = fixture.alertDocuments.open('c1', { kind: 'agentAlert', name: 'Severity 017' })
    const newOperatorId = fixture.operatorDocuments.open('c1', { kind: 'agent' })
    const existingOperatorId = fixture.operatorDocuments.open('c1', { kind: 'agentOperator', name: 'DBA Team' })
    await settled()

    const newAlertHost = await mount({ ...fixture, platform: 'win32' } as unknown as Workbench, createElement(AlertDocument, { documentId: newAlertId }))
    expect(newAlertHost.querySelector('[data-agent-object-focus]')?.getAttribute('id')).toContain('-name')
    expect(newAlertHost.querySelector('.agent-alert-add > select[aria-label="Add an operator"]')).not.toBeNull()
    expect(newAlertHost.querySelector('.agent-alert-add > button')?.textContent).toContain('New operator')

    const existingAlertHost = await mount({ ...fixture, platform: 'win32' } as unknown as Workbench, createElement(AlertDocument, { documentId: existingAlertId }))
    const alertTabs = [...existingAlertHost.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    expect(alertTabs.map(tab => tab.querySelector('.inspector-tab-label')?.textContent)).toEqual(['Alert'])
    expect([...existingAlertHost.querySelectorAll('.agent-eyebrow')].map(el => el.textContent)).toEqual(['When', 'Then', 'Options', 'Activity'])
    expect(existingAlertHost.querySelector('.fact-grid')?.textContent).toContain('2026-11-25 18:14:00')
    expect(existingAlertHost.querySelector('[role="group"][aria-labelledby$="-includeIn-label"]')).not.toBeNull()
    expect(existingAlertHost.querySelector('.agent-alert-add > button')?.textContent).toContain('New operator')

    const newOpHost = await mount({ ...fixture, platform: 'win32' } as unknown as Workbench, createElement(OperatorDocument, { documentId: newOperatorId }))
    expect(newOpHost.querySelector('[data-agent-object-focus]')?.getAttribute('id')).toContain('-name')

    const existingOpHost = await mount({ ...fixture, platform: 'win32' } as unknown as Workbench, createElement(OperatorDocument, { documentId: existingOperatorId }))
    const opTabs = [...existingOpHost.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    expect(opTabs.map(tab => tab.querySelector('.inspector-tab-label')?.textContent)).toEqual(['General', 'Pager duty', 'Notifications'])
    expect(opTabs[2].querySelector('.inspector-tab-count')?.textContent).toBe('1')
    expect(existingOpHost.querySelector('.fact-grid')?.textContent).toContain('2026-11-25 18:14:01')

    await act(async () => { opTabs[1].click() })
    expect(existingOpHost.querySelector('[aria-label="Pager duty hours"]')).not.toBeNull()
    await act(async () => { opTabs[2].click() })
    expect(existingOpHost.querySelector('[aria-label="Alerts that notify this operator"]')).not.toBeNull()
  })

  it('keeps ProxyDocument and CredentialDocument PasswordField DOM state mounted across tab switches', async () => {
    const fixture = workbenchFixture()
    cleanups.push(() => fixture.dispose())
    fixture.api.push(readyBackend())
    fixture.connect(connectionInfo('c1'))
    fixture.api.describeObject.mockImplementation(async params => ({
      ok: true,
      value: (params.dialog === 'agentProxy'
        ? { agentProxyDocument: proxyModel(), elapsedMs: 1 }
        : { credentialDocument: credentialModel(), elapsedMs: 1 }) as ActionDescribeResult
    }))
    const proxyId = fixture.proxyDocuments.openProxy('c1', 'FileShareWriter')
    const credId = fixture.credentialDocuments.openCredential('c1', 'FileShareWriterCred')
    await settled()

    const proxyHost = await mount({ ...fixture, platform: 'win32' } as unknown as Workbench, createElement(ProxyDocument, { documentId: proxyId }))
    const proxyTabs = [...proxyHost.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    expect(proxyTabs.map(tab => tab.querySelector('.inspector-tab-label')?.textContent)).toEqual(['Proxy & Subsystems', 'Principals', 'References'])
    await act(async () => { fixture.proxyDocuments.setCredentialMode(proxyId, 'new') })
    const proxyPwd = proxyHost.querySelector<HTMLInputElement>('input.password-field')!
    proxyPwd.value = 'TempSecret-1'
    await act(async () => { proxyTabs[1].click() })
    expect(proxyHost.querySelector('[aria-label="Principals that may use the proxy"]')).not.toBeNull()
    expect(proxyHost.querySelector<HTMLInputElement>('input.password-field')?.value).toBe('TempSecret-1')
    await act(async () => { proxyTabs[2].click() })
    expect(proxyHost.querySelector('[aria-label="Job steps that run as this proxy"]')).not.toBeNull()
    await act(async () => { proxyTabs[0].click() })
    expect(proxyHost.querySelector<HTMLInputElement>('input.password-field')?.value).toBe('TempSecret-1')

    const credHost = await mount({ ...fixture, platform: 'win32' } as unknown as Workbench, createElement(CredentialDocument, { documentId: credId }))
    const credTabs = [...credHost.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    expect(credTabs.map(tab => tab.querySelector('.inspector-tab-label')?.textContent)).toEqual(['Credential', 'Used by'])
    const changeSwitch = credHost.querySelector<HTMLInputElement>('[role="switch"][data-credential-focus]')!
    expect(changeSwitch).not.toBeNull()
    expect(credHost.querySelector('.fact-grid')?.textContent).toContain('2025-03-02 10:20:00')
    await act(async () => { fixture.credentialDocuments.setChange(credId, true) })
    const credPwd = credHost.querySelector<HTMLInputElement>('input.password-field')!
    credPwd.value = 'CredSecret-2'
    await act(async () => { credTabs[1].click() })
    expect(credHost.querySelector('[aria-label="Proxies and job steps that use this credential"]')?.textContent).toContain('FileShareWriter')
    await act(async () => { credTabs[0].click() })
    expect(credHost.querySelector<HTMLInputElement>('input.password-field')?.value).toBe('CredSecret-2')
  })

  it('renders AgentPropertiesPages with RatioBar, Switch, FactGrid, and styled retention table', async () => {
    const propModel: AgentPropertiesModel = {
      settings: {
        sqlserverRestart: true, monitorAutostart: true, historyMaxRows: 1000, historyMaxRowsPerJob: 100,
        autoStart: true, startupAccount: 'NT Service\\SQLSERVERAGENT', errorLogFile: 'D:\\MSSQL\\Log\\SQLAGENT.OUT', errorLoggingLevel: 3
      },
      serverNow: '2026-11-26T14:30:00', serverOffsetMinutes: 0,
      history: {
        total: 984, recent: 700, jobsTruncated: false,
        jobs: [{ name: 'Backup', rows: 600, recent: 672 }, { name: 'Nightly', rows: 360, recent: 28 }],
        ages: [{ days: 0, rows: 120 }, { days: 3, rows: 350 }, { days: 30, rows: 400 }, { days: 90, rows: 114 }]
      }
    }
    const open = {
      id: 1, dialog: 'agentProperties', phase: 'ready', target: { kind: 'agent' }, server: 'server-a', connectionId: 'a',
      model: propModel, draft: { ...initialAgentPropertiesDraft(propModel), maxRows: '5000' }
    } as unknown as OpenObjectDialog
    const fakeWb = { dialogs: { updateDraft: () => {} } } as unknown as Workbench

    const genHost = await mount(fakeWb, createElement(AgentGeneralPage, { open, editable: true }))
    expect(genHost.querySelectorAll('[role="switch"]')).toHaveLength(2)
    expect(genHost.querySelector('.fact-grid')?.textContent).toContain('NT Service\\SQLSERVERAGENT')

    const histHost = await mount(fakeWb, createElement(AgentHistoryPage, { open, editable: true }))
    expect(histHost.querySelector('.ratio-bar-total')?.textContent).toBe('984 / 1,000 rows (98.4%)')
    expect(histHost.querySelector('.agent-retention-table td[data-tone="warning"]')).not.toBeNull()
    expect(histHost.querySelector('.agent-retention-table td[data-tone="success"]')).not.toBeNull()
  })
})
