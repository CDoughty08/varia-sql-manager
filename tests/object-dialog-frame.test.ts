import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { DialogPageSpec } from '../src/shared/actions/catalog'
import { framePages, narrowFrameQuery, PageList, pageForKey, StepsPanel } from '../src/renderer/src/dialogs/ObjectDialog'
import StepList, { clampPercent, stepIcons, stepWords } from '../src/renderer/src/kit/StepList'

const pages: DialogPageSpec[] = [
  { id: 'general', title: 'General', icon: 'settings-gear' },
  { id: 'files', title: 'Files', icon: 'file', keepMounted: true },
  { id: 'options', title: 'Options', icon: 'settings-gear' }
]
const html = (element: ReturnType<typeof createElement>) => renderToStaticMarkup(element)

describe('object dialog frame', () => {
  it('renders the current page, and keeps a keepMounted page mounted (hidden) once it has been shown', () => {
    const shown = (current: 'general' | 'files' | 'options', visited: string[]) => framePages(pages, current, new Set(visited as never[])).map(({ page, shown }) => `${page.id}${shown ? '' : ' (hidden)'}`)
    expect(shown('general', ['general'])).toEqual(['general'])
    // Files has not been shown yet, so it is not mounted; once it has, it stays while another page is current.
    expect(shown('options', ['general', 'options'])).toEqual(['options'])
    expect(shown('options', ['general', 'files', 'options'])).toEqual(['files (hidden)', 'options'])
    expect(shown('files', ['general', 'files'])).toEqual(['files'])
    // Pages without keepMounted unmount when left.
    expect(shown('files', ['general', 'files', 'options'])).toEqual(['files'])
  })
  it('moves between pages with Up and Down in the list, and Left, Right, Home and End as tabs', () => {
    expect(pageForKey(pages, 'general', 'ArrowDown', false)).toBe('files')
    expect(pageForKey(pages, 'files', 'ArrowUp', false)).toBe('general')
    expect(pageForKey(pages, 'general', 'ArrowUp', false)).toBeUndefined()
    expect(pageForKey(pages, 'options', 'ArrowDown', false)).toBeUndefined()
    expect(pageForKey(pages, 'general', 'ArrowRight', false)).toBeUndefined()
    expect(pageForKey(pages, 'general', 'ArrowRight', true)).toBe('files')
    expect(pageForKey(pages, 'files', 'ArrowLeft', true)).toBe('general')
    expect(pageForKey(pages, 'general', 'ArrowDown', true)).toBeUndefined()
    expect(pageForKey(pages, 'general', 'End', true)).toBe('options')
    expect(pageForKey(pages, 'options', 'Home', true)).toBe('general')
    expect(pageForKey(pages, 'options', 'End', true)).toBeUndefined()
    expect(pageForKey(pages, 'options', 'Home', false)).toBeUndefined()
  })
  it('shows "Select a page" as a list with the current page marked, and as tabs controlling their panels when narrow', () => {
    const list = html(createElement(PageList, { pages, current: 'files', tabs: false, onPage: () => {} }))
    expect(list).toContain('<nav class="object-dialog-pages" aria-label="Select a page">')
    expect(list).toContain('<div class="object-dialog-caption">Select a page</div>')
    expect(list).toMatch(/<button type="button" data-page="files" aria-current="page">.*Files<\/button>/)
    expect(list).not.toContain('role="tab"')
    expect(list.match(/class="codicon codicon-settings-gear/g)?.length).toBe(2)
    const tabs = html(createElement(PageList, { pages, current: 'files', tabs: true, onPage: () => {} }))
    expect(tabs).toContain('role="tablist" aria-label="Select a page"')
    expect(tabs).toContain('role="tab" id="object-dialog-tab-files" aria-selected="true" aria-controls="object-dialog-panel-files" tabindex="0"')
    // A tab names a panel only once its page is mounted: General's and Options' are not, so they name none.
    expect(tabs).toContain('role="tab" id="object-dialog-tab-general" aria-selected="false" tabindex="-1"')
    expect(tabs.match(/aria-controls="[^"]*"/g)).toEqual(['aria-controls="object-dialog-panel-files"'])
    expect(tabs).not.toContain('aria-current')
    const kept = html(createElement(PageList, { pages, current: 'options', tabs: true, rendered: new Set(['files', 'options'] as const), onPage: () => {} }))
    expect(kept.match(/aria-controls="[^"]*"/g)).toEqual(['aria-controls="object-dialog-panel-files"', 'aria-controls="object-dialog-panel-options"'])
    // The dialog is min(820 px, viewport - 48 px) wide, so it is under 720 px below a 768 px viewport.
    expect(narrowFrameQuery).toBe('(max-width: 767px)')
  })
  it('lists a run\'s steps with their state in words, and nothing before the run reports any', () => {
    expect(html(createElement(StepsPanel, { steps: [] }))).toBe('')
    const panel = html(createElement(StepsPanel, { steps: [{ status: 'done', title: 'Close connections' }, { status: 'failed', title: 'Take database offline', message: 'Msg 5070: Database state cannot be changed while other users are using the database' }, { status: 'skipped', title: 'Restore access' }] }))
    expect(panel).toContain('<section class="object-dialog-steps" aria-labelledby="object-dialog-steps"><div class="object-dialog-caption" id="object-dialog-steps">Steps</div>')
    expect([...panel.matchAll(/data-status="(\w+)"/g)].map(match => match[1])).toEqual(['done', 'failed', 'skipped'])
    expect(panel).toContain('<span class="visually-hidden">Failed: </span>Take database offline')
    // Every step reads as its title (a done step has no message); the failure's text belongs to the message bar.
    expect(panel).toContain('<span class="visually-hidden">Done: </span>Close connections')
    expect(panel).not.toContain('Msg 5070')
  })
})

describe('StepList', () => {
  it('draws each state with its icon and words, a meta text, and a progressbar under a step that reports progress', () => {
    const markup = html(createElement(StepList, {
      labelledBy: 'plan', steps: [
        { state: 'done', text: 'Back up the tail of the log', meta: 'Done · 0:31' },
        { state: 'running', text: 'Restore SalesTest', meta: '38 %', progress: 38.4 },
        { state: 'pending', text: 'Bring SalesTest online', meta: 'Pending' }
      ]
    }))
    expect(markup).toMatch(/^<ol class="step-list" aria-labelledby="plan">/)
    expect([...markup.matchAll(/data-status="(\w+)"/g)].map(match => match[1])).toEqual(['done', 'running', 'pending'])
    expect(markup).toContain('codicon-loading step-list-spinner')
    expect(markup).toContain('<span class="step-list-meta">Done · 0:31</span>')
    expect(markup).toContain('role="progressbar" aria-label="Restore SalesTest" aria-valuemin="0" aria-valuemax="100" aria-valuenow="38" aria-valuetext="About 38 %"')
    expect(markup).toContain('style="width:38.4%"')
    expect(markup.match(/role="progressbar"/g)?.length).toBe(1)
    // A pending step is read as its text alone.
    expect(markup).toContain('<span class="step-list-text">Bring SalesTest online</span>')
    expect(markup).toContain('<span class="visually-hidden">Running: </span>Restore SalesTest')
    expect(html(createElement(StepList, { labelledBy: 'x', className: 'more', steps: [{ state: 'running', text: 'Verify', progress: 250, progressText: 'Nearly done' }] })))
      .toContain('aria-valuenow="100" aria-valuetext="Nearly done"><div class="step-list-fill" style="width:100%"')
    expect([clampPercent(-5), clampPercent(Number.NaN), clampPercent(42)]).toEqual([0, 0, 42])
    expect(Object.keys(stepIcons).sort()).toEqual(Object.keys(stepWords).sort())
  })
})

describe('Take Database Offline and Bring Database Online page', () => {
  it('says who is in the database, how many have open transactions, and when it cannot know', async () => {
    const { sessionsMessage } = await import('../src/renderer/src/dialogs/pages/DatabaseStatePage')
    expect(sessionsMessage({ sessions: undefined, withTransaction: undefined })).toBe('Sessions unknown (needs VIEW SERVER STATE).')
    expect(sessionsMessage({ sessions: 0, withTransaction: 0 })).toBe('No active connections.')
    expect(sessionsMessage({ sessions: 1, withTransaction: 0 })).toBe('1 active connection')
    expect(sessionsMessage({ sessions: 1200, withTransaction: 1 })).toBe('1,200 active connections (1 with an open transaction)')
    expect(sessionsMessage({ sessions: 3, withTransaction: 2 })).toBe('3 active connections (2 with open transactions)')
  })
  it('shows SSMS\'s Ready and Not ready before OK, then the run\'s outcome', async () => {
    const { databaseStateStatus } = await import('../src/renderer/src/dialogs/pages/DatabaseStatePage')
    const at = (phase: Parameters<typeof databaseStateStatus>[0]['phase'], blocked = false, model?: object) => databaseStateStatus({ phase, model: model as never }, blocked).label
    expect([at('ready'), at('ready', true), at('loading'), at('loading', false, {}), at('executing'), at('succeeded'), at('failed'), at('loadFailed'), at('stopped')])
      .toEqual(['Ready', 'Not ready', 'Loading', 'Checking', 'In progress', 'Success', 'Error', 'Error', 'Stopped'])
    expect(databaseStateStatus({ phase: 'succeeded', model: undefined }, false).tone).toBe('success')
    expect(databaseStateStatus({ phase: 'ready', model: undefined }, true).tone).toBe('warning')
  })
  it('offers Script before OK and after a failure or Stop, never while it runs or once a dialog that stays open has succeeded', async () => {
    const { scriptAvailable } = await import('../src/renderer/src/dialogs/ObjectDialog')
    const phases = ['ready', 'failed', 'stopped', 'loading', 'scripting', 'confirming', 'executing', 'succeeded'] as const
    expect(phases.filter(phase => scriptAvailable(phase, true))).toEqual(['ready', 'failed', 'stopped'])
    expect(scriptAvailable('ready', false)).toBe(false)
  })
  it('says after Stop that the count read before OK no longer holds', async () => {
    const { stoppedMessage } = await import('../src/renderer/src/dialogs/pages/DatabaseStatePage')
    expect(stoppedMessage).toBe('Stopped. Check Again to see who is connected now.')
  })
})
