// @vitest-environment happy-dom
import { spawnSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { ActionDescribeResult } from '../src/shared/actions/schema'
import { agentJobText, type AgentJobDocumentModel } from '../src/shared/actions/agent-job'
import type { AgentOperatorsModel } from '../src/shared/actions/agent-operator'
import AgentJobStatus from '../src/renderer/src/agent/AgentJobStatus'
import JobDocument from '../src/renderer/src/agent/JobDocument'
import OperatorsDocument from '../src/renderer/src/agent/OperatorsDocument'
import { WorkbenchProvider } from '../src/renderer/src/core/WorkbenchContext'
import type { Workbench } from '../src/renderer/src/core/workbench'
import TitleBar from '../src/renderer/src/TitleBar'
import { stylesheetRules } from './fixtures/css-rules'
import type { FakeLiveHandle } from './fixtures/live-handle'
import { connectionInfo, readyBackend, workbenchFixture } from './fixtures/workbench'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const settled = async () => { for (let turn = 0; turn < 10; turn++) await new Promise(resolve => setImmediate(resolve)) }
const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()) })

async function mount(workbench: Workbench, element: ReturnType<typeof createElement>): Promise<HTMLElement> {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => { root.render(createElement(WorkbenchProvider, { workbench, children: element })) })
  cleanups.unshift(() => { act(() => root.unmount()); host.remove() })
  return host
}

const directIcon = (button: HTMLButtonElement) =>
  Array.from(button.children).filter(child => child.classList.contains('codicon') || child.classList.contains('icon'))

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

const sampleJobModel = (): AgentJobDocumentModel => ({
  job: {
    jobId: '11111111-1111-1111-1111-111111111111', name: 'Nightly load', enabled: true, description: 'Loads warehouse', category: 'Data Collector', owner: 'sa',
    emailLevel: 2, emailOperator: 'DBA', pageLevel: 0, pageOperator: '', netSendLevel: 0, netSendOperator: '', eventLogLevel: 2, deleteLevel: 0,
    created: '2026-01-02T03:04:05', modified: '2026-11-20T14:32:07.123', version: 7, startStepId: 1, lastRun: '2026-11-20T02:00:00', lastOutcome: 1
  },
  login: 'sa', sysadmin: true, platform: 'windows', categories: ['[Uncategorized (Local)]', 'Data Collector'],
  operators: [{ name: 'DBA', enabled: true, email: true, pager: false, netSend: false, pagerDays: 127, weekday: { start: 0, end: 235959 }, saturday: { start: 0, end: 235959 }, sunday: { start: 0, end: 235959 } }],
  owners: ['sa'], steps: [{ id: 1, name: 'Extract', subsystem: 'TSQL' }],
  alerts: [{ id: 11, name: 'Log full', enabled: true, severity: 0, messageId: 9002 }], alertsEditable: true,
  mail: { checked: true, xps: true, profiles: 1, sysadmin: true, useDatabaseMail: true, agentProfile: 'Ops' }
})

const sampleOperatorsModel = (): AgentOperatorsModel => ({
  login: 'sa', sysadmin: true, platform: 'windows',
  operators: [{ id: 9, name: 'DBA', enabled: true, email: 'dba@example.test', pager: '', netSend: '', pagerDays: 127, weekday: { start: 80000, end: 180000 }, saturday: { start: 80000, end: 180000 }, sunday: { start: 80000, end: 180000 } }],
  alerts: [{ id: 7, name: 'Severity 017', enabled: true, kind: 'event', messageId: 0, severity: 17 }],
  notifications: [{ alertId: 7, operatorId: 9, methods: 1 }],
  jobs: [{ id: '11111111-1111-1111-1111-111111111111', name: 'Nightly load', email: 'DBA', page: '', netSend: '' }],
  mail: { checked: true, xps: true, profiles: 1, sysadmin: true, useDatabaseMail: true, agentProfile: 'Ops' }
})

describe('button-icon alignment CSS contract', () => {
  const rules = stylesheetRules()
  const declarationsOf = (selector: string) =>
    rules.filter(rule => !rule.at.length && rule.selector === selector).flatMap(rule => rule.declarations)
  const valueOf = (selector: string, property: string) =>
    declarationsOf(selector).find(decl => decl.property === property)?.value

  it('aligns direct-child codicon and SVG icon buttons via :where(:has(...)) without justify-content', () => {
    const baseRule = 'button:where(:has(> .codicon)), button:where(:has(> .icon))'
    expect(valueOf(baseRule, 'display')).toBe('inline-flex')
    expect(valueOf(baseRule, 'align-items')).toBe('center')
    expect(valueOf(baseRule, 'gap')).toBe('var(--varia-space-1)')
    expect(valueOf(baseRule, 'justify-content')).toBeUndefined()

    const codiconRule = 'button:where(:has(> .codicon)) > .codicon'
    expect(valueOf(codiconRule, 'flex')).toBe('none')
  })

  it('preserves .icon dimensions and avoids adding width/height/flex onto .icon elsewhere', () => {
    expect(valueOf('.icon', 'display')).toBe('block')
    expect(valueOf('.icon', 'width')).toBe('1em')
    expect(valueOf('.icon', 'height')).toBe('1em')
    expect(valueOf('.icon', 'flex')).toBe('0 0 1em')
    const extraIconLayout = rules.filter(rule =>
      rule.selector !== '.icon'
      && rule.selector.split(/,(?![^(]*\))/).some(part => /\.icon(?![\w-])/.test(part.split(/\s*[\s>+~]\s*(?![^(]*\))/).pop() ?? ''))
      && rule.declarations.some(decl => /^(?:width|height|flex(?:-basis)?)$/.test(decl.property))
    )
    expect(extraIconLayout).toEqual([])
  })

  it('centers Agent split-caret, icon-only, and timeline zoom buttons while leaving left-aligned and status buttons intact', () => {
    expect(valueOf('.agent-job-start-split > button + button', 'justify-content')).toBe('center')
    expect(valueOf('.agent-alert-chip > button[aria-label^="Remove"], .agent-proxy-chip > button', 'justify-content')).toBe('center')
    expect(valueOf('.agent-step-banner > button[aria-label="Dismiss"], .agent-last-run-head > button, .lfv-deleted > button', 'justify-content')).toBe('center')
    expect(valueOf('.agent-timeline-zoom', 'display')).toBe('inline-flex')
    expect(valueOf('.agent-timeline-zoom', 'align-items')).toBe('center')
    expect(valueOf('.agent-timeline-zoom', 'justify-content')).toBe('center')

    expect(valueOf('.agent-job-start-choice', 'display')).toBe('flex')
    expect(valueOf('.agent-job-start-choice', 'align-items')).toBe('flex-start')
    expect(valueOf('.agent-job-start-choice', 'justify-content')).toBeUndefined()
    expect(valueOf('.agent-schedule-item', 'display')).toBe('flex')
    expect(valueOf('.agent-schedule-item', 'align-items')).toBe('flex-start')
    expect(valueOf('.agent-schedule-item', 'justify-content')).toBeUndefined()
    expect(valueOf('.agent-step-tree-row', 'display')).toBe('flex')
    expect(valueOf('.agent-step-tree-row', 'align-items')).toBe('center')
    expect(valueOf('.agent-step-tree-row', 'justify-content')).toBeUndefined()

    const statusRule = '.agent-job-status button, .agent-stopped-status button'
    expect(valueOf(statusRule, 'display')).toBe('inline-flex')
    expect(valueOf(statusRule, 'align-items')).toBe('center')
    expect(valueOf(statusRule, 'gap')).toBe('var(--varia-space-1)')
    expect(valueOf(statusRule, 'height')).toBe('20px')
  })
})

describe('button-icon alignment DOM structure', () => {
  it('renders direct-child codicons on JobDocument split/alert buttons in idle and running states', async () => {
    const fixture = workbenchFixture()
    cleanups.push(() => fixture.dispose())
    fixture.api.push(readyBackend())
    fixture.connect(connectionInfo('c1'))
    const jobModel = sampleJobModel()
    fixture.api.describeObject.mockImplementation(async () => ({ ok: true, value: { agentJobDocument: jobModel, elapsedMs: 1 } as ActionDescribeResult }))
    const id = fixture.jobDocuments.openJob('c1', 'Nightly load')
    await settled()

    const host = await mount({ ...fixture, monaco: fakeMonaco(), platform: 'win32' } as unknown as Workbench, createElement(JobDocument, { documentId: id }))
    const splitButtons = Array.from(host.querySelectorAll<HTMLButtonElement>('.agent-job-start-split > button'))
    expect(splitButtons).toHaveLength(2)
    expect(splitButtons[0].textContent).toBe('Start')
    expect(directIcon(splitButtons[0]).map(el => el.getAttribute('data-icon'))).toEqual(['play'])
    expect(splitButtons[1].getAttribute('aria-label')).toBe(agentJobText.startOnce)
    expect(splitButtons[1].textContent).toBe('')
    expect(directIcon(splitButtons[1]).map(el => el.getAttribute('data-icon'))).toEqual(['chevron-down'])

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[role="tab"][data-inspector-tab="notifications"]')?.click()
    })
    const alertNewButton = host.querySelector<HTMLButtonElement>('.agent-job-alerts-new > button')!
    expect(alertNewButton.textContent).toBe(agentJobText.alertsNew)
    expect(directIcon(alertNewButton).map(el => el.getAttribute('data-icon'))).toEqual(['add'])

    const watched = (fixture.live.handles as FakeLiveHandle[]).find(item => item.owner.key === `agent-job:${id}`)!
    await act(async () => {
      watched.deliver({ type: 'live.tick', seq: 1, sampledAt: 1, samples: [{ probe: 'agent.jobs.watched', costMs: 1, effectiveIntervalMs: 2000, metrics: [1, 1, 1, 0, 1, 0] }] })
    })
    const runningStop = host.querySelector<HTMLButtonElement>('.agent-job-start-split > button.danger')!
    expect(runningStop.textContent).toBe('Stop')
    expect(directIcon(runningStop).map(el => el.getAttribute('data-icon'))).toEqual(['debug-stop'])
  })

  it('renders direct-child warning codicon on AgentJobStatus stopped button', async () => {
    const fixture = workbenchFixture()
    cleanups.push(() => fixture.dispose())
    fixture.api.push(readyBackend())
    fixture.connect(connectionInfo('c1'))
    fixture.jobActivity.open('c1')
    const handle = (fixture.live.handles as FakeLiveHandle[]).find(item => item.spec.connectionId === 'c1')!
    handle.deliver({ type: 'live.tick', seq: 1, sampledAt: 1, samples: [{ probe: 'agent.jobs.service', costMs: 1, effectiveIntervalMs: 10_000, status: [{ id: 'agentXps', value: 0 }, { id: 'serviceState', value: 1 }] }] })

    const host = await mount({ ...fixture, platform: 'win32' } as unknown as Workbench, createElement(AgentJobStatus))
    const button = host.querySelector<HTMLButtonElement>('.agent-stopped-status button')!
    expect(directIcon(button).map(el => el.getAttribute('data-icon'))).toEqual(['warning'])
  })

  it('renders direct-child SVG .icon on OperatorsDocument Send test e-mail button', async () => {
    const fixture = workbenchFixture()
    cleanups.push(() => fixture.dispose())
    fixture.api.push(readyBackend())
    fixture.connect(connectionInfo('c1'))
    const model = sampleOperatorsModel()
    fixture.api.describeObject.mockImplementation(async () => ({ ok: true, value: { agentOperators: model, elapsedMs: 1 } as ActionDescribeResult }))
    const id = fixture.operatorsDocuments.open('c1', { kind: 'agent' })
    await settled()

    const host = await mount({ ...fixture, platform: 'win32' } as unknown as Workbench, createElement(OperatorsDocument, { documentId: id }))
    const sendButton = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(btn => btn.textContent?.includes('Send test e-mail'))!
    const icons = directIcon(sendButton)
    expect(icons).toHaveLength(1)
    expect(icons[0].tagName.toLowerCase()).toBe('svg')
    expect(icons[0].classList.contains('icon')).toBe(true)
    expect(icons[0].getAttribute('data-icon')).toBe('agent-operator')
  })

  it('keeps TitleBar mnemonic buttons free of direct-child icons', async () => {
    const fixture = workbenchFixture()
    cleanups.push(() => fixture.dispose())
    const host = await mount({ ...fixture, platform: 'win32' } as unknown as Workbench, createElement(TitleBar, { title: 'Varia SQL Manager' }))
    const menuButtons = Array.from(host.querySelectorAll<HTMLButtonElement>('.title-bar-menus button'))
    expect(menuButtons.length).toBeGreaterThan(0)
    for (const button of menuButtons) {
      expect(button.querySelector('u.menu-mnemonic')).not.toBeNull()
      expect(directIcon(button)).toEqual([])
    }
  })
})

describe('capture-agent-polish CLI validation', () => {
  const runCli = (args: string[]) => {
    const result = spawnSync(process.execPath, ['scripts/capture-agent-polish.mjs', ...args], { encoding: 'utf8' })
    return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
  }

  it('prints usage cleanly on --help and validates missing/empty args and unimplemented lanes before mkdir', () => {
    const help = runCli(['--help'])
    expect(help.status).toBe(0)
    expect(help.stderr).toContain('Usage: node scripts/capture-agent-polish.mjs')

    const missingOut = runCli(['--lane', 'ap-1', '--out'])
    expect(missingOut.status).toBe(1)
    expect(missingOut.stderr).toContain('Missing value for --out')
    expect(missingOut.stderr).not.toContain('at parseArgs')

    const swallowedFlag = runCli(['--lane', 'ap-1', '--out', '--lane', 'ap-2'])
    expect(swallowedFlag.status).toBe(1)
    expect(swallowedFlag.stderr).toContain('Missing value for --out')

    const emptyOut = runCli(['--lane', 'ap-1', '--out='])
    expect(emptyOut.status).toBe(1)
    expect(emptyOut.stderr).toContain('Missing value for --out')

    const emptyLane = runCli(['--lane='])
    expect(emptyLane.status).toBe(1)
    expect(emptyLane.stderr).toContain('Missing value for --lane')

    const uncreated = join(tmpdir(), `varia-ap6-does-not-write-${Date.now()}`)
    expect(existsSync(uncreated)).toBe(false)
    try {
      const unimplemented = runCli(['--lane', 'ap-6', '--out', uncreated])
      expect(unimplemented.status).toBe(1)
      expect(unimplemented.stderr).toContain('Lane ap-6 capture will be implemented in AP-6.')
      expect(existsSync(uncreated)).toBe(false)
    } finally {
      rmSync(uncreated, { recursive: true, force: true })
    }
  })
})
