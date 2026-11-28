// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { ActionDescribeResult } from '../src/shared/actions/schema'
import type { AgentJobDocumentModel } from '../src/shared/actions/agent-job'
import { severalCell, severalRowDraft } from '../src/shared/agent/create-several'
import { liveProbes } from '../src/shared/live/catalog'
import CreateSeveral from '../src/renderer/src/agent/CreateSeveral'
import JobDocument from '../src/renderer/src/agent/JobDocument'
import JobSteps, { stepTypeBadge } from '../src/renderer/src/agent/JobSteps'
import { flowCamera, setFlowCamera } from '../src/renderer/src/agent/step-models'
import type { LiveTable } from '../src/renderer/src/live/LiveService'
import { WorkbenchProvider } from '../src/renderer/src/core/WorkbenchContext'
import type { Workbench } from '../src/renderer/src/core/workbench'
import { stylesheetRules } from './fixtures/css-rules'
import type { FakeLiveHandle } from './fixtures/live-handle'
import { connectionInfo, readyBackend, workbenchFixture } from './fixtures/workbench'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const settled = async () => { for (let turn = 0; turn < 10; turn++) await new Promise(resolve => setImmediate(resolve)) }
const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()) })

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

describe('JobSteps balanced 3-column step cards (CSS + DOM contract)', () => {
  const rules = stylesheetRules()
  const valueOf = (selector: string, property: string) =>
    rules.filter(rule => !rule.at.length && rule.selector.replace(/\s+/g, ' ').trim() === selector)
      .flatMap(rule => rule.declarations)
      .find(decl => decl.property === property)?.value

  it('defines a 44px fixed type badge + equal 1fr success/failure grid with instant selection transition', () => {
    expect(valueOf('.agent-job-steps-fill .agent-step-flow', 'display')).toBe('grid')
    expect(valueOf('.agent-job-steps-fill .agent-step-flow', 'grid-template-columns')).toBe('44px minmax(0, 1fr) minmax(0, 1fr)')
    expect(valueOf('.agent-job-steps-fill .agent-step-type', 'width')).toBe('44px')
    expect(valueOf('.agent-job-steps-fill .agent-step-type', 'overflow')).toBe('hidden')
    expect(valueOf('.agent-job-steps-fill .agent-step-type', 'text-overflow')).toBe('ellipsis')
    expect(valueOf('.agent-job-steps-fill .agent-step-type', 'white-space')).toBe('nowrap')
    expect(valueOf('.agent-job-steps-fill .agent-step-type', 'font-family')).toBe('var(--varia-font-mono)')
    expect(valueOf('.agent-job-steps-fill .agent-step-item[aria-selected="true"]', 'transition')).toBe('none')
    expect(valueOf('.agent-job-steps-fill .agent-step-ok, .agent-job-steps-fill .agent-step-bad', 'white-space')).toBe('nowrap')
  })

  it('prevents SSIS nested scrollers, stacks narrow SSIS/schedule fields, removes Create several columns cap, and keeps forced-colors selection visible', () => {
    const atValueOf = (atMatch: string, selector: string, property: string) =>
      rules.filter(rule => rule.at.some(at => at.includes(atMatch)) && rule.selector.replace(/\s+/g, ' ').trim() === selector)
        .flatMap(rule => rule.declarations)
        .find(decl => decl.property === property)?.value

    expect(valueOf('.agent-job-steps-fill .varia-split-main .agent-step-ssis', 'flex')).toBe('none')
    expect(valueOf('.agent-job-steps-fill .varia-split-main .agent-step-ssis', 'overflow')).toBe('visible')
    expect(valueOf('.agent-job-steps-fill .varia-split-main .agent-step-ssis', 'overflow-y')).toBeUndefined()
    expect(valueOf('.agent-job-steps-fill .varia-split-main .agent-step-ssis-tree', 'max-height')).toBe('none')
    expect(valueOf('.agent-job-steps-fill .varia-split-main .agent-step-ssis-tree', 'overflow')).toBe('visible')
    expect(atValueOf('step-edit (max-width: 440px)', '.agent-job-steps-fill .varia-split-main .agent-step-ssis-pick', 'grid-template-columns')).toBe('minmax(0, 1fr)')
    expect(atValueOf('job-schedules-main (max-width: 440px)', '.agent-job-schedules-main .property-field-note, .agent-job-schedules-main .property-field-error', 'grid-column')).toBe('1')
    expect(valueOf('.document-frame[data-agent-several] .agent-several-columns', 'max-height')).toBe('none')
    expect(valueOf('.document-frame[data-agent-several] .agent-several-columns', 'overflow')).toBe('visible')

    const forcedRules = rules.filter(rule => rule.at.some(at => at.includes('forced-colors: active')))
    for (const target of [
      '.agent-job-steps-fill .agent-step-item[aria-selected="true"]',
      '.agent-job-schedules-fill .agent-schedule-item[aria-current]',
      '.agent-job-history-fill .agent-job-history-runs button[aria-pressed="true"]'
    ]) {
      const decls = forcedRules.filter(rule => rule.selector.split(',').map(part => part.replace(/\s+/g, ' ').trim()).includes(target)).flatMap(rule => rule.declarations)
      expect(decls.find(d => d.property === 'background')?.value, target).toBe('Highlight')
      expect(decls.find(d => d.property === 'color')?.value, target).toBe('HighlightText')
      expect(decls.find(d => d.property === 'forced-color-adjust')?.value, target).toBe('none')
    }
  })

  it('maps subsystem badges case-insensitively while keeping full subsystem labels in titles', () => {
    expect(stepTypeBadge('TSQL')).toBe('TSQL')
    expect(stepTypeBadge(' tsql ')).toBe('TSQL')
    expect(stepTypeBadge('SSIS')).toBe('SSIS')
    expect(stepTypeBadge('PowerShell')).toBe('PS')
    expect(stepTypeBadge('powershell')).toBe('PS')
    expect(stepTypeBadge('CmdExec')).toBe('Cmd')
    expect(stepTypeBadge('cmdexec')).toBe('Cmd')
    expect(stepTypeBadge('ANALYSISCOMMAND')).toBe('SSAS')
    expect(stepTypeBadge('analysisquery')).toBe('SSAS')
    expect(stepTypeBadge('Distribution')).toBe('Repl')
    expect(stepTypeBadge('logreader')).toBe('Repl')
    expect(stepTypeBadge('ActiveScripting')).toBe('ActiveScripting')
  })

  it('renders identical 3-column flow children across TSQL, SSIS, and PowerShell step cards', async () => {
    const fixture = workbenchFixture()
    cleanups.push(() => fixture.dispose())
    fixture.api.push(readyBackend())
    fixture.connect(connectionInfo('c1'))

    const jobModel: AgentJobDocumentModel = {
      job: {
        jobId: '11111111-1111-1111-1111-111111111111', name: 'Mixed steps', enabled: true, description: '', category: '[Uncategorized (Local)]', owner: 'sa',
        emailLevel: 0, emailOperator: '', pageLevel: 0, pageOperator: '', netSendLevel: 0, netSendOperator: '', eventLogLevel: 0, deleteLevel: 0,
        created: '2026-01-02T03:04:05', modified: '2026-11-20T14:32:07.123', version: 1, startStepId: 1
      },
      login: 'sa', sysadmin: true, platform: 'windows', categories: ['[Uncategorized (Local)]'],
      steps: [
        { id: 1, name: 'Check integrity', subsystem: 'TSQL', command: 'SELECT 1;', flags: 0, cmdexecSuccessCode: 0, onSuccessAction: 3, onSuccessStepId: 0, onFailAction: 2, onFailStepId: 0, server: '', databaseName: 'master', databaseUserName: '', retryAttempts: 0, retryInterval: 0, osRunPriority: 0, outputFileName: '', proxyId: 0 },
        { id: 2, name: 'Load warehouse', subsystem: 'SSIS', command: '', flags: 0, cmdexecSuccessCode: 0, onSuccessAction: 4, onSuccessStepId: 3, onFailAction: 2, onFailStepId: 0, server: '', databaseName: '', databaseUserName: '', retryAttempts: 0, retryInterval: 0, osRunPriority: 0, outputFileName: '', proxyId: 0 },
        { id: 3, name: 'Cleanup archive', subsystem: 'PowerShell', command: 'Write-Output 1', flags: 32, cmdexecSuccessCode: 0, onSuccessAction: 1, onSuccessStepId: 0, onFailAction: 4, onFailStepId: 1, server: '', databaseName: '', databaseUserName: '', retryAttempts: 0, retryInterval: 0, osRunPriority: 0, outputFileName: '', proxyId: 0 }
      ],
      alertsEditable: true, mail: { checked: false, sysadmin: true }, subsystems: ['TSQL', 'SSIS', 'PowerShell', 'CmdExec']
    }
    fixture.api.describeObject.mockImplementation(async () => ({ ok: true, value: { agentJobDocument: jobModel, elapsedMs: 1 } as ActionDescribeResult }))
    const id = fixture.jobDocuments.openJob('c1', 'Mixed steps')
    await settled()
    const state = fixture.jobDocuments.get(id)!

    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const wb = {
      ...fixture,
      theme: { getSnapshot: () => fixture.theme.state, subscribe: () => () => {} },
      monaco: fakeMonaco(),
      platform: 'win32'
    } as unknown as Workbench
    await act(async () => {
      root.render(createElement(WorkbenchProvider, {
        workbench: wb,
        children: createElement(JobSteps, { state, model: state.model!, draft: state.draft!, editable: true, service: fixture.jobDocuments })
      }))
    })
    cleanups.unshift(() => { act(() => root.unmount()); host.remove() })

    const cards = Array.from(host.querySelectorAll<HTMLElement>('.agent-step-item'))
    expect(cards).toHaveLength(3)
    const summary = cards.map(card => {
      const flow = card.querySelector('.agent-step-flow')!
      const children = Array.from(flow.children)
      return {
        classes: children.map(el => el.className),
        badge: children[0]?.textContent,
        badgeTitle: children[0]?.getAttribute('title'),
        okIcon: children[1]?.querySelector('[data-icon]')?.getAttribute('data-icon'),
        badIcon: children[2]?.querySelector('[data-icon]')?.getAttribute('data-icon')
      }
    })
    expect(summary).toEqual([
      { classes: ['agent-step-type', 'agent-step-ok', 'agent-step-bad'], badge: 'TSQL', badgeTitle: 'Transact-SQL script (T-SQL)', okIcon: 'check', badIcon: 'close' },
      { classes: ['agent-step-type', 'agent-step-ok', 'agent-step-bad'], badge: 'SSIS', badgeTitle: 'SQL Server Integration Services Package', okIcon: 'check', badIcon: 'close' },
      { classes: ['agent-step-type', 'agent-step-ok', 'agent-step-bad'], badge: 'PS', badgeTitle: 'PowerShell', okIcon: 'check', badIcon: 'close' }
    ])
  })
})

describe('JobDocument, JobStepsFlow, and CreateSeveral AP-2 regressions', () => {
  it('keeps Duration KPI on the unfiltered latest run when Failed filter is active, renders Disabled as neutral, and jumps to tabs from Vitals Problems', async () => {
    const fixture = workbenchFixture()
    cleanups.push(() => fixture.dispose())
    fixture.api.push(readyBackend())
    fixture.connect(connectionInfo('c1'))

    const jobId = '11111111-1111-1111-1111-111111111111'
    const jobModel: AgentJobDocumentModel = {
      job: {
        jobId, name: 'Nightly', enabled: false, description: '', category: '[Uncategorized (Local)]', owner: 'sa',
        emailLevel: 2, emailOperator: '', pageLevel: 0, pageOperator: '', netSendLevel: 0, netSendOperator: '', eventLogLevel: 0, deleteLevel: 0,
        created: '2026-01-02T03:04:05', modified: '2026-11-20T14:32:07.123', version: 1, startStepId: 1, lastOutcome: 0
      },
      login: 'sa', sysadmin: true, platform: 'windows', categories: ['[Uncategorized (Local)]'],
      operators: [{ name: 'DBA', enabled: true, email: true, pager: false, netSend: false, pagerDays: 0, weekday: { start: 0, end: 235959 }, saturday: { start: 0, end: 235959 }, sunday: { start: 0, end: 235959 } }],
      steps: [{ id: 1, name: '', subsystem: 'TSQL', command: 'SELECT 1;', onSuccessAction: 1, onFailAction: 2 }],
      alertsEditable: true, mail: { checked: false, sysadmin: true }, subsystems: ['TSQL']
    }
    fixture.api.describeObject.mockImplementation(async () => ({ ok: true, value: { agentJobDocument: jobModel, elapsedMs: 1 } as ActionDescribeResult }))
    const id = fixture.jobDocuments.openJob('c1', 'Nightly')
    await settled()

    fixture.jobDocuments.openHistory(id)
    fixture.jobDocuments.history.attach(id, jobId)
    const handle = (fixture.live.handles as FakeLiveHandle[]).find(item => item.spec.source === 'agent.history')!
    const tableOf = (index: number, rows: Record<string, string>[]): LiveTable => {
      const columns = liveProbes['agent.history.list'].tables![index].columns.map(column => column.id)
      const cells = rows.map(row => columns.map(column => row[column] ?? ''))
      return {
        handle: { getWindow: async (first: number, count: number) => { const slice = cells.slice(first, first + count); return { first, count: slice.length, colStart: 0, colEnd: columns.length, text: slice.flat(), flags: new Uint8Array(slice.length * columns.length) } } },
        descriptor: { rowsAvailable: rows.length, columns: columns.map(() => ({})) }
      } as unknown as LiveTable
    }
    const deliverRuns = async (rows: Record<string, string>[]) => {
      handle.tables.set('agent.history.list:0', tableOf(0, rows))
      handle.tables.set('agent.history.list:1', tableOf(1, []))
      handle.tables.set('agent.history.list:3', tableOf(3, [{ usualStep: '0', usualSeconds: '60', usualRuns: '1' }]))
      handle.deliver({ type: 'live.tick', seq: 1, sampledAt: 1, samples: [{ probe: 'agent.history.list', costMs: 1, effectiveIntervalMs: 15_000, tables: [] as never }] })
      await settled()
    }
    await deliverRuns([
      { runDate: '2026-11-22 02:00:00', runJob: 'Nightly', runOutcome: 'Succeeded', runDuration: '00:01:00', runSteps: '1', runMessage: 'ok', runKey: `${jobId}:20`, runJobId: jobId, runTone: '' },
      { runDate: '2026-11-21 02:00:00', runJob: 'Nightly', runOutcome: 'Failed', runDuration: '00:05:00', runSteps: '1', runMessage: 'bad', runKey: `${jobId}:19`, runJobId: jobId, runTone: 'error' }
    ])
    fixture.jobDocuments.history.setFailedOnly(id, true)
    await deliverRuns([
      { runDate: '2026-11-21 02:00:00', runJob: 'Nightly', runOutcome: 'Failed', runDuration: '00:05:00', runSteps: '1', runMessage: 'bad', runKey: `${jobId}:19`, runJobId: jobId, runTone: 'error' }
    ])

    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const wb = {
      ...fixture,
      theme: { getSnapshot: () => fixture.theme.state, subscribe: () => () => {} },
      monaco: fakeMonaco(),
      platform: 'win32'
    } as unknown as Workbench
    await act(async () => {
      root.render(createElement(WorkbenchProvider, { workbench: wb, children: createElement(JobDocument, { documentId: id }) }))
    })
    cleanups.unshift(() => { act(() => root.unmount()); host.remove() })

    const durationKpi = Array.from(host.querySelectorAll('.inspector-kpi-item')).find(el => el.querySelector('.inspector-kpi-label')?.textContent === 'Duration')
    expect(durationKpi?.querySelector('.inspector-kpi-value')?.textContent).toContain('00:01:00')

    const disabledPill = Array.from(host.querySelectorAll<HTMLElement>('.status-pill')).find(el => el.textContent?.includes('Disabled'))
    expect(disabledPill?.dataset.tone).toBe('neutral')

    const problemButtons = Array.from(host.querySelectorAll<HTMLButtonElement>('.agent-job-vitals-problem'))
    expect(problemButtons.length).toBeGreaterThanOrEqual(2)
    const notifyBtn = problemButtons.find(btn => btn.textContent?.includes('Choose the operator to notify'))!
    await act(async () => { notifyBtn.click() })
    expect(fixture.jobDocuments.get(id)?.frame.section).toBe('notifications')
    const stepBtn = problemButtons.find(btn => btn.textContent?.includes('Step 1'))!
    await act(async () => { stepBtn.click() })
    expect(fixture.jobDocuments.get(id)?.frame.section).toBe('steps')
  })

  it('preserves saved flowCamera on JobStepsFlow remount without calling revealSelected', async () => {
    const fixture = workbenchFixture()
    cleanups.push(() => fixture.dispose())
    fixture.api.push(readyBackend())
    fixture.connect(connectionInfo('c1'))

    const jobModel: AgentJobDocumentModel = {
      job: {
        jobId: '11111111-1111-1111-1111-111111111111', name: 'Flow cam', enabled: true, description: '', category: '[Uncategorized (Local)]', owner: 'sa',
        emailLevel: 0, emailOperator: '', pageLevel: 0, pageOperator: '', netSendLevel: 0, netSendOperator: '', eventLogLevel: 0, deleteLevel: 0,
        created: '2026-01-02T03:04:05', modified: '2026-11-20T14:32:07.123', version: 1, startStepId: 1
      },
      login: 'sa', sysadmin: true, platform: 'windows', categories: ['[Uncategorized (Local)]'],
      steps: [{ id: 1, name: 'Step 1', subsystem: 'TSQL', onSuccessAction: 3 }, { id: 2, name: 'Step 2', subsystem: 'TSQL', onSuccessAction: 1 }],
      alertsEditable: true, mail: { checked: false, sysadmin: true }, subsystems: ['TSQL']
    }
    fixture.api.describeObject.mockImplementation(async () => ({ ok: true, value: { agentJobDocument: jobModel, elapsedMs: 1 } as ActionDescribeResult }))
    const id = fixture.jobDocuments.openJob('c1', 'Flow cam')
    await settled()
    fixture.jobDocuments.setStepsView(id, 'flow')

    const savedCam = { x: 50, y: -500, scale: 1.5 }
    setFlowCamera(id, savedCam)

    const capturedOptions: { camera?: unknown; revealSelected?: boolean }[] = []
    const reveals: number[] = []
    vi.doMock('../src/renderer/src/agent/FlowCanvas', () => ({
      FlowCanvas: class {
        constructor(options: { camera?: unknown; revealSelected?: boolean }) { capturedOptions.push(options) }
        update() {}
        colors() {}
        reveal(index: number) { reveals.push(index) }
        recenter() {}
        dispose() {}
      }
    }))
    let observerCb: IntersectionObserverCallback | undefined
    let observedTarget: Element | undefined
    const origIntersectionObserver = globalThis.IntersectionObserver
    globalThis.IntersectionObserver = class {
      constructor(cb: IntersectionObserverCallback) { observerCb = cb }
      observe(target: Element) { observedTarget = target; observerCb?.([{ isIntersecting: true, target } as IntersectionObserverEntry], this as unknown as IntersectionObserver) }
      disconnect() {}
      unobserve() {}
      takeRecords() { return [] }
      readonly root = null
      readonly rootMargin = ''
      readonly thresholds = []
    } as unknown as typeof IntersectionObserver
    cleanups.push(() => { globalThis.IntersectionObserver = origIntersectionObserver; vi.doUnmock('../src/renderer/src/agent/FlowCanvas') })

    const { default: JobStepsFlow } = await import('../src/renderer/src/agent/JobStepsFlow')
    const state = fixture.jobDocuments.get(id)!
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const wb = {
      ...fixture,
      theme: { getSnapshot: () => fixture.theme.state, subscribe: () => () => {} },
      monaco: fakeMonaco(),
      platform: 'win32'
    } as unknown as Workbench
    const render = async () => {
      const current = fixture.jobDocuments.get(id)!
      await act(async () => {
        root.render(createElement(WorkbenchProvider, {
          workbench: wb,
          children: createElement(JobStepsFlow, { state: current, model: current.model!, draft: current.draft!, editable: true, service: fixture.jobDocuments, switcher: null, editor: () => null })
        }))
      })
      await settled()
    }
    await render()
    cleanups.unshift(() => { act(() => root.unmount()); host.remove() })

    expect(capturedOptions).toHaveLength(1)
    expect(capturedOptions[0]?.camera).toEqual(savedCam)
    expect(capturedOptions[0]?.revealSelected).toBe(false)
    expect(flowCamera(id)).toEqual(savedCam)

    // Toggle onScreen true -> false -> true BEFORE cameraChanged ever fires: savedCam must still be preserved
    await act(async () => {
      observerCb?.([{ isIntersecting: false, target: observedTarget! } as IntersectionObserverEntry], {} as IntersectionObserver)
    })
    await settled()
    await act(async () => {
      observerCb?.([{ isIntersecting: true, target: observedTarget! } as IntersectionObserverEntry], {} as IntersectionObserver)
    })
    await settled()

    expect(capturedOptions).toHaveLength(2)
    expect(capturedOptions[1]?.camera).toEqual(savedCam)
    expect(capturedOptions[1]?.revealSelected).toBe(false)
    expect(flowCamera(id)).toEqual(savedCam)

    // Post-mount selection change calls canvas.current.reveal(selected)
    fixture.jobDocuments.selectStep(id, state.draft!.steps.steps[1]!.key)
    await render()
    expect(reveals).toEqual([1])

    // Off-screen selection change preserves savedCam and sets revealSelected: true on next mount
    await act(async () => {
      observerCb?.([{ isIntersecting: false, target: observedTarget! } as IntersectionObserverEntry], {} as IntersectionObserver)
    })
    await settled()
    fixture.jobDocuments.selectStep(id, state.draft!.steps.steps[0]!.key)
    await render()
    await act(async () => {
      observerCb?.([{ isIntersecting: true, target: observedTarget! } as IntersectionObserverEntry], {} as IntersectionObserver)
    })
    await settled()

    expect(capturedOptions).toHaveLength(3)
    expect(capturedOptions[2]?.camera).toEqual(savedCam)
    expect(capturedOptions[2]?.revealSelected).toBe(true)
  })

  it('renders collision-free select options in CreateSeveral for empty (none), real "(none)"/"__inherit__" names, and inherit revert', async () => {
    const op = (name: string) => ({ name, enabled: true, email: true, pager: false, netSend: false, pagerDays: 0, weekday: { start: 0, end: 235959 }, saturday: { start: 0, end: 235959 }, sunday: { start: 0, end: 235959 } })
    const setupSelect = async (baseOperator: string) => {
      const fixture = workbenchFixture()
      cleanups.push(() => fixture.dispose())
      fixture.api.push(readyBackend())
      fixture.connect(connectionInfo('c1'))

      const sourceModel: AgentJobDocumentModel = {
        job: {
          jobId: '11111111-1111-1111-1111-111111111111', name: 'Source job', enabled: true, description: '', category: '[Uncategorized (Local)]', owner: 'sa',
          emailLevel: 2, emailOperator: baseOperator, pageLevel: 0, pageOperator: '', netSendLevel: 0, netSendOperator: '', eventLogLevel: 0, deleteLevel: 0,
          created: '2026-01-02T03:04:05', modified: '2026-11-20T14:32:07.123', version: 1, startStepId: 1
        },
        login: 'sa', sysadmin: true, platform: 'windows', categories: ['[Uncategorized (Local)]'],
        operators: [op('DBA'), op('Ops'), op('__inherit__'), op('(none)')],
        steps: [{ id: 1, name: 'Step 1', subsystem: 'TSQL', command: 'SELECT 1;', databaseName: 'master', onSuccessAction: 1, onFailAction: 2 }],
        alertsEditable: true, mail: { checked: false, sysadmin: true }, subsystems: ['TSQL']
      }
      fixture.api.describeObject.mockImplementation(async params => ({
        ok: true,
        value: { agentJobDocument: params.target.kind === 'agent' ? { ...sourceModel, job: undefined, steps: [], alerts: undefined, schedules: [], jobs: ['Source job'] } : sourceModel, elapsedMs: 1 } as ActionDescribeResult
      }))
      const id = fixture.jobDocuments.createLike('c1', 'Source job')
      await settled()
      fixture.jobDocuments.createSeveral(id)
      fixture.jobDocuments.setSeveralColumn(id, 'emailOperator', true)

      const host = document.createElement('div')
      document.body.append(host)
      const root = createRoot(host)
      const wb = {
        ...fixture,
        theme: { getSnapshot: () => fixture.theme.state, subscribe: () => () => {} },
        monaco: fakeMonaco(),
        platform: 'win32'
      } as unknown as Workbench
      const render = async () => {
        await act(async () => {
          root.render(createElement(WorkbenchProvider, {
            workbench: wb,
            children: createElement(CreateSeveral, { state: fixture.jobDocuments.get(id)!, service: fixture.jobDocuments })
          }))
        })
      }
      await render()
      cleanups.unshift(() => { act(() => root.unmount()); host.remove() })
      const select = host.querySelector<HTMLSelectElement>('select[aria-label="E-mail · operator, row 1"]')!
      const choose = async (option: HTMLOptionElement) => {
        await act(async () => {
          select.value = option.value
          select.dispatchEvent(new Event('change', { bubbles: true }))
        })
        await render()
      }
      return { fixture, id, select, choose, render }
    }

    // 1. base === 'DBA' with operators ['DBA', 'Ops', '__inherit__', '(none)']
    {
      const { fixture, id, select, choose, render } = await setupSelect('DBA')
      const options = Array.from(select.options)
      const values = options.map(opt => opt.value)
      expect(options.map(opt => opt.textContent)).toEqual(['DBA', '(none)', 'Ops', '__inherit__', '(none)'])
      expect(new Set(values).size).toBe(5)
      expect(select.value).toBe('inherit')

      const context = fixture.jobDocuments.severalContextOf(id)!
      const column = context.columns.find(c => c.id === 'emailOperator')!
      const row = () => fixture.jobDocuments.get(id)!.several!.table.rows[0]!

      // Probe: select empty (none) -> cell.value === '' (NOT '(none)' operator) and blocking check fires
      const emptyNoneOption = options[1]!
      await choose(emptyNoneOption)
      expect(row().cells.emailOperator).toBe('')
      expect(select.value).toBe(emptyNoneOption.value)
      expect(severalCell(context, row(), column)).toEqual({ value: '', inherited: false, changed: true })
      expect(severalRowDraft(context, row()).draft.emailOperator).toBe('')
      expect(fixture.jobDocuments.severalChecks(id).get(row().key)?.blocking).toContain('Choose the operator to notify.')

      // Probe: select real operator named '(none)' -> draft.emailOperator === '(none)' and no missing-operator error
      const realNoneOption = options[4]!
      await choose(realNoneOption)
      expect(row().cells.emailOperator).toBe('(none)')
      expect(select.value).toBe(realNoneOption.value)
      expect(severalRowDraft(context, row()).draft.emailOperator).toBe('(none)')
      expect(fixture.jobDocuments.severalChecks(id).get(row().key)?.blocking).not.toContain('Choose the operator to notify.')

      // Probe: select real operator named '__inherit__' -> draft.emailOperator === '__inherit__', NOT reset to 'DBA'
      const realInheritOption = options[3]!
      await choose(realInheritOption)
      expect(row().cells.emailOperator).toBe('__inherit__')
      expect(select.value).toBe(realInheritOption.value)
      expect(severalRowDraft(context, row()).draft.emailOperator).toBe('__inherit__')

      // Revert to template inherit ('DBA') -> clears row.cells.emailOperator and marks changed: false
      await choose(options[0]!)
      expect(row().cells.emailOperator).toBeUndefined()
      expect(select.value).toBe('inherit')
      expect(severalCell(context, row(), column)).toEqual({ value: 'DBA', inherited: true, changed: false })
      expect(severalRowDraft(context, row()).draft.emailOperator).toBe('DBA')

      // Full-editor edit followed by inherit revert resets edited value back to template 'DBA'
      const editorId = fixture.jobDocuments.openSeveralRow(id, 'r1')!
      fixture.jobDocuments.updateDraft(editorId, { emailOperator: 'Ops' })
      fixture.jobDocuments.backToTable(editorId)
      await settled()
      await render()
      expect(select.value).toBe(options[2]!.value)
      await choose(options[0]!)
      expect(row().cells.emailOperator).toBeUndefined()
      expect(select.value).toBe('inherit')
      expect(severalRowDraft(context, row()).draft.emailOperator).toBe('DBA')
      expect(severalCell(context, row(), column)).toEqual({ value: 'DBA', inherited: true, changed: false })
    }

    // 2. base === '' with operators ['DBA', 'Ops', '__inherit__', '(none)']
    {
      const { fixture, id, select, choose } = await setupSelect('')
      const options = Array.from(select.options)
      const values = options.map(opt => opt.value)
      expect(options.map(opt => opt.textContent)).toEqual(['(none)', 'DBA', 'Ops', '__inherit__', '(none)'])
      expect(new Set(values).size).toBe(5)
      expect(select.value).toBe('inherit')

      const context = fixture.jobDocuments.severalContextOf(id)!
      const row = () => fixture.jobDocuments.get(id)!.several!.table.rows[0]!

      await choose(options[4]!)
      expect(row().cells.emailOperator).toBe('(none)')
      expect(severalRowDraft(context, row()).draft.emailOperator).toBe('(none)')

      await choose(options[3]!)
      expect(row().cells.emailOperator).toBe('__inherit__')
      expect(severalRowDraft(context, row()).draft.emailOperator).toBe('__inherit__')

      await choose(options[0]!)
      expect(row().cells.emailOperator).toBeUndefined()
      expect(severalRowDraft(context, row()).draft.emailOperator).toBe('')
    }
  })

  it('normalizes pasted select values matching template base to inherit without data-changed while flagging bogus pastes as custom', async () => {
    const op = (name: string) => ({ name, enabled: true, email: true, pager: false, netSend: false, pagerDays: 0, weekday: { start: 0, end: 235959 }, saturday: { start: 0, end: 235959 }, sunday: { start: 0, end: 235959 } })
    const setupPaste = async (baseOperator: string, operatorNames: string[]) => {
      const fixture = workbenchFixture()
      cleanups.push(() => fixture.dispose())
      fixture.api.push(readyBackend())
      fixture.connect(connectionInfo('c1'))

      const sourceModel: AgentJobDocumentModel = {
        job: {
          jobId: '11111111-1111-1111-1111-111111111111', name: 'Source job', enabled: true, description: '', category: '[Uncategorized (Local)]', owner: 'sa',
          emailLevel: 2, emailOperator: baseOperator, pageLevel: 0, pageOperator: '', netSendLevel: 0, netSendOperator: '', eventLogLevel: 0, deleteLevel: 0,
          created: '2026-01-02T03:04:05', modified: '2026-11-20T14:32:07.123', version: 1, startStepId: 1
        },
        login: 'sa', sysadmin: true, platform: 'windows', categories: ['[Uncategorized (Local)]'],
        operators: operatorNames.map(op),
        steps: [{ id: 1, name: 'Step 1', subsystem: 'TSQL', command: 'SELECT 1;', databaseName: 'master', onSuccessAction: 1, onFailAction: 2 }],
        schedules: [{
          id: 9, name: 'Nightly 02:30', enabled: true, freqType: 4, freqInterval: 1, freqSubdayType: 1, freqSubdayInterval: 0,
          freqRelativeInterval: 0, freqRecurrenceFactor: 0, activeStartDate: 20261101, activeEndDate: 99991231,
          activeStartTime: 23000, activeEndTime: 235959, jobCount: 1, owner: 'sa', version: 2, modified: '2026-11-01T02:30:00.000'
        }],
        alertsEditable: true, mail: { checked: false, sysadmin: true }, subsystems: ['TSQL']
      }
      fixture.api.describeObject.mockImplementation(async params => ({
        ok: true,
        value: { agentJobDocument: params.target.kind === 'agent' ? { ...sourceModel, job: undefined, steps: [], alerts: undefined, schedules: [], jobs: ['Source job'] } : sourceModel, elapsedMs: 1 } as ActionDescribeResult
      }))
      const id = fixture.jobDocuments.createLike('c1', 'Source job')
      await settled()
      fixture.jobDocuments.createSeveral(id)
      fixture.jobDocuments.setSeveralColumn(id, 'emailOperator', true)

      const host = document.createElement('div')
      document.body.append(host)
      const root = createRoot(host)
      const wb = {
        ...fixture,
        theme: { getSnapshot: () => fixture.theme.state, subscribe: () => () => {} },
        monaco: fakeMonaco(),
        platform: 'win32'
      } as unknown as Workbench
      const render = async () => {
        await act(async () => {
          root.render(createElement(WorkbenchProvider, {
            workbench: wb,
            children: createElement(CreateSeveral, { state: fixture.jobDocuments.get(id)!, service: fixture.jobDocuments })
          }))
        })
      }
      cleanups.unshift(() => { act(() => root.unmount()); host.remove() })
      return { fixture, id, host, render }
    }

    // 1. base === 'DBA' with shared schedule ('share'), pasting 'dba' + 'Share', and pasting 'bogus', plus literal names
    {
      const { fixture, id, host, render } = await setupPaste('DBA', ['DBA', 'Ops', '__inherit__', 'inherit', 'opt:0', 'custom'])
      const cols = fixture.jobDocuments.get(id)!.several!.table.columns
      const line = (name: string, email: string, sched: string) =>
        cols.map(c => c === 'name' ? name : c === 'emailOperator' ? email : c === 'schedule:9' ? sched : '').join('\t')
      fixture.jobDocuments.pasteSeveral(id, [
        line('Job Inherit', 'dba', 'Share'),
        line('Job Bogus', 'bogus', 'Share'),
        line('Job RealCustom', 'custom', 'Share')
      ].join('\n'))
      await render()

      const emailRow2 = host.querySelector<HTMLSelectElement>('select[aria-label="E-mail · operator, row 2"]')!
      const schedRow2 = host.querySelector<HTMLSelectElement>('select[aria-label="Schedule · Nightly 02:30, row 2"]')!
      expect(emailRow2.value).toBe('inherit')
      expect(emailRow2.closest('td')?.getAttribute('data-changed')).toBeNull()
      expect(emailRow2.querySelector('option[value="custom"]')).toBeNull()
      expect(schedRow2.value).toBe('inherit')
      expect(schedRow2.closest('td')?.getAttribute('data-changed')).toBeNull()

      const emailRow3 = host.querySelector<HTMLSelectElement>('select[aria-label="E-mail · operator, row 3"]')!
      expect(emailRow3.value).toBe('custom')
      expect(emailRow3.getAttribute('aria-invalid')).toBe('true')
      expect(emailRow3.closest('td')?.getAttribute('data-changed')).toBe('true')
      expect(emailRow3.querySelector('option[value="custom"]')?.textContent).toBe('bogus')

      const emailRow4 = host.querySelector<HTMLSelectElement>('select[aria-label="E-mail · operator, row 4"]')!
      expect(emailRow4.value).not.toBe('custom')
      expect(emailRow4.value).not.toBe('inherit')
      expect(emailRow4.getAttribute('aria-invalid')).toBeNull()
      expect(severalRowDraft(fixture.jobDocuments.severalContextOf(id)!, fixture.jobDocuments.get(id)!.several!.table.rows[3]!).draft.emailOperator).toBe('custom')
    }

    // 2. base === '' without literal '(none)' operator -> pasted '(none)' resolves to 'inherit' with no data-changed
    {
      const { fixture, id, host, render } = await setupPaste('', ['DBA', 'Ops'])
      const cols = fixture.jobDocuments.get(id)!.several!.table.columns
      fixture.jobDocuments.pasteSeveral(id, cols.map(c => c === 'name' ? 'Job Empty' : c === 'emailOperator' ? '(none)' : '').join('\t'))
      await render()

      const emailRow2 = host.querySelector<HTMLSelectElement>('select[aria-label="E-mail · operator, row 2"]')!
      expect(emailRow2.value).toBe('inherit')
      expect(emailRow2.closest('td')?.getAttribute('data-changed')).toBeNull()
      expect(emailRow2.querySelector('option[value="custom"]')).toBeNull()
    }

    // 3. base === '' WITH literal '(none)' operator -> pasted '(none)' selects the literal operator option
    {
      const { fixture, id, host, render } = await setupPaste('', ['DBA', '(none)'])
      const cols = fixture.jobDocuments.get(id)!.several!.table.columns
      fixture.jobDocuments.pasteSeveral(id, cols.map(c => c === 'name' ? 'Job LiteralNone' : c === 'emailOperator' ? '(none)' : '').join('\t'))
      await render()

      const emailRow2 = host.querySelector<HTMLSelectElement>('select[aria-label="E-mail · operator, row 2"]')!
      expect(emailRow2.value).toBe('opt:1')
      expect(emailRow2.closest('td')?.getAttribute('data-changed')).toBe('true')
      const row = fixture.jobDocuments.get(id)!.several!.table.rows[1]!
      expect(severalRowDraft(fixture.jobDocuments.severalContextOf(id)!, row).draft.emailOperator).toBe('(none)')
      expect(fixture.jobDocuments.severalChecks(id).get(row.key)?.blocking).not.toContain('Choose the operator to notify.')
    }
  })
})
