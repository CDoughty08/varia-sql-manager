import { afterEach, describe, expect, it, vi } from 'vitest'
import { replaceFile } from '../src/main/json-file'

const failure = (code: string) => Object.assign(new Error(code), { code })
afterEach(() => { vi.useRealTimers() })

describe('atomic file replacement', () => {
  it('retries while Windows briefly holds the destination open', async () => {
    vi.useFakeTimers()
    const move = vi.fn().mockRejectedValueOnce(failure('EPERM')).mockRejectedValueOnce(failure('EBUSY')).mockRejectedValueOnce(failure('EACCES')).mockResolvedValue(undefined)
    const done = replaceFile('from', 'to', 'win32', move)
    await vi.runAllTimersAsync()
    await expect(done).resolves.toBeUndefined()
    expect(move).toHaveBeenCalledTimes(4)
  })

  it('gives up after about two seconds with the last error', async () => {
    vi.useFakeTimers()
    const move = vi.fn().mockRejectedValue(failure('EPERM'))
    const done = replaceFile('from', 'to', 'win32', move)
    const settled = expect(done).rejects.toMatchObject({ code: 'EPERM' })
    await vi.advanceTimersByTimeAsync(2000)
    expect(move).toHaveBeenCalledTimes(7)
    await vi.runAllTimersAsync()
    await settled
    expect(move).toHaveBeenCalledTimes(8)
  })

  it('fails at once for other errors and on other platforms', async () => {
    const missing = vi.fn().mockRejectedValue(failure('ENOENT'))
    await expect(replaceFile('from', 'to', 'win32', missing)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(missing).toHaveBeenCalledTimes(1)
    const locked = vi.fn().mockRejectedValue(failure('EPERM'))
    await expect(replaceFile('from', 'to', 'linux', locked)).rejects.toMatchObject({ code: 'EPERM' })
    expect(locked).toHaveBeenCalledTimes(1)
  })
})
