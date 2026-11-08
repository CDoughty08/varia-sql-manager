import { describe, expect, it } from 'vitest'
import { commandDescriptor, isCommandId } from '../src/shared/commands/catalog'
import { renderGestureDocs } from '../src/shared/commands/gesture-docs'
import { gestureChoices, gestureDefault, gestureDescriptor, gestureIds, gestureLabel, gesturePhrase, gestureScopes, modifiersLabel, physicalModifiers, type GestureModifiers } from '../src/shared/commands/gestures'
import { platforms, specForPlatform, type Platform } from '../src/shared/commands/keybindings'
import { contextMenuIds } from '../src/shared/commands/menus'
import { GestureService, gesturesFor, paneTabTitle, popoutTabTitle, type GestureEvent } from '../src/renderer/src/core/gestures'

/** Every combination of the four modifier fields. */
const events: GestureEvent[] = Array.from({ length: 16 }, (_, bits) => ({ ctrlKey: !!(bits & 1), metaKey: !!(bits & 2), altKey: !!(bits & 4), shiftKey: !!(bits & 8) }))
const same = (a: GestureModifiers, b: GestureModifiers) => a.length === b.length && a.every(modifier => b.includes(modifier))

/** A command the keyboard reaches on `platform`: a key of its own, or an item in a context menu that Shift+F10 opens. */
function keyboardReachable(id: Parameters<typeof commandDescriptor>[0], platform: Platform): boolean {
  const command = commandDescriptor(id)
  if (command.keybindings?.some(spec => specForPlatform(spec, platform) !== undefined)) return true
  return !!command.menus?.some(placement => (contextMenuIds as readonly string[]).includes(placement.menu) && (!placement.platforms || placement.platforms.includes(platform)))
}

describe('gesture catalogue', () => {
  it('declares each gesture consistently', () => {
    for (const id of gestureIds) {
      const gesture = gestureDescriptor(id)
      expect(gesture.title, id).toMatch(/^[A-Z]/)
      expect(gesture.description, id).toMatch(/^[A-Z].*\.$/)
      expect(Object.keys(gestureScopes), id).toContain(gesture.scope)
      // A gesture is either remappable (its default among its choices) or locked with a reason; fixed ones are always locked.
      expect(!!gesture.choices !== !!gesture.locked, id).toBe(true)
      if (gesture.kind === 'fixed') expect(gesture.choices, id).toBeUndefined()
      if (gesture.choices) {
        // Each choice means something different on every platform, and the default is the first; on macOS no click or
        // double-click holds Control, which makes it a right-click there (the context menu opens, no double-click arrives).
        for (const platform of platforms) {
          const choices = gestureChoices(id, platform)!
          expect(same(choices[0], gestureDefault(id, platform)), `${id} on ${platform}: the default is the first choice`).toBe(true)
          const labels = choices.map(choice => modifiersLabel(choice, platform))
          expect(new Set(labels).size, `${id} on ${platform}`).toBe(labels.length)
          if (gesture.darwin) expect(gesture.darwin.choices?.length ?? choices.length, `${id}: macOS offers as many choices, in the same order`).toBe(gesture.choices.length)
        }
        if (gesture.action === 'click' || gesture.action === 'doubleClick') expect(gestureChoices(id, 'darwin')!.some(choice => physicalModifiers(choice, 'darwin').includes('ctrl')), id).toBe(false)
      }
      for (const command of gesture.keyboard ?? []) expect(isCommandId(command), `${id}: ${command}`).toBe(true)
    }
  })
  it('gives every pointer command, and every gesture that names one, a keyboard path on every platform', () => {
    for (const id of gestureIds) {
      const gesture = gestureDescriptor(id)
      if (gesture.kind === 'pointerCommand') expect(gesture.keyboard?.length, `${id} needs a keyboard equivalent`).toBeGreaterThan(0)
      for (const platform of platforms) {
        if (!gesture.keyboard?.length) continue
        // Commands that act on the pointed-at item may split by state (Float or Dock); together they must be reachable.
        expect(gesture.keyboard.every(command => keyboardReachable(command, platform)), `${id} on ${platform}: ${gesture.keyboard.join(', ')}`).toBe(true)
      }
    }
    // The rule fails a command the keyboard cannot reach: Save Layout has no key and no context menu item.
    expect(keyboardReachable('document.rename', 'darwin')).toBe(true)
    expect(keyboardReachable('pane.moveToMainWindow', 'linux')).toBe(true)
    expect(keyboardReachable('layout.save', 'win32')).toBe(false)
  })
})

describe('gesture labels', () => {
  it('names modifiers as each platform does', () => {
    expect(platforms.map(platform => gestureLabel('doubleClick', ['ctrl'], platform))).toEqual(['Ctrl+Double-click', 'Ctrl+Double-click', '⌃ Double-click'])
    expect(platforms.map(platform => gestureLabel('click', ['mod'], platform))).toEqual(['Ctrl+Click', 'Ctrl+Click', '⌘ Click'])
    expect(platforms.map(platform => gestureLabel('hover', ['mod', 'shift'], platform))).toEqual(['Ctrl+Shift+Hover', 'Ctrl+Shift+Hover', '⇧⌘ Hover'])
    expect(platforms.map(platform => gestureLabel('drag', ['meta'], platform))).toEqual(['Win+Drag', 'Super+Drag', '⌘ Drag'])
    expect(platforms.map(platform => gestureLabel('click', ['alt'], platform))).toEqual(['Alt+Click', 'Alt+Click', '⌥ Click'])
    expect(gestureLabel('doubleClick', [], 'darwin')).toBe('Double-click')
    expect(platforms.map(platform => modifiersLabel([], platform))).toEqual(['None', 'None', 'None'])
  })
  it('phrases gestures for tooltips', () => {
    expect(platforms.map(platform => gesturePhrase('drag', ['ctrl'], platform))).toEqual(['Ctrl-drag', 'Ctrl-drag', 'Control-drag'])
    expect(platforms.map(platform => gesturePhrase('hover', ['mod'], platform))).toEqual(['Ctrl-hover', 'Ctrl-hover', 'Command-hover'])
    expect(gesturePhrase('doubleClick', ['alt', 'shift'], 'darwin')).toBe('Option-Shift-double-click')
    expect(gesturePhrase('doubleClick', [], 'win32')).toBe('double-click')
  })
  it('builds the tooltips that mention a gesture from the catalogue', () => {
    expect(paneTabTitle(new GestureService('win32'))).toBe('Drag to dock; Ctrl-drag to float; Ctrl-double-click to toggle docking')
    expect(paneTabTitle(new GestureService('darwin'))).toBe('Drag to dock; Control-drag to float; Command-double-click to toggle docking')
    expect(popoutTabTitle(new GestureService('linux'))).toBe('Drag onto the main window to dock it there; Ctrl-double-click to move it back')
    // A remap reaches the tooltip.
    const remapped = new GestureService('win32')
    remapped.setModifiers(new Map([['dock.floatWhileDragging', ['alt']], ['dock.toggleFloat', ['shift']]]))
    expect(paneTabTitle(remapped)).toBe('Drag to dock; Alt-drag to float; Shift-double-click to toggle docking')
  })
  it('keeps docs/gestures.md in sync', async () => {
    const docs = renderGestureDocs()
    for (const id of gestureIds) expect(docs, id).toContain(`| \`${id}\` |`)
    expect(docs).toContain('| Toggle Docking | `dock.toggleFloat` | Floats a docked panel, or docks a floating one. | Command | Ctrl+Double-click a panel tab | Ctrl+Double-click a panel tab | ⌘ Double-click a panel tab | Choose: Ctrl / ⌘, Alt / ⌥, Shift / ⇧, None | Float (`pane.float`), Dock (`pane.dock`) |')
    expect(docs).toContain('Choose: Ctrl / ⌘, Shift / ⇧, Off')
    await expect(docs).toMatchFileSnapshot('../docs/gestures.md')
  })
})

describe('GestureService', () => {
  it('matches exactly what the handlers checked before the catalogue', () => {
    // Each handler's old test, by gesture: other modifiers never mattered.
    const before: Record<string, (event: GestureEvent, platform: Platform) => boolean> = {
      'grid.addToSelection': (event, platform) => !!(platform === 'darwin' ? event.metaKey : event.ctrlKey),
      'grid.extendSelection': event => !!event.shiftKey,
      'grid.secondaryClick': (event, platform) => !!event.ctrlKey && platform === 'darwin',
      'grid.fitColumn': () => true,
      'global.wheelZoom': event => !!event.ctrlKey,
      'explorer.peekHover': (event, platform) => !!(platform === 'darwin' ? event.metaKey : event.ctrlKey),
      'dock.floatWhileDragging': event => !!event.ctrlKey,
      'dock.dragFloatingTitleBar': event => !!event.shiftKey,
      // Except on macOS, where Control+double-click never arrived (Control+click is a right-click): ⌘ instead.
      'dock.toggleFloat': (event, platform) => !!(platform === 'darwin' ? event.metaKey : event.ctrlKey),
      'popout.returnToMain': (event, platform) => !!(platform === 'darwin' ? event.metaKey : event.ctrlKey),
      'documentTabs.rename': () => true
    }
    for (const platform of platforms) {
      const service = new GestureService(platform)
      for (const [id, old] of Object.entries(before)) for (const event of events) expect(service.matches(id as keyof typeof before & Parameters<GestureService['matches']>[0], event), `${id} on ${platform}: ${JSON.stringify(event)}`).toBe(old(event, platform))
    }
    // Every gesture a handler asks about is pinned above.
    const asked = gestureIds.filter(id => gestureDescriptor(id).kind !== 'fixed' || gestureDescriptor(id).modifiers.length || id === 'grid.fitColumn')
    expect(asked.filter(id => !Object.hasOwn(before, id))).toEqual([])
  })
  it('follows a remap, turns a gesture off, and tracks its modifier key mid-drag', () => {
    const service = new GestureService('darwin')
    expect(service.isModifierKey('dock.floatWhileDragging', 'Control')).toBe(true)
    expect(service.isModifierKey('dock.floatWhileDragging', 'Meta')).toBe(false)
    expect(service.isModifierKey('explorer.peekHover', 'Meta')).toBe(true)
    service.setModifiers(new Map([['dock.floatWhileDragging', ['alt']], ['explorer.peekHover', null]]))
    expect(service.matches('dock.floatWhileDragging', { altKey: true })).toBe(true)
    expect(service.matches('dock.floatWhileDragging', { ctrlKey: true })).toBe(false)
    expect(service.isModifierKey('dock.floatWhileDragging', 'Alt')).toBe(true)
    expect(service.matches('explorer.peekHover', { metaKey: true, ctrlKey: true, altKey: true, shiftKey: true })).toBe(false)
    expect([service.label('explorer.peekHover'), service.label('dock.floatWhileDragging')]).toEqual(['Off', '⌥ Drag'])
    // Locked gestures and modifier sets a gesture does not offer keep their defaults; only modifier gestures turn off.
    service.setModifiers(new Map([['grid.secondaryClick', []], ['explorer.peekHover', ['alt']], ['dock.toggleFloat', null], ['grid.addToSelection', ['alt']]]))
    expect(service.matches('grid.secondaryClick', {})).toBe(false)
    expect(service.matches('grid.secondaryClick', { ctrlKey: true })).toBe(true)
    expect(service.matches('explorer.peekHover', { altKey: true })).toBe(false)
    expect(service.matches('dock.toggleFloat', { metaKey: true })).toBe(true)
    expect(service.matches('grid.addToSelection', { altKey: true })).toBe(true)
    // Ids left out return to their defaults.
    service.setModifiers(new Map())
    expect(service.matches('explorer.peekHover', { metaKey: true })).toBe(true)
  })
  it('shares one service per platform between the workbench and the pure helpers', () => {
    expect(gesturesFor('win32')).toBe(gesturesFor('win32'))
    expect(gesturesFor('win32')).not.toBe(gesturesFor('darwin'))
  })
})
