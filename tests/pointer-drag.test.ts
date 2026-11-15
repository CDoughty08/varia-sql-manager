// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { followPointerDrag, pointerDragEnds } from '../src/renderer/src/kit/pointer-drag'

const pointer = (type: string, pointerId: number, clientY = 0) => new PointerEvent(type, { pointerId, clientY })

describe('followPointerDrag', () => {
  it.each(pointerDragEnds)('stops following once the drag ends with %s, so a later hover does not resize', end => {
    const target = document.createElement('div'), onMove = vi.fn()
    followPointerDrag(target, 7, onMove)
    target.dispatchEvent(pointer('pointermove', 7, 10))
    // Another pointer's events neither move nor end this drag.
    target.dispatchEvent(pointer('pointermove', 8, 20))
    target.dispatchEvent(pointer(end, 8))
    target.dispatchEvent(pointer('pointermove', 7, 30))
    expect(onMove.mock.calls.map(([moved]) => moved.clientY)).toEqual([10, 30])
    target.dispatchEvent(pointer(end, 7))
    target.dispatchEvent(pointer('pointermove', 7, 40))
    expect(onMove).toHaveBeenCalledTimes(2)
  })
  it('starts no drag when the pointer cannot be captured, since its pointerup could land elsewhere', () => {
    const target = document.createElement('div'), onMove = vi.fn()
    target.setPointerCapture = () => { throw new DOMException('No active pointer.', 'NotFoundError') }
    followPointerDrag(target, 7, onMove)
    target.dispatchEvent(pointer('pointermove', 7, 10))
    expect(onMove).not.toHaveBeenCalled()
  })
  it.each(['src/renderer/src/designer/TableDesigner.tsx', 'src/renderer/src/activity/ActivityMonitor.tsx'])('is how %s drags its splitter, with the left button only', file => {
    const source = readFileSync(file, 'utf8')
    expect(source).toContain('followPointerDrag(event.currentTarget, event.pointerId')
    expect(source).toContain('event.button !== 0) return')
    expect(source).not.toContain('setPointerCapture')
  })
})
