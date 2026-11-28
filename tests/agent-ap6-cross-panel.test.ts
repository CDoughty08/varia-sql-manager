// @vitest-environment happy-dom
// AP-6 cross-panel verification: merged CSS isolation, anchors, protected contracts, all 8 ResizableSplit rails across remounts,
// cross-panel button-icon alignment, and ObjectInspectorFrame flow/fill + DocumentFrame ARIA structure across all 8 Agent surfaces.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActionDescribeResult } from '../src/shared/actions/schema'
import { notifyEmail, type AgentAlertDocumentModel } from '../src/shared/actions/agent-alert'
import type { AgentJobDocumentModel } from '../src/shared/actions/agent-job'
import type { AgentOperatorDocumentModel, AgentOperatorsModel } from '../src/shared/actions/agent-operator'
import { initialAgentPropertiesDraft, type AgentPropertiesModel } from '../src/shared/actions/agent-properties'
import type { AgentProxyDocumentModel, CredentialDocumentModel } from '../src/shared/actions/agent-proxy'
import { type AgentScheduleRecord, type AgentSchedulesModel } from '../src/shared/actions/agent-schedule'
import { freq, noEndDate, subday } from '../src/shared/agent/schedule'
import { agentHistoryProbe } from '../src/shared/agent/history'
import { liveProbes } from '../src/shared/live/catalog'
import { contrastExemptions, contrastPairs } from '../src/shared/theme/contrast-pairs'
import { densityUse, glyphUse } from '../src/shared/theme/metrics'
import { colorKeys, cssVariable } from '../src/shared/theme/registry'
import AgentOverview from '../src/renderer/src/agent/AgentOverview'
import AlertDocument from '../src/renderer/src/agent/AlertDocument'
import CreateSeveral from '../src/renderer/src/agent/CreateSeveral'
import CredentialDocument from '../src/renderer/src/agent/CredentialDocument'
import JobActivityMonitor from '../src/renderer/src/agent/JobActivityMonitor'
import JobDocument from '../src/renderer/src/agent/JobDocument'
import LogFileViewer from '../src/renderer/src/agent/LogFileViewer'
import OperatorDocument from '../src/renderer/src/agent/OperatorDocument'
import OperatorsDocument from '../src/renderer/src/agent/OperatorsDocument'
import ProxyDocument from '../src/renderer/src/agent/ProxyDocument'
import SchedulesDocument from '../src/renderer/src/agent/SchedulesDocument'
import SchedulesTimeline from '../src/renderer/src/agent/SchedulesTimeline'
import { WorkbenchProvider } from '../src/renderer/src/core/WorkbenchContext'
import type { Workbench } from '../src/renderer/src/core/workbench'
import type { OpenObjectDialog } from '../src/renderer/src/dialogs/ObjectDialogService'
import { AgentGeneralPage, AgentHistoryPage } from '../src/renderer/src/dialogs/pages/AgentPropertiesPages'
import type { LiveTable } from '../src/renderer/src/live/LiveService'
import { computed, selectorParts } from './fixtures/css-cascade'
import { cssRules, stylesheetRules, unbalancedBrace } from './fixtures/css-rules'
import type { FakeLiveHandle } from './fixtures/live-handle'
import { connectionInfo, readyBackend, workbenchFixture } from './fixtures/workbench'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const settled = async () => { for (let turn = 0; turn < 6; turn++) await new Promise(resolve => setTimeout(resolve, 0)) }
const cleanups: (() => void)[] = []
afterEach(async () => {
  await act(async () => {
    cleanups.splice(0).reverse().forEach(cleanup => cleanup())
    await settled()
  })
})
beforeEach(() => { window.localStorage.clear() })

const nightly = '11111111-1111-1111-1111-111111111111'

const fakeMonaco = () => ({
  Uri: { parse: (value: string) => ({ toString: () => value }) },
  editor: {
    createModel: vi.fn((text: string, language: string) => {
      let currentText = text
      let disposed = false
      return {
        isDisposed: () => disposed,
        getLanguageId: () => language,
        getValue: () => currentText,
        setValue: (next: string) => { currentText = next },
        onDidChangeContent: () => ({ dispose: () => {} }),
        updateOptions: vi.fn(),
        dispose: vi.fn(() => { disposed = true })
      }
    }),
    setModelLanguage: vi.fn(),
    create: vi.fn(() => {
      let currentModel: unknown = null
      const domNode = document.createElement('div')
      return {
        getId: () => 'fake-editor-1',
        getDomNode: () => domNode,
        getContainerDomNode: () => domNode,
        onDidChangeModel: () => ({ dispose: () => {} }),
        getModel: () => currentModel,
        setModel: (model: unknown) => { currentModel = model },
        updateOptions: vi.fn(),
        createContextKey: vi.fn(),
        getContribution: () => undefined,
        onMouseUp: () => ({ dispose: () => {} }),
        onMouseMove: () => ({ dispose: () => {} }),
        onMouseLeave: () => ({ dispose: () => {} }),
        dispose: vi.fn()
      }
    })
  }
})

async function mount(workbench: Workbench, element: ReturnType<typeof createElement>): Promise<HTMLElement> {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(createElement(WorkbenchProvider, { workbench, children: element }))
    await settled()
  })
  cleanups.unshift(() => { act(() => root.unmount()); host.remove() })
  return host
}

const sampleJobModel = (): AgentJobDocumentModel => ({
  job: {
    jobId: nightly, name: 'Nightly', enabled: true, description: 'Nightly care.', category: '[Uncategorized (Local)]', owner: 'sa',
    emailLevel: 2, emailOperator: 'DBA Team', pageLevel: 0, pageOperator: '', netSendLevel: 0, netSendOperator: '', eventLogLevel: 2, deleteLevel: 0,
    created: '2026-01-02T03:04:05', modified: '2026-11-20T14:32:07.123', version: 7, startStepId: 1, lastRun: '2026-11-20T02:00:00', lastOutcome: 1
  },
  login: 'sa', sysadmin: true, platform: 'windows', categories: ['[Uncategorized (Local)]'],
  operators: [{ name: 'DBA Team', enabled: true, email: true, pager: false, netSend: false, pagerDays: 127, weekday: { start: 0, end: 235959 }, saturday: { start: 0, end: 235959 }, sunday: { start: 0, end: 235959 } }],
  owners: ['sa'],
  steps: [
    { id: 1, name: 'Check integrity', subsystem: 'TSQL', command: 'SELECT 1;', flags: 0, cmdexecSuccessCode: 0, onSuccessAction: 3, onSuccessStepId: 0, onFailAction: 2, onFailStepId: 0, server: '', databaseName: 'master', databaseUserName: '', retryAttempts: 0, retryInterval: 0, osRunPriority: 0, outputFileName: '', proxyId: 0 },
    { id: 2, name: 'Load warehouse', subsystem: 'SSIS', command: '', flags: 0, cmdexecSuccessCode: 0, onSuccessAction: 1, onSuccessStepId: 0, onFailAction: 2, onFailStepId: 0, server: '', databaseName: '', databaseUserName: '', retryAttempts: 0, retryInterval: 0, osRunPriority: 0, outputFileName: '', proxyId: 0 }
  ],
  schedules: [{
    id: 1, name: 'Nightly 02:30', enabled: true, freqType: freq.daily, freqInterval: 1, freqSubdayType: subday.once, freqSubdayInterval: 0, freqRelativeInterval: 0, freqRecurrenceFactor: 0,
    activeStartDate: 20260101, activeEndDate: noEndDate, activeStartTime: 23000, activeEndTime: 235959, jobCount: 2, owner: 'sa', version: 2, modified: '2026-11-20T01:02:03.456'
  }],
  alerts: [{ id: 11, name: 'Nightly failed', enabled: true, severity: 17, messageId: 0 }],
  alertsEditable: true,
  mail: { checked: true, xps: true, profiles: 1, sysadmin: true, useDatabaseMail: true, agentProfile: 'Ops' },
  subsystems: ['TSQL', 'SSIS', 'PowerShell', 'CmdExec']
})

const scheduleRecord = (id: number, name: string, time = 23000): AgentScheduleRecord => ({
  id, name, enabled: true, freqType: freq.daily, freqInterval: 1, freqSubdayType: subday.once, freqSubdayInterval: 0, freqRelativeInterval: 0, freqRecurrenceFactor: 0,
  activeStartDate: 20260101, activeEndDate: noEndDate, activeStartTime: time, activeEndTime: 235959, jobCount: 1, owner: 'sa', version: 1, modified: '2026-11-20T01:02:03.456'
})

const sampleSchedulesModel = (): AgentSchedulesModel => ({
  login: 'sa', sysadmin: true, platform: 'windows', now: '2026-11-22T14:30:00',
  schedules: [scheduleRecord(1, 'Nightly 02:30', 23000), scheduleRecord(2, 'Quarter end', 60000)],
  jobs: [{ id: nightly, name: 'Nightly', enabled: true, owner: 'sa', version: 1 }],
  links: [{ scheduleId: 1, jobId: nightly }],
  durations: [{ jobId: nightly, seconds: 600 }]
})

const sampleOperatorsModel = (): AgentOperatorsModel => ({
  login: 'sa', sysadmin: true, platform: 'windows',
  operators: [
    { id: 9, name: 'DBA Team', enabled: true, email: 'dba@example.test', pager: 'pager@example.test', netSend: '', pagerDays: 127, weekday: { start: 80000, end: 180000 }, saturday: { start: 80000, end: 180000 }, sunday: { start: 80000, end: 180000 } },
    { id: 10, name: 'On Call', enabled: true, email: 'oncall@example.test', pager: '', netSend: '', pagerDays: 127, weekday: { start: 80000, end: 180000 }, saturday: { start: 80000, end: 180000 }, sunday: { start: 80000, end: 180000 } }
  ],
  alerts: [{ id: 7, name: 'Severity 017', enabled: true, kind: 'event', messageId: 0, severity: 17 }],
  notifications: [{ alertId: 7, operatorId: 9, methods: notifyEmail }],
  jobs: [{ id: nightly, name: 'Nightly', email: 'DBA Team', page: '', netSend: '' }],
  mail: { checked: true, xps: true, profiles: 1, sysadmin: true, useDatabaseMail: true, agentProfile: 'Ops' }
})

const sampleAlertModel = (): AgentAlertDocumentModel => ({
  alert: {
    id: 7, name: 'Severity 017', enabled: true, kind: 'event', messageId: 0, severity: 17, database: '', keyword: '', condition: '',
    wmiNamespace: '', wmiQuery: '', jobId: '', jobName: '', delay: 60, includeIn: notifyEmail, message: '', occurrences: 2,
    lastOccurred: '2026-11-25T18:14:00', lastResponse: '2026-11-25T18:14:01'
  },
  login: 'sa', sysadmin: true, platform: 'windows',
  operators: [{ name: 'DBA Team', enabled: true, email: true, pager: false, netSend: false, pagerDays: 127, weekday: { start: 0, end: 235959 }, saturday: { start: 0, end: 235959 }, sunday: { start: 0, end: 235959 } }],
  notifications: [{ operator: 'DBA Team', methods: notifyEmail }],
  jobs: [{ id: nightly, name: 'Nightly' }],
  databases: ['master', 'Sales'],
  mail: { checked: true, xps: true, profiles: 1, sysadmin: true, useDatabaseMail: true, agentProfile: 'Ops' }
})

const sampleOperatorModel = (): AgentOperatorDocumentModel => ({
  operator: {
    id: 9, name: 'DBA Team', enabled: true, email: 'dba@example.test', pager: 'pager@example.test', netSend: '', pagerDays: 127,
    weekday: { start: 80000, end: 180000 }, saturday: { start: 80000, end: 180000 }, sunday: { start: 80000, end: 180000 },
    lastEmail: '2026-11-25T18:14:01'
  },
  login: 'sa', sysadmin: true, platform: 'windows',
  alerts: [{ id: 7, name: 'Severity 017', enabled: true, kind: 'event', messageId: 0, severity: 17 }],
  notifications: [{ alertId: 7, operatorId: 9, methods: notifyEmail }],
  jobs: [{ id: nightly, name: 'Nightly', email: 'DBA Team', page: '', netSend: '' }],
  mail: { checked: true, xps: true, profiles: 1, sysadmin: true, useDatabaseMail: true, agentProfile: 'Ops' }
})

const sampleProxyModel = (): AgentProxyDocumentModel => ({
  proxy: {
    id: 1, name: 'FileShareWriter', enabled: true, description: 'Writes extracts', credential: 'FileShareWriterCred',
    credentialIdentity: 'CONTOSO\\svc-fswriter', subsystems: [3, 12], principals: [{ name: 'CONTOSO\\etl', kind: 'login' }]
  },
  platform: 'windows',
  subsystems: [{ id: 3, name: 'CmdExec' }, { id: 11, name: 'SSIS' }, { id: 12, name: 'PowerShell' }],
  credentials: [{ name: 'FileShareWriterCred', identity: 'CONTOSO\\svc-fswriter' }],
  credentialsTruncated: false, canCreateCredential: true,
  principalChoices: [{ name: 'CONTOSO\\etl', kind: 'login' }],
  references: [{ job: 'Nightly', stepId: 2, step: 'Copy extracts', subsystem: 'CmdExec' }],
  referencesTruncated: false
})

const sampleCredentialModel = (): CredentialDocumentModel => ({
  credential: { id: 65536, name: 'FileShareWriterCred', identity: 'CONTOSO\\svc-fswriter', created: '2025-03-02T10:20:00', modified: '2026-11-08T16:02:11.123' },
  platform: 'box', providers: [],
  usedBy: [{ proxy: 'FileShareWriter', subsystems: ['CmdExec', 'PowerShell'], steps: [{ job: 'Nightly', stepId: 2, step: 'Copy extracts' }] }],
  usedByTruncated: false
})

function liveTable(columns: { name: string; dataType: string }[], rows: string[][]): LiveTable {
  const snapshot = { rowsAvailable: rows.length, rowsExpected: rows.length, state: 'complete', columns, truncated: false }
  return {
    handle: {
      getSnapshot: () => snapshot,
      subscribe: () => () => {},
      getWindow: async (first: number, count: number) => {
        const slice = rows.slice(first, first + count)
        return { first, count: slice.length, colStart: 0, colEnd: columns.length, text: slice.flat(), flags: new Uint8Array(slice.length * columns.length) }
      }
    },
    descriptor: { rowsAvailable: rows.length, truncated: false, columns }
  } as unknown as LiveTable
}

const historyTable = (tableIndex: number, rows: string[][]) =>
  liveTable(liveProbes[agentHistoryProbe].tables![tableIndex].columns.map(col => ({ name: col.name, dataType: col.dataType })), rows)

const historyRow = (tableIndex: number, values: Record<string, string>) =>
  liveProbes[agentHistoryProbe].tables![tableIndex].columns.map(col => values[col.id] ?? '')

function setupWorkbench(options: { windowsClient?: boolean } = {}) {
  const fixture = workbenchFixture(options)
  cleanups.push(() => fixture.dispose())
  fixture.api.push(readyBackend())
  fixture.connect(connectionInfo('c1'))
  return fixture
}

function asWorkbench(fixture: ReturnType<typeof workbenchFixture>): Workbench {
  return {
    ...fixture,
    theme: { getSnapshot: () => fixture.theme.state, subscribe: () => () => {} },
    monaco: fakeMonaco(),
    platform: 'win32'
  } as unknown as Workbench
}

describe('AP-6 merged CSS isolation, anchors, and protected contracts', () => {
  const css = readFileSync('src/renderer/src/styles.css', 'utf8')
  const rules = stylesheetRules()
  const valueOf = (selector: string, property: string) =>
    rules.filter(rule => !rule.at.length && rule.selector.replace(/\s+/g, ' ').trim() === selector)
      .flatMap(rule => rule.declarations)
      .filter(decl => decl.property === property)
      .at(-1)?.value

  it('parses cleanly and preserves all 4 Wave-2 CSS anchors in exact order with non-empty sections', () => {
    expect(unbalancedBrace(css)).toBeUndefined()
    const anchors = [
      '/* === AP-2: Job Document === */',
      '/* === AP-3: JAM & Overview === */',
      '/* === AP-4: LFV & Schedules === */',
      '/* === AP-5: Operators, Alerts, Proxies & Props === */'
    ]
    const offsets = anchors.map(anchor => css.indexOf(anchor))
    expect(offsets.every(offset => offset > 0)).toBe(true)
    for (let i = 1; i < offsets.length; i++) expect(offsets[i]).toBeGreaterThan(offsets[i - 1])
    for (let i = 0; i < offsets.length; i++) {
      const slice = css.slice(offsets[i], offsets[i + 1] ?? css.length)
      expect(cssRules(slice).length).toBeGreaterThan(5)
    }
  })

  it('keeps .lfv-* and .agent-job-history-* namespaces strictly disjoint and retires .agent-history*', () => {
    const legacy = rules.filter(rule => /^\.agent-history(?![\w-])|\[data-agent-history/.test(rule.selector))
    expect(legacy).toEqual([])
    const lfvSelectors = rules.filter(rule => rule.selector.includes('.lfv-')).map(rule => rule.selector)
    const jobHistorySelectors = rules.filter(rule => rule.selector.includes('.agent-job-history-')).map(rule => rule.selector)
    expect(lfvSelectors.length).toBeGreaterThan(10)
    expect(jobHistorySelectors.length).toBeGreaterThan(10)
    expect(lfvSelectors.some(sel => sel.includes('agent-job-history'))).toBe(false)
    expect(jobHistorySelectors.some(sel => sel.includes('lfv-'))).toBe(false)
    expect(valueOf('.lfv-run', 'display')).toBe('flex')
    expect(valueOf('.agent-job-history-fill .agent-job-history-split', 'flex')).toBe('1')
  })

  it('keeps .properties-table intact for ObjectDialog while Agent panels use .agent-table exclusively', () => {
    expect(valueOf('.properties-table > .object-dialog-grid', 'table-layout')).toBe('auto')
    expect(valueOf('.agent-table', 'border-collapse')).toBe('collapse')

    const agentDir = 'src/renderer/src/agent'
    const files = [
      ...readdirSync(agentDir).filter(name => name.endsWith('.tsx')).map(name => join(agentDir, name)),
      'src/renderer/src/dialogs/pages/AgentPropertiesPages.tsx'
    ]
    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      expect(source, `${file} must not reference .properties-table`).not.toMatch(/className\s*=\s*["'`][^"'`]*properties-table/)
      const tableTags = source.match(/<table\b[^>]*>/g) ?? []
      for (const tag of tableTags) {
        const expectedClass = file.endsWith('CreateSeveral.tsx') ? 'agent-several-table' : 'agent-table'
        expect(tag, `${file} <table> must use .${expectedClass}`).toContain(expectedClass)
      }
    }
  })

  it('scopes ScheduleEditor .agent-schedule-sentence / .agent-schedule-facts under .agent-schedules-detail and sets explicit foreground on JobSchedules', () => {
    expect(valueOf('.agent-schedule-sentence', 'background')).toBeUndefined()
    expect(valueOf('.agent-schedule-sentence', 'color')).toBeUndefined()
    expect(valueOf('.agent-schedules-detail .agent-schedule-sentence', 'background')).toBe('var(--varia-list-inactiveSelectionBackground)')
    expect(valueOf('.agent-schedules-detail .agent-schedule-sentence', 'color')).toBe('var(--varia-list-inactiveSelectionForeground)')
    expect(valueOf('.agent-job-schedules-main .agent-schedule-sentence', 'background')).toBe('var(--varia-panel-background)')
    expect(valueOf('.agent-job-schedules-main .agent-schedule-sentence', 'color')).toBe('var(--varia-foreground)')
    expect(valueOf('.agent-schedule-facts > section', 'background')).toBeUndefined()
    expect(valueOf('.agent-schedules-detail .agent-schedule-facts > section', 'background')).toBe('var(--varia-editor-background)')
  })

  it('preserves zero-nested-scroller CSS rules across all fill surfaces', () => {
    expect(valueOf('.inspector-pane-fill', 'overflow')).toBe('hidden')
    expect(valueOf('.agent-job-steps-fill .varia-split-main .agent-step-ssis', 'flex')).toBe('none')
    expect(valueOf('.agent-job-steps-fill .varia-split-main .agent-step-ssis', 'overflow')).toBe('visible')
    expect(valueOf('.agent-job-steps-fill .varia-split-main .agent-step-ssis-tree', 'max-height')).toBe('none')
    expect(valueOf('.agent-job-steps-fill .varia-split-main .agent-step-ssis-tree', 'overflow')).toBe('visible')
    expect(valueOf('.document-frame[data-agent-several] .agent-several-columns', 'max-height')).toBe('none')
    expect(valueOf('.document-frame[data-agent-several] .agent-several-columns', 'overflow')).toBe('visible')
    expect(valueOf('.document-body.lfv', 'overflow')).toBe('hidden')
    expect(valueOf('.document-body.agent-schedules-doc', 'overflow')).toBe('hidden')
    expect(valueOf('.agent-operators-grid-wrap', 'max-height')).toBe('none')
  })

  it('registers merged AP-2 + AP-3 metrics, all forced-colors rules, and contrast-safe token pairs', () => {
    expect(glyphUse.sm).toContain('.agent-job-steps-fill .agent-step-flow .codicon')
    for (const selector of [
      '.agent-job-start-split > button',
      '.inspector-pane-flow .agent-job-notify > select',
      '.agent-job-schedules-main .property-field-control > select, .agent-job-schedules-main select.property-input',
      '.ov-check-fix > button'
    ]) {
      expect(densityUse.control, selector).toContain(selector)
    }

    const forcedSelectors = new Set(
      rules.filter(rule => rule.at.some(at => at.includes('forced-colors: active')))
        .flatMap(rule => selectorParts(rule.selector).map(part => part.replace(/\s+/g, ' ').trim()))
    )
    for (const required of [
      '.varia-sash::after',
      '.agent-table tbody tr[aria-selected="true"]',
      '.agent-job-steps-fill .agent-step-item[aria-selected="true"]',
      '.agent-job-schedules-fill .agent-schedule-item[aria-current]',
      '.agent-job-history-fill .agent-job-history-runs button[aria-pressed="true"]',
      '.agent-schedules-grid tbody tr[aria-selected="true"]:hover',
      '.agent-timeline-overlaps-head',
      '.agent-operators-head[aria-pressed="true"]',
      '.agent-operators-cell[data-set]',
      '.agent-alert-method[aria-pressed="true"]',
      '.agent-operators-grid td[data-changed] .agent-operators-cell'
    ]) {
      expect(forcedSelectors.has(required), `forced-colors rule missing for ${required}`).toBe(true)
    }

    // Verify every color+background token pair added in AP-2..AP-5 is covered by contrastPairs or contrastExemptions.
    const ap2Start = css.indexOf('/* === AP-2: Job Document === */')
    const apRules = cssRules(css.slice(ap2Start)).filter(rule => !rule.at.some(at => at.includes('forced-colors: active')))
    const keyOf = new Map(colorKeys.map(key => [cssVariable(key), key]))
    const toKey = (value: string) => {
      const match = value.match(/^var\((--varia-[A-Za-z0-9-]+)\)$/)
      return match ? keyOf.get(match[1]) : undefined
    }
    const covered = new Set(contrastPairs.map(pair => `${pair.foreground}|${pair.background.at(-1)}`))
    for (const rule of apRules) {
      const color = rule.declarations.find(d => d.property === 'color')?.value
      const bg = rule.declarations.find(d => d.property === 'background' || d.property === 'background-color')?.value
      if (!color || !bg) continue
      const fgKey = toKey(color), bgKey = toKey(bg)
      if (!fgKey || !bgKey) continue
      const exempt = contrastExemptions[fgKey] !== undefined
      expect(covered.has(`${fgKey}|${bgKey}`) || exempt, `${rule.selector}: ${fgKey} on ${bgKey} not in contrast-pairs`).toBe(true)
    }
  })
})

describe('AP-6 8-rail ResizableSplit persistence & remount restoration', () => {
  interface SplitCase {
    readonly id: string
    readonly label: string
    readonly defaultWidth: number
    readonly customWidth: number
    readonly key: 'ArrowRight' | 'ArrowLeft'
    readonly expectedAfterKey: number
    readonly mountComponent: (fixture: ReturnType<typeof workbenchFixture>) => Promise<HTMLElement>
  }

  const cases: readonly SplitCase[] = [
    {
      id: 'agent.job.steps', label: 'Resize steps list', defaultWidth: 304, customWidth: 356, key: 'ArrowRight', expectedAfterKey: 368,
      mountComponent: async fixture => {
        fixture.api.describeObject.mockImplementation(async () => ({ ok: true, value: { agentJobDocument: sampleJobModel(), elapsedMs: 1 } as ActionDescribeResult }))
        const id = fixture.jobDocuments.openJob('c1', 'Nightly')
        await settled()
        const host = await mount(asWorkbench(fixture), createElement(JobDocument, { documentId: id }))
        const tab = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(el => el.textContent?.includes('Steps'))!
        await act(async () => { tab.click(); await settled() })
        return host
      }
    },
    {
      id: 'agent.job.schedules', label: 'Resize attached schedules list', defaultWidth: 284, customWidth: 320, key: 'ArrowRight', expectedAfterKey: 332,
      mountComponent: async fixture => {
        fixture.api.describeObject.mockImplementation(async () => ({ ok: true, value: { agentJobDocument: sampleJobModel(), elapsedMs: 1 } as ActionDescribeResult }))
        const id = fixture.jobDocuments.openJob('c1', 'Nightly')
        await settled()
        const host = await mount(asWorkbench(fixture), createElement(JobDocument, { documentId: id }))
        const tab = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(el => el.textContent?.includes('Schedules'))!
        await act(async () => { tab.click(); await settled() })
        return host
      }
    },
    {
      id: 'agent.job.history', label: 'Resize history runs list', defaultWidth: 276, customWidth: 312, key: 'ArrowRight', expectedAfterKey: 324,
      mountComponent: async fixture => {
        fixture.api.describeObject.mockImplementation(async () => ({ ok: true, value: { agentJobDocument: sampleJobModel(), elapsedMs: 1 } as ActionDescribeResult }))
        const id = fixture.jobDocuments.openJob('c1', 'Nightly')
        await settled()
        fixture.jobDocuments.openHistory(id)
        fixture.jobDocuments.history.attach(id, nightly)
        const handle = (fixture.live.handles as FakeLiveHandle[]).find(item => item.spec.source === 'agent.history')!
        const makeTable = (index: number, rows: Record<string, string>[]) => {
          const cols = liveProbes['agent.history.list'].tables![index].columns.map(col => col.id)
          return liveTable(cols.map(name => ({ name, dataType: 'text' })), rows.map(row => cols.map(col => row[col] ?? '')))
        }
        handle.tables.set('agent.history.list:0', makeTable(0, [
          { runDate: '2026-11-22 02:00:00', runJob: 'Nightly', runOutcome: 'Failed', runDuration: '00:05:00', runSteps: '1', runMessage: 'Failed.', runKey: `${nightly}:20`, runJobId: nightly, runTone: 'error' }
        ]))
        handle.tables.set('agent.history.list:1', makeTable(1, []))
        handle.tables.set('agent.history.list:3', makeTable(3, [{ usualStep: '0', usualSeconds: '60', usualRuns: '1' }]))
        handle.deliver({ type: 'live.tick', seq: 1, sampledAt: 1, samples: [{ probe: 'agent.history.list', costMs: 1, effectiveIntervalMs: 15_000 }] })
        await settled()
        const host = await mount(asWorkbench(fixture), createElement(JobDocument, { documentId: id }))
        const tab = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(el => el.textContent?.includes('History'))!
        await act(async () => { tab.click(); await settled() })
        return host
      }
    },
    {
      id: 'agent.jam.lastRunMessage', label: 'Resize last run message', defaultWidth: 440, customWidth: 500, key: 'ArrowLeft', expectedAfterKey: 512,
      mountComponent: async fixture => {
        const id = fixture.jobActivity.open('c1')
        const handle = (fixture.live.handles as FakeLiveHandle[]).find(item => item.spec.probes.some(probe => probe.probe === 'agent.jobs.list'))!
        handle.tables.set('agent.jobs.list:1', liveTable(
          liveProbes['agent.jobs.list'].tables![1]!.columns.map(col => ({ name: col.name, dataType: col.dataType })),
          [['11', '1', 'Extract', 'Succeeded', '2026-11-15 02:30:00', '00:00:01', 'Done.', '']]
        ))
        const host = await mount(asWorkbench(fixture), createElement(JobActivityMonitor, { documentId: id }))
        await act(async () => {
          fixture.jobActivity.toggleExpanded(id, { id: nightly, name: 'Nightly' })
          handle.deliver({ type: 'live.tick', seq: 1, sampledAt: 1, samples: [{ probe: 'agent.jobs.list', costMs: 1, effectiveIntervalMs: 5000, metrics: [0, 0, 0, 0, 0] }] } as never)
          await settled()
        })
        return host
      }
    },
    {
      id: 'agent.lfv.sources', label: 'Resize Select logs', defaultWidth: 236, customWidth: 280, key: 'ArrowRight', expectedAfterKey: 292,
      mountComponent: async fixture => {
        fixture.api.agentProfile.mockResolvedValue({ ok: true, value: { elapsedMs: 1, profile: { sysadmin: true, msdbAccess: true, purgeHistory: true } as never } })
        fixture.api.agentErrorLogs.mockResolvedValue({ ok: true, value: { logs: [], archives: true, elapsedMs: 1 } })
        const id = fixture.logViewer.open('c1')
        await settled()
        return await mount(asWorkbench(fixture), createElement(LogFileViewer, { documentId: id }))
      }
    },
    {
      id: 'agent.lfv.message', label: 'Resize Message details', defaultWidth: 430, customWidth: 490, key: 'ArrowLeft', expectedAfterKey: 502,
      mountComponent: async fixture => {
        fixture.api.agentProfile.mockResolvedValue({ ok: true, value: { elapsedMs: 1, profile: { sysadmin: true, msdbAccess: true, purgeHistory: true } as never } })
        fixture.api.agentErrorLogs.mockResolvedValue({ ok: true, value: { logs: [], archives: true, elapsedMs: 1 } })
        fixture.api.agentHistoryMessage.mockResolvedValue({ ok: true, value: { message: 'Step detail text.', elapsedMs: 1 } })
        const id = fixture.logViewer.open('c1')
        const handle = (fixture.live.handles as FakeLiveHandle[]).find(item => item.spec.source === 'agent.history')!
        handle.tables.set(`${agentHistoryProbe}:2`, historyTable(2, [[nightly, 'Nightly', 'sa', 'No', 'Yes']]))
        handle.tables.set(`${agentHistoryProbe}:0`, historyTable(0, [historyRow(0, { runKey: `${nightly}:12`, jobName: 'Nightly', outcome: 'Failed', started: '2026-11-22 14:00:00', duration: '00:04:18', steps: '1', message: 'Failed.' })]))
        const stepsTable = historyTable(1, [historyRow(1, { stepInstance: '11', stepId: '1', stepName: 'Step 1', stepOutcome: 'Failed', stepStarted: '2026-11-22 14:00:00', stepDuration: '00:01:00' })])
        handle.tables.set(`${agentHistoryProbe}:1`, stepsTable)
        handle.deliver({ type: 'live.tick', seq: 1, sampledAt: 1, samples: [{ probe: agentHistoryProbe, costMs: 1, effectiveIntervalMs: 15_000 }] })
        await settled()
        const host = await mount(asWorkbench(fixture), createElement(LogFileViewer, { documentId: id }))
        await act(async () => {
          fixture.logViewer.attachRuns(id, { subscribe: () => () => {}, getSnapshot: () => ({ activeKey: `${nightly}:12` }) } as never)
          await settled()
        })
        await act(async () => {
          fixture.logViewer.attachSteps(id, { subscribe: () => () => {}, getSnapshot: () => ({ activeKey: '11', table: stepsTable, selection: { active: { row: 0, col: 0 } } }) } as never)
          await settled()
        })
        return host
      }
    },
    {
      id: 'agent.schedules.detail', label: 'Resize schedule detail', defaultWidth: 472, customWidth: 520, key: 'ArrowLeft', expectedAfterKey: 532,
      mountComponent: async fixture => {
        fixture.api.describeObject.mockImplementation(async () => ({ ok: true, value: { agentSchedules: sampleSchedulesModel(), elapsedMs: 1 } as ActionDescribeResult }))
        fixture.api.agentProfile.mockResolvedValue({ ok: true, value: { elapsedMs: 1, profile: { sysadmin: true } as never } })
        const id = fixture.schedules.open('c1')
        await settled()
        const host = await mount(asWorkbench(fixture), createElement(SchedulesDocument, { documentId: id }))
        await act(async () => { fixture.schedules.select(id, '1'); await settled() })
        return host
      }
    },
    {
      id: 'agent.operators.side', label: 'Resize selected operator rail', defaultWidth: 264, customWidth: 312, key: 'ArrowLeft', expectedAfterKey: 324,
      mountComponent: async fixture => {
        fixture.api.describeObject.mockImplementation(async () => ({ ok: true, value: { agentOperators: sampleOperatorsModel(), elapsedMs: 1 } as ActionDescribeResult }))
        const id = fixture.operatorsDocuments.open('c1', { kind: 'agent' })
        await settled()
        return await mount(asWorkbench(fixture), createElement(OperatorsDocument, { documentId: id }))
      }
    }
  ]

  it.each(cases)('restores, updates, persists across remount, and resets $id ($label)', async item => {
    localStorage.setItem(`varia.split.${item.id}`, String(item.customWidth))

    // First mount: seeded customWidth is restored onto separator + rail.
    const fixture1 = setupWorkbench({ windowsClient: true })
    const host1 = await item.mountComponent(fixture1)
    const sep1 = host1.querySelector<HTMLElement>(`[role="separator"][aria-label="${item.label}"]`)!
    expect(sep1, `separator missing for ${item.id}`).not.toBeNull()
    expect(sep1.getAttribute('aria-valuenow')).toBe(String(item.customWidth))
    const rail1 = sep1.parentElement!.querySelector<HTMLElement>('.varia-split-rail')!
    expect(rail1.style.width).toBe(`${item.customWidth}px`)

    // Keyboard resize updates localStorage.
    await act(async () => {
      sep1.dispatchEvent(new KeyboardEvent('keydown', { key: item.key, bubbles: true }))
      await settled()
    })
    expect(sep1.getAttribute('aria-valuenow')).toBe(String(item.expectedAfterKey))
    expect(localStorage.getItem(`varia.split.${item.id}`)).toBe(String(item.expectedAfterKey))

    // Unmount first instance completely before fresh remount.
    await act(async () => { cleanups.splice(0).forEach(fn => fn()) })

    // Second mount: updated width is restored cleanly from localStorage.
    const fixture2 = setupWorkbench({ windowsClient: true })
    const host2 = await item.mountComponent(fixture2)
    const sep2 = host2.querySelector<HTMLElement>(`[role="separator"][aria-label="${item.label}"]`)!
    expect(sep2.getAttribute('aria-valuenow')).toBe(String(item.expectedAfterKey))
    expect(sep2.parentElement!.querySelector<HTMLElement>('.varia-split-rail')!.style.width).toBe(`${item.expectedAfterKey}px`)

    // Home resets to defaultWidth.
    await act(async () => {
      sep2.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
      await settled()
    })
    expect(sep2.getAttribute('aria-valuenow')).toBe(String(item.defaultWidth))
    expect(localStorage.getItem(`varia.split.${item.id}`)).toBe(String(item.defaultWidth))
  })
})

describe('AP-6 cross-panel button-icon CSS & DOM alignment audit', () => {
  it('audits all rendered Agent surfaces for direct-child icon buttons or explicit flex+gap rules', async () => {
    const fixture = setupWorkbench({ windowsClient: true })
    fixture.api.agentProfile.mockResolvedValue({ ok: true, value: { elapsedMs: 1, profile: { sysadmin: true, msdbAccess: true, purgeHistory: true } as never } })
    fixture.api.agentErrorLogs.mockResolvedValue({ ok: true, value: { logs: [], archives: true, elapsedMs: 1 } })
    fixture.api.describeObject.mockImplementation(async params => {
      if (params.dialog === 'agentJob') return { ok: true, value: { agentJobDocument: sampleJobModel(), elapsedMs: 1 } as ActionDescribeResult }
      if (params.dialog === 'agentSchedules') return { ok: true, value: { agentSchedules: sampleSchedulesModel(), elapsedMs: 1 } as ActionDescribeResult }
      if (params.dialog === 'agentOperators') return { ok: true, value: { agentOperators: sampleOperatorsModel(), elapsedMs: 1 } as ActionDescribeResult }
      if (params.dialog === 'agentAlert') return { ok: true, value: { agentAlertDocument: sampleAlertModel(), elapsedMs: 1 } as ActionDescribeResult }
      if (params.dialog === 'agentOperator') return { ok: true, value: { agentOperatorDocument: sampleOperatorModel(), elapsedMs: 1 } as ActionDescribeResult }
      if (params.dialog === 'agentProxy') return { ok: true, value: { agentProxyDocument: sampleProxyModel(), elapsedMs: 1 } as ActionDescribeResult }
      return { ok: true, value: { credentialDocument: sampleCredentialModel(), elapsedMs: 1 } as ActionDescribeResult }
    })

    const wb = asWorkbench(fixture)
    const jobId = fixture.jobDocuments.openJob('c1', 'Nightly')
    const likeId = fixture.jobDocuments.createLike('c1', 'Nightly')
    const jamId = fixture.jobActivity.open('c1')
    const overviewId = fixture.agentOverview.open('c1')
    const lfvId = fixture.logViewer.open('c1')
    const schedId = fixture.schedules.open('c1')
    const opsId = fixture.operatorsDocuments.open('c1', { kind: 'agent' })
    const alertId = fixture.alertDocuments.open('c1', { kind: 'agentAlert', name: 'Severity 017' })
    const opId = fixture.operatorDocuments.open('c1', { kind: 'agentOperator', name: 'DBA Team' })
    const proxyId = fixture.proxyDocuments.openProxy('c1', 'FileShareWriter')
    const credId = fixture.credentialDocuments.openCredential('c1', 'FileShareWriterCred')
    await settled()
    fixture.jobDocuments.createSeveral(likeId)

    const propModel: AgentPropertiesModel = {
      settings: {
        sqlserverRestart: true, monitorAutostart: true, historyMaxRows: 1000, historyMaxRowsPerJob: 100,
        autoStart: true, startupAccount: 'NT Service\\SQLSERVERAGENT', errorLogFile: 'D:\\MSSQL\\Log\\SQLAGENT.OUT', errorLoggingLevel: 3
      },
      serverNow: '2026-11-26T14:30:00', serverOffsetMinutes: 0,
      history: { total: 984, recent: 700, jobsTruncated: false, jobs: [{ name: 'Backup', rows: 600, recent: 672 }], ages: [] }
    }
    const propOpen = {
      id: 1, dialog: 'agentProperties', phase: 'ready', target: { kind: 'agent' }, server: 'server-a', connectionId: 'a',
      model: propModel, draft: initialAgentPropertiesDraft(propModel)
    } as unknown as OpenObjectDialog

    const surfaces = [
      { name: 'JobDocument', host: await mount(wb, createElement(JobDocument, { documentId: jobId })) },
      { name: 'CreateSeveral', host: await mount(wb, createElement(CreateSeveral, { state: fixture.jobDocuments.get(likeId)!, service: fixture.jobDocuments })) },
      { name: 'JobActivityMonitor', host: await mount(wb, createElement(JobActivityMonitor, { documentId: jamId })) },
      { name: 'AgentOverview', host: await mount(wb, createElement(AgentOverview, { documentId: overviewId })) },
      { name: 'LogFileViewer', host: await mount(wb, createElement(LogFileViewer, { documentId: lfvId })) },
      { name: 'SchedulesDocument', host: await mount(wb, createElement(SchedulesDocument, { documentId: schedId })) },
      { name: 'SchedulesTimeline', host: await mount(wb, createElement(SchedulesTimeline, { documentId: schedId, model: sampleSchedulesModel(), span: 'day', onSpan: () => {}, onOpenJob: () => {}, onOpenSchedule: () => {} })) },
      { name: 'OperatorsDocument', host: await mount(wb, createElement(OperatorsDocument, { documentId: opsId })) },
      { name: 'AlertDocument', host: await mount(wb, createElement(AlertDocument, { documentId: alertId })) },
      { name: 'OperatorDocument', host: await mount(wb, createElement(OperatorDocument, { documentId: opId })) },
      { name: 'ProxyDocument', host: await mount(wb, createElement(ProxyDocument, { documentId: proxyId })) },
      { name: 'CredentialDocument', host: await mount(wb, createElement(CredentialDocument, { documentId: credId })) },
      { name: 'AgentGeneralPage', host: await mount(wb, createElement(AgentGeneralPage, { open: propOpen, editable: true })) },
      { name: 'AgentHistoryPage', host: await mount(wb, createElement(AgentHistoryPage, { open: propOpen, editable: true })) }
    ]

    let auditedButtons = 0
    for (const surface of surfaces) {
      const buttons = [...surface.host.querySelectorAll<HTMLButtonElement>('button')].filter(btn => btn.querySelector('.codicon, .icon'))
      for (const button of buttons) {
        auditedButtons++
        const directIcons = [...button.children].filter(child => child.classList.contains('codicon') || child.classList.contains('icon'))
        const tokens = ['button', ...[...button.classList].map(cls => `.${cls}`)]
        const style = computed(tokens)
        const hasFlexClass = style.get('display') === 'inline-flex' || style.get('display') === 'flex'
        expect(directIcons.length > 0 || hasFlexClass, `${surface.name} button "${button.textContent?.trim()}" lacks direct icon or flex class`).toBe(true)
        if (directIcons.length > 0 && style.has('display')) {
          expect(style.get('display'), `${surface.name} button "${button.textContent?.trim()}" overrides display`).toMatch(/flex|grid/)
        }
        if (style.has('gap')) {
          expect(style.get('gap'), `${surface.name} button "${button.textContent?.trim()}" strips gap`).not.toBe('0px')
        }
      }
    }
    expect(auditedButtons).toBeGreaterThan(25)
  })
})

describe('AP-6 cross-panel ARIA & flow/fill container audit', () => {
  it('verifies ObjectInspectorFrame flow/fill panes and DocumentFrame header/body structure across all Agent surfaces', async () => {
    const fixture = setupWorkbench({ windowsClient: true })
    fixture.api.agentProfile.mockResolvedValue({ ok: true, value: { elapsedMs: 1, profile: { sysadmin: true, msdbAccess: true, purgeHistory: true } as never } })
    fixture.api.agentErrorLogs.mockResolvedValue({ ok: true, value: { logs: [], archives: true, elapsedMs: 1 } })
    fixture.api.describeObject.mockImplementation(async params => {
      if (params.dialog === 'agentJob') return { ok: true, value: { agentJobDocument: sampleJobModel(), elapsedMs: 1 } as ActionDescribeResult }
      if (params.dialog === 'agentSchedules') return { ok: true, value: { agentSchedules: sampleSchedulesModel(), elapsedMs: 1 } as ActionDescribeResult }
      if (params.dialog === 'agentOperators') return { ok: true, value: { agentOperators: sampleOperatorsModel(), elapsedMs: 1 } as ActionDescribeResult }
      if (params.dialog === 'agentAlert') return { ok: true, value: { agentAlertDocument: sampleAlertModel(), elapsedMs: 1 } as ActionDescribeResult }
      if (params.dialog === 'agentOperator') return { ok: true, value: { agentOperatorDocument: sampleOperatorModel(), elapsedMs: 1 } as ActionDescribeResult }
      if (params.dialog === 'agentProxy') return { ok: true, value: { agentProxyDocument: sampleProxyModel(), elapsedMs: 1 } as ActionDescribeResult }
      return { ok: true, value: { credentialDocument: sampleCredentialModel(), elapsedMs: 1 } as ActionDescribeResult }
    })

    const wb = asWorkbench(fixture)
    let jobId = '', opsId = '', alertId = '', opId = '', proxyId = '', credId = ''
    let jamId = '', overviewId = '', lfvId = '', schedId = ''
    await act(async () => {
      jobId = fixture.jobDocuments.openJob('c1', 'Nightly')
      opsId = fixture.operatorsDocuments.open('c1', { kind: 'agent' })
      alertId = fixture.alertDocuments.open('c1', { kind: 'agentAlert', name: 'Severity 017' })
      opId = fixture.operatorDocuments.open('c1', { kind: 'agentOperator', name: 'DBA Team' })
      proxyId = fixture.proxyDocuments.openProxy('c1', 'FileShareWriter')
      credId = fixture.credentialDocuments.openCredential('c1', 'FileShareWriterCred')
      jamId = fixture.jobActivity.open('c1')
      overviewId = fixture.agentOverview.open('c1')
      lfvId = fixture.logViewer.open('c1')
      schedId = fixture.schedules.open('c1')
      await settled()
    })

    const inspectorHosts = [
      { name: 'JobDocument', host: await mount(wb, createElement(JobDocument, { documentId: jobId })) },
      { name: 'OperatorsDocument', host: await mount(wb, createElement(OperatorsDocument, { documentId: opsId })) },
      { name: 'AlertDocument', host: await mount(wb, createElement(AlertDocument, { documentId: alertId })) },
      { name: 'OperatorDocument', host: await mount(wb, createElement(OperatorDocument, { documentId: opId })) },
      { name: 'ProxyDocument', host: await mount(wb, createElement(ProxyDocument, { documentId: proxyId })) },
      { name: 'CredentialDocument', host: await mount(wb, createElement(CredentialDocument, { documentId: credId })) }
    ]

    for (const item of inspectorHosts) {
      expect(item.host.querySelector('.inspector-frame'), `${item.name} missing .inspector-frame`).not.toBeNull()
      const panels = [...item.host.querySelectorAll<HTMLElement>('[role="tabpanel"]')]
      expect(panels.length, `${item.name} must render at least 1 tabpanel`).toBeGreaterThanOrEqual(1)
      const visiblePanels = panels.filter(panel => !panel.hidden)
      expect(visiblePanels, `${item.name} must have exactly 1 visible tabpanel`).toHaveLength(1)
      for (const panel of panels) {
        expect(
          panel.classList.contains('inspector-pane-flow') || panel.classList.contains('inspector-pane-fill'),
          `${item.name} tabpanel must declare flow or fill layout`
        ).toBe(true)
      }
    }

    const docFrameHosts = [
      { name: 'JobActivityMonitor', slot: '.document-content', host: await mount(wb, createElement(JobActivityMonitor, { documentId: jamId })) },
      { name: 'AgentOverview', slot: '.document-content', host: await mount(wb, createElement(AgentOverview, { documentId: overviewId })) },
      { name: 'LogFileViewer', slot: '.document-body', host: await mount(wb, createElement(LogFileViewer, { documentId: lfvId })) },
      { name: 'SchedulesDocument', slot: '.document-body', host: await mount(wb, createElement(SchedulesDocument, { documentId: schedId })) }
    ]

    for (const item of docFrameHosts) {
      expect(item.host.querySelector('.document-frame > .document-header'), `${item.name} missing .document-header`).not.toBeNull()
      expect(item.host.querySelector(`.document-frame > ${item.slot}`), `${item.name} missing ${item.slot}`).not.toBeNull()
      if (item.slot === '.document-body') {
        expect(item.host.querySelector('.document-frame > .document-content'), `${item.name} must not wrap .document-content`).toBeNull()
      }
    }
  })
})
