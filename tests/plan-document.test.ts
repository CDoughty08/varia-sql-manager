// @vitest-environment happy-dom
import { act, createElement, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { WorkbenchProvider } from '../src/renderer/src/core/WorkbenchContext'
import type { Workbench } from '../src/renderer/src/core/workbench'
import PlanDocument from '../src/renderer/src/plans/PlanDocument'

const captured = vi.hoisted(() => ({ viewer: vi.fn() }))
vi.mock('../src/renderer/src/plans/PlanViewer', () => ({ default: (props: unknown) => { captured.viewer(props); return null } }))

it('waits for a new XML document to finish filling before mapping the caret back to an operator', async () => {
  vi.useFakeTimers()
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const host = document.createElement('div'), root = createRoot(host)
  document.body.append(host)
  let filling = true, text = '<ShowPlanXML', revision = 1, changed: (() => void) | undefined, position = { lineNumber: 1, column: 1 }
  let range: { startColumn: number; endColumn: number } | undefined
  const select = vi.fn((value: { startColumn: number; endColumn: number }) => { range = value; position = { lineNumber: 1, column: value.endColumn } })
  const model = { getValue: () => text, getVersionId: () => revision, getPositionAt: (offset: number) => ({ lineNumber: 1, column: offset + 1 }), getOffsetAt: (value: typeof position) => value.column - 1,
    onDidChangeContent: (callback: () => void) => { changed = callback; return { dispose() {} } } }
  const workbench = { documents: { getModel: () => model, isFilling: () => filling, editorOf: () => ({ setSelection: select, revealRangeInCenter() {}, focus() {}, getPosition: () => position,
    getSelection: () => range ? { startLineNumber: 1, startColumn: range.startColumn, isEmpty: () => false } : undefined }) },
    planPreparation: { takeXml: () => ({ statement: 0, operator: 1, nodeId: '1' }), watchDocument() {} } } as unknown as Workbench
  function Document() { const [source, setSource] = useState(false); return createElement(PlanDocument, { documentId: 'new', source, onSource: setSource }) }
  try {
    await act(async () => root.render(createElement(WorkbenchProvider, { workbench, children: createElement(Document) })))
    const graph = host.querySelector<HTMLButtonElement>('button')!
    expect(graph.disabled).toBe(true)
    expect(select).not.toHaveBeenCalled()
    text = '<ShowPlanXML xmlns="http://schemas.microsoft.com/sqlserver/2004/07/showplan"><StmtSimple><RelOp NodeId="0"><RelOp NodeId="1" /></RelOp></StmtSimple></ShowPlanXML>'
    filling = false; revision++
    await act(async () => { changed?.(); await vi.advanceTimersByTimeAsync(150) })
    expect(graph.disabled).toBe(false)
    expect(select).toHaveBeenCalledOnce()
    expect(text.slice(range!.startColumn - 1)).toMatch(/^<RelOp NodeId="1"/)
    await act(async () => graph.click())
    expect(captured.viewer.mock.lastCall?.[0].xmlNavigation).toMatchObject({ statement: 0, operator: 1, nodeId: '1' })
    // Ordinary view switches leave XML's selection/scroll and graph's selection independent.
    const xml = host.querySelectorAll<HTMLButtonElement>('button')[1]
    select.mockClear()
    await act(async () => xml.click())
    expect(select).not.toHaveBeenCalled()
    await act(async () => graph.click())
    expect(captured.viewer.mock.lastCall?.[0].xmlNavigation).toBeUndefined()
    // Moving the XML caret still intentionally navigates the graph.
    await act(async () => xml.click())
    range = undefined; position = { lineNumber: 1, column: text.indexOf('<RelOp NodeId="0"') + 2 }
    await act(async () => graph.click())
    expect(captured.viewer.mock.lastCall?.[0].xmlNavigation).toMatchObject({ statement: 0, operator: 0, nodeId: '0' })
    // Explicit navigation targets XML even when the graph was already prepared.
    await act(async () => captured.viewer.mock.lastCall?.[0].navigateXml({ statement: 0, operator: 1, nodeId: '1' }))
    expect(select).toHaveBeenCalledOnce()
    await act(async () => graph.click())
    expect(captured.viewer.mock.lastCall?.[0].xmlNavigation).toMatchObject({ statement: 0, operator: 1, nodeId: '1' })
  } finally { await act(async () => root.unmount()); host.remove(); vi.useRealTimers() }
})
