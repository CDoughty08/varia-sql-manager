// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import ExplorerRow, { type RowActions } from '../src/renderer/src/explorer/ExplorerRow'
import { RowKind } from '../src/renderer/src/explorer/tree-model'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).reverse().forEach(clean => clean()) })

describe('Object Explorer row drags', () => {
  // The tree drops a server where the last row marked it; a row that told it nothing would leave the row above's line in place.
  it('report a drag over a loading, error or recovery row, so the tree clears the line the row above left', async () => {
    for (const kind of [RowKind.Loading, RowKind.More, RowKind.Error, RowKind.MoreError, RowKind.Stopped, RowKind.Paused, RowKind.Capped]) {
      const dragOver = vi.fn()
      const actions: RowActions = { select: vi.fn(), toggle: vi.fn(), activate: vi.fn(), reconnect: vi.fn(), remove: vi.fn(), dragStart: vi.fn(() => true), commitRename: vi.fn(async () => true), cancelRename: vi.fn(), peekHover: vi.fn(), click: vi.fn(), dragOver, dragEnd: vi.fn() }
      const host = document.createElement('div')
      document.body.append(host)
      const root = createRoot(host)
      await act(async () => {
        root.render(createElement(ExplorerRow, { rowId: 41, kind, top: 0, level: 2, posinset: 0, setsize: 0, node: undefined, rev: 0, text: 'Loading…', selected: false, draggable: false, active: false, color: undefined, actions, menuTarget: () => {} }))
      })
      cleanups.push(() => { act(() => root.unmount()); host.remove() })
      const row = host.querySelector('[role="treeitem"]')!
      act(() => { row.dispatchEvent(new Event('dragover', { bubbles: true, cancelable: true })) })
      expect(dragOver, `kind ${kind}`).toHaveBeenCalledTimes(1)
      expect(dragOver.mock.calls[0]![0]).toBe(41)
    }
  })
})
