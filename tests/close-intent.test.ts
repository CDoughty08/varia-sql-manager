import { describe, expect, it } from 'vitest'
import { closeAction, mergeCloseIntent } from '../src/main/close-intent'

describe('closing the window', () => {
  it('closes only the window on macOS, which keeps the app running, unless the user quit', () => {
    expect(closeAction('darwin', 'window')).toBe('closeWindow')
    // The page's own Close Window, which main did not ask for, is a window close too.
    expect(closeAction('darwin', undefined)).toBe('closeWindow')
    expect(closeAction('darwin', 'quit')).toBe('quit')
  })
  it('quits on Windows and Linux, where closing the last window quits anyway', () => {
    for (const platform of ['win32', 'linux'] as const) {
      for (const intent of ['window', 'quit', undefined] as const) expect(closeAction(platform, intent), `${platform} ${intent}`).toBe('quit')
    }
  })
  it('lets a quit during a window close make it a quit, and never turns a quit back', () => {
    expect(mergeCloseIntent(undefined, 'window')).toBe('window')
    expect(mergeCloseIntent('window', 'quit')).toBe('quit')
    expect(mergeCloseIntent('quit', 'window')).toBe('quit')
    expect(closeAction('darwin', mergeCloseIntent(mergeCloseIntent(undefined, 'window'), 'quit'))).toBe('quit')
  })
})
