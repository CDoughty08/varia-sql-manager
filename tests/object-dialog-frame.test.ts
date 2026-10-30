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
    expect(tabs).toContain('role="tab" id="object-dialog-tab-general" aria-selected="false" aria-controls="object-dialog-panel-general" tabindex="-1"')
    expect(tabs).not.toContain('aria-current')
    // The dialog is min(820 px, viewport - 48 px) wide, so it is under 720 px below a 768 px viewport.
    expect(narrowFrameQuery).toBe('(max-width: 767px)')
  })
  it('lists a run\'s steps with their state in words, and nothing before the run reports any', () => {
    expect(html(createElement(StepsPanel, { steps: [] }))).toBe('')
    const panel = html(createElement(StepsPanel, { steps: [{ status: 'done', message: 'Close connections' }, { status: 'failed', message: 'Take database offline' }, { status: 'skipped', message: 'Restore access' }] }))
    expect(panel).toContain('<section class="object-dialog-steps" aria-labelledby="object-dialog-steps"><div class="object-dialog-caption" id="object-dialog-steps">Steps</div>')
    expect([...panel.matchAll(/data-status="(\w+)"/g)].map(match => match[1])).toEqual(['done', 'failed', 'skipped'])
    expect(panel).toContain('<span class="visually-hidden">Failed: </span>Take database offline')
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
