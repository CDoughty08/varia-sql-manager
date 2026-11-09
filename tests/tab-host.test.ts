// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { followTabHost } from '../src/renderer/src/editor-groups/tab-host'

/** An event source as Dockview's: listeners added and removed, fired by the test. */
function emitter() {
  const listeners = new Set<() => void>()
  return { subscribe: (listener: () => void) => { listeners.add(listener); return { dispose: () => { listeners.delete(listener) } } }, fire: () => listeners.forEach(listener => listener()), get size() { return listeners.size } }
}
const wrapper = () => { const host = document.createElement('div'); host.className = 'dv-tab'; host.setAttribute('role', 'tab'); document.body.append(host); return host }

describe('a document tab\'s Dockview tab element', () => {
  it('marks a new tab element when a clean tab moves into another group with its header unchanged (#364)', async () => {
    const layout = emitter(), group = emitter(), content = document.createElement('div'), first = wrapper()
    first.append(content)
    const host = followTabHost(content, [layout.subscribe, group.subscribe])
    host.update({ tooltip: 'SQLQuery1.sql', description: 'Production environment' })
    expect(first.hasAttribute('data-document-tab')).toBe(true)
    expect(first.title).toBe('SQLQuery1.sql')
    expect(first.getAttribute('aria-description')).toBe('Production environment')
    // A split: Dockview builds a new tab element and moves the same header into it; the name, state and description stay.
    const second = wrapper()
    second.append(content)
    group.fire()
    await Promise.resolve()
    expect(second.hasAttribute('data-document-tab')).toBe(true)
    expect(second.title).toBe('SQLQuery1.sql')
    expect(second.getAttribute('aria-description')).toBe('Production environment')
    // A drag reports only a layout change.
    const third = wrapper()
    third.append(content)
    layout.fire()
    await Promise.resolve()
    expect(third.hasAttribute('data-document-tab')).toBe(true)
    host.update({ tooltip: 'SQLQuery1.sql (unsaved changes)', description: undefined })
    expect(third.title).toBe('SQLQuery1.sql (unsaved changes)')
    expect(third.hasAttribute('aria-description')).toBe(false)
    host.dispose()
    expect(layout.size + group.size).toBe(0)
  })
})
