// @vitest-environment happy-dom
// AG-16: a link opens a document at a section it lists only once loaded (a job's History); the column scrolls there when it appears.
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { DocumentSections, type FrameSection } from '../src/renderer/src/kit/DocumentFrame'
import { initialFrameState, pendingReveal, revealSection, type FrameState } from '../src/renderer/src/kit/document-frame'

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })

const general: FrameSection = { id: 'general', title: 'General', content: 'General' }
const history: FrameSection = { id: 'history', title: 'History', content: 'History' }

/** happy-dom lays nothing out: each section heading sits 300px below the one before it. */
function laidOut(): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetTop')
  Object.defineProperty(HTMLElement.prototype, 'offsetTop', { configurable: true, get(this: HTMLElement) { return this.id.endsWith('history') ? 300 : 0 } })
  return () => { if (descriptor) Object.defineProperty(HTMLElement.prototype, 'offsetTop', descriptor) }
}

describe('DocumentSections reveal', () => {
  it('waits for a revealed section the frame does not list yet, then scrolls to it', async () => {
    cleanups.push(laidOut())
    const all = [general, history]
    const frame: FrameState = revealSection(initialFrameState(all), all, 'history')
    expect(pendingReveal(frame, [general])).toBe('history')
    expect(pendingReveal(frame, all)).toBeUndefined()
    expect(pendingReveal(initialFrameState(all), [general])).toBeUndefined()
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    cleanups.unshift(() => { act(() => root.unmount()); host.remove() })
    const render = (sections: readonly FrameSection[]) => createElement(DocumentSections, { id: 'job-1', title: 'Nightly', sections, frame, onFrame: () => {} })
    // Loading: only General is listed, so nothing scrolls yet.
    await act(async () => { root.render(render([general])) })
    const column = host.querySelector<HTMLElement>('.document-content')!
    expect(column.scrollTop).toBe(0)
    // Loaded: History is listed and the column scrolls its heading to the top.
    await act(async () => { root.render(render(all)) })
    expect(column.scrollTop).toBe(300)
  })
})
