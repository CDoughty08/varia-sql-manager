// @vitest-environment happy-dom
// Labels follow a remap without remounting, and the Shortcuts page finds the workbench's service with no provider of its own.
import { describe, expect, it } from 'vitest'
import { act, createElement, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { effectiveRules } from '../src/shared/commands/effective'
import { emptyShortcutFile } from '../src/shared/commands/shortcut-schema'
import Keybinding from '../src/renderer/src/Keybinding'
import { KeybindingService } from '../src/renderer/src/core/keybindings'
import { ShortcutsProvider, useShortcuts } from '../src/renderer/src/core/ShortcutsContext'
import { createFakeShortcutsService } from '../src/renderer/src/core/ShortcutsService.fake'
import { useKeybindingLabel } from '../src/renderer/src/core/useCommand'
import { WorkbenchProvider } from '../src/renderer/src/core/WorkbenchContext'
import type { Workbench } from '../src/renderer/src/core/workbench'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function mount(node: ReactNode) {
  const container = document.createElement('div')
  const root = createRoot(container)
  act(() => { root.render(node) })
  return { container, unmount: () => act(() => { root.unmount() }) }
}
const keybindings = () => new KeybindingService({ platform: 'win32', commands: { execute: async () => true }, context: { get: () => ({}) as never }, modalOpen: () => false, editorHasTextFocus: () => false })
const remap = effectiveRules('win32', { ...emptyShortcutFile, bindings: [{ command: 'file.new', key: 'mod+n', remove: true }, { command: 'file.new', key: 'mod+shift+f9' }] }).rules

describe('shortcut labels and the shortcuts hook', () => {
  it('re-renders key labels and tooltips when the rules change', () => {
    const service = keybindings()
    function Hint() { return createElement('span', { 'data-hint': '' }, useKeybindingLabel('file.new')?.text ?? 'none') }
    const view = mount(createElement(WorkbenchProvider, { workbench: { keybindings: service } as unknown as Workbench }, createElement(Keybinding, { id: 'file.new' }), createElement(Hint)))
    const text = () => [view.container.querySelector('.keybinding')?.getAttribute('aria-label'), view.container.querySelector('[data-hint]')?.textContent]
    expect(text()).toEqual(['Control+N', 'Ctrl+N'])
    act(() => { service.setRules(remap) })
    expect(text()).toEqual(['Control+Shift+F9', 'Ctrl+Shift+F9'])
    view.unmount()
  })
  it("uses a ShortcutsProvider's service, or else the workbench's", () => {
    const own = createFakeShortcutsService({ revision: 7 }), workbenchService = createFakeShortcutsService({ revision: 3 })
    function Revision() { return createElement('span', null, String(useShortcuts().snapshot().revision)) }
    const workbench = { shortcuts: workbenchService } as unknown as Workbench
    const fromWorkbench = mount(createElement(WorkbenchProvider, { workbench }, createElement(Revision)))
    const fromProvider = mount(createElement(WorkbenchProvider, { workbench }, createElement(ShortcutsProvider, { shortcuts: own }, createElement(Revision))))
    expect([fromWorkbench.container.textContent, fromProvider.container.textContent]).toEqual(['3', '7'])
    fromWorkbench.unmount(); fromProvider.unmount()
  })
})
