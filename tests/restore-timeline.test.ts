// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { BackupSetRow } from '../src/shared/actions/restore'
import BackupTimeline from '../src/renderer/src/restore/BackupTimeline'
import { initialDraft, type RestoreDraft, type RestoreFacts } from '../src/renderer/src/restore/model'
import type { RestoreService, RestoreState } from '../src/renderer/src/restore/RestoreService'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).reverse().forEach(clean => clean()) })

const row = (id: string, type: BackupSetRow['type'], first: string, last: string, base: string, second: number): BackupSetRow => ({
  id, name: id, type, server: 'SQLHOST', database: 'Sales', position: 1, firstLsn: first, lastLsn: last, checkpointLsn: type === 'log' ? last : first, databaseBackupLsn: base,
  start: `2026-10-29T21:05:${second}`, finish: `2026-10-29T21:05:${second}`, sizeBytes: 1024, userName: 'CONTOSO\\dba', copyOnly: false, damaged: false, devices: [`B:\\Backup\\${id}.bak`]
})
// A full, two logs, a differential and a third log (the D1 probe's shape).
const sets = [
  row('full', 'full', '43200001', '45600001', '0', 40),
  row('log1', 'log', '43200001', '51200001', '43200001', 41),
  row('log2', 'log', '51200001', '56800001', '43200001', 44),
  row('diff', 'differential', '56800001', '68000001', '43200001', 45),
  row('log3', 'log', '56800001', '68800001', '43200001', 46)
]
const facts: RestoreFacts = { historyDatabases: ['Sales'], sets, setsTruncated: false, files: [] }

function mount(change: Partial<RestoreDraft>) {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const draft = { ...initialDraft('Sales', facts, new Date(Date.UTC(2026, 9, 30))), ...change }
  const service = { openDialog: vi.fn(), updateDraft: vi.fn() } as unknown as RestoreService
  act(() => root.render(createElement(BackupTimeline, { state: { id: 'r1' } as RestoreState, draft, facts, service })))
  cleanups.push(() => { act(() => root.unmount()); host.remove() })
  const dialog = [...document.querySelectorAll('[role="dialog"]')].at(-1) as HTMLElement
  const radio = (name: string) => [...dialog.querySelectorAll('label')].find(label => label.textContent?.startsWith(name))!
  const ok = () => [...dialog.querySelectorAll('button')].find(button => button.textContent === 'OK') as HTMLButtonElement
  const slider = dialog.querySelector('[role="slider"]') as SVGElement
  return { dialog, radio, ok, slider, service }
}
const press = (target: Element, key: string) => act(() => { target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })) })

describe('the Backup Timeline sub-dialog', () => {
  it('names the last backup taken, not the set point\'s plan\'s last log', () => {
    const { radio } = mount({ stopAt: '2026-10-29T21:05:43' })
    expect(radio('Last backup taken').textContent).toBe('Last backup taken (2026-10-29 21:05:46)')
  })
  it('follows the checked sets under Manual Selection: their last backup, their band, and OK only where they stop', () => {
    const { dialog, radio, ok, slider } = mount({ manual: ['full', 'log1', 'log2'] })
    expect(radio('Last backup taken').textContent).toBe('Last backup taken (2026-10-29 21:05:44)')
    // One band, from log1's finish (the set before the last log), where the planner's starts earlier, at the full's.
    const band = (element: SVGElement) => [...element.querySelectorAll('rect.restore-timeline-covered')].map(rect => Number(rect.getAttribute('x')))
    const checked = band(slider)
    expect(checked).toHaveLength(1)
    // Choosing a specific time starts at their last backup, which they restore to.
    act(() => { radio('Specific date and time').querySelector('input')!.click() })
    expect(slider.getAttribute('aria-valuetext')).toBe('2026-10-29 21:05:44')
    expect(ok().disabled).toBe(false)
    // The newest backup, log3, is past them: OK is disabled, and the status says the checked sets do not stop there.
    press(slider, 'End')
    expect(slider.getAttribute('aria-valuetext')).toBe('2026-10-29 21:05:46')
    expect(ok().disabled).toBe(true)
    expect(dialog.textContent).toContain('The checked backup sets do not stop at this point in time.')
    const planner = band(mount({}).slider)
    expect(planner).toHaveLength(1)
    expect(checked[0]).toBeGreaterThan(planner[0])
  })
  it('allows the planner\'s points without Manual Selection', () => {
    const { radio, ok, slider } = mount({})
    act(() => { radio('Specific date and time').querySelector('input')!.click() })
    press(slider, 'End')
    expect(slider.getAttribute('aria-valuetext')).toBe('2026-10-29 21:05:46')
    expect(ok().disabled).toBe(false)
  })
})
