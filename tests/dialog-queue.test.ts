import { describe, expect, it } from 'vitest'
import { dialogQueue } from '../src/main/dialog-queue'

const settle = () => new Promise(resolve => setTimeout(resolve, 0))
/** A dialog that stays open until the test answers it. */
function held<T>() {
  let answer!: (value: T) => void, fail!: (error: Error) => void
  const shown = new Promise<T>((resolve, reject) => { answer = resolve; fail = reject })
  return { shown, answer, fail }
}
const cancelled = { canceled: true }

describe('dialogQueue', () => {
  it('opens a dialog asked for while another is open only once that one closes', async () => {
    const queue = dialogQueue(), opened: string[] = []
    const grid = held<{ canceled: boolean }>(), script = held<{ canceled: boolean }>()
    const first = queue(() => { opened.push('Save Grid Results'); return grid.shown }, cancelled)
    const second = queue(() => { opened.push('Save SQL query'); return script.shown }, cancelled)
    await settle()
    expect(opened).toEqual(['Save Grid Results'])
    grid.answer({ canceled: true })
    expect(await first).toEqual({ canceled: true })
    await settle()
    expect(opened).toEqual(['Save Grid Results', 'Save SQL query'])
    script.answer({ canceled: false })
    expect(await second).toEqual({ canceled: false })
  })
  it('keeps going after a dialog fails, in the order they were asked for', async () => {
    const queue = dialogQueue(), opened: number[] = []
    const failing = held<number>()
    const results = [queue(() => { opened.push(1); return failing.shown }, 0), queue(async () => { opened.push(2); return 2 }, 0), queue(async () => { opened.push(3); return 3 }, 0)]
    await settle()
    expect(opened).toEqual([1])
    failing.fail(new Error('The window is gone.'))
    await expect(results[0]).rejects.toThrow('The window is gone.')
    expect(await results[1]).toBe(2)
    expect(await results[2]).toBe(3)
    expect(opened).toEqual([1, 2, 3])
  })
  it('passes a dialog that throws before it opens on as a failure', async () => {
    const queue = dialogQueue()
    await expect(queue(() => { throw new Error('Object has been destroyed') }, 'cancel')).rejects.toThrow('Object has been destroyed')
    expect(await queue(async () => 'next', 'cancel')).toBe('next')
  })
  it('settles the dialogs a crashed page asked for as cancelled without showing them, after the one already open', async () => {
    const queue = dialogQueue(), opened: string[] = []
    const grid = held<{ canceled: boolean; filePath?: string }>(), open = held<{ canceled: boolean; filePaths: string[] }>()
    const shown = queue(() => { opened.push('Save Grid Results'); return grid.shown }, cancelled)
    const stale = queue(async () => { opened.push('Save SQL query'); return { canceled: false, filePath: '/tmp/stale.sql' } }, { canceled: true, filePath: '' })
    const prompt = queue(async () => { opened.push('Unsaved query'); return { response: 0 } }, { response: 2 })
    await settle()
    queue.reset()
    // Those not shown yet settle at once with their Cancel answer; the open one cannot be closed, so it stays.
    expect(await stale).toEqual({ canceled: true, filePath: '' })
    expect(await prompt).toEqual({ response: 2 })
    // The crash prompt and the new page's dialogs come after the open one, and nothing of the old page's opens.
    const crash = queue(async () => { opened.push('Workbench stopped'); return { response: 0 } }, { response: -1 })
    const next = queue(() => { opened.push('Open SQL query'); return open.shown }, { canceled: true, filePaths: [] })
    await settle()
    expect(opened).toEqual(['Save Grid Results'])
    grid.answer({ canceled: false, filePath: '/tmp/grid.csv' })
    expect(await shown).toEqual({ canceled: false, filePath: '/tmp/grid.csv' })
    expect(await crash).toEqual({ response: 0 })
    await settle()
    expect(opened).toEqual(['Save Grid Results', 'Workbench stopped', 'Open SQL query'])
    open.answer({ canceled: false, filePaths: ['/tmp/a.sql'] })
    expect(await next).toEqual({ canceled: false, filePaths: ['/tmp/a.sql'] })
    // A reset with nothing waiting changes nothing.
    queue.reset()
    expect(await queue(async () => 'after', 'cancel')).toBe('after')
  })
  it('closes the open message box of a page that is gone, so the crash prompt follows at once', async () => {
    const queue = dialogQueue(), opened: string[] = [], signals: (AbortSignal | undefined)[] = []
    // As Electron does: an aborted message box closes, answering its cancelId.
    const messageBox = (title: string, cancelId: number) => (signal?: AbortSignal) => {
      opened.push(title); signals.push(signal)
      return new Promise<{ response: number }>(resolve => signal?.addEventListener('abort', () => resolve({ response: cancelId })))
    }
    const prompt = queue(messageBox('Unsaved query', 2), { response: 2 }, true)
    const queued = queue(messageBox('Restart SQL backend', 1), { response: 1 }, true)
    await settle()
    expect(opened).toEqual(['Unsaved query'])
    expect(signals[0]?.aborted).toBe(false)
    queue.reset()
    expect(signals[0]?.aborted).toBe(true)
    expect(await prompt).toEqual({ response: 2 })
    expect(await queued).toEqual({ response: 1 })
    const crash = queue(async () => { opened.push('Workbench stopped'); return { response: 0 } }, { response: -1 })
    expect(await crash).toEqual({ response: 0 })
    expect(opened).toEqual(['Unsaved query', 'Workbench stopped'])
    // A file chooser gets no signal: it cannot be closed from main, so the next dialog still waits for it.
    const grid = held<{ canceled: boolean }>()
    const chooser = queue(signal => { opened.push('Save Grid Results'); signals.push(signal); return grid.shown }, cancelled)
    const after = queue(async () => { opened.push('Open SQL query'); return { canceled: true } }, cancelled)
    await settle()
    queue.reset()
    expect(signals.at(-1)).toBeUndefined()
    expect(await after).toEqual(cancelled)
    expect(opened.at(-1)).toBe('Save Grid Results')
    grid.answer({ canceled: false })
    expect(await chooser).toEqual({ canceled: false })
  })
})
