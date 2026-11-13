// @vitest-environment happy-dom
// The results grid's React shell, which ResultGrid and LiveGridPane both mount: it builds the view once per mount key (at
// once, or at a live grid's first sample, from the props it has by then), keeps a built view's sort and funnels current,
// opens a column's funnel, and its error boundary keeps a failed grid in its frame until Retry renders it again.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { WorkbenchProvider } from '../src/renderer/src/core/WorkbenchContext'
import type { Workbench } from '../src/renderer/src/core/workbench'
import type { ColumnFilterSource } from '../src/renderer/src/results/ColumnFilterPopover'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// GridView stands in as a recorder: its options, its updates, and the funnel calls the shell makes.
const views: FakeView[] = []
class FakeView {
  updates: unknown[] = []
  disposed = false
  constructor(readonly options: Record<string, unknown> & { root: HTMLElement; scroller: HTMLElement; onFilter?: (column: number, anchor: DOMRect) => void }) { views.push(this) }
  update(o: unknown): void { this.updates.push(o) }
  canFilter(column: number): boolean { return column === 1 }
  filterAnchor(): DOMRect { return { left: 0, top: 0, right: 10, bottom: 10, width: 10, height: 10, x: 0, y: 0, toJSON: () => ({}) } as DOMRect }
  key(): boolean { return false }
  retry(): void {}
  dispose(): void { this.disposed = true }
}
vi.mock('../src/renderer/src/grid/GridView', () => ({ GridView: FakeView }))
const { default: GridShell, GridErrorBoundary } = await import('../src/renderer/src/grid/GridShell')
type ShellProps = Parameters<typeof GridShell>[0]

const settingsSnapshot = { values: { 'queryResults.grid.whitespace': 'all' } }
const settings = { subscribe: () => () => {}, getSnapshot: () => settingsSnapshot }
const workbench = { resultClient: {}, platform: 'win32', settings } as unknown as Workbench
const mounted: (() => void)[] = []
afterEach(() => { for (const unmount of mounted.splice(0)) unmount(); views.length = 0; document.body.replaceChildren() })

function render(node: ReactNode) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const show = (next: ReactNode) => act(() => root.render(createElement(WorkbenchProvider, { workbench, children: next })))
  show(node)
  mounted.push(() => act(() => root.unmount()))
  return { container, show }
}
const source: ColumnFilterSource = { columnValues: () => new Promise(() => {}), apply: () => true }
const spec = { entry: 'e1', resultNumber: 1, resultCount: 1 } as never

describe('GridShell', () => {
  it('builds its view once per mount key, and cleans up what it built when the key changes', () => {
    const cleanups: string[] = []
    const props = (key: string): ShellProps => ({ rootProps: { 'aria-label': 'Grid' }, mountKey: key, mount: create => { create(spec); return () => cleanups.push(key) } })
    const { container, show } = render(createElement(GridShell, props('a')))
    expect(views).toHaveLength(1)
    expect(views[0].options.root).toBe(container.querySelector('[role="grid"]'))
    expect(views[0].options.scroller).toBe(container.querySelector('.rg-scroll'))
    show(createElement(GridShell, props('a')))
    expect(views).toHaveLength(1)
    show(createElement(GridShell, props('b')))
    expect(cleanups).toEqual(['a'])
    expect(views).toHaveLength(2)
  })

  it('builds a live grid\'s view at its first sample from the sort and funnels it has by then, and keeps them current', () => {
    let later: ((spec: never) => unknown) | undefined
    const onSort = vi.fn()
    const props = (sort: { column: number; descending: boolean }[], filtered: Set<number>): ShellProps => ({
      rootProps: {}, mountKey: 'live', mount: create => { later = create as never; return () => {} },
      sort, onSort, funnels: { source, filtered, filterable: new Set([1]), columnName: column => ['id', 'name'][column] }
    })
    const { show } = render(createElement(GridShell, props([], new Set())))
    expect(views).toHaveLength(0)
    // The owner's state moved on before the first sample arrived.
    show(createElement(GridShell, props([{ column: 1, descending: true }], new Set([1]))))
    act(() => { later!({ ...(spec as object), sortable: true } as never) })
    expect(views[0].options).toMatchObject({ sort: [{ column: 1, descending: true }], filtered: new Set([1]), filterable: new Set([1]) })
    ;(views[0].options.onSort as (column: number, add: boolean) => void)(0, true)
    expect(onSort).toHaveBeenCalledWith(0, true)
    show(createElement(GridShell, props([], new Set())))
    expect(views[0].updates.at(-1)).toMatchObject({ sort: [], filtered: new Set() })
    // A header funnel opens the shared popover for its column; pressing it again closes it.
    act(() => views[0].options.onFilter!(1, views[0].filterAnchor()))
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Filter name')
    act(() => views[0].options.onFilter!(1, views[0].filterAnchor()))
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('follows the results white space setting unless the source sets its own (a grid whose menu has no White space item)', () => {
    const props = (whitespace?: 'none'): ShellProps => ({ rootProps: {}, mountKey: 'k', ...whitespace ? { whitespace } : {}, mount: create => { create(spec); return () => {} } })
    const { show } = render(createElement(GridShell, props()))
    expect(views[0].options.whitespace).toBe('all')
    show(createElement(GridShell, props('none')))
    expect(views[0].updates.at(-1)).toMatchObject({ whitespace: 'none' })
  })

  it('gives a table that does not sort no header sort buttons', () => {
    render(createElement(GridShell, { rootProps: {}, mountKey: 'log', onSort: () => {}, mount: create => { create({ ...(spec as object), sortable: false } as never); return () => {} } }))
    expect(views[0].options.onSort).toBeUndefined()
  })

  it('keeps a grid that failed to render in its frame, and renders all of it again on Retry', () => {
    let fail = true
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const Source = () => { if (fail) throw new Error('render failed'); return createElement('p', null, 'rows') }
      const { container } = render(createElement(GridErrorBoundary, { contents: 'rows', frameProps: { className: 'live-grid', 'data-live-probe': 'p' }, children: createElement(Source) }))
      const frame = container.querySelector('.rg-frame.failed.live-grid')
      expect(frame?.getAttribute('data-live-probe')).toBe('p')
      expect(frame?.textContent).toContain('These rows could not be displayed.')
      fail = false
      act(() => (frame!.querySelector('button') as HTMLButtonElement).click())
      expect(container.textContent).toBe('rows')
    } finally { errors.mockRestore() }
  })

  it('puts a strip\'s button after its text, runs it, and gives the focus to the grid when the button goes while focused', () => {
    const run = vi.fn()
    const props = (action: boolean): ShellProps => ({ rootProps: {}, mountKey: 'a', mount: create => { create(spec); return () => {} },
      strip: { text: 'Only the first rows are shown.', ...action ? { action: { label: 'Stop query', icon: 'debug-stop', title: 'Cancel Executing Query (Alt+Pause)', keys: 'Alt+Pause', run } } : {} } })
    const { container, show } = render(createElement(GridShell, props(true)))
    const strip = container.querySelector('.rg-strip')!
    const button = strip.querySelector('button')!
    expect([strip.getAttribute('role'), strip.querySelector('.rg-strip-text')?.textContent, button.textContent, button.getAttribute('aria-keyshortcuts')])
      .toEqual(['status', 'Only the first rows are shown.', 'Stop query', 'Alt+Pause'])
    act(() => button.click())
    expect(run).toHaveBeenCalledTimes(1)
    act(() => button.focus())
    show(createElement(GridShell, props(false)))
    expect(container.querySelector('.rg-strip button')).toBeNull()
    expect(document.activeElement).toBe(container.querySelector('[role="grid"]'))
    // Focus the user moved away from the button (to nothing focusable) is not taken back to the grid when the button goes.
    show(createElement(GridShell, props(true)))
    act(() => container.querySelector<HTMLButtonElement>('.rg-strip button')!.focus())
    act(() => (document.activeElement as HTMLElement).blur())
    expect(document.activeElement).toBe(document.body)
    show(createElement(GridShell, props(false)))
    expect(document.activeElement).toBe(document.body)
  })
})
