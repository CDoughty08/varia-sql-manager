import { describe, expect, it, vi } from 'vitest'
import { EditorDialogs, parseLineNumber } from '../src/renderer/src/editor/go-to-line'

describe('Go To Line', () => {
  it('accepts only digits naming a line of the query', () => {
    expect([parseLineNumber('1', 3), parseLineNumber('3', 3), parseLineNumber('007', 10)]).toEqual([1, 3, 7])
    for (const text of ['0', '4', '-1', '+2', ' 2', '2 ', '1.5', '1e1', '', '12345678901', '٣', '0x1']) expect(parseLineNumber(text, 3), JSON.stringify(text)).toBeUndefined()
    expect(parseLineNumber('9999999999', 9_999_999_999)).toBe(9_999_999_999)
  })
  it('opens and closes its dialog through the workbench store', () => {
    const dialogs = new EditorDialogs(), listener = vi.fn()
    dialogs.subscribe(listener)
    dialogs.openGoToLine({ tabId: 'a', lineCount: 3, line: 2 })
    expect(dialogs.getSnapshot().goToLine).toEqual({ tabId: 'a', lineCount: 3, line: 2 })
    dialogs.closeGoToLine(); dialogs.closeGoToLine()
    expect(dialogs.getSnapshot().goToLine).toBeUndefined()
    expect(listener).toHaveBeenCalledTimes(2)
    dialogs.dispose()
  })
})
