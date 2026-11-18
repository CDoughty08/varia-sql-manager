// @vitest-environment happy-dom
// The column profile's peek at the selected columns: which columns a selection covers, what the panel lists with Selected
// Columns Only and while peeking, and the peek's modifier as Object Explorer's Peek on Hover reads it (pointer on the
// panel, the press delay, a chord, release and blur).
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { GestureService } from '../src/renderer/src/core/gestures'
import { columnSelection, selectAll, selectedColumns, type GridSelection } from '../src/renderer/src/grid/selection'
import { profileList, profileStrip } from '../src/renderer/src/results/profile-format'
import { ProfilePeekService } from '../src/renderer/src/results/ProfilePeekService'
import { playCardMoves } from '../src/renderer/src/results/profile-motion'
import { peekLimits } from '../src/shared/explorer/peek'
import { manualTimers } from './fixtures/workbench'
import { descriptor, fakeResultClient, summaryOf } from './fixtures/results'
import { keyAt } from './fixtures/entries'
import { EventBus } from '../src/renderer/src/core/events'
import { ResultsService } from '../src/renderer/src/results/ResultsService'
import type { VariaApi } from '../src/shared/contracts'

const cells = (entry: string, ...blocks: [number, number, number, number][]): GridSelection =>
  ({ entry, blocks: blocks.map(([r0, c0, r1, c1]) => ({ kind: 'cells' as const, anchor: { row: r0, column: c0 }, focus: { row: r1, column: c1 } })), active: { row: blocks.at(-1)![2], column: blocks.at(-1)![3] } })

describe('column profile selection', () => {
  it('covers the columns of every block, whatever rows they span, and every column for a row or Select All', () => {
    expect([...selectedColumns(undefined, 5)]).toEqual([])
    expect([...selectedColumns(cells('e', [3, 1, 9, 2], [0, 4, 0, 4]), 5)].sort()).toEqual([1, 2, 4])
    expect([...selectedColumns(columnSelection('e', 3, 7), 5)]).toEqual([3])
    expect(columnSelection('e', 3, 7).active).toEqual({ row: 7, column: 3 })
    expect([...selectedColumns(selectAll('e'), 3)].sort()).toEqual([0, 1, 2])
    expect([...selectedColumns({ entry: 'e', blocks: [{ kind: 'rows', anchor: { row: 2, column: 0 }, focus: { row: 4, column: 0 } }], active: { row: 2, column: 0 } }, 3)].sort()).toEqual([0, 1, 2])
    // A block past the last column is clamped to it.
    expect([...selectedColumns(cells('e', [0, 1, 0, 99]), 3)].sort()).toEqual([1, 2])
  })

  it('lists the selected columns with Selected Columns Only, and the other list while peeking', () => {
    const all = [0, 1, 2, 3], selected = new Set([1, 3])
    expect(profileList(all, selected, false, false)).toEqual({ columns: all, only: false })
    expect(profileList(all, selected, true, false)).toEqual({ columns: [1, 3], only: true })
    expect(profileList(all, selected, false, true)).toEqual({ columns: [1, 3], only: true })
    expect(profileList(all, selected, true, true)).toEqual({ columns: all, only: false })
    expect(profileStrip(profileList(all, selected, false, false), 4, false)).toBeUndefined()
    expect(profileStrip(profileList(all, selected, true, false), 4, false)).toBe('2 of 4 columns')
    expect(profileStrip(profileList(all, new Set(), true, false), 4, false)).toBe('No columns selected')
    expect(profileStrip(profileList(all, new Set([2]), false, true), 4, true)).toBe('Peeking at 1 selected column · release to show all')
    expect(profileStrip(profileList(all, selected, true, true), 4, true)).toBe('Peeking at all 4 columns · release to go back')
  })
})

describe('profile card motion', () => {
  it('keeps the list\'s scrollbar gutter, so cards keep their width as a filtered list starts or stops overflowing', () => {
    const rule = /\.profile-cards \{([^}]*)\}/.exec(readFileSync('src/renderer/src/styles.css', 'utf8'))?.[1] ?? ''
    expect(rule).toContain('overflow: auto')
    expect(rule).toContain('scrollbar-gutter: stable')
  })

  it('moves, fades in and fades out the cards with transform and opacity only, never layout properties', () => {
    const played: { target: Element; frames: Keyframe[]; options: unknown }[] = []
    const animate = vi.spyOn(HTMLElement.prototype, 'animate').mockImplementation(function (this: HTMLElement, frames, options) {
      played.push({ target: this, frames: frames as Keyframe[], options })
      return { cancel() {}, onfinish: null, oncancel: null } as unknown as Animation
    })
    const animations = vi.spyOn(HTMLElement.prototype, 'getAnimations').mockReturnValue([])
    const place = (element: HTMLElement, top: number) => { element.getBoundingClientRect = () => ({ top, left: 10, width: 200, height: 40, right: 210, bottom: top + 40, x: 10, y: top, toJSON() {} }) }
    const scroller = document.createElement('div'), ghosts = document.createElement('div')
    // The theme's move token, as styles.css sets it (0 ms while motion is reduced, when nothing animates).
    scroller.style.setProperty('--varia-motion-move', '0ms')
    scroller.getBoundingClientRect = () => ({ top: 0, left: 0, width: 220, height: 400, right: 220, bottom: 400, x: 0, y: 0, toJSON() {} })
    scroller.append(ghosts)
    document.body.append(scroller)
    const stays = document.createElement('section'), arrives = document.createElement('section'), goes = document.createElement('section')
    goes.setAttribute('aria-label', 'c0')
    place(stays, 50)
    place(arrives, 100)
    // c1 was drawn at 100 and moves up to 50; c0 left from 50; c2 is new.
    const play = () => playCardMoves({ before: new Map([[0, { top: 50, height: 40, left: 10, width: 200 }], [1, { top: 100, height: 40, left: 10, width: 200 }]]), cards: new Map([[1, stays], [2, arrives]]), left: new Map([[0, goes]]), scroller, ghosts })
    play()
    expect(played).toEqual([])
    expect(ghosts.children).toHaveLength(0)
    scroller.style.setProperty('--varia-motion-move', '180ms')
    play()
    expect(played.every(entry => (entry.options as KeyframeAnimationOptions).duration === 180)).toBe(true)
    expect(played.find(play => play.target === stays)?.frames).toEqual([{ transform: 'translateY(50px)' }, { transform: 'none' }])
    expect(played.find(play => play.target === arrives)?.frames[0]).toMatchObject({ opacity: 0 })
    const ghost = ghosts.firstElementChild as HTMLElement
    expect(ghost.getAttribute('aria-label')).toBeNull()
    expect(ghost.getAttribute('aria-hidden')).toBe('true')
    expect(played.find(play => play.target === ghost)?.frames.at(-1)).toMatchObject({ opacity: 0 })
    const properties = new Set(played.flatMap(play => play.frames.flatMap(frame => Object.keys(frame))))
    expect([...properties].filter(property => !['transform', 'opacity', 'offset', 'easing'].includes(property))).toEqual([])
    scroller.remove()
    animate.mockRestore()
    animations.mockRestore()
  })

  it('animates only the cards drawn within a view of the scroller, so thousands of columns start a few dozen animations', () => {
    const targets: Element[] = []
    const animate = vi.spyOn(HTMLElement.prototype, 'animate').mockImplementation(function (this: HTMLElement) {
      targets.push(this)
      return { cancel() {}, onfinish: null, oncancel: null } as unknown as Animation
    })
    const animations = vi.spyOn(HTMLElement.prototype, 'getAnimations').mockReturnValue([])
    const place = (element: HTMLElement, top: number, height = 40) => { element.getBoundingClientRect = () => ({ top, left: 0, width: 200, height, right: 200, bottom: top + height, x: 0, y: top, toJSON() {} }) }
    const scroller = document.createElement('div'), ghosts = document.createElement('div')
    scroller.style.setProperty('--varia-motion-move', '180ms')
    place(scroller, 0, 400)
    scroller.append(ghosts)
    document.body.append(scroller)
    // Every card moves up 40 px; only those seen, before or after, within 400 px of the 400 px view move.
    const cards = new Map<number, HTMLElement>(), before = new Map<number, { top: number; height: number; left: number; width: number }>()
    for (let column = 0; column < 2000; column++) {
      const card = document.createElement('section')
      place(card, column * 40 - 2000)
      cards.set(column, card)
      before.set(column, { top: column * 40 - 1960, height: 40, left: 0, width: 200 })
    }
    playCardMoves({ before, cards, left: new Map(), scroller, ghosts })
    expect(targets.length).toBeGreaterThan(0)
    expect(targets.length).toBeLessThan(40)
    expect(targets.every(card => { const top = card.getBoundingClientRect().top; return top >= -480 && top <= 800 })).toBe(true)
    // A card that left far out of view leaves no ghost.
    const far = document.createElement('section')
    playCardMoves({ before: new Map([[5000, { top: 9000, height: 40, left: 0, width: 200 }]]), cards: new Map(), left: new Map([[5000, far]]), scroller, ghosts })
    expect(ghosts.children).toHaveLength(0)
    scroller.remove()
    animate.mockRestore()
    animations.mockRestore()
  })
})

describe('profile peek', () => {
  const setup = (gestures = new GestureService('win32')) => {
    const timers = manualTimers()
    const peek = new ProfilePeekService({ gestures, timers: timers.timers })
    const changes: (string | undefined)[] = []
    peek.subscribe(() => changes.push(peek.getSnapshot()))
    return { peek, timers, changes }
  }

  it('peeks the panel under a still pointer once Ctrl has been held for the press delay, until it is released', () => {
    const { peek, timers, changes } = setup()
    peek.keyDown('Control')
    timers.advance(peekLimits.pressMs)
    expect(peek.getSnapshot()).toBeUndefined()
    peek.keyUp('Control')
    peek.pointer('t', false)
    peek.keyDown('Control')
    timers.advance(peekLimits.pressMs - 1)
    expect(peek.getSnapshot()).toBeUndefined()
    timers.advance(1)
    expect(peek.getSnapshot()).toBe('t')
    // Key repeat while held changes nothing.
    peek.keyDown('Control', true)
    expect(changes).toEqual(['t'])
    peek.keyUp('Control')
    expect(peek.getSnapshot()).toBeUndefined()
  })

  it('peeks when the pointer arrives with Ctrl held, and stops when it leaves or the window loses focus', () => {
    const { peek, timers } = setup()
    peek.pointer('t', true)
    timers.advance(peekLimits.pressMs)
    expect(peek.getSnapshot()).toBe('t')
    peek.pointer(undefined)
    expect(peek.getSnapshot()).toBeUndefined()
    peek.pointer('t', true)
    timers.advance(peekLimits.pressMs)
    peek.blur()
    expect(peek.getSnapshot()).toBeUndefined()
    // A move without the modifier corrects a release the window did not see.
    peek.pointer('t', true)
    timers.advance(peekLimits.pressMs)
    peek.pointer('t', false)
    expect(peek.getSnapshot()).toBeUndefined()
  })

  it('stops peeking when the panel under the pointer goes away, and ignores another panel going', () => {
    const { peek, timers } = setup()
    peek.pointer('t', true)
    timers.advance(peekLimits.pressMs)
    peek.leave('other')
    expect(peek.getSnapshot()).toBe('t')
    peek.leave('t')
    expect(peek.getSnapshot()).toBeUndefined()
    // Ctrl pressed again with the pointer nowhere does not bring back the panel that went.
    peek.keyUp('Control')
    peek.keyDown('Control')
    timers.advance(peekLimits.pressMs)
    expect(peek.getSnapshot()).toBeUndefined()
  })

  it('treats Ctrl with another key as a chord (Ctrl+C on the panel), before or during the peek, until the pointer moves', () => {
    const { peek, timers, changes } = setup()
    peek.pointer('t', false)
    peek.keyDown('Control')
    peek.keyDown('c')
    timers.advance(peekLimits.pressMs)
    expect(changes).toEqual([])
    peek.keyUp('c')
    peek.keyDown('Control')
    timers.advance(peekLimits.pressMs)
    expect(peek.getSnapshot()).toBe('t')
    peek.keyDown('c')
    expect(peek.getSnapshot()).toBeUndefined()
    // Ctrl still held: nothing starts again until the pointer moves.
    timers.advance(peekLimits.pressMs)
    expect(peek.getSnapshot()).toBeUndefined()
    peek.pointer('t', true)
    timers.advance(peekLimits.pressMs)
    expect(peek.getSnapshot()).toBe('t')
  })

  it('follows a remapped modifier', () => {
    const gestures = new GestureService('win32')
    gestures.setModifiers({ 'output.profilePeekHover': 'shift' })
    const { peek, timers } = setup(gestures)
    peek.pointer('t', false)
    peek.keyDown('Control')
    timers.advance(peekLimits.pressMs)
    expect(peek.getSnapshot()).toBeUndefined()
    peek.keyUp('Control')
    peek.keyDown('Shift')
    timers.advance(peekLimits.pressMs)
    expect(peek.getSnapshot()).toBe('t')
  })
})

describe('results selection signal', () => {
  it('publishes a revision at every selection change, and selects a whole column for a profile card', () => {
    const client = fakeResultClient(), timers = manualTimers()
    const api = { copyResults: vi.fn(), saveResults: vi.fn(), cancelResultsJob: vi.fn(), onResultsJob: vi.fn(() => () => {}) } as unknown as VariaApi
    const results = new ResultsService({ client, api, events: new EventBus(), frame: callback => callback(), timers: timers.timers, newId: () => crypto.randomUUID() })
    results.begin('t1', 'q1')
    const value = descriptor(1, { rowsRead: 5, rowsStored: 5, rowsAvailable: 5 })
    client.emit('q1', { type: 'resultSet.opened', descriptor: value })
    void results.finish('t1', 'q1', { summary: summaryOf([value]) })
    const key = keyAt(results, 't1', 0)
    const seen = vi.fn()
    results.selections.subscribe(seen)
    results.setSelection('t1', key, columnSelection(key, 0, 3))
    expect(seen).toHaveBeenCalledTimes(1)
    // No grid drawn: the selection is set, on the active row it had.
    results.selectColumn('t1', key, 1)
    expect(results.selection('t1', key)).toEqual(columnSelection(key, 1, 3))
    expect(seen).toHaveBeenCalledTimes(2)
    // A drawn grid selects and scrolls itself; a column it does not have is ignored.
    const controller = { selectAll: vi.fn(), repaint: vi.fn(), fitColumn: vi.fn(), selectColumn: vi.fn() }
    const registration = results.registerGrid('t1', key, controller)
    results.selectColumn('t1', key, 0)
    results.selectColumn('t1', key, 2)
    expect(controller.selectColumn.mock.calls).toEqual([[0]])
    results.selectionChanged()
    results.clearSelections('t1')
    expect(seen).toHaveBeenCalledTimes(4)
    registration.dispose()
    results.dispose()
  })
})
