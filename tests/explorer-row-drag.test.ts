// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import ExplorerRow, { type RowActions, type RowProps } from '../src/renderer/src/explorer/ExplorerRow'
import { RowKind, type TreeNode } from '../src/renderer/src/explorer/tree-model'

// A server row draws its connection colour through the theme, which a bare render has no store for.
vi.mock('../src/renderer/src/core/WorkbenchContext', async original => ({ ...await original<object>(), useConnectionAccent: () => undefined }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).reverse().forEach(clean => clean()) })

const actions = (dragOver = vi.fn()): RowActions => ({ select: vi.fn(), toggle: vi.fn(), activate: vi.fn(), reconnect: vi.fn(), remove: vi.fn(), dragStart: vi.fn(() => true), commitRename: vi.fn(async () => true), cancelRename: vi.fn(), peekHover: vi.fn(), click: vi.fn(), dragOver, dragEnd: vi.fn() })
/** A server row as ExplorerService keeps it, with `fields` over a connected server's defaults. */
function server(fields: Partial<TreeNode> = {}): TreeNode {
  return {
    id: 5, parent: 0, connectionId: 'c', ref: { type: 'object', object: { kind: 'server' } }, kind: 'server', folder: undefined, level: 1, label: 'sql-a', lower: 'sql-a', sublabel: undefined, detail: undefined,
    icon: 'server', subtype: undefined, status: undefined, created: undefined, hasChildren: true, expanded: false, children: undefined, staticCount: 0, total: undefined,
    cursor: undefined, load: 'none', more: 'none', error: undefined, connectionError: undefined, filtered: false, lost: false, showLoading: false, generation: 0, rev: 0,
    lastUsed: 0, descendants: 0, ...fields
  }
}
async function mount(props: Partial<RowProps>) {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(createElement(ExplorerRow, { rowId: 41, kind: RowKind.Node, top: 0, level: 1, posinset: 1, setsize: 2, node: undefined, rev: 0, text: '', selected: false, draggable: true, active: false, color: undefined, actions: actions(), menuTarget: () => {}, ...props }))
  })
  cleanups.push(() => { act(() => root.unmount()); host.remove() })
  return host.querySelector('[role="treeitem"]')!
}
/** A dragover at `clientY` over a row 20 px tall at 100 px (happy-dom lays nothing out, and its DragEvent drops clientY). */
const dragOverAt = (row: Element, clientY: number) => act(() => {
  row.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: 100, width: 300, height: 20 })
  row.dispatchEvent(new MouseEvent('dragover', { clientY, bubbles: true, cancelable: true }))
})

describe('Object Explorer row drags', () => {
  // The line below everything is drawn on the tree's last row, which can be a loading, error or recovery row.
  it('draw the drop line on a loading, error or recovery row', () => {
    for (const kind of [RowKind.Loading, RowKind.Error, RowKind.Capped]) {
      const html = renderToStaticMarkup(createElement(ExplorerRow, { rowId: -3, kind, top: 0, level: 3, posinset: 0, setsize: 0, node: undefined, rev: 0, text: 'Loading…', selected: false, draggable: false, active: false, color: undefined, actions: actions(), menuTarget: () => {}, drop: 'after' }))
      expect(html, `kind ${kind}`).toContain('data-drop="after"')
    }
  })
  // A server dropped after an open one lands below its children; a line under its row would show the wrong place.
  it('offer only the top edge of an open server, and both halves of a closed one', async () => {
    for (const [expanded, edge] of [[true, 'before'], [false, 'after']] as const) {
      const dragOver = vi.fn()
      const row = await mount({ rowId: 5, node: server({ expanded }), actions: actions(dragOver) })
      dragOverAt(row, 115)
      expect(dragOver.mock.calls.map(call => call.slice(0, 2)), `expanded ${expanded}`).toEqual([[5, edge]])
    }
  })
  // The tree drops a server where the last row marked it; a row that told it nothing would leave the row above's line in
  // place. Its half matters too: the lower half of the tree's last row drops a server last.
  it('report a drag over a loading, error or recovery row with the half the pointer is in, so the tree clears or moves the line', async () => {
    for (const kind of [RowKind.Loading, RowKind.More, RowKind.Error, RowKind.MoreError, RowKind.Stopped, RowKind.Paused, RowKind.Capped]) {
      const dragOver = vi.fn()
      const row = await mount({ rowId: 41, kind, level: 2, posinset: 0, setsize: 0, text: 'Loading…', draggable: false, actions: actions(dragOver) })
      dragOverAt(row, 105)
      dragOverAt(row, 115)
      expect(dragOver.mock.calls.map(call => call.slice(0, 2)), `kind ${kind}`).toEqual([[41, 'before'], [41, 'after']])
    }
  })
})
