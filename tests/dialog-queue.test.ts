import { describe, expect, it } from 'vitest'
import { dialogQueue } from '../src/main/dialog-queue'

const settle = () => new Promise(resolve => setTimeout(resolve, 0))
/** A dialog that stays open until the test answers it. */
function held<T>() {
  let answer!: (value: T) => void, fail!: (error: Error) => void
  const shown = new Promise<T>((resolve, reject) => { answer = resolve; fail = reject })
  return { shown, answer, fail }
}

describe('dialogQueue', () => {
  it('opens a dialog asked for while another is open only once that one closes', async () => {
    const queue = dialogQueue(), opened: string[] = []
    const grid = held<{ canceled: boolean }>(), script = held<{ canceled: boolean }>()
    const first = queue(() => { opened.push('Save Grid Results'); return grid.shown })
    const second = queue(() => { opened.push('Save SQL query'); return script.shown })
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
    const results = [queue(() => { opened.push(1); return failing.shown }), queue(async () => { opened.push(2); return 2 }), queue(async () => { opened.push(3); return 3 })]
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
    await expect(queue(() => { throw new Error('Object has been destroyed') })).rejects.toThrow('Object has been destroyed')
    expect(await queue(async () => 'next')).toBe('next')
  })
})
