// @vitest-environment happy-dom
// The Schedules document's grid (AG-10): the SQLAgentOperatorRole answer arrives after the schedules, and the grid's Enabled box on
// another login's schedule follows it at once, not only after the next selection or filter.
import { afterEach, describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import SchedulesDocument from '../src/renderer/src/agent/SchedulesDocument'
import { WorkbenchProvider } from '../src/renderer/src/core/WorkbenchContext'
import type { Workbench } from '../src/renderer/src/core/workbench'
import type { ActionDescribeResult } from '../src/shared/actions/schema'
import type { AgentScheduleRecord, AgentSchedulesModel } from '../src/shared/actions/agent-schedule'
import { freq, noEndDate, subday } from '../src/shared/agent/schedule'
import { compare, selectorParts, specificity } from './fixtures/css-cascade'
import { stylesheetRules } from './fixtures/css-rules'
import { connectionInfo, readyBackend, workbenchFixture } from './fixtures/workbench'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()) })

const record = (id: number, name: string, owner: string): AgentScheduleRecord => ({
  name, enabled: false, freqType: freq.daily, freqInterval: 1, freqSubdayType: subday.once, freqSubdayInterval: 0, freqRelativeInterval: 0, freqRecurrenceFactor: 0,
  activeStartDate: 20260101, activeEndDate: noEndDate, activeStartTime: 23000, activeEndTime: 235959, id, jobCount: 0, owner, version: 3, modified: '2026-11-20T01:02:03.456'
})
const model: AgentSchedulesModel = { login: 'sa', sysadmin: false, platform: 'windows', now: '2026-11-22T14:30:00', schedules: [record(3, 'Off', 'dana')], jobs: [], durations: [] }
const profile = { platform: 'windows', engineEdition: 3, msdbAccess: true, sysadmin: false, userRole: false, readerRole: false, operatorRole: true, purgeHistory: true, serverServices: false, sessions: false, alterAnyCredential: false, clustered: false, databaseMail: false } as const

describe('The Schedules grid', () => {
  it("enables the Enabled box on another login's schedule once the operator role is read", async () => {
    const fixture = workbenchFixture()
    cleanups.push(() => fixture.dispose())
    fixture.api.push(readyBackend())
    fixture.connect(connectionInfo('c1'))
    fixture.api.describeObject.mockImplementation(async () => ({ ok: true, value: { agentSchedules: model, elapsedMs: 1 } as ActionDescribeResult }))
    let answer: (value: unknown) => void = () => {}
    fixture.api.agentProfile.mockImplementation(() => new Promise(resolve => { answer = resolve }) as never)
    const id = fixture.schedules.open('c1')
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(async () => { root.render(createElement(WorkbenchProvider, { workbench: fixture as unknown as Workbench, children: createElement(SchedulesDocument, { documentId: id }) })) })
    cleanups.unshift(() => { act(() => root.unmount()); host.remove() })
    const box = () => {
      const label = [...host.querySelectorAll('label')].find(item => item.textContent === 'Enabled: Off')
      const id = label?.getAttribute('for')
      return id ? host.querySelector<HTMLInputElement>(`#${CSS.escape(id)}`) : null
    }
    await act(async () => { for (let turn = 0; turn < 10; turn++) await new Promise(resolve => setImmediate(resolve)) })
    expect(box()?.getAttribute('role')).toBe('switch')
    expect(box()?.disabled).toBe(true)
    await act(async () => { answer({ ok: true, value: { elapsedMs: 1, profile } }); for (let turn = 0; turn < 10; turn++) await new Promise(resolve => setImmediate(resolve)) })
    expect(box()?.disabled).toBe(false)
  })

  it('renders DocumentFrame header, Next Run column, ResizableSplit detail sash, and ScheduleEditor summary/cards', async () => {
    const enabledModel: AgentSchedulesModel = {
      ...model,
      schedules: [
        { ...record(1, 'Nightly 02:30', 'sa'), enabled: true, jobCount: 2 },
        record(3, 'Off', 'dana')
      ]
    }
    const fixture = workbenchFixture()
    cleanups.push(() => fixture.dispose())
    fixture.api.push(readyBackend())
    fixture.connect(connectionInfo('c1'))
    fixture.api.describeObject.mockImplementation(async () => ({ ok: true, value: { agentSchedules: enabledModel, elapsedMs: 1 } as ActionDescribeResult }))
    fixture.api.agentProfile.mockResolvedValue({ ok: true, value: { elapsedMs: 1, profile } } as never)
    const id = fixture.schedules.open('c1')
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(async () => { root.render(createElement(WorkbenchProvider, { workbench: fixture as unknown as Workbench, children: createElement(SchedulesDocument, { documentId: id }) })) })
    cleanups.unshift(() => { act(() => root.unmount()); host.remove() })
    await act(async () => { for (let turn = 0; turn < 10; turn++) await new Promise(resolve => setImmediate(resolve)) })
    await act(async () => { fixture.schedules.select(id, '1'); for (let turn = 0; turn < 5; turn++) await new Promise(resolve => setImmediate(resolve)) })

    // DocumentFrame header & body (no .document-content outer scroller)
    expect(host.querySelector('.document-frame > .document-header .document-title')?.textContent).toBe('Schedules')
    expect(host.querySelector('.document-frame > .document-content')).toBeNull()
    expect(host.querySelector('.document-frame > .document-header')?.textContent).toContain('2 shared')
    expect(host.querySelectorAll('.document-header [role="radiogroup"] [role="radio"]').length).toBe(2)

    // Grid columns include Next Run & tabular Jobs
    const headers = [...host.querySelectorAll('table.agent-table thead th')].map(th => th.textContent)
    expect(headers).toEqual(['Name', 'When', 'Enabled', 'Jobs', 'Next Run', 'Owner'])
    const rows = [...host.querySelectorAll('table.agent-table tbody tr')]
    expect(rows[0].querySelectorAll('td')[3].className).toContain('num')
    expect(rows[0].querySelectorAll('td')[4].textContent).toMatch(/^\w{3} \d{4}-\d{2}-\d{2} 02:30$/)
    expect(rows[1].querySelectorAll('td')[4].textContent).toBe('Disabled')

    // ResizableSplit separator
    const sash = host.querySelector('[role="separator"][aria-label="Resize schedule detail"]')
    expect(sash).not.toBeNull()
    expect(sash?.getAttribute('aria-valuenow')).toBe('472')

    // ScheduleEditor summary leads .properties-fields and renders 2-card preview
    const editor = host.querySelector('.agent-schedule-editor')!
    expect(editor.firstElementChild?.className).toContain('agent-schedule-sentence')
    expect(editor.querySelector('[aria-label="Next 5 runs"]')).not.toBeNull()
    expect(editor.querySelector('[aria-label="Jobs using it"]')).not.toBeNull()
  })

  it('preserves forced-colors Highlight/HighlightText and forced-colors: none selection vs disabled tokens on .agent-schedules-grid rows', () => {
    const table = document.createElement('table')
    table.className = 'agent-table borderless agent-schedules-grid'
    const tbody = document.createElement('tbody')
    const unselected = document.createElement('tr')
    const unselectedDisabled = document.createElement('tr')
    unselectedDisabled.setAttribute('data-disabled', 'true')
    const selected = document.createElement('tr')
    selected.setAttribute('aria-selected', 'true')
    const selectedDisabled = document.createElement('tr')
    selectedDisabled.setAttribute('aria-selected', 'true')
    selectedDisabled.setAttribute('data-disabled', 'true')
    tbody.append(unselected, unselectedDisabled, selected, selectedDisabled)
    table.append(tbody)
    document.body.append(table)
    cleanups.push(() => table.remove())

    const rules = stylesheetRules()
    const colorProperty: Record<string, string> = { background: 'background-color' }
    const resolveRowStyles = (tr: HTMLTableRowElement, { hover = false, forcedColors = false } = {}) => {
      const winners = new Map<string, { value: string; rank: [number, number, number]; order: number }>()
      rules.forEach((rule, order) => {
        if (rule.at.length) {
          const media = rule.at.join(' ')
          if (forcedColors ? media !== '@media (forced-colors: active)' : media !== '@media (forced-colors: none)') return
        }
        for (const part of selectorParts(rule.selector)) {
          if (part.includes('::')) continue
          const hasHover = /:hover\b/.test(part)
          if (hasHover && !hover) continue
          const candidate = hasHover ? part.replace(/:hover\b/g, '') : part
          let matched = false
          try { matched = tr.matches(candidate) } catch { matched = false }
          if (!matched) continue
          const rank = specificity(part)
          for (const { property, value } of rule.declarations) {
            const name = colorProperty[property] ?? property, current = winners.get(name)
            if (!current || compare(rank, current.rank) > 0 || (compare(rank, current.rank) === 0 && order >= current.order)) winners.set(name, { value, rank, order })
          }
        }
      })
      return new Map([...winners].map(([name, { value }]) => [name, value]))
    }

    // forced-colors: active — selected+hovered, selected+disabled, and selected+disabled+hovered keep Highlight/HighlightText; unselected+hovered stays transparent
    const fcSelectedHover = resolveRowStyles(selected, { hover: true, forcedColors: true })
    expect(fcSelectedHover.get('background-color')).toBe('Highlight')
    expect(fcSelectedHover.get('color')).toBe('HighlightText')

    const fcSelectedDisabled = resolveRowStyles(selectedDisabled, { forcedColors: true })
    expect(fcSelectedDisabled.get('background-color')).toBe('Highlight')
    expect(fcSelectedDisabled.get('color')).toBe('HighlightText')

    const fcSelectedDisabledHover = resolveRowStyles(selectedDisabled, { hover: true, forcedColors: true })
    expect(fcSelectedDisabledHover.get('background-color')).toBe('Highlight')
    expect(fcSelectedDisabledHover.get('color')).toBe('HighlightText')

    const fcUnselectedHover = resolveRowStyles(unselected, { hover: true, forcedColors: true })
    expect(fcUnselectedHover.get('background-color')).toBe('transparent')

    // forced-colors: none — selected+disabled keeps inactiveSelectionForeground; unselected+disabled gets descriptionForeground
    const normalSelectedDisabled = resolveRowStyles(selectedDisabled, { forcedColors: false })
    expect(normalSelectedDisabled.get('background-color')).toBe('var(--varia-list-inactiveSelectionBackground)')
    expect(normalSelectedDisabled.get('color')).toBe('var(--varia-list-inactiveSelectionForeground)')

    const normalUnselectedDisabled = resolveRowStyles(unselectedDisabled, { forcedColors: false })
    expect(normalUnselectedDisabled.get('color')).toBe('var(--varia-descriptionForeground)')
  })
})
