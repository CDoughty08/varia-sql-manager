import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MenubarId } from '../src/shared/commands/menus'
import { dragActivation, hoverDelay, maxLevels, MenuController, safeTriangleTimeout, typeAheadTimeout, type MenuKey } from '../src/renderer/src/menus/MenuController'
import type { Rect } from '../src/renderer/src/menus/geometry'
import type { ResolvedMenuItem } from '../src/renderer/src/menus/resolve'
import { manualTimers } from './fixtures/workbench'

afterEach(() => { vi.restoreAllMocks() })

let separators = 0
const command = (title: string, mnemonic = 0, enabled = true): ResolvedMenuItem => ({ kind: 'command', key: title, id: 'file.new', title, mnemonic, enabled })
const separator = (): ResolvedMenuItem => ({ kind: 'separator', key: `sep:${separators++}` })
const submenu = (title: string, mnemonic: number, items: ResolvedMenuItem[]): ResolvedMenuItem => ({ kind: 'submenu', key: title, title, mnemonic, items })

const menus: Record<MenubarId, ResolvedMenuItem[]> = {
  file: [command('New Query'), command('Open…'), separator(), command('Save'), command('Save As…', 5, false)],
  edit: [command('Undo'), command('Redo'), separator(), command('Find')],
  view: [command('Command Palette…'), separator(), submenu('Theme', 1, [command('Color Theme…'), separator(), submenu('Dark Theme', 3, [command('Varia Dark', -1), command('Harbor', -1)])])],
  query: [submenu('Connection', 1, [command('Connect…'), command('Disconnect')]), command('Execute', 1), command('Cancel Executing Query', 0, false)],
  tools: [command('Options…')],
  window: [command('Object Explorer')]
}
const buttons: Record<MenubarId, Rect> = { file: rect(40, 0, 40, 34), edit: rect(80, 0, 40, 34), view: rect(120, 0, 40, 34), query: rect(160, 0, 50, 34), tools: rect(210, 0, 50, 34), window: rect(260, 0, 60, 34) }
function rect(left: number, top: number, width: number, height: number): Rect { return { left, top, right: left + width, bottom: top + height } }
const key = (name: string, extra: Partial<MenuKey> = {}): MenuKey => ({ key: name, code: /^[a-z]$/i.test(name) ? `Key${name.toUpperCase()}` : name, alt: false, ctrl: false, meta: false, shift: false, repeat: false, ...extra })

function harness() {
  const { timers, advance, pending } = manualTimers()
  const calls: string[] = []
  const controller = new MenuController({
    timers, menubar: id => menus[id], menubarRect: id => buttons[id],
    activate: item => calls.push(`activate ${item.key} (levels ${controller.view.levels.length})`),
    closed: reason => calls.push(`closed ${reason}`)
  })
  const press = (name: string, extra: Partial<MenuKey> = {}) => controller.key(key(name, extra))
  const active = () => controller.view.levels.map(level => level.active)
  const titles = (level = controller.view.levels.length - 1) => controller.view.levels[level]?.items.map(item => item.kind === 'separator' ? '-' : item.title)
  const current = () => { const level = controller.view.levels.at(-1); const item = level?.items[level.active]; return item && item.kind !== 'separator' ? item.title : undefined }
  return { controller, calls, advance, pending, press, active, titles, current }
}

describe('menubar focus (no dropdown)', () => {
  it('moves between menus with the arrows, Home, and End, wrapping', () => {
    const { controller, press } = harness()
    expect(controller.ownsKeyboard()).toBe(false)
    expect(press('ArrowDown')).toBe('passthrough')
    controller.focusMenubar()
    expect(controller.view).toMatchObject({ levels: [], source: null, mnemonics: true, menubar: { focused: 'file', open: null } })
    expect(controller.ownsKeyboard()).toBe(true)
    const focused = () => controller.view.menubar.focused
    expect([press('ArrowLeft'), focused()]).toEqual(['consumed', 'window'])
    press('ArrowRight'); expect(focused()).toBe('file')
    press('ArrowRight'); expect(focused()).toBe('edit')
    press('End'); expect(focused()).toBe('window')
    press('Home'); expect(focused()).toBe('file')
  })
  it('opens the focused menu with Down, Enter, or Space at the first item, and Up at the last', () => {
    for (const [name, expected] of [['ArrowDown', 0], ['Enter', 0], [' ', 0], ['ArrowUp', 4]] as const) {
      const { controller, press, active } = harness()
      controller.focusMenubar('file')
      press(name)
      expect(controller.view, name).toMatchObject({ source: 'menubar', mnemonics: true, menubar: { focused: 'file', open: 'file' } })
      expect(active(), name).toEqual([expected])
      expect(controller.view.levels[0]).toMatchObject({ label: 'File', anchor: { kind: 'below', rect: buttons.file } })
    }
  })
  it('opens a menu by its mnemonic and consumes every other key', () => {
    const { controller, press, active, calls } = harness()
    controller.focusMenubar('file')
    for (const name of ['x', 'F5', 'Delete', 'Shift', 'F10']) {
      if (name === 'F10') break
      expect(press(name), name).toBe('consumed')
    }
    expect(controller.view.menubar).toEqual({ focused: 'file', open: null })
    press('q')
    expect(controller.view.menubar.open).toBe('query')
    expect(active()).toEqual([0])
    expect(calls).toEqual([])
  })
  it('leaves with Escape, Tab, or F10, and lets Ctrl and ⌘ chords through after leaving', () => {
    for (const [name, extra, reason, result] of [['Escape', {}, 'escape', 'consumed'], ['Tab', {}, 'tab', 'consumed'], ['Tab', { shift: true }, 'tab', 'consumed'], ['F10', {}, 'escape', 'consumed'], ['s', { ctrl: true }, 'escape', 'passthrough'], ['p', { meta: true, shift: true }, 'escape', 'passthrough']] as const) {
      const { controller, press, calls } = harness()
      controller.focusMenubar('edit')
      expect(press(name, extra), name).toBe(result)
      expect(calls, name).toEqual([`closed ${reason}`])
      expect(controller.ownsKeyboard()).toBe(false)
    }
  })
})

describe('keys inside a menu', () => {
  it('moves with the arrows, skipping separators and wrapping, and lets disabled items take focus', () => {
    const { controller, press, active } = harness()
    controller.openMenubar('file', { keyboard: false, focus: 'none' })
    expect(active()).toEqual([-1])
    press('ArrowDown'); expect(active()).toEqual([0])
    expect(controller.view.mnemonics).toBe(true)
    press('ArrowDown'); press('ArrowDown'); expect(active()).toEqual([3])
    press('ArrowDown'); expect(active()).toEqual([4])
    press('ArrowDown'); expect(active()).toEqual([0])
    press('ArrowUp'); expect(active()).toEqual([4])
    press('Home'); expect(active()).toEqual([0])
    press('PageDown'); expect(active()).toEqual([4])
    press('PageUp'); expect(active()).toEqual([0])
    press('End'); expect(active()).toEqual([4])
    controller.openMenubar('file', { keyboard: false, focus: 'none' })
    press('ArrowUp'); expect(active()).toEqual([4])
  })
  it('opens submenus with Right, Enter, or Space, and closes only the innermost with Left or Escape', () => {
    const { controller, press, active, titles } = harness()
    controller.openMenubar('query', { keyboard: true, focus: 'first' })
    press('ArrowRight')
    expect(active()).toEqual([0, 0])
    expect(titles()).toEqual(['Connect…', 'Disconnect'])
    expect(controller.view.levels[1].label).toBe('Connection')
    press('ArrowLeft')
    expect(active()).toEqual([0])
    press('Enter'); expect(active()).toEqual([0, 0])
    press('Escape'); expect(active()).toEqual([0])
    press(' '); expect(active()).toEqual([0, 0])
    expect(controller.view.menubar.open).toBe('query')
  })
  it('switches menubar menus with Left and Right at a dropdown\'s root', () => {
    const { controller, press, active } = harness()
    controller.openMenubar('edit', { keyboard: false, focus: 'none' })
    press('ArrowRight')
    expect(controller.view.menubar).toEqual({ focused: 'view', open: 'view' })
    expect(active()).toEqual([0])
    expect(controller.view.mnemonics).toBe(true)
    press('ArrowLeft'); press('ArrowLeft')
    expect(controller.view.menubar.open).toBe('file')
    press('ArrowLeft')
    expect(controller.view.menubar.open).toBe('window')
  })
  it('does nothing with Left or Right at a context menu\'s root', () => {
    const { controller, press, active } = harness()
    controller.openContext(menus.edit, { kind: 'point', x: 5, y: 5 }, { keyboard: true, label: 'Query editor' })
    press('ArrowRight'); press('ArrowLeft')
    expect(active()).toEqual([0])
    expect(controller.view.source).toBe('context')
  })
  it('runs a command with Enter or Space after closing, and ignores disabled items', () => {
    const { controller, press, calls } = harness()
    controller.openMenubar('file', { keyboard: true, focus: 'last' })
    press('Enter'); press(' ')
    expect(calls).toEqual([])
    press('Home'); press('Enter')
    expect(calls).toEqual(['closed activate', 'activate New Query (levels 0)'])
    expect(controller.ownsKeyboard()).toBe(false)
  })
  it('returns Escape from a dropdown to its menubar button, and from a context menu to the page', () => {
    const { controller, press, calls } = harness()
    controller.openMenubar('edit', { keyboard: false, focus: 'none' })
    press('Escape')
    expect(controller.view).toMatchObject({ levels: [], menubar: { focused: 'edit', open: null }, mnemonics: true })
    expect(calls).toEqual([])
    press('Escape')
    expect(calls).toEqual(['closed escape'])
    controller.openContext(menus.edit, { kind: 'point', x: 5, y: 5 }, { keyboard: false, label: 'Query editor' })
    press('Escape')
    expect(calls).toEqual(['closed escape', 'closed escape'])
  })
  it('closes everything on Tab or F10, and passes Ctrl and ⌘ chords and Alt+F4 on after closing', () => {
    for (const [name, extra, reason, result] of [['Tab', {}, 'tab', 'consumed'], ['F10', {}, 'escape', 'consumed'], ['s', { ctrl: true }, 'escape', 'passthrough'], ['c', { meta: true }, 'escape', 'passthrough'], ['F4', { alt: true }, 'escape', 'passthrough']] as const) {
      const { controller, press, calls } = harness()
      controller.openMenubar('view', { keyboard: true, focus: 'last' })
      press('ArrowRight')
      expect(press(name, extra), name).toBe(result)
      expect(calls, name).toEqual([`closed ${reason}`])
      expect(controller.view.levels).toEqual([])
    }
  })
  it('consumes Shift+F10, the context-menu key, function keys, and modifiers without doing anything', () => {
    const { controller, press, active, calls } = harness()
    controller.openContext(menus.file, { kind: 'point', x: 5, y: 5 }, { keyboard: true, label: 'Query tab' })
    for (const [name, extra] of [['F10', { shift: true }], ['ContextMenu', {}], ['F5', {}], ['Alt', { alt: true }], ['Control', { ctrl: true }], ['Insert', {}]] as const) expect(press(name, extra), name).toBe('consumed')
    expect(active()).toEqual([0])
    expect(calls).toEqual([])
  })
  it('switches dropdowns with Alt and a menubar mnemonic, and uses Alt+letter as the mnemonic in a context menu', () => {
    const { controller, press, calls } = harness()
    controller.openMenubar('file', { keyboard: true, focus: 'first' })
    press('w', { alt: true })
    expect(controller.view.menubar.open).toBe('window')
    controller.openContext(menus.edit, { kind: 'point', x: 5, y: 5 }, { keyboard: false, label: 'Text field' })
    press('r', { alt: true })
    expect(calls).toEqual(['closed replace', 'closed activate', 'activate Redo (levels 0)'])
  })
})

describe('mnemonics and type-ahead', () => {
  it('activates a unique enabled mnemonic, opens a submenu, and only focuses a disabled one', () => {
    const { controller, press, active, calls } = harness()
    controller.openMenubar('query', { keyboard: false, focus: 'none' })
    press('c')
    expect(active()).toEqual([2])
    expect(calls).toEqual([])
    expect(controller.view.mnemonics).toBe(true)
    press('o')
    expect(active()).toEqual([0, 0])
    press('Escape')
    press('x')
    expect(calls).toEqual(['closed activate', 'activate Execute (levels 0)'])
  })
  it('cycles between items that share a mnemonic', () => {
    const { controller, press, active, calls } = harness()
    const shared = [command('Copy'), command('Cut', 0), separator(), command('Paste')]
    controller.openContext(shared, { kind: 'point', x: 5, y: 5 }, { keyboard: false, label: 'Text field' })
    press('c'); expect(active()).toEqual([0])
    press('C'); expect(active()).toEqual([1])
    press('c'); expect(active()).toEqual([0])
    expect(calls).toEqual([])
  })
  it('uses the physical key for mnemonics on non-Latin layouts', () => {
    const { controller, press, calls } = harness()
    controller.openContext(menus.edit, { kind: 'point', x: 5, y: 5 }, { keyboard: true, label: 'Text field' })
    press('к', { code: 'KeyR' })
    expect(calls).toEqual(['closed activate', 'activate Redo (levels 0)'])
  })
  it('searches titles with the characters typed within 500 ms when no mnemonic matches', () => {
    const { controller, press, current, advance } = harness()
    const items = [command('Save', -1), command('Select All', -1), command('Save All', -1), separator(), command('Script', -1), command('Save As', -1)]
    controller.openContext(items, { kind: 'point', x: 5, y: 5 }, { keyboard: true, label: 'Query tab' })
    press('s'); expect(current()).toBe('Select All')
    advance(typeAheadTimeout - 1)
    press('a'); expect(current()).toBe('Save All')
    // Space joins the search while one is running.
    for (const character of 've a') press(character)
    expect(current()).toBe('Save All')
    press('s'); expect(current()).toBe('Save As')
    // A new search starts after the active item and wraps.
    advance(typeAheadTimeout)
    press('s'); expect(current()).toBe('Save')
    advance(typeAheadTimeout)
    press('x'); expect(current()).toBe('Save')
    // Space starts no search: it runs the active item.
    advance(typeAheadTimeout)
    expect(press(' ')).toBe('consumed')
    expect(controller.view.levels).toEqual([])
  })
  it('limits the search text to 32 characters', () => {
    const { controller, press, current } = harness()
    const long = 'a'.repeat(32)
    controller.openContext([command('b', -1), command(long + 'b', -1), command(long + 'c', -1)], { kind: 'point', x: 5, y: 5 }, { keyboard: false, label: 'List' })
    for (let index = 0; index < 32; index++) press('a')
    expect(current()).toBe(long + 'b')
    press('c')
    expect(current()).toBe(long + 'b')
  })
})

describe('pointer', () => {
  it('activates hovered items and opens a submenu parent after the hover delay', () => {
    const { controller, active, advance, titles } = harness()
    controller.openMenubar('view', { keyboard: false, focus: 'none' })
    controller.pointerEnterItem(0, 0, { x: 130, y: 45 })
    expect(active()).toEqual([0])
    controller.pointerEnterItem(0, 2, { x: 130, y: 80 })
    advance(hoverDelay - 1)
    expect(active()).toEqual([2])
    // Hovering away before the delay cancels it.
    controller.pointerEnterItem(0, 0, { x: 130, y: 45 })
    advance(hoverDelay)
    expect(active()).toEqual([0])
    controller.pointerEnterItem(0, 2, { x: 130, y: 80 })
    advance(hoverDelay)
    expect(active()).toEqual([2, -1])
    expect(titles()).toEqual(['Color Theme…', '-', 'Dark Theme'])
    // Separators take no hover.
    controller.pointerEnterItem(1, 1, { x: 400, y: 80 })
    expect(active()).toEqual([2, -1])
  })
  it('keeps the active item while its submenu is open when the pointer leaves, and clears it otherwise', () => {
    const { controller, active } = harness()
    controller.openMenubar('query', { keyboard: false, focus: 'none' })
    controller.click(0, 0)
    controller.pointerLeaveLevel(0)
    expect(active()).toEqual([0, -1])
    controller.pointerEnterItem(1, 1, { x: 300, y: 60 })
    controller.pointerLeaveLevel(1)
    expect(active()).toEqual([0, -1])
    controller.pointerEnterItem(0, 1, { x: 170, y: 70 })
    controller.click(0, 1)
    expect(controller.view.levels).toEqual([])
  })
  it('closes an open submenu 250 ms after the pointer moves to a sibling outside the safe triangle', () => {
    const { controller, active, advance } = harness()
    controller.openMenubar('view', { keyboard: false, focus: 'none' })
    controller.click(0, 2)
    controller.setLevelRect(0, rect(120, 34, 200, 80), [rect(120, 38, 200, 24), rect(120, 62, 200, 9), rect(120, 71, 200, 24)])
    controller.setLevelRect(1, rect(318, 67, 200, 60), [rect(318, 71, 200, 24)])
    controller.pointerMove({ x: 200, y: 80 })
    controller.pointerEnterItem(0, 0, { x: 200, y: 50 })
    advance(hoverDelay - 1)
    expect(active()).toEqual([2, -1])
    advance(1)
    expect(active()).toEqual([0])
  })
  it('defers a sibling while the pointer heads for the submenu, up to 400 ms, unless it enters it', () => {
    const { controller, active, advance } = harness()
    const open = () => {
      controller.openMenubar('view', { keyboard: false, focus: 'none' })
      controller.click(0, 2)
      // The parent item spans y 71-95; its submenu opens to the right, from y 67 down to y 400.
      controller.setLevelRect(0, rect(120, 34, 200, 80), [rect(120, 38, 200, 24), rect(120, 62, 200, 9), rect(120, 71, 200, 24)])
      controller.setLevelRect(1, rect(318, 67, 200, 333), [rect(318, 71, 200, 24)])
      controller.pointerMove({ x: 250, y: 92 })
    }
    open()
    // On its way to the submenu, the pointer crosses another item of the parent menu.
    controller.pointerEnterItem(0, 0, { x: 260, y: 96 })
    advance(hoverDelay)
    expect(active()).toEqual([2, -1])
    controller.pointerMove({ x: 270, y: 110 })
    advance(safeTriangleTimeout - hoverDelay - 1)
    expect(active()).toEqual([2, -1])
    advance(1)
    expect(active()).toEqual([0])
    // Entering the submenu keeps it open.
    open()
    controller.pointerEnterItem(0, 0, { x: 260, y: 96 })
    controller.pointerEnterItem(1, 0, { x: 320, y: 120 })
    advance(safeTriangleTimeout)
    expect(active()).toEqual([2, 0])
    // Leaving the triangle falls back to the hover delay.
    open()
    controller.pointerEnterItem(0, 0, { x: 260, y: 96 })
    advance(100)
    controller.pointerMove({ x: 150, y: 96 })
    advance(hoverDelay - 1)
    expect(active()).toEqual([2, -1])
    advance(1)
    expect(active()).toEqual([0])
    // Coming back to the parent item cancels the change.
    open()
    controller.pointerEnterItem(0, 0, { x: 260, y: 96 })
    controller.pointerEnterItem(0, 2, { x: 260, y: 90 })
    advance(safeTriangleTimeout)
    expect(active()).toEqual([2, -1])
  })
  it('activates enabled commands on click, including clicks with no pointer events before them', () => {
    const { controller, calls } = harness()
    controller.openMenubar('file', { keyboard: false, focus: 'none' })
    controller.click(0, 4)
    controller.click(0, 2)
    controller.click(0, 9)
    controller.click(3, 0)
    expect(calls).toEqual([])
    controller.click(0, 1)
    expect(calls).toEqual(['closed activate', 'activate Open… (levels 0)'])
  })
  it('opens a submenu on click at once, anchored beside its parent item', () => {
    const { controller, active, pending } = harness()
    controller.openMenubar('view', { keyboard: false, focus: 'none' })
    controller.setLevelRect(0, rect(120, 34, 200, 80), [rect(120, 38, 200, 24), rect(120, 62, 200, 9), rect(120, 71, 200, 24)])
    controller.pointerEnterItem(0, 2, { x: 130, y: 80 })
    controller.click(0, 2)
    expect(active()).toEqual([2, -1])
    expect(controller.view.levels[1].anchor).toEqual({ kind: 'right', rect: { left: 120, right: 320, top: 71, bottom: 95 } })
    expect(pending.size).toBe(0)
  })
  it('never activates on a release of another button, or a quick release after a menubar press', () => {
    const { controller, calls, advance } = harness()
    controller.menubarPointerDown('file', { x: 50, y: 10 })
    expect(controller.view.menubar.open).toBe('file')
    controller.pointerUp(0, 0, { x: 52, y: 12 }, 0)
    expect(calls).toEqual([])
    controller.menubarPointerDown('edit', { x: 90, y: 10 })
    advance(dragActivation.ms)
    controller.pointerUp(0, 0, { x: 90, y: 50 }, 2)
    controller.pointerUp(0, 0, { x: 90, y: 50 }, 0)
    expect(calls).toEqual([])
    expect(controller.view.menubar.open).toBe('edit')
  })
  it('activates on a menubar press dragged to an item and released after 250 ms or 6 px', () => {
    for (const [wait, moved] of [[dragActivation.ms, 0], [0, dragActivation.px]]) {
      const { controller, calls, advance } = harness()
      controller.menubarPointerDown('edit', { x: 90, y: 10 })
      advance(wait)
      controller.pointerMove({ x: 90, y: 10 + moved })
      controller.pointerUp(0, 1, { x: 90, y: 10 + moved }, 0)
      expect(calls).toEqual(['closed activate', 'activate Redo (levels 0)'])
    }
    // Released over nothing, or over a disabled item: the press ends and the menu stays.
    const { controller, calls, advance } = harness()
    controller.menubarPointerDown('file', { x: 50, y: 10 })
    advance(dragActivation.ms)
    controller.pointerUp(0, 4, { x: 50, y: 150 }, 0)
    controller.pointerUp(-1, -1, { x: 50, y: 150 }, 0)
    expect(calls).toEqual([])
    expect(controller.view.menubar.open).toBe('file')
  })
  it('toggles a menubar menu by pressing its button, and switches menus by hovering others while one is open', () => {
    const { controller, calls } = harness()
    controller.menubarPointerEnter('view')
    expect(controller.view.levels).toEqual([])
    controller.menubarPointerDown('file', { x: 50, y: 10 })
    controller.menubarPointerEnter('view')
    expect(controller.view.menubar).toEqual({ focused: 'view', open: 'view' })
    expect(controller.view.levels[0].active).toBe(-1)
    controller.menubarPointerDown('view', { x: 130, y: 10 })
    expect(controller.ownsKeyboard()).toBe(false)
    expect(calls).toEqual(['closed outside'])
  })
})

describe('menu lifecycle', () => {
  it('opens context menus with or without the keyboard, and replaces an open one', () => {
    const { controller, active, calls } = harness()
    controller.openContext([separator()], { kind: 'point', x: 1, y: 1 }, { keyboard: true, label: 'Empty' })
    expect(controller.ownsKeyboard()).toBe(false)
    controller.openContext(menus.edit, { kind: 'point', x: 10, y: 20 }, { keyboard: false, label: 'Query editor' })
    expect(controller.view).toMatchObject({ source: 'context', mnemonics: false, menubar: { focused: null, open: null } })
    expect(controller.view.levels[0]).toMatchObject({ label: 'Query editor', active: -1, anchor: { kind: 'point', x: 10, y: 20 } })
    controller.openContext([separator(), ...menus.file], { kind: 'below', rect: rect(0, 0, 10, 10) }, { keyboard: true, label: 'Query tab' })
    expect(active()).toEqual([1])
    expect(controller.view.mnemonics).toBe(true)
    expect(calls).toEqual(['closed replace'])
    controller.openMenubar('edit', { keyboard: true, focus: 'first' })
    expect(calls).toEqual(['closed replace', 'closed replace'])
    controller.focusMenubar()
    expect(controller.view.menubar).toEqual({ focused: 'edit', open: null })
    expect(calls).toHaveLength(2)
  })
  it('closes before running a command, so focus is restored first', () => {
    const order: string[] = []
    const controller = new MenuController({ timers: manualTimers().timers, menubar: id => menus[id], menubarRect: () => undefined,
      closed: reason => order.push(`closed ${reason}: ${controller.view.levels.length} levels`), activate: item => order.push(`activate ${item.key}`) })
    controller.openMenubar('file', { keyboard: true, focus: 'first' })
    controller.key(key('Enter'))
    expect(order).toEqual(['closed activate: 0 levels', 'activate New Query'])
    expect(controller.view.levels[0]).toBeUndefined()
  })
  it('opens at most four levels', () => {
    let items: ResolvedMenuItem[] = [command('Leaf')]
    for (let depth = 0; depth < 5; depth++) items = [submenu(`Level ${depth}`, 0, items)]
    const { controller, press } = harness()
    controller.openContext(items, { kind: 'point', x: 1, y: 1 }, { keyboard: true, label: 'Deep' })
    for (let step = 0; step < 6; step++) press('ArrowRight')
    expect(controller.view.levels).toHaveLength(maxLevels)
  })
  it('contains failing callbacks', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const controller = new MenuController({ timers: manualTimers().timers, menubar: () => { throw new Error('menubar') }, menubarRect: () => undefined,
      closed: () => { throw new Error('closed') }, activate: () => { throw new Error('activate') } })
    controller.openMenubar('file', { keyboard: true, focus: 'first' })
    expect(controller.ownsKeyboard()).toBe(false)
    controller.openContext(menus.edit, { kind: 'point', x: 1, y: 1 }, { keyboard: true, label: 'Text field' })
    controller.key(key('Enter'))
    expect(controller.view.levels).toEqual([])
    expect(error).toHaveBeenCalledTimes(3)
  })
  it('clears its timers and listeners on dispose', () => {
    const { controller, pending, calls } = harness()
    const listener = vi.fn()
    controller.subscribe(listener)
    controller.menubarPointerDown('view', { x: 130, y: 10 })
    controller.pointerEnterItem(0, 2, { x: 130, y: 80 })
    controller.key(key('z'))
    expect(pending.size).toBeGreaterThan(0)
    controller.dispose()
    expect(pending.size).toBe(0)
    expect(calls).toEqual(['closed dispose'])
    expect(controller.view.levels).toEqual([])
    listener.mockClear()
    controller.openContext(menus.edit, { kind: 'point', x: 1, y: 1 }, { keyboard: false, label: 'Text field' })
    expect(listener).not.toHaveBeenCalled()
  })
})
