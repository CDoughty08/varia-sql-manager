import { readFileSync } from 'node:fs'
import type { WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { installPermissionHandlers, permitted, type PermissionSession } from '../src/main/permissions'

const contents = (name: string) => ({ name }) as unknown as WebContents

function installed(main: WebContents | undefined) {
  let request: Parameters<PermissionSession['setPermissionRequestHandler']>[0] = null
  let check: Parameters<PermissionSession['setPermissionCheckHandler']>[0] = null
  installPermissionHandlers({ setPermissionRequestHandler: handler => { request = handler }, setPermissionCheckHandler: handler => { check = handler } }, () => main)
  const ask = (requester: WebContents, permission: string, isMainFrame: boolean) => {
    const callback = vi.fn<(granted: boolean) => void>()
    request!(requester, permission as never, callback, { isMainFrame, requestingUrl: 'app://varia/' } as never)
    return callback.mock.calls[0]?.[0]
  }
  const query = (requester: WebContents | null, permission: string, isMainFrame: boolean) => check!(requester, permission as never, 'app://varia', { isMainFrame, requestingUrl: 'app://varia/' } as never)
  return { ask, query }
}

describe('permission handlers', () => {
  const main = contents('main'), popout = contents('popout')
  it('grants only sanitized clipboard writes from the main window\'s main frame', () => {
    expect(permitted(main, main, 'clipboard-sanitized-write', true)).toBe(true)
    expect(permitted(main, main, 'clipboard-sanitized-write', false)).toBe(false)
    expect(permitted(popout, main, 'clipboard-sanitized-write', true)).toBe(false)
    expect(permitted(null, main, 'clipboard-sanitized-write', true)).toBe(false)
    // Before the window exists (or after it closed) nothing is granted, even to a null requester.
    expect(permitted(null, undefined, 'clipboard-sanitized-write', true)).toBe(false)
    for (const permission of ['clipboard-read', 'media', 'notifications', 'geolocation', 'hid', 'serial', 'usb', 'fullscreen', 'openExternal'])
      expect(permitted(main, main, permission, true)).toBe(false)
  })

  it('answers checks exactly as requests, instead of Electron\'s default check that grants everything', () => {
    const { ask, query } = installed(main)
    for (const [requester, permission, mainFrame] of [[main, 'clipboard-sanitized-write', true], [main, 'clipboard-sanitized-write', false], [popout, 'clipboard-sanitized-write', true], [main, 'clipboard-read', true], [main, 'hid', true], [main, 'serial', true], [main, 'media', true]] as const) {
      expect(query(requester, permission, mainFrame)).toBe(ask(requester, permission, mainFrame))
    }
    expect(query(main, 'clipboard-sanitized-write', true)).toBe(true)
    expect(query(main, 'hid', true)).toBe(false)
    expect(query(null, 'serial', true)).toBe(false)
  })

  it('looks up the main window at each answer, so a window made after installing still counts', () => {
    let current: WebContents | undefined
    let check: Parameters<PermissionSession['setPermissionCheckHandler']>[0] = null
    installPermissionHandlers({ setPermissionRequestHandler: () => {}, setPermissionCheckHandler: handler => { check = handler } }, () => current)
    expect(check!(main, 'clipboard-sanitized-write', 'app://varia', { isMainFrame: true } as never)).toBe(false)
    current = main
    expect(check!(main, 'clipboard-sanitized-write', 'app://varia', { isMainFrame: true } as never)).toBe(true)
  })

  it('is how main installs its session\'s handlers', () => {
    const source = readFileSync('src/main/index.ts', 'utf8')
    expect(source).toContain('installPermissionHandlers(contents.session, () => mainWindow?.webContents)')
    expect(source).not.toMatch(/setPermission(Request|Check)Handler/)
  })
})
